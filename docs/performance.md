# Performance: where it stands, and the rav1d baseline

## Where 0.3.0 stands

**0.3.0 is level with or ahead of 0.2.x on 8-bit 720p and 1080p video with
one tile per frame (0.87 of it on a synthetic test pattern, on one
thread), and behind it with threads on video encoded with several tiles.**
0.2.x decoded with rav1d; since 0.3.0 the decoder is rivet-av1. Measured on
2026-11-13 on one Apple silicon machine (Node 26 / V8, both cores built
the same way, `.wasm` without `wasm-opt`, the two taking turns in the same
run), frames per second.

One thread, SIMD variant, decode only (rivet-av1's own harness):

| stream, SIMD variant, one thread | rav1d (0.2.x) | rivet-av1 (0.3.0) | |
|---|---|---|---|
| SVT-AV1 mandelbrot + noise, 1280×720 | 154.1 | 178.9 | 1.16× |
| SVT-AV1 mandelbrot + noise, 1280×720, eight tiles | 153.9 | 186.0 | 1.21× |
| SVT-AV1 mandelbrot + noise, 1920×1080 | 80.1 | 89.7 | 1.12× |
| SVT-AV1 mandelbrot + noise, 1280×720 10-bit | 86.4 | 217.1 | 2.51× |
| SVT-AV1 testsrc2, 1280×720 | 323.6 | 283.0 | 0.87× |

The baseline variant is at 1.00 to 1.07 times rav1d on the mandelbrot
clips and 0.94 on testsrc2.

Threads, the SIMD + threads variant in Node through this package's build,
by the wall clock of the whole decode (three rounds of three timed
decodes, every MD5 the reference):

| SIMD + threads variant in Node | core | 1 thread | 2 | 4 | 8 |
|---|---|---|---|---|---|
| mandelbrot + noise 1280×720, one tile | rav1d | 146 | 269 | 376 | 496 (3.4×) |
| | rivet-av1 | 175 | 308 | 477 | 652 (3.7×) |
| mandelbrot + noise 1920×1080, one tile | rav1d | 76 | 137 | 198 | 267 (3.5×) |
| | rivet-av1 | 85 | 158 | 258 | 360 (4.2×) |
| mandelbrot + noise 1280×720, eight tiles | rav1d | 152 | 290 | 523 | 956 (6.3×) |
| | rivet-av1 | 178 | 286 | 380 | 372 (2.1×) |

With more than one thread rivet-av1 reconstructs and filters a one-tile
frame's superblock rows behind its parsing and decodes several frames at
once, so its frames come out a few temporal units after they went in
([features/variants-and-threading.md](features/variants-and-threading.md)).
A frame of several tiles is not part of that: its tiles are decoded in
parallel and its post-filters in bands, one frame at a time, which is why
the eight-tile clip stops gaining at four threads and ends at 0.39 of
rav1d's rate on eight.

In the browsers (Playwright's Chromium, Firefox and WebKit on the same
machine, `scripts/bench-browser.mjs`, 300 frames, decode in a Worker, the
same frame hash in every configuration):

| clip | engine | simd, 1 thread | simd-threads, 4 | 8 |
|---|---|---|---|---|
| mandelbrot + noise 1280×720 | Chromium | 168 fps | 404 | 595 |
| mandelbrot + noise 1920×1080 | Chromium | 89 | 230 | 292 |
| mandelbrot + noise 1280×720 | WebKit | 145 | 363 | 451 |
| mandelbrot + noise 1920×1080 | WebKit | 70 | 181 | 222 |
| mandelbrot + noise 1280×720 | Firefox | 14 | 44 | 62 |
| mandelbrot + noise 1920×1080 | Firefox | 7 | 22 | 32 |

Firefox's one-thread rate is what 0.2.x measured there with rav1d too (14
frames per second at 720p and 7 at 1080p in the table further down, on
another clip and machine): the engine, not the decoder. On eight threads
at 720p it is at 62 where rav1d reached 35.

