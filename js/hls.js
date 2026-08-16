// HLS/CMAF for the AV1 fallback: read the playlists, fetch init + media
// segments, feed the decoder segment by segment, and paint frames against
// an external clock.
//
// This is what a page that already plays HLS through a `<video>` needs when
// the browser cannot decode AV1: keep the `<video>` for the *audio*
// rendition (hls.js plays AAC anywhere; the element stays the transport —
// play/pause/seek/currentTime/volume all keep working), and let this paint
// the AV1 video rendition onto a `<canvas>` synced to `video.currentTime`.
//
//   import { HlsAv1Video } from '@safewords/wasm-av1';
//   const v = new HlsAv1Video(canvas, { clock: () => videoEl.currentTime, worker: true, baseUrl: '/wasm-av1/', workerUrl: '/wasm-av1/js/worker.js' });
//   const master = await v.loadMaster(masterUrl);   // parsed variants + audio groups
//   await v.selectVariant(master.variants[0]);      // fetches init, starts prefetching
//   v.start();                                      // paints when the clock says so
//   videoEl.addEventListener('seeking', () => v.seek(videoEl.currentTime));
//
// Playlist parsing covers what CMAF-VOD ladders use: variants with CODECS /
// RESOLUTION / BANDWIDTH / AUDIO groups, EXT-X-MEDIA audio renditions,
// EXT-X-MAP init segments, EXTINF durations, EXT-X-ENDLIST. No byte ranges,
// no live/LL-HLS, no encryption — none of which the ladders here have.

import { Av1Player } from './player.js';

/** Resolve `uri` against `base` (a playlist URL). */
function resolve(uri, base) {
  try {
    return new URL(uri, base).href;
  } catch {
    return uri;
  }
}

/** `KEY=VALUE,KEY="quoted, value"` attribute lists. */
function parseAttrs(s) {
  const out = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|([^,]*))/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[3] !== undefined ? m[3] : m[4];
  return out;
}

/** True when a CODECS attribute names AV1 for the video track. */
export function isAv1Codecs(codecs) {
  return /(^|,)\s*av01\./.test(codecs || '');
}

/**
 * Parse a master playlist.
 * @returns {{variants: Array<{url, bandwidth, codecs, width, height, frameRate, audioGroup, av1}>, audio: Array<{groupId, name, url, isDefault, language}>}}
 */
export function parseMaster(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const variants = [];
  const audio = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttrs(line.slice('#EXT-X-STREAM-INF:'.length));
      const uri = lines[i + 1] && !lines[i + 1].startsWith('#') ? lines[++i] : null;
      if (!uri) continue;
      const [w, h] = (a.RESOLUTION || 'x').split('x').map((n) => parseInt(n, 10));
      variants.push({
        url: resolve(uri, baseUrl),
        bandwidth: parseInt(a.BANDWIDTH || a['AVERAGE-BANDWIDTH'] || '0', 10),
        codecs: a.CODECS || '',
        width: w || 0,
        height: h || 0,
        frameRate: parseFloat(a['FRAME-RATE'] || '0') || 0,
        audioGroup: a.AUDIO || null,
        av1: isAv1Codecs(a.CODECS),
      });
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttrs(line.slice('#EXT-X-MEDIA:'.length));
      if (a.TYPE === 'AUDIO') {
        audio.push({
          groupId: a['GROUP-ID'] || '',
          name: a.NAME || '',
          url: a.URI ? resolve(a.URI, baseUrl) : null,
          isDefault: a.DEFAULT === 'YES',
          language: a.LANGUAGE || null,
        });
      }
    }
  }
  variants.sort((x, y) => x.bandwidth - y.bandwidth);
  return { variants, audio };
}

/**
 * Parse a media playlist.
 * @returns {{init: string|null, segments: Array<{url, duration, start, index}>, duration: number, endList: boolean, targetDuration: number}}
 */
export function parseMediaPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let init = null;
  let targetDuration = 0;
  let endList = false;
  let pendingDuration = null;
  let start = 0;
  const segments = [];
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(line.slice('#EXT-X-MAP:'.length));
      if (a.URI) init = resolve(a.URI, baseUrl);
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = parseFloat(line.split(':')[1]) || 0;
    } else if (line.startsWith('#EXTINF:')) {
      pendingDuration = parseFloat(line.slice('#EXTINF:'.length).split(',')[0]) || 0;
    } else if (line === '#EXT-X-ENDLIST') {
      endList = true;
    } else if (!line.startsWith('#')) {
      const duration = pendingDuration ?? targetDuration;
      segments.push({ url: resolve(line, baseUrl), duration, start, index: segments.length });
      start += duration;
      pendingDuration = null;
    }
  }
  return { init, segments, duration: start, endList, targetDuration };
}

const defaultFetchBytes = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return new Uint8Array(await r.arrayBuffer());
};
const defaultFetchText = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
};

/**
 * AV1-over-HLS video onto a canvas, clocked externally.
 *
 * Extends `Av1Player`'s loop with segment fetching (prefetch ahead of the
 * clock), variant selection and seeking. Decoding is in-thread or in a
 * Worker per `opts.worker`, like `Av1Player`.
 */
