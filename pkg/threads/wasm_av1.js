/* @ts-self-types="./wasm_av1.d.ts" */

/**
 * One AV1 decoder with its frame ring and a reusable RGBA scratch buffer.
 */
export class Av1Decoder {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        Av1DecoderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_av1decoder_free(ptr, 0);
    }
    /**
     * Convert the current frame to RGBA8 into the internal scratch buffer
     * (SIMD128 in the SIMD build) and return its pointer; `rgbaLen` bytes.
     * @returns {number}
     */
    convertToRgba() {
        const ret = wasm.av1decoder_convertToRgba(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Container duration in seconds (0 if unknown / not a container).
     * @returns {number}
     */
    durationHint() {
        const ret = wasm.av1decoder_durationHint(this.__wbg_ptr);
        return ret;
    }
    /**
     * Push mode: nothing more is coming.
     */
    endOfStream() {
        wasm.av1decoder_endOfStream(this.__wbg_ptr);
    }
    /**
     * Nothing left to decode or show.
     * @returns {boolean}
     */
    finished() {
        const ret = wasm.av1decoder_finished(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Drop everything buffered, reset rav1d; IVF sources rewind.
     */
    flush() {
        const ret = wasm.av1decoder_flush(this.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * 8, 10 or 12.
     * @returns {number}
     */
    frameBitDepth() {
        const ret = wasm.av1decoder_frameBitDepth(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * 1 or 2.
     * @returns {number}
     */
    frameBytesPerSample() {
        const ret = wasm.av1decoder_frameBytesPerSample(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Frame count announced by the IVF header or container (0 = unknown).
     * @returns {number}
     */
    frameCountHint() {
        const ret = wasm.av1decoder_frameCountHint(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {boolean}
     */
    frameFullRange() {
        const ret = wasm.av1decoder_frameFullRange(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {number}
     */
    frameHeight() {
        const ret = wasm.av1decoder_frameHeight(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * 0 = I400, 1 = I420, 2 = I422, 3 = I444.
     * @returns {number}
     */
    frameLayout() {
        const ret = wasm.av1decoder_frameLayout(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    frameLen() {
        const ret = wasm.av1decoder_frameLen(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * ISO 23091-2 matrix code (1 BT.709, 5/6 BT.601, 9 BT.2020, 2 unspecified).
     * @returns {number}
     */
    frameMatrix() {
        const ret = wasm.av1decoder_frameMatrix(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    framePrimaries() {
        const ret = wasm.av1decoder_framePrimaries(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Pointer to the packed planes of the current frame in wasm memory.
     * @returns {number}
     */
    framePtr() {
        const ret = wasm.av1decoder_framePtr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * pts as given with the input; NaN if it had none.
     * @returns {number}
     */
    framePts() {
        const ret = wasm.av1decoder_framePts(this.__wbg_ptr);
        return ret;
    }
    /**
     * Frame rate as the container (or IVF time base) suggests; 0 if unknown.
     * @returns {number}
     */
    frameRateHint() {
        const ret = wasm.av1decoder_frameRateHint(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    frameTransfer() {
        const ret = wasm.av1decoder_frameTransfer(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    frameWidth() {
        const ret = wasm.av1decoder_frameWidth(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    framesBuffered() {
        const ret = wasm.av1decoder_framesBuffered(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {boolean}
     */
    hasFrame() {
        const ret = wasm.av1decoder_hasFrame(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {number}
     */
    height() {
        const ret = wasm.av1decoder_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * pts of the first sample of the segment most recently pushed, or NaN.
     * @returns {number}
     */
    lastSegmentFirstPts() {
        const ret = wasm.av1decoder_lastSegmentFirstPts(this.__wbg_ptr);
        return ret;
    }
    /**
     * pts of the last sample of the segment most recently pushed, or NaN.
     * @returns {number}
     */
    lastSegmentLastPts() {
        const ret = wasm.av1decoder_lastSegmentLastPts(this.__wbg_ptr);
        return ret;
    }
    /**
     * pts of the last temporal unit handed to the decoder, or NaN.
     * @returns {number}
     */
    lastSentPts() {
        const ret = wasm.av1decoder_lastSentPts(this.__wbg_ptr);
        return ret;
    }
    /**
     * `maxBuffered` frames kept ahead (default 10, upstream's
     * `NUM_FRAMES_BUFFERED`); `applyGrain` toggles film-grain synthesis
     * (default true); `threads` rav1d worker threads (default 1; more only
     * on a build where `threadsSupported()` is true, else forced to 1 — see
     * `threads()` for what was applied).
     * @param {number | null} [max_buffered]
     * @param {boolean | null} [apply_grain]
     * @param {number | null} [threads]
     */
    constructor(max_buffered, apply_grain, threads) {
        const ret = wasm.av1decoder_new(isLikeNone(max_buffered) ? Number.MAX_SAFE_INTEGER : (max_buffered) >>> 0, isLikeNone(apply_grain) ? 0xFFFFFF : apply_grain ? 1 : 0, isLikeNone(threads) ? Number.MAX_SAFE_INTEGER : (threads) >>> 0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        Av1DecoderFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Make the oldest buffered frame current; false if none is buffered.
     * @returns {boolean}
     */
    nextFrame() {
        const ret = wasm.av1decoder_nextFrame(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * pts of the next queued temporal unit (push mode), or NaN.
     * @returns {number}
     */
    nextQueuedPts() {
        const ret = wasm.av1decoder_nextQueuedPts(this.__wbg_ptr);
        return ret;
    }
    /**
     * pts of the oldest buffered frame (the one `nextFrame` would return),
     * without popping it; NaN if none is buffered or it has no pts.
     * @returns {number}
     */
    peekPts() {
        const ret = wasm.av1decoder_peekPts(this.__wbg_ptr);
        return ret;
    }
    /**
     * Temporal units queued and not yet decoded (push mode).
     * @returns {number}
     */
    pendingInput() {
        const ret = wasm.av1decoder_pendingInput(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} i
     * @returns {number}
     */
    planeHeight(i) {
        const ret = wasm.av1decoder_planeHeight(this.__wbg_ptr, i);
        return ret >>> 0;
    }
    /**
     * Byte offset of plane `i` (0 Y, 1 U, 2 V) within the frame buffer.
     * @param {number} i
     * @returns {number}
     */
    planeOffset(i) {
        const ret = wasm.av1decoder_planeOffset(this.__wbg_ptr, i);
        return ret >>> 0;
    }
    /**
     * @param {number} i
     * @returns {number}
     */
    planeStride(i) {
        const ret = wasm.av1decoder_planeStride(this.__wbg_ptr, i);
        return ret >>> 0;
    }
    /**
     * @param {number} i
     * @returns {number}
     */
    planeWidth(i) {
        const ret = wasm.av1decoder_planeWidth(this.__wbg_ptr, i);
        return ret >>> 0;
    }
    /**
     * Demux one media segment (`moof`+`mdat`, or a whole file) with rivet
     * and queue its samples as temporal units; returns how many. Frames keep
     * flowing across segments — no reset. Time base = the container's.
     * @param {Uint8Array} segment
     * @returns {number}
     */
    pushSegment(segment) {
        const ptr0 = passArray8ToWasm0(segment, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.av1decoder_pushSegment(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Queue one temporal unit (an AV1 sample's OBUs) with its pts.
     * @param {Uint8Array} data
     * @param {number} pts
     */
    pushTemporalUnit(data, pts) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.av1decoder_pushTemporalUnit(this.__wbg_ptr, ptr0, len0, pts);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Bytes of RGBA the *current frame* needs (`width * height * 4`).
     * @returns {number}
     */
    rgbaLen() {
        const ret = wasm.av1decoder_rgbaLen(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    rgbaPtr() {
        const ret = wasm.av1decoder_rgbaPtr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * One bounded step of decoding — see `Decoder::run`. A rejected temporal
     * unit throws; the decoder stays usable, keep calling.
     * @returns {RunResult}
     */
    run() {
        const ret = wasm.av1decoder_run(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * `run()` until the ring is full or input runs out.
     * @returns {RunResult}
     */
    runUntilFull() {
        const ret = wasm.av1decoder_runUntilFull(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * Segment-fed playback: keep the CMAF/fMP4 initialisation segment
     * (`ftyp`+`moov`) so `pushSegment` can demux media segments against it.
     * Switches to push mode. Throws without the `container` feature.
     * @param {Uint8Array} init
     */
    setInitSegment(init) {
        const ptr0 = passArray8ToWasm0(init, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.av1decoder_setInitSegment(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Load a whole container file — MP4 / fragmented MP4 / CMAF, WebM / MKV,
     * MPEG-TS — demuxed by rivet (copied into wasm memory). Resets the
     * decoder. Throws if the build lacks the `container` feature, rivet
     * cannot read the file, or the video track is not AV1.
     * @param {Uint8Array} data
     */
    setSourceContainer(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.av1decoder_setSourceContainer(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Load a whole IVF file (copied into wasm memory). Resets the decoder.
     * @param {Uint8Array} data
     */
    setSourceIvf(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.av1decoder_setSourceIvf(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @returns {DecoderStats}
     */
    stats() {
        const ret = wasm.av1decoder_stats(this.__wbg_ptr);
        return DecoderStats.__wrap(ret);
    }
    /**
     * Worker threads this decoder runs with (1 unless the build supports
     * threads and more were asked for).
     * @returns {number}
     */
    threads() {
        const ret = wasm.av1decoder_threads(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    timeBaseDen() {
        const ret = wasm.av1decoder_timeBaseDen(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Time base numerator: `seconds = pts * num / den` for frame pts. From
     * the IVF header or the container timescale; 0 in push mode (you know
     * your own units).
     * @returns {number}
     */
    timeBaseNum() {
        const ret = wasm.av1decoder_timeBaseNum(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Push mode: drop the queued, not-yet-decoded temporal units with
     * `pts >= pts` (a rendition switch replaces the future from a segment
     * boundary the decoder has not reached — no flush, no gap). Returns how
     * many were dropped. See `Decoder::truncate_queued_from`.
     * @param {number} pts
     * @returns {number}
     */
    truncateQueuedFrom(pts) {
        const ret = wasm.av1decoder_truncateQueuedFrom(this.__wbg_ptr, pts);
        return ret >>> 0;
    }
    /**
     * Stream width: the IVF header's, else the last decoded frame's; 0 if unknown yet.
     * @returns {number}
     */
    width() {
        const ret = wasm.av1decoder_width(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) Av1Decoder.prototype[Symbol.dispose] = Av1Decoder.prototype.free;

/**
 * Decoder counters.
 */
export class DecoderStats {
    static __wrap(ptr) {
        const obj = Object.create(DecoderStats.prototype);
        obj.__wbg_ptr = ptr;
        DecoderStatsFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DecoderStatsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_decoderstats_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get bytesIn() {
        const ret = wasm.__wbg_get_decoderstats_bytesIn(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get decodeErrors() {
        const ret = wasm.__wbg_get_decoderstats_decodeErrors(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get framesOut() {
        const ret = wasm.__wbg_get_decoderstats_framesOut(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get temporalUnitsIn() {
        const ret = wasm.__wbg_get_decoderstats_temporalUnitsIn(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set bytesIn(arg0) {
        wasm.__wbg_set_decoderstats_bytesIn(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set decodeErrors(arg0) {
        wasm.__wbg_set_decoderstats_decodeErrors(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set framesOut(arg0) {
        wasm.__wbg_set_decoderstats_framesOut(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set temporalUnitsIn(arg0) {
        wasm.__wbg_set_decoderstats_temporalUnitsIn(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) DecoderStats.prototype[Symbol.dispose] = DecoderStats.prototype.free;

/**
 * [`RunOutcome`] as a small integer for JS.
 * @enum {0 | 1 | 2 | 3}
 */
export const RunResult = Object.freeze({
    Full: 0, "0": "Full",
    Consumed: 1, "1": "Consumed",
    Starved: 2, "2": "Starved",
    EndOfStream: 3, "3": "EndOfStream",
});

/**
 * Entry point of a thread Worker: run the body whose address `spawn` gave
 * JS. Called exactly once per address, from `pkg/thread-worker.js`.
 * @param {number} ptr
 */
export function __wasm_av1_thread_entry(ptr) {
    wasm.__wasm_av1_thread_entry(ptr);
}

/**
 * True when this .wasm can demux containers (`setSourceContainer`), i.e.
 * was built with the `container` feature (rivet-container).
 * @returns {boolean}
 */
export function containerSupport() {
    const ret = wasm.containerSupport();
    return ret !== 0;
}

/**
 * True when this .wasm was built with SIMD128.
 * @returns {boolean}
 */
export function simdEnabled() {
    const ret = wasm.simdEnabled();
    return ret !== 0;
}

/**
 * True when this .wasm was built with atomics + shared memory and can run
 * rav1d's worker threads as Web Workers (`threads` > 1 in the constructor).
 * Needs a cross-origin-isolated page and the decoder in a Worker.
 * @returns {boolean}
 */
export function threadsSupported() {
    const ret = wasm.threadsSupported();
    return ret !== 0;
}

/**
 * Crate version.
 * @returns {string}
 */
export function version() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.version();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}
function __wbg_get_imports(memory) {
    const import0 = {
        __proto__: null,
        __wbg_Error_408e67f47ca7b58b: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wasmAv1SpawnThread_4a182efea409359d: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = globalThis.__wasmAv1SpawnThread(arg0, arg1, arg2 >>> 0);
            return ret;
        }, arguments); },
        __wbg___wbindgen_memory_5dc2a138835b0f8e: function() {
            const ret = wasm.memory;
            return ret;
        },
        __wbg___wbindgen_module_d70c256490b5f616: function() {
            const ret = wasmModule;
            return ret;
        },
        __wbg___wbindgen_throw_bb96b2010945f0bc: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
        memory: memory || new WebAssembly.Memory({initial:25,maximum:16384,shared:true}),
    };
    return {
        __proto__: null,
        "./wasm_av1_bg.js": import0,
    };
}

const Av1DecoderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_av1decoder_free(ptr, 1));
const DecoderStatsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_decoderstats_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.buffer !== wasm.memory.buffer) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = (typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }) : undefined);
if (cachedTextDecoder) cachedTextDecoder.decode();

const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().slice(ptr, ptr + len));
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module, thread_stack_size) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedUint8ArrayMemory0 = null;
    if (typeof thread_stack_size !== 'undefined' && (typeof thread_stack_size !== 'number' || thread_stack_size === 0 || thread_stack_size % 65536 !== 0)) {
        throw new Error('invalid stack size');
    }

    wasm.__wbindgen_start(thread_stack_size);
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module, memory) {
    if (wasm !== undefined) return wasm;

    let thread_stack_size
    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module, memory, thread_stack_size} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports(memory);
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module, thread_stack_size);
}

async function __wbg_init(module_or_path, memory) {
    if (wasm !== undefined) return wasm;

    let thread_stack_size
    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path, memory, thread_stack_size} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('wasm_av1_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports(memory);

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module, thread_stack_size);
}

export { initSync, __wbg_init as default };
