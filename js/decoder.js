// A JS-shaped wrapper around the wasm `Av1Decoder`.
//
// The wasm object speaks in pointers and lengths; this class turns the current
// frame into a `Frame` with typed-array views, and enforces the one rule those
// views come with: they are valid only until the next call that can decode
// (memory may grow and detach them). A `Frame` knows its generation and throws
// if you touch it after it has been superseded, rather than handing you a
// detached buffer.

/** Pixel layouts, matching the wasm side (and AV1's numbering). */
export const Layout = Object.freeze({ I400: 0, I420: 1, I422: 2, I444: 3 });

/** ISO 23091-2 matrix codes we know how to convert. */
export const Matrix = Object.freeze({ IDENTITY: 0, BT709: 1, UNSPECIFIED: 2, FCC: 4, BT470BG: 5, BT601: 6, SMPTE240: 7, BT2020_NCL: 9, BT2020_CL: 10 });

/**
 * Kr/Kb for a matrix code — the same table as `convert.rs`, so the WebGL
 * shader and the wasm converter agree on colour.
 */
export function krKbFor(matrix, height) {
  switch (matrix) {
    case 1: return [0.2126, 0.0722];
    case 4: return [0.30, 0.11];
    case 5:
    case 6: return [0.299, 0.114];
    case 7: return [0.212, 0.087];
    case 9:
    case 10: return [0.2627, 0.0593];
    default: return height > 576 ? [0.2126, 0.0722] : [0.299, 0.114];
  }
}

export class Frame {
  /** @package */
  constructor(decoder, generation) {
    this._dec = decoder;
    this._gen = generation;
    const raw = decoder.raw;
    this.width = raw.frameWidth();
    this.height = raw.frameHeight();
    this.bitDepth = raw.frameBitDepth();
    this.bytesPerSample = raw.frameBytesPerSample();
    this.layout = raw.frameLayout();
    const pts = raw.framePts();
    /** pts as given with the input, or null. */
    this.pts = Number.isNaN(pts) ? null : pts;
    this.matrix = raw.frameMatrix();
    this.primaries = raw.framePrimaries();
    this.transfer = raw.frameTransfer();
    this.fullRange = raw.frameFullRange();
    /** [{offset, stride, width, height}] for Y, U, V (U/V zero for I400). */
    this.planes = [0, 1, 2].map((i) => ({
      offset: raw.planeOffset(i),
      stride: raw.planeStride(i),
      width: raw.planeWidth(i),
      height: raw.planeHeight(i),
    }));
    this._ptr = raw.framePtr();
    this._len = raw.frameLen();
    /** Wall-clock time in seconds this frame is due, if the decoder has a time base. */
    this.seconds = decoder.secondsOf(this.pts);
  }

  /** True until the decoder moved on to another frame. */
  get valid() {
    return this._gen === this._dec._generation;
  }

  _check() {
    if (!this.valid) throw new Error('wasm-av1: frame is stale (nextFrame() or flush() was called since)');
  }

  /** Transient view over the packed planes in wasm memory. Rebuild after any decode call. */
  get data() {
    this._check();
    return new Uint8Array(this._dec.rt.wasm.memory.buffer, this._ptr, this._len);
  }

  /** Transient view over one plane (0 Y, 1 U, 2 V). */
  plane(i) {
    const p = this.planes[i];
    return this.data.subarray(p.offset, p.offset + p.stride * p.height);
  }

  /** Copy the packed planes out of wasm memory (safe to keep / transfer). */
  copyData() {
    return this.data.slice();
  }

  /**
   * Convert to RGBA8 in wasm (SIMD128 in the SIMD build) and return a
   * transient `Uint8ClampedArray` view of `width*height*4` bytes.
   */
  rgba() {
    this._check();
    const ptr = this._dec.raw.convertToRgba();
    return new Uint8ClampedArray(this._dec.rt.wasm.memory.buffer, ptr, this.width * this.height * 4);
  }

  /** A fresh ImageData holding a copy of the RGBA conversion. */
  toImageData() {
    return new ImageData(this.rgba().slice(), this.width, this.height);
  }

  /** Copy RGBA into an existing ImageData of the same size (no allocation). */
  writeImageData(imageData) {
    imageData.data.set(this.rgba());
    return imageData;
  }

  /**
   * A structured-clone-friendly copy of everything, for posting from a
   * Worker: `{...meta, data: ArrayBuffer[, rgba: ArrayBuffer]}`.
   */
  toTransferable({ rgba = false } = {}) {
    const out = {
      width: this.width, height: this.height, bitDepth: this.bitDepth, bytesPerSample: this.bytesPerSample,
      layout: this.layout, pts: this.pts, seconds: this.seconds, matrix: this.matrix, primaries: this.primaries,
      transfer: this.transfer, fullRange: this.fullRange, planes: this.planes,
      data: this.copyData().buffer,
    };
    if (rgba) out.rgba = this.rgba().slice().buffer;
    return out;
  }
}

