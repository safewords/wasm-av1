# Performance: what was measured, and where the SIMD work actually is

All numbers from `scripts/bench.mjs` under Node 22 (V8, the same engine as
Chrome), one thread, on an x86-64 laptop, 2026-08-15. Clips from
`scripts/fetch-samples.sh` (Big Buck Bunny AV1, 30 fps, 10 s). Both variants
decode to the libdav1d MD5 (checked in the same run).

## Decode

| clip | baseline | simd | speed-up |
|---|---|---|---|
| 640×360 | 7.65 ms/frame (131 fps), p95 15.0, worst TU 39 ms | 7.62 ms (131 fps) | 1.00× |
| 1280×720 | 26.3 ms/frame (38 fps), p95 50, worst TU 144 ms | 28.2 ms (35 fps) | 0.93× |
| 1920×1080 | 48.7 ms/frame (21 fps), p95 101, worst TU 253 ms | 44.2 ms (23 fps) | 1.10× |

Firefox (SpiderMonkey) decodes the 320×180 fixture in ~5.3 ms/frame where
Chromium takes ~1.4 ms — about 4× slower — with the same correctness.

Read: single-threaded software AV1 in wasm is comfortably real-time at 360p
and 720p on a laptop, borderline at 1080p. An old phone is 3–8× slower than
this laptop, which is why the frontend plan (docs/frontend-integration.md)
picks a low rung for the wasm fallback.

## YUV → RGBA (the explicit simd128 path in `convert.rs`)

| clip | baseline | simd | speed-up |
|---|---|---|---|
| 640×360 | 0.614 ms/frame | 0.236 ms | 2.6× |
| 1280×720 | 3.02 ms/frame | 1.10 ms | 2.7× |
| 1920×1080 | 6.14 ms/frame | 2.13 ms | 2.9× |

Byte-identical output between the two (tested on every fixture, including
the odd-width tail path). With the WebGL renderer this cost is skipped
entirely — the planes go up as textures and the shader converts.

## Why `+simd128` barely moves decode — the profile

`node --cpu-prof` on the SIMD build decoding 300 frames of BBB 720p, self time:

```
31.9%  rav1d::mc::warp_affine_8x8_c_erased
16.1%  rav1d::mc::put_8tap_rust
14.2%  rav1d::cdef::cdef_filter_block_rust
 5.3%  rav1d::loopfilter::loop_filter
 4.3%  rav1d::msac::rav1d_msac_decode_symbol_adapt_rust
 2.8%  rav1d::recon::decode_coefs
 2.2%  rav1d::itx::inv_txfm_add
 …
by module:  mc 50%  cdef 14%  recon 7%  loopfilter 6%  msac 5.5%  refmvs 4%  itx 6%
```

Seventy percent of the time is in three DSP families — motion compensation
(8-tap subpel filters, warped motion), CDEF, and the deblocking loop filter.
On native targets rav1d dispatches those to dav1d's hand-written SIMD (SSE/AVX
on x86, NEON on ARM — the "up to 5× faster" the wasm-av1 article mentions); in
wasm there is no such kernel, so the `_rust` fallbacks run, and LLVM's
autovectoriser does little with them (their inner loops carry per-pixel
clamps, table lookups and data-dependent strides). `-C target-feature=+simd128`
therefore vectorises the odd loop, not the hot ones: 1.0–1.1×.

The RGBA conversion shows what explicit `v128` code buys on this hardware
model: 2.6–2.9× on a bandwidth-bound loop.

## SIMD phase 2 (not done; measured, scoped)

Write wasm simd128 kernels for rav1d's DSP dispatch tables, wired the way its
asm variants are, under
`#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]`, on the
`safewords/rav1d` branch, in this order of measured value:

1. `mc`: `put_8tap` / `prep_8tap` (all six filter combinations, 2-D
   separable, 8-bit first) and `warp_affine_8x8`. Half the time.
2. `cdef_filter_block` (4×4 / 8×8, direction + primary/secondary strength).
3. `loop_filter` (4/6/8/16-wide, H and V).
4. Then `itx` (inverse transforms) and `msac` decode_symbol_adapt (a 16-lane
   CDF update that maps onto `i16x8` pairs).

If those three families reach a 4× kernel speed-up — conservative against
dav1d's own numbers — overall decode is ~1/(0.30 + 0.70/4) ≈ **2.1× faster**:
720p at ~70 fps and 1080p at ~45 fps on this laptop, and on the ARM phones this
is for, the difference between 360p and 720p being playable. It is a
well-defined but real project (each family is a few hundred lines of
intrinsics plus tests against the `_rust` versions), and it belongs upstream
in rav1d if they will take portable-SIMD kernels; the fork branch is where it
starts either way.

Cheaper wins to try first, in order:
- `rav1d` features: build with `bitdepth_8` only for 8-bit content (smaller
  code, some hot paths lose a branch).
- `-C target-cpu`-style tuning does not exist for wasm; but `wasm-opt -O3` is
  already applied and worth ~15% size, ~0% speed.
- Threads: `wasm32` atomics + a worker pool would let rav1d frame/tile
  threading run, roughly N× on N cores — but needs COOP/COEP headers on
  lewd.net and rav1d's thread paths compiled for wasm; a bigger step than the
  kernels and it multiplies with them rather than replacing them.
