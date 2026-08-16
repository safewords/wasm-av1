/* tslint:disable */
/* eslint-disable */

/**
 * One AV1 decoder with its frame ring and a reusable RGBA scratch buffer.
 */
export class Av1Decoder {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Convert the current frame to RGBA8 into the internal scratch buffer
     * (SIMD128 in the SIMD build) and return its pointer; `rgbaLen` bytes.
     */
    convertToRgba(): number;
    /**
     * Container duration in seconds (0 if unknown / not a container).
     */
    durationHint(): number;
    /**
     * Push mode: nothing more is coming.
     */
    endOfStream(): void;
    /**
     * Nothing left to decode or show.
     */
    finished(): boolean;
    /**
     * Drop everything buffered, reset rav1d; IVF sources rewind.
     */
    flush(): void;
    /**
     * 8, 10 or 12.
     */
    frameBitDepth(): number;
    /**
     * 1 or 2.
     */
    frameBytesPerSample(): number;
    /**
     * Frame count announced by the IVF header or container (0 = unknown).
     */
    frameCountHint(): number;
    frameFullRange(): boolean;
    frameHeight(): number;
    /**
     * 0 = I400, 1 = I420, 2 = I422, 3 = I444.
     */
    frameLayout(): number;
    frameLen(): number;
    /**
     * ISO 23091-2 matrix code (1 BT.709, 5/6 BT.601, 9 BT.2020, 2 unspecified).
     */
    frameMatrix(): number;
    framePrimaries(): number;
    /**
     * Pointer to the packed planes of the current frame in wasm memory.
     */
    framePtr(): number;
    /**
     * pts as given with the input; NaN if it had none.
     */
    framePts(): number;
    /**
     * Frame rate as the container (or IVF time base) suggests; 0 if unknown.
     */
    frameRateHint(): number;
    frameTransfer(): number;
    frameWidth(): number;
    framesBuffered(): number;
    hasFrame(): boolean;
    height(): number;
    /**
     * `maxBuffered` frames kept ahead (default 10, upstream's
     * `NUM_FRAMES_BUFFERED`); `applyGrain` toggles film-grain synthesis
     * (default true); `threads` rav1d worker threads (default 1; more only
     * on a build where `threadsSupported()` is true, else forced to 1 — see
     * `threads()` for what was applied).
     */
    constructor(max_buffered?: number | null, apply_grain?: boolean | null, threads?: number | null);
    /**
     * Make the oldest buffered frame current; false if none is buffered.
     */
    nextFrame(): boolean;
    /**
     * pts of the oldest buffered frame (the one `nextFrame` would return),
     * without popping it; NaN if none is buffered or it has no pts.
     */
    peekPts(): number;
    /**
     * Temporal units queued and not yet decoded (push mode).
     */
    pendingInput(): number;
    planeHeight(i: number): number;
    /**
     * Byte offset of plane `i` (0 Y, 1 U, 2 V) within the frame buffer.
     */
    planeOffset(i: number): number;
    planeStride(i: number): number;
    planeWidth(i: number): number;
    /**
     * Demux one media segment (`moof`+`mdat`, or a whole file) with rivet
     * and queue its samples as temporal units; returns how many. Frames keep
     * flowing across segments — no reset. Time base = the container's.
     */
    pushSegment(segment: Uint8Array): number;
    /**
     * Queue one temporal unit (an AV1 sample's OBUs) with its pts.
     */
    pushTemporalUnit(data: Uint8Array, pts: number): void;
    /**
     * Bytes of RGBA the *current frame* needs (`width * height * 4`).
     */
    rgbaLen(): number;
    rgbaPtr(): number;
    /**
     * One bounded step of decoding — see `Decoder::run`. A rejected temporal
     * unit throws; the decoder stays usable, keep calling.
     */
    run(): RunResult;
    /**
     * `run()` until the ring is full or input runs out.
     */
    runUntilFull(): RunResult;
    /**
     * Segment-fed playback: keep the CMAF/fMP4 initialisation segment
     * (`ftyp`+`moov`) so `pushSegment` can demux media segments against it.
     * Switches to push mode. Throws without the `container` feature.
     */
    setInitSegment(init: Uint8Array): void;
    /**
     * Load a whole container file — MP4 / fragmented MP4 / CMAF, WebM / MKV,
     * MPEG-TS — demuxed by rivet (copied into wasm memory). Resets the
     * decoder. Throws if the build lacks the `container` feature, rivet
     * cannot read the file, or the video track is not AV1.
     */
    setSourceContainer(data: Uint8Array): void;
    /**
     * Load a whole IVF file (copied into wasm memory). Resets the decoder.
     */
    setSourceIvf(data: Uint8Array): void;
    stats(): DecoderStats;
    /**
     * Worker threads this decoder runs with (1 unless the build supports
     * threads and more were asked for).
     */
    threads(): number;
    timeBaseDen(): number;
    /**
     * Time base numerator: `seconds = pts * num / den` for frame pts. From
     * the IVF header or the container timescale; 0 in push mode (you know
     * your own units).
     */
    timeBaseNum(): number;
    /**
     * Stream width: the IVF header's, else the last decoded frame's; 0 if unknown yet.
     */
    width(): number;
}

