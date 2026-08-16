# Performance: what was measured, what was done about it, what is left

All numbers from `scripts/bench.mjs` under Node 22 (V8, the same engine as
Chrome), one thread, on an x86-64 laptop, 2026-08-15/16. Clips from
`scripts/fetch-samples.sh` (Big Buck Bunny and Sintel AV1, 30 fps, 10 s).
Both variants decode to the libdav1d MD5 (checked in the same run).

## Decode, after the SIMD kernels

| clip | baseline | simd | speed-up |
|---|---|---|---|
| BBB 640×360 | 8.5 ms/frame (117 fps), p95 15.8 | 5.9 ms (170 fps), p95 14 | 1.44× |
| BBB 1280×720 | 24.0 ms/frame (42 fps), p95 49 | 9.0 ms (111 fps), p95 27 | 2.66× |
| BBB 1920×1080 | 43.2 ms/frame (23 fps), p95 96 | 16.7 ms (60 fps), p95 54 | 2.58× |
| Sintel 1920×818 | 33.1 ms/frame (30 fps), p95 121 | 18.2 ms (55 fps), p95 62 | 1.82× |

Firefox (SpiderMonkey) decodes the 320×180 fixture in ~4–5 ms/frame where
Chromium takes ~1 ms — about 4× slower — with the same correctness.

Read: single-threaded software AV1 in wasm is now real-time at 1080p on a
laptop and comfortable at 720p. An old phone is 3–8× slower than this laptop,
so the frontend plan (docs/frontend-integration.md) starts the fallback on
the 360p/480p rung and steps up on measurement.

## YUV → RGBA (the explicit simd128 path in `convert.rs`)

| clip | baseline | simd | speed-up |
|---|---|---|---|
| 640×360 | 0.68 ms/frame | 0.24 ms | 2.8× |
| 1280×720 | 2.68 ms/frame | 0.94 ms | 2.9× |
| 1920×1080 | 5.37 ms/frame | 2.07 ms | 2.6× |

Byte-identical output between the two (tested on every fixture, including
the odd-width tail path). With the WebGL renderer this cost is skipped
entirely — the planes go up as textures and the shader converts.

## How the decode speed-up was found and made

Before the kernels, `+simd128` alone gave 1.0–1.1×: rav1d's DSP fallbacks
are scalar loops that LLVM does not vectorise. `node --cpu-prof` on the SIMD
build decoding 300 frames of BBB 720p, self time:

```
before:  31.9% mc::warp_affine_8x8   16.1% mc::put_8tap   14.2% cdef::cdef_filter_block   5.3% loopfilter::loop_filter   4.3% msac …
         by module: mc 50%  cdef 14%  recon 7%  loopfilter 6%  msac 5.5%  itx 6%       (14.0 s sampled)
after:   15.8% mc::wasm::warp_affine_8x8   11.4% msac::decode_symbol_adapt   7.0% loopfilter::wasm::loop_filter
          5.9% mc::wasm::put_8tap   5.4% recon::decode_coefs   4.9% itx::inv_txfm_add   2.4% cdef::wasm            (5.5 s sampled)
```

The kernels live in the rav1d fork (docs/rav1d.md): MC 8-tap put/prep (H, V,
2-D), warp 8×8 (put and the compound `t` variant), CDEF filter block, loop
filter — 8 bpc, wired as early returns in the `_rust` functions under
`cfg(target_feature = "simd128")`, bit-exact by construction and by test.
One non-SIMD fix mattered as much as a kernel: the 2-D 8-tap path zeroed a
34 KB intermediate on every call; for an 8×8 block that memset outweighed
the filter.

## What is left (in order of measured value)

1. `msac::rav1d_msac_decode_symbol_adapt` — 11% now. dav1d has SSE2 for it
   (compute the ≤16 `v` candidates at once, count the prefix, adapt the CDF
   vector); ~2× on that function is plausible → ~5% overall.
2. `warp_affine_8x8` — 16%: a taps-transposed horizontal pass instead of
   per-pixel dot products would shave a third; content-dependent (BBB is
   unusually warp-heavy).
3. Inverse transforms (`itx`, ~10% together across sizes) — a large surface.
4. Threads: wasm atomics + a worker pool for rav1d's frame/tile threading —
   roughly N× on N cores, multiplies with the above. Needs COOP/COEP on the
   serving origin and rav1d's thread paths compiled for wasm; the biggest step
   and the one to take once the single-thread build is deployed.

Cheap knobs: `bitdepth_8` only (smaller code) if every stream is 8-bit;
`wasm-opt -O3` is already applied.
