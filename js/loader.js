// Load one of the wasm variants and hand back its runtime.
//
// The variants are wasm-bindgen `--target web` modules under pkg/<variant>/:
// baseline, simd, threads (baseline + atomics/shared memory) and simd-threads.
// They are imported dynamically by URL, so a bundler must not try to inline
// them: serve pkg/ as static files and pass `baseUrl` (or keep the default,
// which resolves relative to this file — fine for the demo, and for a build
// that copies js/ and pkg/ side by side).
//
// A threads variant runs rav1d's worker threads as Web Workers (pkg/
// thread-worker.js), each an instance of the same module on the shared
// memory. rav1d asks for them through `globalThis.__wasmAv1SpawnThread`,
// which this file installs in the context that instantiated the module. On a
// page it creates the Worker right there. Inside a Worker (the normal case:
// the decoder lives in one) it hands the request up to the page instead —
// `self.postMessage({type: 'spawnThread', …})`, answered by WorkerDecoder in
// worker-client.js — for two reasons: the requesting Worker is about to
// block in `Atomics.wait` for those very threads, and in Chromium a nested
// Worker only starts once its parent returns to the event loop (deadlock);
// and Safari before 16.4 has no Workers inside Workers at all.

import { chooseVariant, detectBaseline, detectSimd, detectThreads } from './detect.js';

const runtimes = new Map();

/** Stack of each rav1d worker thread (bytes, a multiple of 64 KiB). rav1d
 * runs fine on Rust's 2 MiB default natively and on the 1 MiB main stack of
 * the single-threaded build; 2 MiB leaves room. Allocated from the shared
 * heap per thread. */
export const THREAD_STACK_SIZE = 2 * 1024 * 1024;

/** memory (a shared WebAssembly.Memory) → the glue URL of the module it belongs to. */
const threadGlue = new Map();

function installThreadSpawner() {
  if (globalThis.__wasmAv1SpawnThread) return;
  globalThis.__wasmAv1SpawnThread = (module, memory, ptr) => {
    const glue = threadGlue.get(memory);
    if (!glue) throw new Error('wasm-av1: thread requested for a module this loader did not instantiate');
    const msg = { type: 'spawnThread', glue: glue.href, module, memory, ptr, stackSize: THREAD_STACK_SIZE };
    const inWorker = typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope;
    if (inWorker) {
      // The page (or whoever owns this Worker — WorkerDecoder listens) starts it.
      self.postMessage(msg);
    } else if (typeof Worker === 'function') {
      spawnThreadWorker(msg);
    } else {
      throw new Error('wasm-av1: no way to start a thread here');
    }
  };
}

/**
 * Create the Worker for one rav1d thread from a spawn request (see
 * `installThreadSpawner`; WorkerDecoder calls it for the requests a decode
 * Worker forwards).
 * @param {{glue: string, module: WebAssembly.Module, memory: WebAssembly.Memory, ptr: number, stackSize: number}} msg
 */
export function spawnThreadWorker(msg) {
  const w = new Worker(new URL('../thread-worker.js', msg.glue), { type: 'module', name: 'wasm-av1-thread' });
  w.onerror = (e) => console.error('wasm-av1: thread worker:', e?.message ?? e);
  w.postMessage({ glue: msg.glue, module: msg.module, memory: msg.memory, ptr: msg.ptr, stackSize: msg.stackSize });
  return w;
}

/**
 * @typedef {object} Runtime
 * @property {'baseline'|'simd'|'threads'|'simd-threads'} variant   which build is loaded
 * @property {boolean} simd                built with SIMD128
 * @property {boolean} threads             built with atomics; `new Decoder(rt, {threads: n})` can run n > 1
 * @property {object} mod                  the wasm-bindgen glue module (Av1Decoder, RunResult, …)
 * @property {object} wasm                 the instance exports; `wasm.memory` is the linear memory
 * @property {string} version              crate version
 */

/**
 * @param {object} [opts]
 * @param {'auto'|'simd'|'baseline'|'threads'|'simd-threads'} [opts.variant='auto']
 * @param {boolean} [opts.threads=false]  with variant 'auto': prefer a threads build when the engine allows it
 *                                        (cross-origin isolated page + Workers); the decoder must then live in a Worker
 * @param {string|URL} [opts.baseUrl]  directory containing baseline/, simd/, threads/, simd-threads/ and thread-worker.js
 * @param {(url: URL) => Promise<Response>} [opts.fetch]  custom fetch for the .wasm (e.g. to add credentials)
 * @returns {Promise<Runtime>}
 */
export async function loadWasmAv1(opts = {}) {
  const want = opts.variant ?? 'auto';
  const variant = want === 'auto' ? chooseVariant({ threads: opts.threads ?? false }) : want;
  if (!variant) {
    throw new Error('wasm-av1: this engine supports neither the SIMD nor the baseline build');
  }
  const wantsSimd = variant === 'simd' || variant === 'simd-threads';
  const wantsThreads = variant === 'threads' || variant === 'simd-threads';
  if (wantsSimd && !detectSimd()) {
    throw new Error('wasm-av1: SIMD build requested but this engine has no wasm SIMD');
  }
  if (!wantsSimd && !detectBaseline()) {
    throw new Error('wasm-av1: this engine lacks the post-MVP wasm features the baseline build needs');
  }
  if (wantsThreads && !detectThreads()) {
    throw new Error('wasm-av1: threads build requested but this context has no shared memory (is the page cross-origin isolated?) or no Workers');
  }
  const baseUrl = new URL(opts.baseUrl ?? new URL('../pkg/', import.meta.url), globalThis.location?.href ?? import.meta.url);
  const key = `${variant}@${baseUrl.href}`;
  if (!runtimes.has(key)) {
    runtimes.set(
      key,
      (async () => {
        const glueUrl = new URL(`${variant}/wasm_av1.js`, baseUrl);
        const wasmUrl = new URL(`${variant}/wasm_av1_bg.wasm`, baseUrl);
        const mod = await import(/* @vite-ignore */ /* webpackIgnore: true */ glueUrl.href);
        const source = opts.fetch ? await opts.fetch(wasmUrl) : wasmUrl;
        const wasm = await mod.default({ module_or_path: source });
        const threads = typeof mod.threadsSupported === 'function' && mod.threadsSupported();
        if (threads) {
          threadGlue.set(wasm.memory, glueUrl);
          installThreadSpawner();
        }
        return { variant, simd: mod.simdEnabled(), threads, mod, wasm, version: mod.version() };
      })().catch((e) => {
        runtimes.delete(key);
        throw e;
      }),
    );
  }
  return runtimes.get(key);
}
