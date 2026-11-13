# wasm-av1

AV1 decoding for the browser, in Rust: [rivet-av1] (rivet's own AV1 decoder,
written from the specification) compiled to WebAssembly, in **baseline**,
**SIMD128** and **threads** builds (the decoder's threads as Web Workers on
shared memory), behind the small streaming API
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
it is rivet-av1 and nothing else, and it is level with or ahead of rav1d on
the video most sites serve. As measured on 2026-11-13: on one thread, 1.0 to
1.2 times rav1d's rate on 8-bit 720p and 1080p video in both the SIMD and
the baseline build, 2.5 times on 10-bit in the SIMD build, and 0.87 on a
synthetic test pattern. With threads, on streams with one tile per frame
(which is most video), 1.3 times rav1d's rate on four and on eight threads:
it decodes several frames at once, as rav1d did. On a stream encoded with
eight tiles it is behind with threads (0.39 of rav1d's rate on eight),
because frames of several tiles are still decoded one at a time. The output
is bit-exact. The numbers, with rav1d kept as the baseline, are under
[Performance](#performance) and in [docs/rivet-av1.md](docs/rivet-av1.md).

**Nothing upstream is vendored.** rivet-av1 and rivet-container are git
dependencies, two packages of rivet `main` (`Cargo.lock` pins the
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
pkg/baseline/wasm_av1_bg.wasm      post-MVP wasm                     2.87 MB (994 KB gzip)   Chrome 96 / Firefox 89 / Safari 15
pkg/simd/wasm_av1_bg.wasm          + simd128 kernels                 3.43 MB (1.13 MB gzip)  Chrome 91 / Firefox 89 / Safari 16.4
pkg/threads/wasm_av1_bg.wasm       baseline + atomics/shared memory  2.92 MB (1.00 MB gzip)  + cross-origin isolation (Safari 15.2)
pkg/simd-threads/wasm_av1_bg.wasm  simd + atomics/shared memory      3.48 MB (1.15 MB gzip)  + cross-origin isolation
pkg/thread-worker.js               the Worker each decoder thread runs in
js/                                ESM wrapper: loader + feature detection, Decoder, WebGL/2D renderers, Worker, Av1Player, HlsAv1Video
```

Those sizes are CI's build of 0.3.0 with `wasm-opt -O3` (2026-11-12), which
is what `pkg/` holds. The same CI built the last rav1d commit that day at
3.30 MB baseline and 3.70 MB SIMD, so the change of decoder made each variant
7 to 13% smaller (the speed work's kernels added back about 30 KB to the
SIMD builds). The 0.2.2 package was smaller still (1.70 MB baseline,
606 KB gzip) because it was built in August, before the rivet-container
update of 2026-11-06 that most of each file now is: without the `container`
feature a local build without `wasm-opt` is 681 KB baseline (268 KB gzip)
and 871 KB SIMD (314 KB gzip).

The threads builds give the decoder a pool of Web Workers on the same shared
memory. A frame of one tile is parsed on one thread while the others
reconstruct and filter its rows behind the parsing, and up to eight frames
are decoded at once; a frame of several tiles has its tiles decoded in
parallel and its filters run in bands. With more than one thread a frame
therefore comes out a few temporal units after its data went in, or when
the input ends (`unitsInFlight` says how many are still to come); with one
thread there is no delay. They need `SharedArrayBuffer`, i.e. a **cross-origin-isolated
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

The threads variants also go through `tools/wasm-copy-guard`, which the
script builds with cargo: in WebKit, a Worker's `memory.copy` and
`memory.fill` trap on shared memory that another Worker grew, and the pass
routes them around that ([docs/features/variants-and-threading.md](docs/features/variants-and-threading.md)).

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
| `node --test test/copy-guard.test.mjs` | `tools/wasm-copy-guard`, the post-link pass the threads builds get for WebKit: every `memory.copy`/`memory.fill` becomes a call, and both paths of its helpers behave as memmove/memset and still trap out of bounds. |
| `node test/browser.mjs` (needs Playwright — `PLAYWRIGHT_DIR` or a local install) | Headless Chromium + Firefox + WebKit × {baseline, simd, threads, simd-threads} × {WebGL, 2D} × {main thread, Worker} × {IVF, fMP4, MP4, WebM, HLS/CMAF via `HlsAv1Video`}: every frame shown, correctly paced, pixels on the canvas, the thread count that ran: 21 combinations per engine, on a cross-origin-isolated harness page. And per engine a live stream on four threads, pushed unit by unit with no end of stream: every frame arrives, though the last are still being decoded when the input runs out. |
| `node scripts/bench-browser.mjs` | Decode speed per thread count in the real engines, same frame hash in every configuration. |
| `scripts/bench.mjs` | Decode speed on real 360p/720p/1080p clips (`scripts/fetch-samples.sh`), with libdav1d MD5 check. |

`scripts/make-fixtures.sh` regenerates `testdata/` with ffmpeg (libaom encode,
libdav1d + libaom decode for the reference MD5s — they must agree or it aborts).

## Performance

Measured on 2026-11-13 on one Apple silicon laptop (Node 26 / V8, `.wasm`
without `wasm-opt`), with the rav1d build of 0.2.x beside it, built the same
way and taking turns with it in the same run. rav1d is no longer in this
project; its column is the baseline the performance work in rivet-av1 is
measured against. Frames per second, one thread, decode only (median of 7).
"first" is rivet-av1 as 0.3.0 first built it (`3c2c549`); "now" is the
revision `Cargo.lock` pins (`c753ea1`: the loop filter, inter prediction and
the residual path, each rewritten from the specification's processes; the
pinned revision is now `03054ad`, whose one-thread rate is within about 1 % of it):

| stream | baseline: rav1d | first | now | SIMD: rav1d | first | now |
|---|---|---|---|---|---|---|
| SVT-AV1 mandelbrot + noise, 1280×720 | 69.1 | 31.4 | 73.3 (1.06×) | 154.1 | 64.3 | 178.9 (1.16×) |
| SVT-AV1 mandelbrot + noise, 1280×720, eight tiles | 66.5 | 31.1 | 71.0 (1.07×) | 153.9 | 64.0 | 186.0 (1.21×) |
| SVT-AV1 mandelbrot + noise, 1920×1080 | 34.1 | 16.0 | 34.1 (1.00×) | 80.1 | 33.4 | 89.7 (1.12×) |
| SVT-AV1 mandelbrot + noise, 1280×720 10-bit | 78.6 | 37.4 | 80.7 (1.03×) | 86.4 | 81.0 | 217.1 (2.51×) |
| SVT-AV1 testsrc2, 1280×720 | 188.0 | 63.1 | 177.0 (0.94×) | 323.6 | 114.4 | 283.0 (0.87×) |

These were measured in rivet-av1's own harness, not re-measured through this
package, with another benchmark running on the machine (good to a few
percent); its `docs/wasm-performance.md` has the fourteen-stream tables for
each piece of work, the native numbers and what each change bought.

Threads, the SIMD + threads build in Node (each wasm thread a Worker on the
shared memory), frames per second by the wall clock of the whole decode.
Measured on 2026-11-13 through this package's build of rivet-av1 `03054ad`,
the rav1d build taking turns with it (median of three rounds of three
decodes):

| clip | core | 1 thread | 2 | 4 | 8 |
|---|---|---|---|---|---|
| mandelbrot + noise 1280×720, one tile | rav1d | 146 | 269 | 376 | 496 (3.4×) |
| | rivet-av1 | 175 | 308 | 477 | 652 (3.7×) |
| mandelbrot + noise 1920×1080, one tile | rav1d | 76 | 137 | 198 | 267 (3.5×) |
| | rivet-av1 | 85 | 158 | 258 | 360 (4.2×) |
| mandelbrot + noise 1280×720, eight tiles | rav1d | 152 | 290 | 523 | 956 (6.3×) |
| | rivet-av1 | 178 | 286 | 380 | 372 (2.1×) |

On a stream with one tile per frame rivet-av1 is 1.27 to 1.35 times rav1d's
rate on four and eight threads. On the eight-tile clip it is at 0.39 of it
on eight threads: frames of several tiles do not go through the engine that
decodes several frames at once, and that is what is left to do in
rivet-av1. As 0.3.0 was first built (2026-11-12) these rows read 60 / 69 /
74 / 78, 32 / 36 / 32 / 42 and 63 / 112 / 174 / 210.

In the browsers (Playwright's builds on the same laptop,
`scripts/bench-browser.mjs`, 300 frames decoded in a Worker, the same frame
hash in every configuration), frames per second on 1 / 4 / 8 threads:

| clip | Chromium | WebKit | Firefox |
|---|---|---|---|
| mandelbrot + noise 1280×720 | 168 / 404 / 595 | 145 / 363 / 451 | 14 / 44 / 62 |
| mandelbrot + noise 1920×1080 | 89 / 230 / 292 | 70 / 181 / 222 | 7 / 22 / 32 |

Firefox's engine runs this decoder at about a twelfth of V8's rate on one
thread. It did the same with rav1d: 0.2.x measured 14 and 7 frames per
second on one thread at 720p and 1080p there, on another clip and machine
([docs/performance.md](docs/performance.md)).

Not measured with rivet-av1: the Big Buck Bunny and Sintel clips of
[docs/performance.md](docs/performance.md), which holds the 0.2.x
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
