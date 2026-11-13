# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
A release is a `v*` tag matching the version in `package.json` and
`Cargo.toml`; `release.yml` publishes it to the GitHub Release and to npm as
`@safewords/wasm-av1`.

## [Unreleased]

The version in `Cargo.toml` and `package.json` is 0.3.0: this section
becomes that release when it is tagged.

### Fixed

- **The threads builds work in WebKit (Safari's engine) with more than one
  thread.** They failed in every release so far (0.2.0 to 0.2.2), within the
  first frames: "Out of bounds memory access" from the decoder, then
  "recursive use of an object detected which would lead to unsafe aliasing
  in rust" on every later call. The cause is a JavaScriptCore bug: after one
  Worker grows a shared memory, `memory.copy` and `memory.fill` in another
  Worker's instance still check bounds against the old size and trap, and
  every decoder thread is such an instance. `scripts/build.sh` now runs a
  post-link pass, `tools/wasm-copy-guard`, on the two threads variants. It
  routes those two instructions through helpers that fall back to plain
  loads and stores on pages the instance cannot see. Engines without the
  bug always take the instruction, at no measurable cost (Chromium, bbb-720p,
  8 threads). Found by decodeanywhere.dev's end-to-end suite in Playwright's
  macOS WebKit 623.1.10; WebKit 626.1.1 no longer has the bug, and which
  Safari releases have it was not tested. `test/copy-guard.test.mjs` tests
  the pass and `test/browser.mjs` reports whether each engine has the bug.
- A threaded player no longer leaks its thread Workers. The page creates
  them, a pool thread never returns, and `WorkerDecoder.close()` ended only
  the decode Worker, so each destroyed player left up to seven Workers and
  the wasm heap alive. `close()` now terminates them.

### Removed

- **rav1d.** The decoder is rivet-av1, rivet's own AV1 decoder, and nothing
  else: the rav1d dependency (and its `safewords/rav1d` fork), its adapter,
  and `parking_lot_core`, which only rav1d needed, are gone. Output is
  bit-exact as before, on every fixture in all four variants. Speed, as
  measured on 2026-11-13 in wasm: on one thread 1.0 to 1.2 times rav1d's
  rate on 8-bit 720p and 1080p video (0.87 on a synthetic test pattern); on
  four and eight threads 1.3 times on streams with one tile per frame, and
  0.39 of it on eight threads on a stream encoded with eight tiles. See
  `README.md` and `docs/rivet-av1.md`.
- **Breaking, Cargo features:** `bitdepth_8` and `bitdepth_16`. They selected
  rav1d's sample depths; every build now decodes 8, 10 and 12 bits, and
  naming either feature is an error. The default features are `container`
  alone. `--no-default-features` (which used to need a `bitdepth_*` feature
  beside it) is the build without the demuxers.
- **Breaking, Rust API:** `Frame::from_picture(&rav1d::Picture)`. Nothing
  replaces it: a `Frame` comes from `Decoder`, and its fields are public.
- **Breaking, build script:** `FEATURES=bitdepth_8 scripts/build.sh` and its
  like. `FEATURES` set to nothing now means no default features
  (`FEATURES= scripts/build.sh` builds without the demuxers); unset, as
  before, it means the defaults.
- rav1d's C API (`dav1d_open` and the rest: 20 symbols in the 0.2.2 build)
  is no longer exported from the `.wasm`. Nothing called it.
- rav1d's BSD-2-Clause notice, from `NOTICE`.

### Changed

- The two rivet packages come from rivet's `main` branch, which was brought
  up to `develop` on 2026-11-13; the revision is the same one.
- rivet-av1 moves to `c753ea1` (rivet `5680060`): its loop filter, inter
  prediction and residual path rewritten from the specification's
  processes. One thread in wasm is 2.2 to 2.9 times faster than 0.3.0 first
  built, and level with or ahead of rav1d on 8-bit 720p and 1080p video in
  both builds (0.87 of it on a synthetic test pattern). Output is unchanged,
  bit for bit.
- rivet-av1 moves on to `03054ad` (rivet `639239c`): frame threading,
  derived from the specification's dependencies. A frame of one tile is
  parsed on one thread while the others reconstruct and filter its rows,
  and several frames are decoded at once. In the SIMD + threads build in
  Node, 1280×720 with one tile per frame decodes at 175 / 308 / 477 / 652
  frames per second on 1 / 2 / 4 / 8 threads (rav1d: 146 / 269 / 376 / 496)
  and 1920×1080 at 85 / 158 / 258 / 360 (rav1d: 76 / 137 / 198 / 267); as
  0.3.0 was first built, eight threads gave 78 and 42. A stream of eight
  tiles per frame scales as before (372 on eight threads; rav1d 956).
  Output is unchanged, bit for bit.
- **Breaking, Rust API:** `Error::Open` and `Error::Decode` carry
  `wasm_av1::CoreError`, which is rivet-av1's `av1::Error` (`Bitstream`,
  `Unsupported` or `InvalidInput`, each with a message) where they carried
  `rav1d::Rav1dError`. `Error::Open` is no longer returned by anything:
  `Decoder::new` keeps its `Result` and cannot fail.
- **Breaking, messages:** a decode error's text, in Rust and as the thrown
  JavaScript `Error`, begins `rivet-av1: ` and continues with rivet-av1's
  wording, where it began `rav1d: `.
