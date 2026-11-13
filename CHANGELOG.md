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

### Removed

- **rav1d.** The decoder is rivet-av1, rivet's own AV1 decoder, and nothing
  else: the rav1d dependency (and its `safewords/rav1d` fork), its adapter,
  and `parking_lot_core`, which only rav1d needed, are gone. Output is
  bit-exact as before, on every fixture in all four variants. **It is
  slower**: as measured on 2026-11-12, in wasm rivet-av1 decodes 8-bit video
  at a third to two thirds of rav1d's single-thread rate, and gains 1.2 to
  1.3 times from eight threads on a stream with one tile per frame where
  rav1d gained about 3.5. The performance work is under way in rivet-av1.
  See `docs/rivet-av1.md`.
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
- Threads decode the tiles of a frame in parallel and its post-filters in
  bands, one frame at a time; rav1d also decoded several frames at once.
  Frames come out with no delay, so `finished()` is true as soon as the last
  frame has been popped, without the further `run()` the end-of-input drain
  needed.
- In the threads variants the Workers are a pool that belongs to the wasm
  instance: `threads - 1` of them are started when the first decoder with
  that many threads opens, and they outlive every decoder. rav1d started a
  set per decoder.
- A damaged frame is not concealed: the temporal unit is dropped and
  decoding resumes at the next keyframe, where rav1d carried on with what it
  had. The decoder stays usable either way.
- The decoder is smaller: 3.03 MB for the baseline variant with the
  demuxers and 681 KB without, against 3.50 MB with rav1d, all without
  `wasm-opt`.
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