function asU8(bytes) {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

/** 'ivf' | 'mp4' | 'webm' | 'ts' | 'unknown' from the first bytes of a file. */
export function sniff(bytes) {
  const b = asU8(bytes);
  if (b.length >= 4 && b[0] === 0x44 && b[1] === 0x4b && b[2] === 0x49 && b[3] === 0x46) return 'ivf'; // DKIF
  if (b.length >= 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'mp4'; // ....ftyp
  if (b.length >= 8 && b[4] === 0x6d && b[5] === 0x6f && b[6] === 0x6f && b[7] === 0x66) return 'mp4'; // a bare moof segment
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm'; // EBML
  if (b.length >= 189 && b[0] === 0x47 && b[188] === 0x47) return 'ts';
  return 'unknown';
}

/** Outcomes of `run()`; mirrors the wasm `RunResult`. */
export const Run = Object.freeze({ FULL: 0, CONSUMED: 1, STARVED: 2, END_OF_STREAM: 3 });

export class Decoder {
  /**
   * @param {import('./loader.js').Runtime} runtime  from `loadWasmAv1()`
   * @param {object} [opts]
   * @param {number} [opts.maxBuffered=10]  decoded frames kept ahead
   * @param {boolean} [opts.applyGrain=true]  film-grain synthesis
   */
  constructor(runtime, { maxBuffered = 10, applyGrain = true } = {}) {
    this.rt = runtime;
    this.raw = new runtime.mod.Av1Decoder(maxBuffered, applyGrain);
    this.maxBuffered = maxBuffered;
    this._generation = 0;
    this._current = null;
    /** Seconds per pts tick; set from the IVF header, or by `setTimeBase()` in push mode. */
    this.timeBase = null;
  }

  /** Load a whole IVF (ArrayBuffer or Uint8Array). Resets the decoder. */
  setSourceIvf(bytes) {
    this._bump();
    this.raw.setSourceIvf(asU8(bytes));
    this._readTimeBase();
    return this.info();
  }

  /**
   * Load a whole container file — MP4 / fragmented MP4 (CMAF), WebM/MKV,
   * MPEG-TS — demuxed by rivet inside the wasm. Resets the decoder. Throws if
   * the build lacks container support or the video track is not AV1.
   */
  setSourceContainer(bytes) {
    this._bump();
    this.raw.setSourceContainer(asU8(bytes));
    this._readTimeBase();
    return this.info();
  }

  /** IVF or container, decided by the file's magic bytes. */
  setSource(bytes) {
    return sniff(asU8(bytes)) === 'ivf' ? this.setSourceIvf(bytes) : this.setSourceContainer(bytes);
  }

  _readTimeBase() {
    const num = this.raw.timeBaseNum();
    const den = this.raw.timeBaseDen();
    this.timeBase = num && den ? num / den : null;
  }

  /** Push mode: one temporal unit (the OBUs of one AV1 sample) and its pts. */
  pushTemporalUnit(bytes, pts = 0) {
    this.raw.pushTemporalUnit(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), pts);
  }

  /** Push mode: how to turn pts into seconds (e.g. `1 / track.timescale`). */
  setTimeBase(secondsPerTick) {
    this.timeBase = secondsPerTick;
  }

  endOfStream() {
    this.raw.endOfStream();
  }

  /** Reset everything; IVF sources rewind. */
  flush() {
    this._bump();
    this.raw.flush();
  }

  /** One bounded step; returns a `Run` value. Throws on a rejected temporal unit — keep going. */
  run() {
    return this.raw.run();
  }

  runUntilFull() {
    return this.raw.runUntilFull();
  }

  get framesBuffered() {
    return this.raw.framesBuffered();
  }

  get finished() {
    return this.raw.finished();
  }

  get pendingInput() {
    return this.raw.pendingInput();
  }

  info() {
    return {
      width: this.raw.width(),
      height: this.raw.height(),
      timeBase: this.timeBase,
      frameCount: this.raw.frameCountHint() || null,
      frameRate: this.raw.frameRateHint() || null,
      duration: this.raw.durationHint() || null,
    };
  }

  stats() {
    const s = this.raw.stats();
    const out = { temporalUnitsIn: s.temporalUnitsIn, bytesIn: s.bytesIn, framesOut: s.framesOut, decodeErrors: s.decodeErrors };
    s.free?.();
    return out;
  }

  secondsOf(pts) {
    return pts == null || this.timeBase == null ? null : pts * this.timeBase;
  }

  /** pts of the frame `nextFrame()` would return next, or null (nothing buffered / no pts). Does not pop. */
  peekPts() {
    const p = this.raw.peekPts();
    return Number.isNaN(p) ? null : p;
  }

  /** Seconds of the next frame, or null. */
  peekSeconds() {
    return this.secondsOf(this.peekPts());
  }

  /** Pop the oldest buffered frame, or null. Invalidates the previous Frame. */
  nextFrame() {
    this._bump();
    if (!this.raw.nextFrame()) return null;
    this._current = new Frame(this, this._generation);
    return this._current;
  }

  /** The frame most recently returned by nextFrame(), if still valid. */
  get currentFrame() {
    return this._current && this._current.valid ? this._current : null;
  }

  _bump() {
    this._generation++;
    this._current = null;
  }

  free() {
    this._bump();
    this.raw.free();
  }
}
