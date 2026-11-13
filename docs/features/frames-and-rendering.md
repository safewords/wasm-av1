# Frames, colour conversion and rendering

> **Status:** STABLE
> **Owners (code):** `src/frame.rs`, `src/convert.rs`, `src/wasm.rs` (frame and RGBA sections), `js/decoder.js` (`Frame`, `krKbFor`), `js/render.js`
> **Related docs:** [decoder-core.md](./decoder-core.md), [js-api-and-worker.md](./js-api-and-worker.md), [`../performance.md`](../performance.md)
> **Last verified against code:** 2026-11-12 @ `4386183`

## Overview

A decoded picture leaves rav1d as a `Frame`: the three planes copied into one
tightly packed buffer with explicit geometry and the stream's colour
metadata. From there it is either uploaded as planes to WebGL, where the
shader does YUV to RGB, or converted to RGBA in wasm (SIMD128 in the SIMD
builds) for a 2D canvas. The two conversions use the same Kr/Kb table so they
agree on colour.

## How it works today

### Data model

`Frame` (`src/frame.rs:107-125`): `width`, `height`, `bit_depth` (8/10/12),
`bytes_per_sample` (1, or 2 little-endian for 10/12-bit), `layout`
(`I400`/`I420`/`I422`/`I444`), `planes: [PlaneInfo; 3]` (`offset`, `stride`,
`width`, `height`), `pts`, `color` (`matrix`, `primaries`, `transfer`,
`full_range`, defaults "unspecified", `src/frame.rs:85-105`), and `data`.

The packed layout is Y then U then V, no padding (`Frame::geometry`,
`src/frame.rs:129-158`), which is exactly what WebCodecs' `I420` expects.
`Frame::from_picture` copies row by row from rav1d's padded strides
(`src/core_rav1d.rs:96-150`); that copy is the price of a frame that survives
the next decode call. (A `rivet-av1` build has no such copy: rivet-av1 hands
back a frame already packed this way and `src/core_rivet.rs:108-135` takes
its buffer.)

### Interfaces

| Kind | Name | Notes |
|---|---|---|
| wasm | `nextFrame`, `hasFrame`, `peekPts` | `src/wasm.rs:381-400` |
| wasm | `frameWidth/Height/BitDepth/BytesPerSample/Layout/Pts/Matrix/Primaries/Transfer/FullRange` | `src/wasm.rs:406-462` |
| wasm | `framePtr`, `frameLen`, `planeOffset/Stride/Width/Height(i)` | Pointers into wasm memory (`src/wasm.rs:464-498`) |
| wasm | `convertToRgba()`, `rgbaPtr`, `rgbaLen` | Into a reused scratch buffer (`src/wasm.rs:504-527`) |
| JS | `Frame` | `data`, `plane(i)`, `copyData()`, `rgba()`, `toImageData()`, `writeImageData()`, `toTransferable()` (`js/decoder.js:33-125`) |
| JS | `WebGLRenderer`, `Canvas2DRenderer`, `createRenderer(canvas, 'auto'|'webgl'|'2d')` | `js/render.js:62`, `214`, `243` |

### Flow: conversion

`Coefficients::for_matrix` (`src/convert.rs:67-78`) maps the ISO 23091-2
matrix code to Kr/Kb (BT.709, FCC, BT.601, SMPTE 240M, BT.2020); unspecified
codes use BT.709 above 576 lines and BT.601 below. Coefficients are derived in
Q16 fixed point (`src/convert.rs:46-61`). `yuv_to_rgba_with`
(`src/convert.rs:109-123`) takes the SIMD128 path for 8-bit 4:2:0 in a SIMD
build and the scalar path for every other shape and depth. Both use the same
integer arithmetic and are tested byte-identical (`tests/wasm_convert.rs`, 55
combinations). `krKbFor` in JS (`js/decoder.js:20-31`) is the same table for
the shader.

### Flow: rendering

`WebGLRenderer.draw` (`js/render.js:162-193`) uploads Y/U/V as luminance
textures and converts in the fragment shader with the frame's matrix and
range; it returns `'yuv'`. For 16-bit frames, and identity-matrix 4:4:4, it
falls back to an RGBA texture from the wasm converter and returns `'rgba'`.
`Canvas2DRenderer` always converts in wasm and `putImageData`s into a reused
`ImageData`. Both take a live `Frame` or the plain object a Worker posts.
`Av1Player` records the returned path in `stats.drawPath`.

### Edge cases & gotchas

- **Views are transient.** Any call that can decode may grow wasm memory and
  detach every `Uint8Array` over it (`src/wasm.rs:11-13`). The JS `Frame`
  rebuilds its view on each access and throws once `nextFrame()` or `flush()`
  has superseded it (`js/decoder.js:64-71`).
- `rgba()` reuses one scratch buffer per decoder: the next `rgba()` call
  overwrites the previous result. Copy (`toImageData`) to keep it.
- Primaries and transfer are carried but not applied; HDR tone mapping is the
  renderer's job and none is implemented.

## History & references

- Upstream `yuv-to-rgb.c` (approximate BT.601, 16-bit 4:2:0 only) and
  `draw-image.js` (rebuilt GL state per frame), both replaced here.
- [`../performance.md`](../performance.md): conversion timings, baseline vs SIMD.

## Proposed / Ideas (backlog)

| Idea | Motivation | Sketch | Status |
|---|---|---|---|
| WebCodecs `VideoFrame` output | Hand frames to a `<canvas>`/`MediaStreamTrackGenerator` without our renderer | `new VideoFrame(frame.copyData(), {format: 'I420', ...})` | Proposed |
| 10-bit WebGL path | Avoid CPU conversion for 10-bit streams | `R16UI`/half-float textures in WebGL2 | Proposed |