export class HlsAv1Video {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} opts  `Av1Player` options plus:
   * @param {() => number} opts.clock          media time in seconds (e.g. `() => video.currentTime`)
   * @param {(url: string) => Promise<Uint8Array>} [opts.fetchBytes]  segment/init fetch (add credentials here)
   * @param {(url: string) => Promise<string>} [opts.fetchText]      playlist fetch
   * @param {number} [opts.prefetchSeconds=8]  how far ahead of the clock to keep segments pushed
   * @param {number} [opts.maxBuffered=16]     decoded frames kept ahead (wasm ring)
   */
  constructor(canvas, opts = {}) {
    if (typeof opts.clock !== 'function') throw new Error('HlsAv1Video needs opts.clock');
    this.clock = opts.clock;
    this.fetchBytes = opts.fetchBytes ?? defaultFetchBytes;
    this.fetchText = opts.fetchText ?? defaultFetchText;
    this.prefetchSeconds = opts.prefetchSeconds ?? 8;
    this.player = new Av1Player(canvas, { maxBuffered: 16, ...opts, clock: opts.clock });
    this.master = null;
    this.variant = null;
    this.playlist = null;
    this._nextSegment = 0;
    this._pushedThrough = 0; // media time up to which segments have been pushed
    this._pumping = false;
    this._generation = 0;
    this.onerror = opts.onerror ?? null;
    this.onvariant = null;
    this.player.onerror = (e) => this.onerror?.(e);
  }

  /** Stats from the underlying player (frames shown/dropped, decode ms, …). */
  get stats() {
    return this.player.stats;
  }

  /** Fetch + parse the master playlist. Returns `{variants, audio}`; variants sorted by bandwidth. */
  async loadMaster(url) {
    this.master = parseMaster(await this.fetchText(url), url);
    return this.master;
  }

  /**
   * Choose a variant (an entry from `master.variants`, or a media playlist
   * URL). Fetches its playlist and init segment and starts prefetching from
   * the current clock position. Switching variants mid-stream is a seek to
   * the current time on the new ladder rung.
   */
  async selectVariant(variant) {
    const url = typeof variant === 'string' ? variant : variant.url;
    const gen = ++this._generation;
    const playlist = parseMediaPlaylist(await this.fetchText(url), url);
    if (!playlist.init) throw new Error('media playlist has no EXT-X-MAP init segment (not CMAF?)');
    const init = await this.fetchBytes(playlist.init);
    if (gen !== this._generation) return; // superseded
    await this.player.init();
    if (this.variant) {
      // switching: reset the decoder, keep the loop
      this.player.src.flush?.();
    }
    this.variant = typeof variant === 'string' ? { url } : variant;
    this.playlist = playlist;
    await this.player.openStream({ timeBase: null });
    this.player.src.setInitSegment(init);
    this._seekTo(this.clock());
    this.onvariant?.(this.variant);
    this._pump();
  }

  /** Start painting (idempotent). Segments are fetched as the clock advances. */
  start() {
    if (!this.playlist) throw new Error('selectVariant() first');
    this.player.play();
    this._pump();
    if (!this._tick) {
      this._tick = setInterval(() => this._pump(), 250);
    }
  }

  stop() {
    this.player.pause();
    if (this._tick) {
      clearInterval(this._tick);
      this._tick = null;
    }
  }

  /** The clock jumped (user seek): drop everything decoded and refill from the segment holding `seconds`. */
  seek(seconds) {
    if (!this.playlist) return;
    this._generation++;
    this.player.src.flush?.();
    this._seekTo(seconds);
    this._pump();
  }

  destroy() {
    this.stop();
    this._generation++;
    this.player.destroy();
  }

  _seekTo(seconds) {
    const segs = this.playlist.segments;
    let i = segs.findIndex((s) => seconds < s.start + s.duration);
    if (i < 0) i = segs.length;
    this._nextSegment = i;
    this._pushedThrough = i < segs.length ? segs[i].start : this.playlist.duration;
    this.player._frameIndex = 0;
  }

  /** Keep segments pushed `prefetchSeconds` ahead of the clock. */
  async _pump() {
    if (this._pumping || !this.playlist) return;
    this._pumping = true;
    const gen = this._generation;
    try {
      while (
        gen === this._generation
        && this._nextSegment < this.playlist.segments.length
        && this._pushedThrough - this.clock() < this.prefetchSeconds
      ) {
        const seg = this.playlist.segments[this._nextSegment];
        const bytes = await this.fetchBytes(seg.url);
        if (gen !== this._generation) return;
        this.player.src.pushSegment(bytes);
        this._nextSegment++;
        this._pushedThrough = seg.start + seg.duration;
      }
      if (gen === this._generation && this._nextSegment >= this.playlist.segments.length && this.playlist.endList) {
        this.player.src.endOfStream();
      }
    } catch (e) {
      this.onerror?.(e);
    } finally {
      this._pumping = false;
    }
  }
}
