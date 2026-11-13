# wasm-av1

AV1 decoding for the browser, in Rust: [rivet-av1] (rivet's own AV1 decoder,
written from the specification) compiled to WebAssembly, in **baseline**,
**SIMD128** and **threads** builds (the decoder's tile and post-filter
threads as Web Workers on shared memory), behind the small streaming API
that [GoogleChromeLabs/wasm-av1] put in front of libaom in 2018 — ported
from C to Rust here. Containers (MP4, fragmented MP4 / CMAF, WebM/MKV,
MPEG-TS) are demuxed inside the same wasm by [rivet]'s `rivet-container`
crate.

Why: a site that serves AV1 wants it to play everywhere. Devices without an
AV1 decoder — older phones and laptops, and Safari before AV1 hardware — get
a WebAssembly software decoder that the browser JIT compiles to NEON/SSE
where the SIMD build is used, and that spreads over the cores where the page
allows threads, instead of a fallback rung in another codec.

**How fast it is, plainly.** Up to 0.2.2 the decoder was rav1d. Since 0.3.0
it is rivet-av1 and nothing else, and it is slower: as measured on
2026-11-12, rivet-av1 in wasm decodes 8-bit video at roughly a third to two
thirds of rav1d's single-thread rate (10-bit comes close in the SIMD build),
and it scales poorly with threads — 1.2 to 1.3 times on eight for a stream
with one tile per frame, where rav1d reached about 3.5. The output is
bit-exact. The performance work is under way in rivet-av1; the numbers, with
rav1d kept as the baseline that work is measured against, are under
[Performance](#performance) and in [docs/rivet-av1.md](docs/rivet-av1.md).

**Nothing upstream is vendored.** rivet-av1 and rivet-container are git
dependencies, two packages of rivet `develop` (`Cargo.lock` pins the
revision; [docs/rivet-av1.md](docs/rivet-av1.md),
[docs/rivet.md](docs/rivet.md)); upstream wasm-av1 checked all of libaom
into `third_party/`. `pkg/` — the built `.wasm` + glue — is committed so a
git dependency (`github:safewords/wasm-av1#sha`) carries it;
`scripts/build.sh` regenerates it.

**Feature docs:** [`docs/features/README.md`](docs/features/README.md) — each
component as the code has it, with `path:line` references, and the known
defects.

**Changelog:** [`CHANGELOG.md`](CHANGELOG.md) — every release, newest first.

## What you get

```
pkg/baseline/wasm_av1_bg.wasm      post-MVP wasm                     3.03 MB (964 KB gzip)   Chrome 96 / Firefox 89 / Safari 15
pkg/simd/wasm_av1_bg.wasm          + simd128 kernels                 3.47 MB (1.10 MB gzip)  Chrome 91 / Firefox 89 / Safari 16.4
pkg/threads/wasm_av1_bg.wasm       baseline + atomics/shared memory  3.07 MB                 + cross-origin isolation (Safari 15.2)
pkg/simd-threads/wasm_av1_bg.wasm  simd + atomics/shared memory      3.52 MB                 + cross-origin isolation
pkg/thread-worker.js               the Worker each decoder thread runs in
js/                                ESM wrapper: loader + feature detection, Decoder, WebGL/2D renderers, Worker, Av1Player, HlsAv1Video
```

Those sizes are a local build of 0.3.0 **without `wasm-opt`** (2026-11-12).
CI runs `wasm-opt`, which about halved the rav1d builds (0.2.2 shipped
1.70 MB baseline, 606 KB gzip, from 3.50 MB), and CI has not built 0.3.0
yet. Most of each file is the demuxers: without the `container` feature the
baseline build is 681 KB (268 KB gzip) and the SIMD build 871 KB (314 KB
gzip), again without `wasm-opt`.

The threads builds give the decoder a pool of Web Workers on the same shared
memory: it decodes the tiles of a frame in parallel and runs the loop
filter, CDEF and loop restoration in bands; frames are decoded one after
another. They need `SharedArrayBuffer`, i.e. a **cross-origin-isolated
page** (`Cross-Origin-Opener-Policy: same-origin` +
`Cross-Origin-Embedder-Policy: require-corp` on the document), and the
decoder in a Worker (it blocks its calling thread while the others work).
`loadWasmAv1({ threads: true })` picks one when `detectThreads()` says the
page can; `Av1Player`/`HlsAv1Video` take `{ worker: true, threads: 'auto' }`
and report `stats.threads`. What threads buy depends on the stream's
tiling, see [Performance](#performance).

```js
import { loadWasmAv1, Decoder } from '@safewords/wasm-av1';

const rt  = await loadWasmAv1();          // picks simd or baseline for this browser ({ threads: true } for a threads build, from a Worker)
const dec = new Decoder(rt);
dec.setSource(bytes);                     // IVF, MP4/fMP4, WebM, TS — or setInitSegment()+pushSegment() for CMAF, or pushTemporalUnit(obus, pts)
dec.runUntilFull();                       // decode ahead (ring of 10 frames)
const frame = dec.nextFrame();            // planes in wasm memory: frame.plane(0..2), frame.planes[i].{offset,stride,width,height}
frame.rgba();                             // or RGBA8 (SIMD128 in the SIMD build)
```

Higher up, `Av1Player` (canvas, pacing by pts or by an external clock,
decode budget per animation frame, in-thread or in a Worker, stutter stats:
late frames and stalls), the renderers — WebGL uploads the planes and does
YUV→RGB in the shader; 2D uses the wasm RGBA conversion — and `HlsAv1Video`:
HLS master/media playlists → CMAF init + segments (demuxed by rivet inside
the wasm, no decoder reset between segments) → canvas, clocked by a `<video>`
that plays the audio rendition, with a bandwidth estimate from its own
downloads and rung switches that take effect at the next segment boundary
without a gap.
That last one is the shape a site with an existing HLS player needs — see
[docs/integration.md](docs/integration.md) for the decision, the pipeline,
rung selection, threads/isolation headers and serving. The demo page
(`npm run serve`, then http://localhost:8080/demo/) exercises the file paths.

## Consuming it

```bash
npm install @safewords/wasm-av1
```

The package is `js/` (the ESM API) + `pkg/` (the built `.wasm` variants and
their glue) + `docs/`. `pkg/` must be served as static files, not bundled —
copy it into your assets and pass `baseUrl` to
`loadWasmAv1`/`Av1Player`/`HlsAv1Video`. For the Worker, either let your
bundler pick up `new Worker(new URL('./worker.js', import.meta.url))` or —
more predictably — serve `js/` statically too and pass
`workerUrl: '<baseUrl>js/worker.js'` (its imports are relative).

Every `v*` tag is built, tested and published by `.github/workflows/release.yml`:
to npm (with provenance), and on the GitHub Release as public, unauthenticated
artefacts for consumers without a registry —
`safewords-wasm-av1-<ver>.tgz` (the same `npm pack`, installable by URL:
`"@safewords/wasm-av1": "https://github.com/safewords/wasm-av1/releases/download/v<ver>/safewords-wasm-av1-<ver>.tgz"`),
`wasm-av1-pkg-<ver>.zip` (`pkg/` alone) and `SHA256SUMS`.
`github:safewords/wasm-av1#v<ver>` works too (the repo is public and `pkg/`
is committed).

## Building

```bash
rustup target add wasm32-unknown-unknown            # rust-toolchain.toml pins 1.100.0
cargo install wasm-bindgen-cli --version 0.2.130 --locked   # must match Cargo.lock
scoop install binaryen   # or apt/brew — wasm-opt, optional (~15% smaller)
scripts/build.sh                                    # → pkg/{baseline,simd,threads,simd-threads}, pkg/thread-worker.js, pkg/manifest.json
```

`FEATURES= scripts/build.sh` (`FEATURES` set to nothing) builds without the
default features, that is without the container demuxers: IVF and raw
temporal units only, and under a quarter of the size. The crate has one Cargo
feature, `container`; the decoder has none (every build decodes 8, 10 and
12 bits).

Commit a `pkg/` only from CI's build (it pins `wasm-opt`); after a local
build, `git checkout -- pkg`. On macOS the script needs a GNU `sed` and
`stat` and a newer shell than `/bin/bash`
([docs/features/build-and-release.md](docs/features/build-and-release.md)).

## Testing — what runs, and what it proves

| Command | Proves |
|---|---|
| `cargo test --release` (and `--no-default-features`) | Native: IVF parser, geometry, colour conversion against a float reference; every fixture in `testdata/` decodes to **the same MD5 libdav1d and libaom produce** (8-bit, 10-bit, 4:4:4, mono, film grain, odd 177×99) on 1, 2 and 4 threads; film grain left out on request; push mode ≡ IVF mode; MP4/fMP4/WebM via rivet ≡ IVF. |
| `cargo test --release --target wasm32-unknown-unknown --test wasm_convert` (± `RUSTFLAGS=-C target-feature=+simd128`) | Inside wasm, in Node: the RGBA dispatch equals the scalar path on 55 shape/matrix combinations — the SIMD build's v128 code included. |
| `node --test test/decode.test.mjs` (after `scripts/build.sh`) | The built `.wasm`, all four variants, same MD5s through the wasm-bindgen surface (so the SIMD kernels are bit-exact too); the two threads builds on 1, 2, 4 and 8 threads, each wasm thread a `worker_threads` Worker on the shared memory; `applyGrain: false`; SIMD and baseline RGBA **byte-identical**; container path; CMAF segments pushed one by one; ms/frame. |
| `node test/browser.mjs` (needs Playwright — `PLAYWRIGHT_DIR` or a local install) | Headless Chromium + Firefox + WebKit × {baseline, simd, threads, simd-threads} × {WebGL, 2D} × {main thread, Worker} × {IVF, fMP4, MP4, WebM, HLS/CMAF via `HlsAv1Video`}: every frame shown, correctly paced, pixels on the canvas, the thread count that ran — 54 combinations, on a cross-origin-isolated harness page. |
| `node scripts/bench-browser.mjs` | Decode speed per thread count in the real engines, same frame hash in every configuration. |
| `scripts/bench.mjs` | Decode speed on real 360p/720p/1080p clips (`scripts/fetch-samples.sh`), with libdav1d MD5 check. |

`scripts/make-fixtures.sh` regenerates `testdata/` with ffmpeg (libaom encode,
libdav1d + libaom decode for the reference MD5s — they must agree or it aborts).

## Performance

Measured on 2026-11-12 on one Apple silicon laptop (Node 26 / V8, `.wasm`
without `wasm-opt`), with the rav1d build of 0.2.x beside it, built the same
way. rav1d is no longer in this project; its column is the baseline the
performance work in rivet-av1 is measured against. Frames per second, one
thread, decode only (median of 7):

| stream | baseline: rav1d | rivet-av1 (0.3.0) | SIMD: rav1d | rivet-av1 (0.3.0) |
|---|---|---|---|---|
| fixture 320×180, 8-bit | 1163 | 576 (0.50×) | 1703 | 839 (0.49×) |
| AOM `av1-1-b8-00-quantizer-20`, 352×288 | 188 | 101 (0.54×) | 281 | 176 (0.63×) |
| AOM `av1-1-b10-00-quantizer-10`, 352×288 10-bit | 70.9 | 37.8 (0.53×) | 72.9 | 62.9 (0.86×) |
| SVT-AV1 testsrc2, 1280×720 | 175 | 58.1 (0.33×) | 296 | 107 (0.36×) |
| SVT-AV1 mandelbrot + noise, 1280×720 | 65.0 | 29.7 (0.46×) | 145 | 60.8 (0.42×) |
| SVT-AV1 mandelbrot + noise, 1280×720 10-bit | 73.4 | 36.2 (0.49×) | 80.4 | 77.8 (0.97×) |
| SVT-AV1 mandelbrot + noise, 1920×1080 | 31.8 | 15.1 (0.47×) | 73.8 | 31.5 (0.43×) |

Threads, the SIMD + threads build in Node (each wasm thread a Worker on the
shared memory), frames per second:

| clip | core | 1 thread | 2 | 4 | 8 |
|---|---|---|---|---|---|
| mandelbrot + noise 1280×720, one tile | rav1d | 141 | 256 | 375 | 497 (3.5×) |
| | rivet-av1 (0.3.0) | 60.1 | 68.7 | 73.7 | 77.9 (1.3×) |
| mandelbrot + noise 1920×1080, one tile | rav1d | 73.9 | 132 | 197 | 265 (3.6×) |
| | rivet-av1 (0.3.0) | 31.5 | 36.2 | 31.7 | 42.3 (1.3×) |
| mandelbrot + noise 1280×720, eight tiles | rav1d | 151 | 290 | 530 | 954 (6.3×) |
| | rivet-av1 (0.3.0) | 62.8 | 112 | 174 | 210 (3.3×) |

Read: 0.3.0 decodes 8-bit video at a third to two thirds of the rate 0.2.x
did, and where 0.2.x multiplied that by about 3.5 on eight threads, 0.3.0
gains 1.3 unless the stream was encoded with several tiles. rivet-av1
threads the tiles and the post-filters of one frame; rav1d threaded frames,
and had SIMD kernels for 8-bit motion compensation and the loop filter that
rivet-av1 does not have for wasm yet. Closing that is work in rivet-av1,
under way; this crate takes it with `cargo update -p rivet-av1`. The whole
table (fourteen streams, native too), the method, the profile and what the
work consists of are in [docs/rivet-av1.md](docs/rivet-av1.md).

Not measured with rivet-av1: the browsers, and the Big Buck Bunny and Sintel
clips of [docs/performance.md](docs/performance.md), which holds the 0.2.x
measurements (rav1d: 1080p at 62 fps on one thread and 333 on eight in Chromium,
on an x86-64 laptop). The YUV→RGBA conversion is this crate's own
and unchanged: 2.6 to 2.9 times faster in the SIMD build, byte-identical.

## Layout

```
src/ivf.rs        IVF reader (upstream init_avx / blob-api.c)
src/decoder.rs    run/next_frame/finished ring around the decoder core (upstream AVX_Decoder_*), IVF / container / push sources
src/core.rs       the core: rivet-av1 behind four calls (open, flush, send, picture)
src/frame.rs      packed planes + geometry + colour metadata (upstream buffer_frame)
src/convert.rs    YUV→RGBA: scalar (any layout/depth) + wasm simd128 (8-bit 4:2:0), bit-identical
src/wasm.rs       the wasm-bindgen surface (upstream EXPORTED_FUNCTIONS)
src/threads.rs    the threads builds: a pool of Workers that runs rivet-av1's parallel jobs
js/               loader, detect, decoder, render, worker, player, hls, thread-worker
examples/decode_ivf.rs   native CLI (upstream test.c) — MD5, frame dumps, PPM, timings
tests/, test/     native and Node tests (test/threads-node.mjs: a threads build on real threads in Node);  test/browser.mjs the Playwright matrix (Chromium, Firefox, WebKit)
scripts/          build.sh, bench.mjs (Node), bench-browser.mjs (threads, in the browsers), serve.mjs
docs/             rivet-av1.md, rivet.md, performance.md, integration.md, features/
```

Licence: this repository's own code is Apache-2.0 (as upstream). The
decoder and the demuxers it is built with, rivet-av1 and rivet-container,
are under the Open Encoding Attribution License 1.0, which is
source-available and not open source: every `.wasm` built here, `pkg/` and
the npm package included, contains them, so distributing one means carrying
that licence and its notices along, and commercial use that reaches third
parties owes a short visible credit. See NOTICE.

[rivet-av1]: https://github.com/safewords/rivet-av1
[GoogleChromeLabs/wasm-av1]: https://github.com/GoogleChromeLabs/wasm-av1
[rivet]: https://github.com/rivet-transcoder/rivet
