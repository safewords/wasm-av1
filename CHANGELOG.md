# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
A release is a `v*` tag matching the version in `package.json` and
`Cargo.toml`; `release.yml` publishes it to the GitHub Release and to npm as
`@safewords/wasm-av1`.

## [Unreleased]

### Changed

- IVF handed to `setSourceContainer` decodes, now that rivet reads IVF as a
  container; it had been refused.
- Built with Rust 1.100.0; the native side links with mold.
- `cargo update` and `cargo add` in this repository ignore crates.io versions
  published in the last 7 days (`.cargo/config.toml`). Builds from
  `Cargo.lock` are unaffected.
- Dependencies updated within their semver ranges, including wasm-bindgen
  0.2.130.

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