So on that machine one thread decodes these 720p clips at 145 frames a
second or more in Chromium and WebKit and 1080p at 70 or more; a phone is
3 to 8 times slower, and threads now help on a one-tile stream as they
did with 0.2.x. A player can start where it did with 0.2.x and step up on
measurement ([integration.md](integration.md)). The full tables, the
method, the 2026-11-12 measurements this started from (a third to two
thirds of rav1d's rate on one thread, 1.2 to 1.3 times from eight threads)
and what is left are in [rivet-av1.md](rivet-av1.md). The rav1d numbers,
there and below, are the baseline it was measured against. The clips of
the rest of this file (Big Buck Bunny, Sintel) have not been measured with
rivet-av1, and neither has a phone.

What does not depend on the core is unchanged: the YUV → RGBA conversion
below, and the requirements and the Worker arrangement of the threads
builds.

## The rav1d baseline (0.2.x)

Everything from here on was measured with rav1d as the decoder, and the
decoder-side explanations describe rav1d. Single-thread numbers from
`scripts/bench.mjs` under Node 22 (V8, the same engine as Chrome), on an
x86-64 laptop, 2026-08-15/16; thread numbers from
`scripts/bench-browser.mjs` in Playwright's Chromium, Firefox and WebKit on
the same machine, 2026-08-16. Clips from `scripts/fetch-samples.sh` (Big Buck
Bunny and Sintel AV1, 30 fps, 10 s). Every configuration decoded to the
libdav1d MD5 (checked in the same run).

### Threads

The threads builds (`+atomics`, shared memory, std rebuilt) ran rav1d's own
frame + tile threading — dav1d's task pool, unchanged — with each thread a
Web Worker holding another instance of the module on the same memory. Decode
inside a Worker, frames consumed there, so this is decode alone:

| clip | engine | simd, 1 thread | 2 | 4 | 8 |
|---|---|---|---|---|---|
| BBB 1280×720 | Chromium | 8.5 ms/frame (118 fps), worst run 52 ms | 5.0 (199) | 4.0 (249), worst 27 | 3.8 (260) — 2.2× |
| BBB 1920×1080 | Chromium | 16.0 ms/frame (62 fps), worst 96 ms | 8.5 (118) | 4.5 (220), worst 38 | 3.0 (333), worst 26 — 5.3× |
| BBB 1280×720 | Firefox | 69.5 ms/frame (14 fps) | 41.2 (24) | 32.8 (30) | 28.2 (35) — 2.5× |
| BBB 1920×1080 | Firefox | 140.8 ms/frame (7 fps) | 73.9 (14) | 40.6 (25) | 25.4 (39) — 5.5× |
| BBB 1280×720 | WebKit | 11.2 ms/frame (90 fps) | 6.7 (150) | 5.4 (185) | — |

Read: near-linear to 4 threads at 1080p, and the *worst single run* — what
turns into a dropped frame — comes down with it (96 → 26 ms). 720p flattens
after 4 because the per-temporal-unit overhead (JS call, ring, hash) is a
larger share of a 4 ms frame. Firefox is 8× slower than V8 single-threaded
on these clips and scales the same way, which is what makes 1080p playable
there at all. On a phone the absolute numbers are 3–8× worse and the core
count is 4–8, so this is what makes 720p smooth where 480p stuttered.

Requirements: `SharedArrayBuffer`, i.e. a cross-origin-isolated page (COOP +
COEP on the document), Chrome 74+/Firefox 79+/Safari 15.2+; the decoder in a
Worker. `js/detect.js::detectThreads()` says whether the current context
qualifies; `loadWasmAv1({ threads: true })` then picks `simd-threads` /
`threads`, else falls back to `simd` / `baseline` — one code path either way.

How it was made, in the order the problems came up. Points 1 and 6 hold for
0.3.0 as they stand. Points 2 to 5 are rav1d's: rivet-av1 starts no
threads of its own on wasm and needs no `parking_lot`, and its side of
this is a pool of Workers behind `av1::parallel`
([features/variants-and-threading.md](features/variants-and-threading.md)).
What point 4 describes is true of 0.3.0 again, by other means: with more
than one thread rivet-av1 has several frames in flight, output is a few
temporal units late, and at the end of the input `Decoder::run` waits for
them (`Core::finish` in `src/core.rs`) before `finished` settles.

1. rustc no longer adds the shared-memory linker flags for `+atomics` on
   `wasm32-unknown-unknown` (only the wasip1-threads target spec has them):
   `--shared-memory --max-memory=1GiB --import-memory` and the `__tls_*` /
   `__wasm_init_tls` exports must be passed explicitly (`scripts/build.sh`,
   `THREADS_LINK`), and std must be rebuilt with atomics (`-Zbuild-std`,
   `rust-src`, `RUSTC_BOOTSTRAP=1` on the pinned stable — no nightly).
2. `std::thread::spawn` is unsupported on this target, so rav1d (fork commit
   `e051d04`) hands each worker body to an embedder-registered spawner and
   waits for its context on a condvar instead of `park`/`unpark` — a Worker
   starts asynchronously. `src/threads.rs` here is that spawner: box the
   body, give its address + `wasm_bindgen::module()` + `memory()` to JS
   (`globalThis.__wasmAv1SpawnThread`), and `pkg/thread-worker.js`
   instantiates the module on the shared memory and calls
   `__wasm_av1_thread_entry(ptr)`.
3. `parking_lot` (rav1d's mutexes/condvars) has its real wasm parker behind
   its `nightly` feature; without it the first wait panics ("unreachable"
   in every thread Worker at once). `Cargo.toml` enables it for the
   atomics builds only.
4. Frame threading delays output by up to n frame-threads: at end of input
   rav1d's `get_picture` needs to be called *again* after a TryAgain (its
   drain state) to wait for in-flight frames, and `finished` must not
   settle before that (`decoder.rs::drain_in_flight`, `needs_drain`).
   Without it the last two frames of every clip vanished.
5. A reset used to recreate the rav1d instance; with threads that respawns
   every Worker on every seek, so `reset_state` uses rav1d's `flush()` — which
   needed to also drop the wrapper's pending input (fork commit `6f780a0`) or
   `send_data` after a mid-TU flush asserted.
6. In Chromium a Worker created by another Worker only starts once the
   parent returns to its event loop — and the decode Worker blocks in
   `Atomics.wait` for exactly those threads right after asking for them.
   Firefox and WebKit start nested Workers independently. So a decode Worker
   never creates the thread Workers itself: it forwards the request to the
   page (`spawnThread` message, answered by `WorkerDecoder`), which is never
   blocked. That also covers Safari 15.2–16.3, which has no nested Workers.

### Decode, after the SIMD kernels

| clip | baseline | simd | speed-up |
|---|---|---|---|
| BBB 640×360 | 8.5 ms/frame (117 fps), p95 15.8 | 5.9 ms (170 fps), p95 14 | 1.44× |
| BBB 1280×720 | 24.0 ms/frame (42 fps), p95 49 | 9.0 ms (111 fps), p95 27 | 2.66× |
| BBB 1920×1080 | 43.2 ms/frame (23 fps), p95 96 | 16.7 ms (60 fps), p95 54 | 2.58× |
| Sintel 1920×818 | 33.1 ms/frame (30 fps), p95 121 | 18.2 ms (55 fps), p95 62 | 1.82× |

Firefox (SpiderMonkey) decodes the 320×180 fixture in ~4–5 ms/frame where
Chromium takes ~1 ms — about 4× slower — with the same correctness.

Read: with rav1d, single-threaded software AV1 in wasm was real-time at
1080p on a laptop and comfortable at 720p. An old phone is 3–8× slower than
this laptop, so a player should start the fallback on the 360p/480p rung and
step up on measurement (docs/integration.md).

## YUV → RGBA (the explicit simd128 path in `convert.rs`)

This crate's own code, the same in 0.3.0.

| clip | baseline | simd | speed-up |
|---|---|---|---|
| 640×360 | 0.68 ms/frame | 0.24 ms | 2.8× |
| 1280×720 | 2.68 ms/frame | 0.94 ms | 2.9× |
| 1920×1080 | 5.37 ms/frame | 2.07 ms | 2.6× |

Byte-identical output between the two (tested on every fixture, including
the odd-width tail path). With the WebGL renderer this cost is skipped
entirely — the planes go up as textures and the shader converts.

## How rav1d's decode speed-up was found and made

Before the kernels, `+simd128` alone gave 1.0–1.1×: rav1d's DSP fallbacks
are scalar loops that LLVM does not vectorise. `node --cpu-prof` on the SIMD
build decoding 300 frames of BBB 720p, self time:

```
before:  31.9% mc::warp_affine_8x8   16.1% mc::put_8tap   14.2% cdef::cdef_filter_block   5.3% loopfilter::loop_filter   4.3% msac …
         by module: mc 50%  cdef 14%  recon 7%  loopfilter 6%  msac 5.5%  itx 6%       (14.0 s sampled)
after:   15.8% mc::wasm::warp_affine_8x8   11.4% msac::decode_symbol_adapt   7.0% loopfilter::wasm::loop_filter
          5.9% mc::wasm::put_8tap   5.4% recon::decode_coefs   4.9% itx::inv_txfm_add   2.4% cdef::wasm            (5.5 s sampled)
```

The kernels lived in the rav1d fork (`safewords/rav1d`, `55c4d09`): MC 8-tap put/prep (H, V,
2-D), warp 8×8 (put and the compound `t` variant), CDEF filter block, loop
filter — 8 bpc, wired as early returns in the `_rust` functions under
`cfg(target_feature = "simd128")`, bit-exact by construction and by test.
One non-SIMD fix mattered as much as a kernel: the 2-D 8-tap path zeroed a
34 KB intermediate on every call; for an 8×8 block that memset outweighed
the filter.

## What was left in rav1d (in order of measured value)

Kept as a record of where a fast decoder's time goes; none of it is this
project's work any more. What is left for rivet-av1 is in
[rivet-av1.md](rivet-av1.md#closing-the-gap).

1. `msac::rav1d_msac_decode_symbol_adapt` — 11% now. dav1d has SSE2 for it
   (compute the ≤16 `v` candidates at once, count the prefix, adapt the CDF
   vector); ~2× on that function is plausible → ~5% overall.
2. `warp_affine_8x8` — 16%: a taps-transposed horizontal pass instead of
   per-pixel dot products would shave a third; content-dependent (BBB is
   unusually warp-heavy).
3. Inverse transforms (`itx`, ~10% together across sizes) — a large surface.
4. ~~Threads~~ — done, see above. What remains there: the 720p plateau
   (per-TU overhead) and letting rav1d use more frame threads than
   ceil(√n) for throughput at the cost of latency (`max_frame_delay`).

`wasm-opt -O3` is already applied.
