// Feature detection for picking a wasm variant.
//
// WebAssembly has no runtime feature query: a module using an unsupported
// instruction fails to *validate*. So we validate a tiny module that contains
// exactly one v128 instruction and see whether the engine accepts it — the
// approach used by GoogleChromeLabs/wasm-feature-detect, inlined so there is
// no dependency.

let simdCache;

/** True if this engine can instantiate wasm that uses SIMD128. */
export function detectSimd() {
  if (simdCache === undefined) {
    try {
      // (module (func (result v128) i32.const 0 i8x16.splat i8x16.popcnt))
      simdCache = WebAssembly.validate(
        new Uint8Array([
          0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
        ]),
      );
    } catch {
      simdCache = false;
    }
  }
  return simdCache;
}

/**
 * True if the baseline build can run at all: it needs the post-MVP features
 * rustc enables by default for wasm32 (bulk memory, sign extension, mutable
 * globals, non-trapping float→int, reference types, multi-value). This probe
 * uses one instruction from each of bulk-memory, sign-ext, reference types,
 * non-trapping float→int and multi-value (Chrome ≥ 96, Firefox ≥ 89, Safari ≥ 15).
 */
export function detectBaseline() {
  try {
    // Assembled with binaryen's wasm-as from:
    //   (module (memory 1)
    //     (func (param i32) local.get 0 i32.extend8_s drop i32.const 0 i32.const 0 i32.const 0 memory.fill)
    //     (func (result externref) ref.null extern)
    //     (func (param f32) (result i32) local.get 0 i32.trunc_sat_f32_s)
    //     (func (result i32 i32) i32.const 1 i32.const 2))
    return WebAssembly.validate(
      new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 19, 4, 96, 1, 127, 0, 96, 0, 1, 111, 96, 1, 125, 1, 127, 96, 0, 2, 127, 127, 3, 5,
        4, 0, 1, 2, 3, 5, 3, 1, 0, 1, 10, 36, 4, 15, 0, 32, 0, 192, 26, 65, 0, 65, 0, 65, 0, 252, 11, 0, 11, 4, 0, 208,
        111, 11, 6, 0, 32, 0, 252, 0, 11, 6, 0, 65, 1, 65, 2, 11,
      ]),
    );
  } catch {
    return false;
  }
}

/** Which variant `loadWasmAv1({ variant: 'auto' })` would choose, or null if none can run. */
export function chooseVariant() {
  if (detectSimd()) return 'simd';
  if (detectBaseline()) return 'baseline';
  return null;
}
