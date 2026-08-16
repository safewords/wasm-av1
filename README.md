# wasm-av1

AV1 decoding for the browser, in Rust: [rav1d] (the Rust port of dav1d)
compiled to WebAssembly, in a **baseline** and a **SIMD128** build, behind the
small streaming API that [GoogleChromeLabs/wasm-av1] put in front of libaom in
2018 — ported from C to Rust here. Containers (MP4, fragmented MP4 / CMAF,
WebM/MKV, MPEG-TS) are demuxed inside the same wasm by [rivet]'s
`rivet-container`, the org's own transcoder library.

Why: lewd.net serves AV1. Devices without an AV1 hardware decoder — the older
phones and laptops this is for — get a WebAssembly software decoder that the
browser JIT compiles to NEON/SSE where the SIMD build is used, instead of a
fallback rung in another codec.

**Nothing upstream is vendored.** rav1d and rivet-container are git
dependencies (`Cargo.lock` pins the revisions); upstream wasm-av1 checked all
of libaom into `third_party/`. rav1d comes from `safewords/rav1d` `main`
(upstream + libc-free build, a panic fix, and the wasm SIMD128 kernels — see
[docs/rav1d.md](docs/rav1d.md)); rivet-container from rivet `develop`
([docs/rivet.md](docs/rivet.md)). `pkg/` — the built `.wasm` + glue — is
committed so a git dependency (`github:safewords/wasm-av1#sha`) carries it;
`scripts/build.sh` regenerates it.

## What you get

```
pkg/baseline/wasm_av1_bg.wasm   post-MVP wasm            1.69 MB (604 KB gzip)   Chrome 96 / Firefox 89 / Safari 15
pkg/simd/wasm_av1_bg.wasm       + simd128 kernels        1.79 MB (634 KB gzip)   Chrome 91 / Firefox 89 / Safari 16.4
js/                             ESM wrapper: loader + feature detection, Decoder, WebGL/2D renderers, Worker, Av1Player, HlsAv1Video
```

(Without the `container` feature: 1.09 MB / 384 KB gzip and 1.19 MB / 413 KB.)

```js
import { loadWasmAv1, Decoder } from '@safewords/wasm-av1';

const rt  = await loadWasmAv1();          // picks simd or baseline for this browser
const dec = new Decoder(rt);
dec.setSource(bytes);                     // IVF, MP4/fMP4, WebM, TS — or setInitSegment()+pushSegment() for CMAF, or pushTemporalUnit(obus, pts)
dec.runUntilFull();                       // decode ahead (ring of 10 frames)
const frame = dec.nextFrame();            // planes in wasm memory: frame.plane(0..2), frame.planes[i].{offset,stride,width,height}
frame.rgba();                             // or RGBA8 (SIMD128 in the SIMD build)
```