/**
 * Decoder counters.
 */
export class DecoderStats {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    bytesIn: number;
    decodeErrors: number;
    framesOut: number;
    temporalUnitsIn: number;
}

/**
 * [`RunOutcome`] as a small integer for JS.
 */
export enum RunResult {
    Full = 0,
    Consumed = 1,
    Starved = 2,
    EndOfStream = 3,
}

/**
 * Entry point of a thread Worker: run the body whose address `spawn` gave
 * JS. Called exactly once per address, from `pkg/thread-worker.js`.
 */
export function __wasm_av1_thread_entry(ptr: number): void;

/**
 * True when this .wasm can demux containers (`setSourceContainer`), i.e.
 * was built with the `container` feature (rivet-container).
 */
export function containerSupport(): boolean;

/**
 * True when this .wasm was built with SIMD128.
 */
export function simdEnabled(): boolean;

/**
 * True when this .wasm was built with atomics + shared memory and can run
 * rav1d's worker threads as Web Workers (`threads` > 1 in the constructor).
 * Needs a cross-origin-isolated page and the decoder in a Worker.
 */
export function threadsSupported(): boolean;

/**
 * Crate version.
 */
export function version(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly __wbg_av1decoder_free: (a: number, b: number) => void;
    readonly __wbg_decoderstats_free: (a: number, b: number) => void;
    readonly __wbg_get_decoderstats_bytesIn: (a: number) => number;
    readonly __wbg_get_decoderstats_decodeErrors: (a: number) => number;
    readonly __wbg_get_decoderstats_framesOut: (a: number) => number;
    readonly __wbg_get_decoderstats_temporalUnitsIn: (a: number) => number;
    readonly __wbg_set_decoderstats_bytesIn: (a: number, b: number) => void;
    readonly __wbg_set_decoderstats_decodeErrors: (a: number, b: number) => void;
    readonly __wbg_set_decoderstats_framesOut: (a: number, b: number) => void;
    readonly __wbg_set_decoderstats_temporalUnitsIn: (a: number, b: number) => void;
    readonly av1decoder_convertToRgba: (a: number) => [number, number, number];
    readonly av1decoder_durationHint: (a: number) => number;
    readonly av1decoder_endOfStream: (a: number) => void;
    readonly av1decoder_finished: (a: number) => number;
    readonly av1decoder_flush: (a: number) => [number, number];
    readonly av1decoder_frameBitDepth: (a: number) => number;
    readonly av1decoder_frameBytesPerSample: (a: number) => number;
    readonly av1decoder_frameCountHint: (a: number) => number;
    readonly av1decoder_frameFullRange: (a: number) => number;
    readonly av1decoder_frameHeight: (a: number) => number;
    readonly av1decoder_frameLayout: (a: number) => number;
    readonly av1decoder_frameLen: (a: number) => number;
    readonly av1decoder_frameMatrix: (a: number) => number;
    readonly av1decoder_framePrimaries: (a: number) => number;
    readonly av1decoder_framePtr: (a: number) => number;
    readonly av1decoder_framePts: (a: number) => number;
    readonly av1decoder_frameRateHint: (a: number) => number;
    readonly av1decoder_frameTransfer: (a: number) => number;
    readonly av1decoder_frameWidth: (a: number) => number;
    readonly av1decoder_framesBuffered: (a: number) => number;
    readonly av1decoder_hasFrame: (a: number) => number;
    readonly av1decoder_height: (a: number) => number;
    readonly av1decoder_new: (a: number, b: number, c: number) => [number, number, number];
    readonly av1decoder_nextFrame: (a: number) => number;
    readonly av1decoder_peekPts: (a: number) => number;
    readonly av1decoder_pendingInput: (a: number) => number;
    readonly av1decoder_planeHeight: (a: number, b: number) => number;
    readonly av1decoder_planeOffset: (a: number, b: number) => number;
    readonly av1decoder_planeStride: (a: number, b: number) => number;
    readonly av1decoder_planeWidth: (a: number, b: number) => number;
    readonly av1decoder_pushSegment: (a: number, b: number, c: number) => [number, number, number];
    readonly av1decoder_pushTemporalUnit: (a: number, b: number, c: number, d: number) => [number, number];
    readonly av1decoder_rgbaLen: (a: number) => number;
    readonly av1decoder_rgbaPtr: (a: number) => number;
    readonly av1decoder_run: (a: number) => [number, number, number];
    readonly av1decoder_runUntilFull: (a: number) => [number, number, number];
    readonly av1decoder_setInitSegment: (a: number, b: number, c: number) => [number, number];
    readonly av1decoder_setSourceContainer: (a: number, b: number, c: number) => [number, number];
    readonly av1decoder_setSourceIvf: (a: number, b: number, c: number) => [number, number];
    readonly av1decoder_stats: (a: number) => number;
    readonly av1decoder_threads: (a: number) => number;
    readonly av1decoder_timeBaseDen: (a: number) => number;
    readonly av1decoder_timeBaseNum: (a: number) => number;
    readonly av1decoder_width: (a: number) => number;
    readonly containerSupport: () => number;
    readonly version: () => [number, number];
    readonly __wasm_av1_thread_entry: (a: number) => void;
    readonly simdEnabled: () => number;
    readonly threadsSupported: () => number;
    readonly dav1d_apply_grain: (a: number, b: number, c: number) => number;
    readonly dav1d_close: (a: number) => void;
    readonly dav1d_data_create: (a: number, b: number) => number;
    readonly dav1d_data_props_unref: (a: number) => void;
    readonly dav1d_data_unref: (a: number) => void;
    readonly dav1d_data_wrap: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly dav1d_data_wrap_user_data: (a: number, b: number, c: number, d: number) => number;
    readonly dav1d_default_settings: (a: number) => void;
    readonly dav1d_flush: (a: number) => void;
    readonly dav1d_get_decode_error_data_props: (a: number, b: number) => number;
    readonly dav1d_get_event_flags: (a: number, b: number) => number;
    readonly dav1d_get_frame_delay: (a: number) => number;
    readonly dav1d_get_picture: (a: number, b: number) => number;
    readonly dav1d_open: (a: number, b: number) => number;
    readonly dav1d_parse_sequence_header: (a: number, b: number, c: number) => number;
    readonly dav1d_picture_unref: (a: number) => void;
    readonly dav1d_send_data: (a: number, b: number) => number;
    readonly dav1d_version: () => number;
    readonly dav1d_version_api: () => number;
    readonly dav1d_set_cpu_flags_mask: (a: number) => void;
    readonly memory: WebAssembly.Memory;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_thread_destroy: (a?: number, b?: number, c?: number) => void;
    readonly __wbindgen_start: (a: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput, memory?: WebAssembly.Memory, thread_stack_size?: number }} module - Passing `SyncInitInput` directly is deprecated.
 * @param {WebAssembly.Memory} memory - Deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput, memory?: WebAssembly.Memory, thread_stack_size?: number } | SyncInitInput, memory?: WebAssembly.Memory): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput>, memory?: WebAssembly.Memory, thread_stack_size?: number }} module_or_path - Passing `InitInput` directly is deprecated.
 * @param {WebAssembly.Memory} memory - Deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput>, memory?: WebAssembly.Memory, thread_stack_size?: number } | InitInput | Promise<InitInput>, memory?: WebAssembly.Memory): Promise<InitOutput>;
