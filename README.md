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
of libaom into `third_party/`. Two small patches are needed on our side and
live as branches meant to go upstream — see [docs/rav1d.md](docs/rav1d.md)
and [docs/rivet.md](docs/rivet.md).

## What you get

```
pkg/baseline/wasm_av1_bg.wasm   post-MVP wasm            1.69 MB (604 KB gzip)   Chrome 96 / Firefox 89 / Safari 15
pkg/simd/wasm_av1_bg.wasm       + simd128                1.78 MB (631 KB gzip)   Chrome 91 / Firefox 89 / Safari 16.4
js/                             ESM wrapper: loader + feature detection, Decoder, WebGL/2D renderers, Worker, Av1Player
```

(Without the `container` feature: 1.09 MB / 384 KB gzip and 1.19 MB / 413 KB.)

```js
import { loadWasmAv1, Decoder } from '@safewords/wasm-av1';

const rt  = await loadWasmAv1();          // picks simd or baseline for this browser
const dec = new Decoder(rt);
dec.setSource(bytes);                     // IVF, MP4/fMP4, WebM, TS — or dec.pushTemporalUnit(obus, pts)
dec.runUntilFull();                       // decode ahead (ring of 10 frames)
const frame = dec.nextFrame();            // planes in wasm memory: frame.plane(0..2), frame.planes[i].{offset,stride,width,height}
frame.rgba();                             // or RGBA8 (SIMD128 in the SIMD build)
```

Higher up, `Av1Player` (canvas, pacing by pts, decode budget per animation
frame, in-thread or in a Worker) and the renderers — WebGL uploads the planes
and does YUV→RGB in the shader; 2D uses the wasm RGBA conversion. The demo
page (`npm run serve`, then http://localhost:8080/demo/) exercises all of it.

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
| `node --test test/` (after `scripts/build.sh`) | The built `.wasm`, both variants, same MD5s through the wasm-bindgen surface; SIMD and baseline RGBA **byte-identical**; container path; ms/frame. |
| `node test/browser.mjs` (needs Playwright) | Headless Chromium + Firefox × {baseline, simd} × {WebGL, 2D} × {main thread, Worker} × {IVF, fMP4, MP4, WebM}: every frame shown, correctly paced, pixels on the canvas. |
| `scripts/bench.mjs` | Decode speed on real 360p/720p/1080p clips (`scripts/fetch-samples.sh`), with libdav1d MD5 check. |

`scripts/make-fixtures.sh` regenerates `testdata/` with ffmpeg (libaom encode,
libdav1d + libaom decode for the reference MD5s — they must agree or it aborts).

## Performance (Node 22 / V8 = Chrome's engine, x86-64 laptop, single thread)

| clip | baseline decode | simd decode | YUV→RGBA baseline → simd |
|---|---|---|---|
| BBB 640×360 | 7.6 ms/frame (131 fps) | 7.6 ms (131 fps) | 0.61 → 0.24 ms (2.6×) |
| BBB 1280×720 | 26.3 ms/frame (38 fps) | 28.2 ms (35 fps) | 3.0 → 1.1 ms (2.7×) |
| BBB 1920×1080 | 48.7 ms/frame (21 fps) | 44.2 ms (23 fps) | 6.1 → 2.1 ms (2.9×) |

Firefox's wasm tier is ~4× slower than V8 on the same machine (see the browser
test's decode column). The SIMD build's decode gain is small today because
rav1d's DSP kernels are scalar Rust in wasm — the profile and the plan to fix
that are in [docs/performance.md](docs/performance.md).

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