Higher up, `Av1Player` (canvas, pacing by pts or by an external clock,
decode budget per animation frame, in-thread or in a Worker), the renderers —
WebGL uploads the planes and does YUV→RGB in the shader; 2D uses the wasm
RGBA conversion — and `HlsAv1Video`: HLS master/media playlists → CMAF init +
segments (demuxed by rivet inside the wasm, no decoder reset between
segments) → canvas, clocked by a `<video>` that plays the audio rendition.
That last one is the shape lewd-frontend needs (see `WASM_AV1_FALLBACK.md`
there). The demo page (`npm run serve`, then http://localhost:8080/demo/)
exercises the file paths.

## Consuming it

Releases (`v*` tags → `.github/workflows/release.yml`) publish public,
unauthenticated artefacts on the GitHub Release:

```json
"@safewords/wasm-av1": "https://github.com/safewords/wasm-av1/releases/download/v0.1.0/safewords-wasm-av1-0.1.0.tgz"
```

That tarball is `npm pack` of this package (`js/` + `pkg/`), so
`import { … } from '@safewords/wasm-av1'` works, and `pkg/` is there to copy
into your static assets (the `.wasm` must be served as files, not bundled —
pass `baseUrl` to `loadWasmAv1`/`Av1Player`/`HlsAv1Video`). For the Worker,
either let your bundler pick up `new Worker(new URL('./worker.js', import.meta.url))`
or — more predictably — serve `js/` statically too and pass
`workerUrl: '<baseUrl>js/worker.js'` (its imports are relative). `wasm-av1-pkg-<ver>.zip`
is `pkg/` alone for non-npm consumers. `github:safewords/wasm-av1#v0.1.0`
works too (the repo is public and `pkg/` is committed).

## Building

```bash
rustup target add wasm32-unknown-unknown            # rust-toolchain.toml pins 1.96
cargo install wasm-bindgen-cli --version 0.2.127 --locked   # must match Cargo.lock
scoop install binaryen   # or apt/brew — wasm-opt, optional (~15% smaller)
scripts/build.sh                                    # → pkg/baseline, pkg/simd, pkg/manifest.json
```

`FEATURES=bitdepth_8 scripts/build.sh` drops 10/12-bit support for a smaller
decoder; `FEATURES=bitdepth_8,bitdepth_16 scripts/build.sh` drops the container
demuxers.

## Testing — what runs, and what it proves

| Command | Proves |
|---|---|
| `cargo test --release` | Native: IVF parser, geometry, colour conversion against a float reference; every fixture in `testdata/` decodes to **the same MD5 libdav1d and libaom produce** (8-bit, 10-bit, 4:4:4, mono, film grain, odd 177×99); push mode ≡ IVF mode; MP4/fMP4/WebM via rivet ≡ IVF. |
| `cargo test --release --target wasm32-unknown-unknown --test wasm_convert` (± `RUSTFLAGS=-C target-feature=+simd128`) | Inside wasm, in Node: the RGBA dispatch equals the scalar path on 55 shape/matrix combinations — the SIMD build's v128 code included. |
| `node --test test/decode.test.mjs` (after `scripts/build.sh`) | The built `.wasm`, both variants, same MD5s through the wasm-bindgen surface (so the SIMD kernels are bit-exact too); SIMD and baseline RGBA **byte-identical**; container path; CMAF segments pushed one by one; ms/frame. |
| `node test/browser.mjs` (needs Playwright) | Headless Chromium + Firefox × {baseline, simd} × {WebGL, 2D} × {main thread, Worker} × {IVF, fMP4, MP4, WebM, HLS/CMAF via `HlsAv1Video`}: every frame shown, correctly paced, pixels on the canvas — 26 combinations. |
| `scripts/bench.mjs` | Decode speed on real 360p/720p/1080p clips (`scripts/fetch-samples.sh`), with libdav1d MD5 check. |

`scripts/make-fixtures.sh` regenerates `testdata/` with ffmpeg (libaom encode,
libdav1d + libaom decode for the reference MD5s — they must agree or it aborts).

## Performance (Node 22 / V8 = Chrome's engine, x86-64 laptop, single thread)

| clip | baseline decode | simd decode | speed-up | YUV→RGBA baseline → simd |
|---|---|---|---|---|
| BBB 640×360 | 8.5 ms/frame (117 fps) | 5.9 ms (170 fps) | 1.4× | 0.68 → 0.24 ms (2.8×) |
| BBB 1280×720 | 24.0 ms/frame (42 fps) | 9.0 ms (111 fps) | 2.7× | 2.7 → 0.9 ms (2.9×) |
| BBB 1920×1080 | 43.2 ms/frame (23 fps) | 16.7 ms (60 fps) | 2.6× | 5.4 → 2.1 ms (2.6×) |
| Sintel 1920×818 | 33.1 ms/frame (30 fps) | 18.2 ms (55 fps) | 1.8× | 4.1 → 1.6 ms (2.6×) |

The SIMD build carries wasm SIMD128 kernels for rav1d's hot 8-bit paths —
motion compensation (8-tap, warped), CDEF and the deblocking loop filter —
written for this project on the `safewords/rav1d` branch, bit-exact against
the scalar code. Firefox's wasm tier is ~4× slower than V8 on the same
machine (browser test's decode column). Profile, method and what is left are
in [docs/performance.md](docs/performance.md).

## Layout

```
src/ivf.rs        IVF reader (upstream init_avx / blob-api.c)
src/decoder.rs    run/next_frame/finished ring around rav1d (upstream AVX_Decoder_*), IVF / container / push sources
src/frame.rs      packed planes + geometry + colour metadata (upstream buffer_frame)
src/convert.rs    YUV→RGBA: scalar (any layout/depth) + wasm simd128 (8-bit 4:2:0), bit-identical
src/wasm.rs       the wasm-bindgen surface (upstream EXPORTED_FUNCTIONS)
js/               loader, detect, decoder, render, worker, player
examples/decode_ivf.rs   native CLI (upstream test.c) — MD5, frame dumps, PPM, timings
tests/, test/     native and Node tests;  test/browser.mjs the Playwright matrix
docs/             rav1d.md, rivet.md, performance.md, frontend-integration.md
```

Licence: Apache-2.0 (as upstream). See NOTICE for what is linked and under what.

[rav1d]: https://github.com/memorysafety/rav1d
[GoogleChromeLabs/wasm-av1]: https://github.com/GoogleChromeLabs/wasm-av1
[rivet]: https://github.com/rivet-transcoder/rivet
