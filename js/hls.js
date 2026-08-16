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

/**
 * Bandwidth estimate from segment downloads, the way hls.js does it: two
 * exponentially weighted moving averages of bits/s — one that reacts fast
 * (half-life `fastHalfLife` seconds of download time) and one that is slow to
 * move (`slowHalfLife`) — and the estimate is the lower of the two, so a
 * sudden slow-down is believed at once and a burst of speed is not.
 */
export class BandwidthEstimator {
  constructor({ fastHalfLife = 3, slowHalfLife = 9, defaultEstimate = 0 } = {}) {
    this.fastHalfLife = fastHalfLife;
    this.slowHalfLife = slowHalfLife;
    this.defaultEstimate = defaultEstimate;
    this._fast = 0;
    this._slow = 0;
    this._fastW = 0; // total weight seen, for bias correction
    this._slowW = 0;
    this.samples = 0;
    this.last = null; // {bps, seconds, bytes}
  }

  /** One download: `seconds` wall time for `bytes`. Ignores trivially small or instant ones. */
  sample(seconds, bytes) {
    if (!(seconds > 0.0005) || !(bytes > 0)) return;
    const bps = (8 * bytes) / seconds;
    const af = Math.pow(0.5, seconds / this.fastHalfLife);
    const as = Math.pow(0.5, seconds / this.slowHalfLife);
    this._fast = af * this._fast + (1 - af) * bps;
    this._slow = as * this._slow + (1 - as) * bps;
    this._fastW = af * this._fastW + (1 - af);
    this._slowW = as * this._slowW + (1 - as);
    this.samples++;
    this.last = { bps, seconds, bytes };
  }