- **Licence of what is built.** This repository's code stays Apache-2.0, but
  every `.wasm` now contains rivet-av1, under the Open Encoding Attribution
  License 1.0 (source-available, not open source; notices carried forward;
  a credit for commercial use that reaches third parties), including a
  build without the `container` feature, which used to contain only
  BSD-licensed rav1d. `NOTICE` states it.
- **With more than one thread, frames come out a few temporal units after
  their data went in**, as they did with rav1d: up to eight frames (and at
  most eight 1920×1088 frames' worth of samples, so two at 4K) are decoded
  at once. At the end of the input `run()` decodes what is still in flight,
  and `finished()` is true once those frames have been popped. A unit that
  fails is reported when its turn comes, in `stats.decode_errors`. With one
  thread nothing is delayed.
- In the threads variants the Workers are a pool that belongs to the wasm
  instance: `threads - 1` of them are started when the first decoder with
  that many threads opens, and they outlive every decoder. rav1d started a
  set per decoder.
- A damaged frame is not concealed: the temporal unit is dropped and
  decoding resumes at the next keyframe, where rav1d carried on with what it
  had. The decoder stays usable either way.
- The decoder is smaller: CI's baseline variant is 2.86 MB against 3.30 MB
  for the last rav1d commit built the same day (681 KB without the
  demuxers, locally and without `wasm-opt`). The package is nonetheless
  larger than 0.2.2's 1.70 MB, which was built before the rivet-container
  update of 2026-11-06.
- `pkg/manifest.json` has `core` (`rivet-av1`) and `rivet` (the rivet
  revision `Cargo.lock` pins) where it had `rav1d`.
- IVF handed to `setSourceContainer` decodes, now that rivet reads IVF as a
  container; it had been refused.
- Built with Rust 1.100.0; the native side links with mold.
- `cargo update` and `cargo add` in this repository ignore crates.io versions
  published in the last 7 days (`.cargo/config.toml`). Builds from
  `Cargo.lock` are unaffected.
- Dependencies updated within their semver ranges, including wasm-bindgen
  0.2.130.

### Added

- `Decoder::units_in_flight()` (`unitsInFlight` in JavaScript): temporal
  units the decoder has taken whose frames have not come out yet. While it
  is not 0, a `run()` that returned `Starved` will have frames later
  without new input. The decode Worker uses it to come back for those
  frames by itself, so a live stream that never signals its end still gets
  every frame; `test/browser.mjs` has that case in all three engines.
- The threads variants are tested on real threads in Node: both, on 1, 2, 4
  and 8 threads, every fixture's MD5 (`test/threads-node.mjs`, run by
  `node --test test/decode.test.mjs`), and `applyGrain: false` in the
  baseline and SIMD builds.

## [0.2.2] - 2026-08-16

### Added

- `HlsAv1Video.stats` reports bandwidth, buffer ahead and slow fetches, and
  `variantForBandwidth()` picks the rung the network allows.
- `Av1Player.stats` reports late frames, stalls and the worst lateness.

### Changed

- `HlsAv1Video.selectVariant()` while playing switches at the next segment
  boundary without stopping the decoder: no flush, no gap. `{ at: 'now' }`
  keeps the hard switch.

### Fixed

- A hard rung switch no longer leaves the player stopped.

## [0.2.1] - 2026-08-16

### Added

- Published to npm as `@safewords/wasm-av1`, with provenance.

### Changed

- The documentation is generic, with no site-specific references; the
  integration guide is `docs/integration.md`.

## [0.2.0] - 2026-08-16

### Added

- `threads` and `simd-threads` variants: rav1d's frame and tile threads run
  as Web Workers on shared memory, about five times faster at 1080p on eight
  threads. A `threads` option on every entry point, `stats.threads`, and
  `detectThreads()`; `loadWasmAv1({ threads: true })` picks a threads variant
  only on a cross-origin-isolated page.

### Changed

- A reset flushes the decoder instead of recreating it, so the threads
  survive a seek. Frames still in flight are drained at the end of input.

## [0.1.3] - 2026-08-16

### Fixed

- The WebGL renderer is reported as WebGL in a minified bundle.
- The WebGL canvas can be read back between frames.

## [0.1.2] - 2026-08-16

### Fixed

- The decode Worker loads in a Vite or webpack bundle. `workerUrl` is passed
  through `Av1Player` and `HlsAv1Video` for consumers that serve `js/`
  themselves.

## [0.1.1] - 2026-08-16

### Fixed

- `WebGLRenderer.destroy()` no longer loses the canvas's WebGL context, so a
  canvas can be reused for the next stream.

## [0.1.0] - 2026-08-16

### Added

- AV1 decoding in WebAssembly, through rav1d with rivet demuxing, in baseline
  and SIMD builds. SIMD kernels make 720p about 2.6 times faster.
- A CMAF segment API and `HlsAv1Video`.
- A release pipeline: a `v*` tag publishes an npm tarball and a `pkg/` zip on
  the GitHub Release.

[unreleased]: https://github.com/safewords/wasm-av1/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/safewords/wasm-av1/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/safewords/wasm-av1/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/safewords/wasm-av1/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/safewords/wasm-av1/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/safewords/wasm-av1/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/safewords/wasm-av1/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/safewords/wasm-av1/releases/tag/v0.1.0
