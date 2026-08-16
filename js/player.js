// A minimal player: the `requestAnimationFrame` loop from upstream
// `index.html`, without the hard-coded 24 fps — frames are shown at
// `pts × time base` (IVF header, or `setTimeBase` in push mode) — with a
// decode budget per tick, catch-up by dropping late frames, and either an
// in-thread `Decoder` or a `WorkerDecoder` behind the same loop.
//
// It is deliberately small: it exists to prove the pipeline and to give the
// lewd-frontend integration a reference for the pacing/decode-budget/renderer
// choices, not to be a full player (no audio, no seeking UI).

import { Decoder, Run } from './decoder.js';
import { loadWasmAv1 } from './loader.js';
import { createRenderer } from './render.js';
import { WorkerDecoder } from './worker-client.js';

export class Av1Player {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} [opts]
   * @param {'auto'|'webgl'|'2d'} [opts.renderer='auto']
   * @param {boolean} [opts.worker=false]      decode in a Web Worker
   * @param {'auto'|'simd'|'baseline'} [opts.variant='auto']
   * @param {string|URL} [opts.baseUrl]        pkg/ directory
   * @param {number} [opts.maxBuffered=10]
   * @param {boolean} [opts.applyGrain=true]
   * @param {number} [opts.decodeBudgetMs=8]   max decode time per animation frame (in-thread mode)
   * @param {number} [opts.fallbackFps=24]     when the stream carries no time base
   * @param {() => number} [opts.clock]        external media clock in seconds (e.g. `() => video.currentTime`);
   *                                           without it the player free-runs from `play()`
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = { renderer: 'auto', worker: false, variant: 'auto', maxBuffered: 10, applyGrain: true, decodeBudgetMs: 8, fallbackFps: 24, ...opts };
    this.renderer = createRenderer(canvas, this.opts.renderer);
    this.rendererKind = this.renderer.constructor.name === 'WebGLRenderer' ? 'webgl' : '2d';
    this.state = 'idle'; // idle | loading | ready | playing | paused | ended
    this.onstate = null;
    this.onstats = null;
    this.onerror = null;
    this._raf = 0;
    this._resetStats();
  }

  _resetStats() {
    this.stats = {
      framesShown: 0, framesDropped: 0, decodeMs: 0, drawMs: 0, maxRunMs: 0, runs: 0,
      buffered: 0, fps: 0, variant: null, simd: null, renderer: this.rendererKind, drawPath: null, worker: this.opts.worker,
      decoder: null,
    };
    this._fpsWindow = [];
  }

  _setState(s) {
    this.state = s;
    this.onstate?.(s);
  }

  /** Load the wasm runtime (or start the worker). Idempotent. */
  async init() {
    if (this._initialised) return this;
    if (this.opts.worker) {
      this.src = new WorkerDecoder({
        variant: this.opts.variant, baseUrl: this.opts.baseUrl, maxBuffered: this.opts.maxBuffered,
        applyGrain: this.opts.applyGrain, output: this.rendererKind === 'webgl' ? 'planes' : 'rgba',
      });
      this.src.onerror = (e) => this.onerror?.(e);
      const r = await this.src.ready;
      this.stats.variant = r.variant;
      this.stats.simd = r.simd;
    } else {
      this.rt = await loadWasmAv1({ variant: this.opts.variant, baseUrl: this.opts.baseUrl });
      this.src = new Decoder(this.rt, { maxBuffered: this.opts.maxBuffered, applyGrain: this.opts.applyGrain });
      this.stats.variant = this.rt.variant;
      this.stats.simd = this.rt.simd;
    }
    this._initialised = true;
    return this;
  }

  /**
   * Load a whole file — IVF, or MP4 / fragmented MP4 / WebM / TS (demuxed by
   * rivet inside the wasm) — and get ready to play.
   */
  async load(bytes) {
    await this.init();
    this.stop();
    this._setState('loading');
    this._resetStats();
    this.stats.variant = this.src.variant ?? this.rt?.variant ?? null;
    this.stats.simd = this.src.simd ?? this.rt?.simd ?? null;
    this.src.setSource(bytes);
    this.info = this.opts.worker ? await this._waitInfo() : this.src.info();
    this._timeBase = this.info?.timeBase ?? null;
    this._frameIndex = 0;
    this._setState('ready');
    return this.info;
  }

  _waitInfo() {
    return new Promise((resolve) => {
      const tick = () => (this.src.info ? resolve(this.src.info) : setTimeout(tick, 5));
      tick();
    });
  }

  /**
   * Push mode for segment-fed playback: feed temporal units yourself, tell
   * the player the time base, call `endOfStream()` at the end.
   */
  async openStream({ timeBase } = {}) {
    await this.init();
    this.stop();
    this._resetStats();
    this.stats.variant = this.src.variant ?? this.rt?.variant ?? null;
    this.stats.simd = this.src.simd ?? this.rt?.simd ?? null;
    this._timeBase = timeBase ?? null;
    if (!this.opts.worker && timeBase != null) this.src.setTimeBase(timeBase);
    this._frameIndex = 0;
    this._setState('ready');
  }

  pushTemporalUnit(bytes, pts) {
    if (this.opts.worker) this.src.pushTemporalUnit(bytes, pts, this._timeBase);
    else this.src.pushTemporalUnit(bytes, pts);
  }

  endOfStream() {
    this.src.endOfStream();
  }

  play() {
    if (this.state === 'playing') return;
    if (this.state !== 'ready' && this.state !== 'paused') return;
    // Free-running: anchor the clock so the *next* frame is due now. With an
    // external clock the frames are due when *it* says so.
    if (!this.opts.clock) this._t0 = performance.now() / 1000 - this._peekDue();
    this._setState('playing');
    this._loop();
  }

  pause() {
    if (this.state !== 'playing') return;
    cancelAnimationFrame(this._raf);
    this._setState('paused');
  }

  stop() {
    cancelAnimationFrame(this._raf);
    if (this._initialised && this.state !== 'idle') this._setState('ready');
  }

  destroy() {
    cancelAnimationFrame(this._raf);
    if (this.opts.worker) this.src?.close();
    else this.src?.free();
    this.renderer.destroy();
    this._setState('idle');
  }

  /** Seconds at which the next buffered frame is due (pts × time base, else index / fps). */
  _peekDue() {
    const secs = this.src.peekSeconds?.();
    if (secs != null) return secs;
    const pts = this.src.peekPts?.();
    if (pts != null && this._timeBase != null) return pts * this._timeBase;
    const fps = this._timeBase ? 1 / this._timeBase : this.opts.fallbackFps;
    return this._frameIndex / fps;
  }

  _decodeSome(tickStart) {
    if (this.opts.worker) return; // the worker decodes on its own
    const budget = this.opts.decodeBudgetMs;
    while (this.src.framesBuffered < this.opts.maxBuffered) {
      const t = performance.now();
      let r;
      try {
        r = this.src.run();
      } catch (e) {
        this.onerror?.(e);
        r = Run.CONSUMED;
      }
      const dt = performance.now() - t;
      this.stats.decodeMs += dt;
      this.stats.runs++;
      if (dt > this.stats.maxRunMs) this.stats.maxRunMs = dt;
      if (r === Run.STARVED || r === Run.END_OF_STREAM || r === Run.FULL) break;
      if (performance.now() - tickStart > budget) break;
    }
  }

  _loop = () => {
    if (this.state !== 'playing') return;
    const tickStart = performance.now();
    const now = this.opts.clock ? this.opts.clock() : tickStart / 1000 - this._t0;

    // Show the frame that is due. If we are behind and the one after it is
    // due too, this one is late: drop it (skip the draw) and move on. Peeking
    // by pts means the current frame is never invalidated before it is drawn.
    let toShow = null;
    while (this.src.framesBuffered > 0 && this._peekDue() <= now) {
      const f = this.src.nextFrame();
      if (!f) break;
      this._frameIndex++;
      const after = this.src.framesBuffered > 0 ? this._peekDue() : Infinity;
      if (after <= now) {
        this.stats.framesDropped++;
        continue;
      }
      toShow = f;
      break;
    }
    if (toShow) {
      const t = performance.now();
      try {
        this.stats.drawPath = this.renderer.draw(toShow);
      } catch (e) {
        this.onerror?.(e);
      }
      this.stats.drawMs += performance.now() - t;
      this.stats.framesShown++;
      this._fpsWindow.push(t);
      while (this._fpsWindow.length && this._fpsWindow[0] < t - 1000) this._fpsWindow.shift();
      this.stats.fps = this._fpsWindow.length;
    }

    this._decodeSome(tickStart);
    this.stats.buffered = this.src.framesBuffered;
    if (this.opts.worker) this.stats.decoder = this.src.stats;
    else this.stats.decoder = this.src.stats();
    this.onstats?.(this.stats);

    const finished = this.src.finished && this.src.framesBuffered === 0;
    if (finished) {
      this._setState('ended');
      return;
    }
    this._raf = requestAnimationFrame(this._loop);
  };
}
