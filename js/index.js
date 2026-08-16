// @safewords/wasm-av1 — AV1 decoding in WebAssembly, for browsers without it.
//
//   import { loadWasmAv1, Decoder } from '@safewords/wasm-av1';
//   const rt = await loadWasmAv1();               // picks simd or baseline (threads builds: see loader.js)
//   const dec = new Decoder(rt);
//   dec.setSource(bytes);                          // IVF, MP4/fMP4, WebM, TS — or dec.pushTemporalUnit(obus, pts)
//   dec.runUntilFull();
//   const frame = dec.nextFrame();                 // planes in wasm memory, or frame.rgba()
//
// Higher up: `Av1Player` (canvas + pacing, in-thread or Worker), the
// renderers, and `HlsAv1Video` (HLS/CMAF playlists → segments → canvas,
// clocked by a `<video>` playing the audio), all documented in their own files.

export { detectSimd, detectBaseline, detectThreads, chooseVariant, VARIANTS } from './detect.js';
export { loadWasmAv1, spawnThreadWorker, THREAD_STACK_SIZE } from './loader.js';
export { Decoder, Frame, Run, Layout, Matrix, krKbFor, sniff } from './decoder.js';
export { WebGLRenderer, Canvas2DRenderer, createRenderer } from './render.js';
export { WorkerDecoder } from './worker-client.js';
export { Av1Player, resolveThreads } from './player.js';
export { HlsAv1Video, parseMaster, parseMediaPlaylist, isAv1Codecs } from './hls.js';
