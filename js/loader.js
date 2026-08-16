// Load one of the two wasm variants and hand back its runtime.
//
// The variants are wasm-bindgen `--target web` modules under pkg/<variant>/.
// They are imported dynamically by URL, so a bundler must not try to inline
// them: serve pkg/ as static files and pass `baseUrl` (or keep the default,
// which resolves relative to this file — fine for the demo, and for a build
// that copies js/ and pkg/ side by side).

import { chooseVariant, detectBaseline, detectSimd } from './detect.js';

const runtimes = new Map();

/**
 * @typedef {object} Runtime
 * @property {'baseline'|'simd'} variant   which build is loaded
 * @property {boolean} simd                same as variant === 'simd'
 * @property {object} mod                  the wasm-bindgen glue module (Av1Decoder, RunResult, …)
 * @property {object} wasm                 the instance exports; `wasm.memory` is the linear memory
 * @property {string} version              crate version
 */

/**
 * @param {object} [opts]
 * @param {'auto'|'simd'|'baseline'} [opts.variant='auto']
 * @param {string|URL} [opts.baseUrl]  directory containing baseline/ and simd/
 * @param {(url: URL) => Promise<Response>} [opts.fetch]  custom fetch for the .wasm (e.g. to add credentials)
 * @returns {Promise<Runtime>}
 */
export async function loadWasmAv1(opts = {}) {
  const want = opts.variant ?? 'auto';
  const variant = want === 'auto' ? chooseVariant() : want;
  if (!variant) {
    throw new Error('wasm-av1: this engine supports neither the SIMD nor the baseline build');
  }
  if (variant === 'simd' && !detectSimd()) {
    throw new Error('wasm-av1: SIMD build requested but this engine has no wasm SIMD');
  }
  if (variant === 'baseline' && !detectBaseline()) {
    throw new Error('wasm-av1: this engine lacks the post-MVP wasm features the baseline build needs');
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
        return { variant, simd: mod.simdEnabled(), mod, wasm, version: mod.version() };
      })().catch((e) => {
        runtimes.delete(key);
        throw e;
      }),
    );
  }
  return runtimes.get(key);
}
