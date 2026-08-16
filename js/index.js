// @safewords/wasm-av1 — AV1 decoding in WebAssembly, for browsers without it.
//
//   import { loadWasmAv1, Decoder } from '@safewords/wasm-av1';
//   const rt = await loadWasmAv1();               // picks simd or baseline
//   const dec = new Decoder(rt);
//   dec.setSource(bytes);                          // IVF, MP4/fMP4, WebM, TS — or dec.pushTemporalUnit(obus, pts)
//   dec.runUntilFull();
//   const frame = dec.nextFrame();                 // planes in wasm memory, or frame.rgba()
//
// Higher up: `Av1Player` (canvas + pacing, in-thread or Worker) and the
// renderers, all documented in their own files.

export { detectSimd, detectBaseline, chooseVariant } from './detect.js';
export { loadWasmAv1 } from './loader.js';
export { Decoder, Frame, Run, Layout, Matrix, krKbFor, sniff } from './decoder.js';
export { WebGLRenderer, Canvas2DRenderer, createRenderer } from './render.js';
export { WorkerDecoder } from './worker-client.js';
export { Av1Player } from './player.js';