  /** bits per second, or `defaultEstimate` before any sample. */
  get estimate() {
    if (!this.samples) return this.defaultEstimate;
    return Math.min(this._fast / this._fastW, this._slow / this._slowW);
  }
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
   * @param {number} [opts.bandwidthEstimate=0]  starting bandwidth estimate (bits/s) before any segment was fetched
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
    this._pushed = []; // {index, start, samples, firstPts, lastPts} of pushed segments, in push order (bounded)
    this._samplesPushed = 0; // temporal units pushed since the last (re)start
    this._pumping = false;
    this._generation = 0;
    this._switching = null;
    /** Bandwidth from this player's own segment downloads (bits/s in `.estimate`). */
    this.bandwidth = new BandwidthEstimator({ defaultEstimate: opts.bandwidthEstimate ?? 0 });
    this._slowFetches = 0;
    this._fetches = 0;
    this.onerror = opts.onerror ?? null;
    this.onvariant = null;
    this.player.onerror = (e) => this.onerror?.(e);
  }

  /**
   * Stats from the underlying player (frames shown/dropped/late, stalls,
   * decode ms, threads, …) plus this layer's:
   *  - `bandwidth`     bits/s estimate from segment downloads (0 until one landed)
   *  - `bufferAhead`   seconds of segments pushed beyond the clock (network side of the buffer)
   *  - `slowFetches`   downloads that took longer than the segment they carried — the
   *                    network is not keeping up with this rung
   *  - `fetches`       downloads so far
   *  - `variantHeight` / `variantBandwidth` of the rung in effect
   */
  get stats() {
    const s = this.player.stats;
    s.bandwidth = this.bandwidth.estimate;
    s.bufferAhead = this.playlist ? Math.max(0, this._pushedThrough - this.clock()) : 0;
    s.slowFetches = this._slowFetches;
    s.fetches = this._fetches;
    s.variantHeight = this.variant?.height ?? null;
    s.variantBandwidth = this.variant?.bandwidth ?? null;
    return s;
  }

  /**
   * The rung the network can carry: the highest of `variants` (default: the
   * master's AV1 variants) whose declared BANDWIDTH fits under the estimate ×
   * `factor` and whose height is ≤ `maxHeight`; the lowest when none fits or
   * there is no estimate yet. A player takes the lower of this and what the
   * device can decode (its own stutter evidence) — see docs/integration.md.
   */
  variantForBandwidth({ variants, bandwidth = this.bandwidth.estimate, factor = 0.8, maxHeight = Infinity } = {}) {
    const list = (variants ?? this.master?.variants ?? []).filter((v) => v.av1 !== false && (v.height || 0) <= maxHeight);
    if (!list.length) return null;
    const sorted = [...list].sort((a, b) => a.bandwidth - b.bandwidth);
    if (!(bandwidth > 0)) return sorted[0];
    let best = sorted[0];
    for (const v of sorted) if (v.bandwidth <= bandwidth * factor) best = v;
    return best;
  }

  /** Fetch + parse the master playlist. Returns `{variants, audio}`; variants sorted by bandwidth. */
  async loadMaster(url) {
    this.master = parseMaster(await this.fetchText(url), url);
    return this.master;
  }

  /**
   * Choose a variant (an entry from `master.variants`, or a media playlist
   * URL). Fetches its playlist and init segment and starts prefetching.
   *
   * `at`: how a switch from a playing variant takes effect —
   *  - `'boundary'` (the default while something plays): seamlessly, at the
   *    next segment boundary the decoder has not reached. Segments already
   *    pushed past it are un-queued and re-fetched from the new rung, the
   *    new init goes in, decoding never stops, nothing already decoded is
   *    lost — the picture changes rung a segment later with no gap. Needs the
   *    two playlists to be segment-aligned (a ladder is); otherwise, or if
   *    the decoder outruns the attempt, it falls back to `'now'`.
   *  - `'now'`: a hard switch — flush and refill from the segment holding the
   *    clock (a visible gap while it decodes up to the clock again).
   * The first `selectVariant` (nothing playing yet) is always immediate.
   * Resolves to how it happened: `'boundary'`, `'now'`, `'none'` (asked for
   * a boundary switch but the decoder already holds everything to the end —
   * nothing to switch, the variant stays) or `'superseded'`.
   */
  async selectVariant(variant, { at = 'boundary' } = {}) {
    const url = typeof variant === 'string' ? variant : variant.url;
    const wanted = typeof variant === 'string' ? { url } : variant;
    if (this.playlist && at === 'boundary') {
      const how = await this._switchAtBoundary(wanted, url);
      if (how) return how;
      // null: not segment-aligned, or the decoder kept outrunning us — hard switch
    }
    const gen = ++this._generation;
    const playlist = parseMediaPlaylist(await this.fetchText(url), url);
    if (!playlist.init) throw new Error('media playlist has no EXT-X-MAP init segment (not CMAF?)');
    const init = await this.fetchBytes(playlist.init);
    if (gen !== this._generation) return 'superseded';
    await this.player.init();
    const wasPlaying = this.player.state === 'playing' || !!this._tick;
    if (this.variant) {
      // switching: reset the decoder, keep the loop
      this.player.src.flush?.();
    }
    this.variant = wanted;
    this.playlist = playlist;
    await this.player.openStream({ timeBase: null }); // stops the loop and zeroes the stats
    this.player.src.setInitSegment(init);
    this._pushed = [];
    this._samplesPushed = 0;
    this._seekTo(this.clock());
    if (wasPlaying) this.player.play(); // keep painting: a switch is not a pause
    this.onvariant?.(this.variant);
    this._pump();
    return 'now';
  }

  /** The seamless path of `selectVariant`; null when it cannot be done (caller hard-switches). */
  async _switchAtBoundary(wanted, url) {
    if (this._switching) return this._switching; // one at a time
    this._switching = (async () => {
      const startGen = this._generation;
      const playlist = parseMediaPlaylist(await this.fetchText(url), url);
      if (!playlist.init) return null;
      const init = await this.fetchBytes(playlist.init);
      if (startGen !== this._generation) return 'superseded';
      const oldSegs = this.playlist.segments;
      // Segment-aligned ladders only: same count, same starts (within 50 ms).
      const aligned = playlist.segments.length === oldSegs.length
        && playlist.segments.every((s, i) => Math.abs(s.start - oldSegs[i].start) < 0.05);
      if (!aligned) return null;
      for (let attempt = 0; attempt < 3; attempt++) {
        // The segment being decoded: the pushed one that holds temporal
        // unit number `temporalUnitsIn` (worker stats lag a few frames, so
        // this may be one low — the decoder's own guard catches that and we
        // move to the next boundary).
        const decoded = this.player.stats?.decoder?.temporalUnitsIn ?? 0;
        let cum = 0;
        let decodingIndex = -1;
        for (const p of this._pushed) {
          cum += p.samples;
          decodingIndex = p.index;
          if (cum > decoded) break;
        }
        let b = Math.max(decodingIndex + 1 + attempt, 0);
        // Never before the clock: the viewer must not see the switch behind them.
        while (b < oldSegs.length && oldSegs[b].start + oldSegs[b].duration <= this.clock()) b++;
        // No boundary left: the decoder already holds everything to the end
        // (or the clock is in the last segment). Nothing to switch.
        if (b >= oldSegs.length) return 'none';
        const pushed = this._pushed.find((p) => p.index === b);
        const boundaryPts = pushed?.firstPts ?? null; // null: nothing beyond b was pushed, nothing to truncate
        const r = await this.player.src.switchStream({ boundaryPts, init: init.slice(0) });
        if (startGen !== this._generation) return 'superseded';
        if (!r?.ok) continue; // the decoder crossed it meanwhile: next boundary
        // Committed. From b on, the new rung.
        this._generation++; // any in-flight fetch of the old rung past b is dropped by the pump
        this.variant = wanted;
        this.playlist = playlist;
        this._pushed = this._pushed.filter((p) => p.index < b);
        this._samplesPushed = this._pushed.reduce((n, p) => n + p.samples, 0);
        this._nextSegment = b;
        this._pushedThrough = playlist.segments[b].start;
        this.onvariant?.(this.variant);
        this._pump();
        return 'boundary';
      }
      return null;
    })().finally(() => { this._switching = null; });
    return this._switching;
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
    this._pushed = [];
    this._samplesPushed = 0;
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
        const t0 = performance.now();
        const bytes = await this.fetchBytes(seg.url);
        const dt = (performance.now() - t0) / 1000;
        this._fetches++;
        this.bandwidth.sample(dt, bytes.byteLength ?? bytes.length ?? 0);
        if (seg.duration > 0 && dt > seg.duration) this._slowFetches++;
        if (gen !== this._generation) return;
        // In-thread Decoder answers synchronously with a count; the Worker
        // resolves with the segment's sample count and pts range.
        const r = await Promise.resolve(this.player.src.pushSegment(bytes));
        if (gen !== this._generation) return;
        const range = typeof r === 'number' ? { samples: r, ...this.player.src.lastSegmentRange() } : r;
        if (range?.error) throw new Error(range.error);
        this._pushed.push({ index: seg.index, start: seg.start, samples: range?.samples ?? 0, firstPts: range?.firstPts ?? null, lastPts: range?.lastPts ?? null });
        if (this._pushed.length > 64) this._pushed.splice(0, this._pushed.length - 64);
        this._samplesPushed += range?.samples ?? 0;
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
