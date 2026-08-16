// Main-thread handle on worker.js: the same feed/pull shape as `Decoder`,
// but frames arrive asynchronously and are plain transferable objects
// (`Frame.toTransferable()`), which the renderers accept as-is.

export class WorkerDecoder {
  /**
   * @param {object} [opts]
   * @param {'auto'|'simd'|'baseline'} [opts.variant='auto']
   * @param {string|URL} [opts.baseUrl]           pkg/ directory (see loader.js)
   * @param {'planes'|'rgba'} [opts.output='planes']  what each frame carries; 'rgba' for a 2D-canvas renderer
   * @param {number} [opts.prefetch=6]            frames the worker keeps in flight to the page
   * @param {number} [opts.maxBuffered=10]        frames the wasm ring holds inside the worker
   * @param {boolean} [opts.applyGrain=true]
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
    const url = opts.workerUrl ?? new URL('./worker.js', import.meta.url);
    this.worker = new Worker(url, { type: 'module' });
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
    });
  }

  _onMessage(m) {
    switch (m.type) {
      case 'ready':
        this.variant = m.variant;
        this.simd = m.simd;
        this.version = m.version;
        this._resolveReady({ variant: m.variant, simd: m.simd, version: m.version });
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

  /** One media segment (transferred); demuxed in the worker, samples queued. */
  pushSegment(bytes) {
    const buf = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    this.finished = false;
    this.worker.postMessage({ type: 'segment', data: buf }, [buf]);
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
