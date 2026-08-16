// Main-thread handle on worker.js: the same feed/pull shape as `Decoder`,
// but frames arrive asynchronously and are plain transferable objects
// (`Frame.toTransferable()`), which the renderers accept as-is.

import { spawnThreadWorker } from './loader.js';

export class WorkerDecoder {
  /**
   * @param {object} [opts]
   * @param {'auto'|'simd'|'baseline'} [opts.variant='auto']
   * @param {string|URL} [opts.baseUrl]           pkg/ directory (see loader.js)
   * @param {'planes'|'rgba'} [opts.output='planes']  what each frame carries; 'rgba' for a 2D-canvas renderer
   * @param {number} [opts.prefetch=6]            frames the worker keeps in flight to the page
   * @param {number} [opts.maxBuffered=10]        frames the wasm ring holds inside the worker
   * @param {boolean} [opts.applyGrain=true]
   * @param {number} [opts.threads=1]             rav1d worker threads (each a Worker on shared memory); takes effect only
   *                                              on a cross-origin-isolated page — see `ready` / `threads` for what applied
   * @param {string|URL} [opts.workerUrl]         defaults to ./worker.js next to this file
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.queue = [];
    this.finished = false;
    this.info = null;
    this.stats = null;
    this.ready = null;
    this.onerror = null;
    this.onframe = null;
    this._waiters = [];
    this._replies = new Map(); // tag → resolve, for request/response messages
    this._tag = 0;
    // Bundlers (Vite, webpack) only recognise a worker entry when the URL is
    // built inline in the `new Worker(...)` call; a variable defeats it and
    // the file gets copied as a plain asset with its bare imports intact.
    // Consumers that serve js/ statically can bypass all of that with
    // `workerUrl` (worker.js imports ./loader.js and ./decoder.js relatively).
    this.worker = opts.workerUrl
      ? new Worker(opts.workerUrl, { type: 'module' })
      : new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.ready = new Promise((resolve, reject) => {
      this._resolveReady = resolve;
      this._rejectReady = reject;
    });
    this.worker.onmessage = (ev) => this._onMessage(ev.data);
    this.worker.onerror = (e) => {
      const err = new Error(`wasm-av1 worker: ${e.message ?? e}`);
      this._rejectReady?.(err);
      this.onerror?.(err);
    };
    this.worker.postMessage({
      type: 'init',
      variant: opts.variant ?? 'auto',
      baseUrl: opts.baseUrl ? String(opts.baseUrl) : String(new URL('../pkg/', import.meta.url)),
      output: opts.output ?? 'planes',
      prefetch: opts.prefetch ?? 6,
      maxBuffered: opts.maxBuffered ?? 10,
      applyGrain: opts.applyGrain ?? true,
      threads: opts.threads ?? 1,
    });
  }

  _onMessage(m) {
    switch (m.type) {
      case 'ready':
        this.variant = m.variant;
        this.simd = m.simd;
        this.threads = m.threads ?? 1;
        this.version = m.version;
        this._resolveReady({ variant: m.variant, simd: m.simd, threads: this.threads, version: m.version });
        break;
      case 'spawnThread':
        // A rav1d worker thread for the decode Worker's decoder: it asks us
        // because it is about to block waiting for it (see loader.js). The
        // compiled module and the shared memory came along.
        spawnThreadWorker(m);
        break;
      case 'info':
        this.info = m.info;
        break;
      case 'frame':
        this.stats = m.stats;
        this.queue.push(m.frame);
        this.onframe?.(m.frame);
        this._wakeWaiters();
        break;
      case 'finished':
        this.stats = m.stats;
        this.finished = true;
        this._wakeWaiters();
        break;
      case 'flushed':
        break;
      case 'segment':
        this.info = m.info;
        this.onsegment?.(m);
        this._reply(m);
        break;
      case 'switched':
        this._reply(m);
        break;
      case 'error': {
        const err = new Error(m.message);
        if (m.fatal) this._rejectReady?.(err);
        this.onerror?.(err);
        break;
      }
    }
  }

  _wakeWaiters() {
    const w = this._waiters;
    this._waiters = [];
    w.forEach((r) => r());
  }

  _request(msg, transfer) {
    const tag = ++this._tag;
    return new Promise((resolve) => {
      this._replies.set(tag, resolve);
      this.worker.postMessage({ ...msg, tag }, transfer || []);
    });
  }

  _reply(m) {
    const r = this._replies.get(m.tag);
    if (r) {
      this._replies.delete(m.tag);
      r(m);
    }
  }

  _setSource(type, bytes) {
    const buf = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    this.queue = [];
    this.finished = false;
    this.info = null;
    this.worker.postMessage({ type, data: buf }, [buf]);
  }

  /** Whole IVF; the buffer is transferred (detached) to the worker. */
  setSourceIvf(bytes) {
    this._setSource('ivf', bytes);
  }

  /** Whole MP4/fMP4/WebM/TS; transferred to the worker and demuxed by rivet there. */
  setSourceContainer(bytes) {
    this._setSource('container', bytes);
  }

  /** IVF or container, by magic bytes. */
  setSource(bytes) {
    this._setSource('source', bytes);
  }

  /** Push one temporal unit (transferred). `timeBase` = seconds per pts tick, if known. */
  pushTemporalUnit(bytes, pts = 0, timeBase) {
    const buf = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    this.finished = false;
    this.worker.postMessage({ type: 'push', data: buf, pts, timeBase }, [buf]);
  }

  /** Segment-fed playback: the CMAF init segment (transferred). */
  setInitSegment(bytes) {
    const buf = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    this.finished = false;
    this.worker.postMessage({ type: 'initSegment', data: buf }, [buf]);
  }

  /**
   * One media segment (transferred); demuxed in the worker, samples queued.
   * Resolves to `{samples, firstPts, lastPts, timeBase, error}` once the
   * worker has queued it — `firstPts` is the segment boundary, exactly.
   */
  pushSegment(bytes) {
    const buf = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    this.finished = false;
    return this._request({ type: 'segment', data: buf }, [buf]);
  }

  /**
   * Seamless rendition switch (see `Decoder.switchStream`): resolves to
   * `{ok, dropped}`; `ok: false` = the decoder is already past `boundaryPts`.
   */
  switchStream({ boundaryPts = null, init }) {
    const buf = init instanceof ArrayBuffer ? init : init.buffer.slice(init.byteOffset, init.byteOffset + init.byteLength);
    this.finished = false;
    return this._request({ type: 'switchStream', boundaryPts, init: buf }, [buf]);
  }

  endOfStream() {
    this.worker.postMessage({ type: 'eos' });
  }

  flush() {
    this.queue = [];
    this.finished = false;
    this.worker.postMessage({ type: 'flush' });
  }

  /** Frames received and not yet taken. */
  get framesBuffered() {
    return this.queue.length;
  }

  /** pts / seconds of the next queued frame without taking it. */
  peekPts() {
    return this.queue.length ? this.queue[0].pts : null;
  }

  peekSeconds() {
    return this.queue.length ? this.queue[0].seconds : null;
  }

  /** Take the oldest received frame synchronously, or null; the worker is told to send more. */
  nextFrame() {
    const f = this.queue.shift() ?? null;
    if (f) this.worker.postMessage({ type: 'ack', count: 1 });
    return f;
  }

  /** Await the next frame; resolves null at end of stream. */
  async frame() {
    for (;;) {
      const f = this.nextFrame();
      if (f) return f;
      if (this.finished) return null;
      await new Promise((r) => this._waiters.push(r));
    }
  }

  close() {
    this.worker.postMessage({ type: 'close' });
    this.worker.terminate();
  }
}
