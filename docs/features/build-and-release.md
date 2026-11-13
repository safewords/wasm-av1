# Build, tests and release

> **Status:** PARTIAL — CI and release work; the committed `pkg/` trails `main`: it is still the rav1d build of 0.2.2.
> **Owners (code):** `scripts/build.sh`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `package.json`, `Cargo.toml`, `rust-toolchain.toml`, `tests/`, `test/`, `scripts/`
> **Related docs:** [variants-and-threading.md](./variants-and-threading.md), [`../performance.md`](../performance.md), [`../rivet-av1.md`](../rivet-av1.md)
> **Last verified against code:** 2026-11-12 @ `162385f`

## Overview

`scripts/build.sh` compiles the four variants and runs wasm-bindgen and
wasm-opt into `pkg/`. CI proves the decoder on every push to `main`; a `v*`
tag builds the tag, tests it, and publishes `@safewords/wasm-av1` to npm and
to a GitHub Release. `pkg/` is committed so that a git dependency carries the
wasm. Nothing here deploys a service.

```mermaid
flowchart LR
  push[push to main] --> ci[ci.yml: fmt, clippy, cargo test,<br/>wasm tests, build.sh, node tests,<br/>npm publish --dry-run]
  tag[tag v*] --> rel[release.yml: build.sh, tests]
  rel --> gh[GitHub Release<br/>.tgz, pkg .zip, SHA256SUMS]
  rel --> npm[npm @safewords/wasm-av1<br/>provenance]
  gh --> lewd[lewd-frontend<br/>installs the v0.2.2 .tgz by URL:<br/>the rav1d build]
```

## How it works today

### Interfaces

| Kind | Name | Notes |
|---|---|---|
| Script | `scripts/build.sh [--dev]` | `VARIANTS="simd simd-threads"` builds a subset. `FEATURES` unset builds the default features (`container`); set, even to nothing, it builds exactly the features it names, so `FEATURES= scripts/build.sh` leaves the demuxers out (`scripts/build.sh:36-46`). Checks wasm-bindgen-cli equals the `Cargo.lock` version (`50-56`); writes `pkg/manifest.json` with the version, `"core": "rivet-av1"`, the rivet revision `Cargo.lock` pins, the features and each variant's size (`116-134`) |
| npm | `build`, `test`, `test:node`, `test:browser`, `bench`, `bench:browser`, `serve` | `package.json:52-60` |
| Workflow | `ci.yml` | `push` to `main`, `workflow_dispatch` (`.github/workflows/ci.yml:12-20`); `docs/**` and `**/*.md` are paths-ignored since `bad92a8`, so a docs-only push runs nothing |
| Workflow | `release.yml` | `push` of `v*` tags, or `workflow_dispatch` with a tag (`.github/workflows/release.yml:25-32`) |
| Secret | `NPM_TOKEN` (repository secret, optional) | Otherwise npm trusted publishing (OIDC); with neither the npm step warns and the release still succeeds (`release.yml:126-150`) |

Toolchain: Rust `1.100.0` with `rust-src` (`rust-toolchain.toml`),
wasm-bindgen-cli `0.2.130`, binaryen `version_123`, Node 22, mold for native
links (`ci.yml:21-33`). The threads variants rebuild std with
`-Zbuild-std` under `RUSTC_BOOTSTRAP=1` (`scripts/build.sh:68-75`).

### Flow: tests

| Command | Proves |
|---|---|
| `cargo test --release` (also `--no-default-features`, without `container`) | Every fixture decodes to the libdav1d/libaom MD5 on 1, 2 and 4 threads; film grain on and off; push ≡ IVF; MP4/fMP4/WebM ≡ IVF; CMAF segments and rendition switches (`tests/decode.rs`, `tests/container.rs`) |
| `cargo test --target wasm32-unknown-unknown --test wasm_convert` (± simd128) | RGBA dispatch equals scalar on 55 combinations inside wasm |
| `node --test test/decode.test.mjs` | The built `.wasm`, all four variants: same MD5s in baseline and SIMD, with `applyGrain` false too; the `threads` and `simd-threads` builds on 1, 2, 4 and 8 threads, each wasm thread a `worker_threads` Worker (`test/threads-node.mjs`, one process per run so a decoder left waiting fails instead of hanging); SIMD and baseline RGBA byte-identical; container and segment paths; rung switch through the JS `Decoder`. 20 tests |
| `node test/browser.mjs` (Playwright, not in CI) | Chromium, Firefox, WebKit × variants × renderers × thread/Worker × formats, on a cross-origin-isolated page |

`scripts/make-fixtures.sh` regenerates `testdata/` with ffmpeg; libdav1d and
libaom must agree or it aborts.

### Flow: release

`release.yml` checks the tag equals `package.json` and `Cargo.toml` versions
(`55-63`), builds, runs `cargo test` and the Node tests, `npm pack`s, zips
`pkg/`, writes `SHA256SUMS` and release notes with the rivet revision,
creates or updates the GitHub Release, and publishes to npm unless
that version already exists. To release: bump both versions, rebuild and
commit `pkg/`, tag `vX.Y.Z`, push the tag.

### Edge cases & gotchas

- **The committed `pkg/` trails `main`, by a decoder.** It was last rebuilt
  in `527e95a` (0.2.2) and is a rav1d build: its `manifest.json` says
  `"version": "0.2.2"` and has a `rav1d` entry where `build.sh` now writes
  `core` and `rivet`. `main` is 0.3.0 on rivet-av1. It is replaced only from
  CI's build (the pinned `wasm-opt`), never from a local one. Until then:
  consumers of the release tarball are unaffected (release.yml builds the
  tag itself); consumers of `github:safewords/wasm-av1#main` get 0.2.2 wasm
  with newer JS; and `node --test test/decode.test.mjs` run against the
  committed `pkg/` without building first fails six of its twenty tests,
  the threads builds on 2, 4 and 8 threads, on "thread Workers asked for"
  (rav1d started a set of threads per decoder, the pool starts
  `threads - 1` once). CI builds before it tests and is not affected.
- CI's "does the committed `pkg/` match" step is a warning only: a Windows
  build and a Linux build differ in the paths embedded in panic strings
  (`ci.yml:98-104`).
- `scripts/build.sh` does not run on a stock macOS (run 2026-11-12): BSD sed
  rejects the `{n;s/…/p}` expressions (`scripts/build.sh:48`, `:50`) and the
  script exits there; `/bin/bash` 3.2 then refuses the empty arrays under
  `set -u` (`:75`); and `:129` (with `release.yml:112`) uses GNU
  `stat -c %s`. CI runs it on Linux, where all three are fine. It does run
  there unmodified as `zsh --emulate ksh scripts/build.sh` (zsh accepts the
  empty arrays and, emulating ksh, splits `$VARIANTS` as sh does) with two
  shims first on `PATH`: a `sed` that rewrites `p}` to `p;}` before calling
  `/usr/bin/sed`, and a `stat` that calls coreutils' `gstat`. All four
  variants were built that way on 2026-11-12, for 0.3.0 and, before it, for
  both decoder cores.
- **Without `wasm-opt` the `.wasm` is about twice the size.** `build.sh`
  says "~15% smaller"; measured on 2026-11-12 with rav1d, the baseline
  variant was 3 499 115 bytes without binaryen against the 1 700 331 CI
  shipped. 0.3.0 without binaryen is 3 026 836; CI has not built it yet, so
  the README's size table is the local, unoptimised build and says so.
  Compare sizes only between builds made the same way.
- The threads variants pass `-C target-feature=+atomics`, which is not a
  stable target feature. rustc has always warned; from 1.100.0 the warning
  adds that it "will become a hard error in a future release"
  (rust-lang/rust#162235). The build still succeeds under
  `RUSTC_BOOTSTRAP=1`; read that issue before the next toolchain bump.
- Nothing reaches into Cargo's build directory. `build.sh` reads only the
  final `target/wasm-<variant>/wasm32-unknown-unknown/<profile>/wasm_av1.wasm`
  (`scripts/build.sh:76`), which Cargo 1.100's new layout for intermediate
  artifacts did not move.
- `.cargo/config.toml` sets a 7-day dependency cooldown
  (`global-min-publish-age`): `cargo update` and `cargo add` skip crates.io
  versions younger than that. It does not apply to the two git dependencies
  or to builds from `Cargo.lock`.
- The browser matrix needs Playwright (`PLAYWRIGHT_DIR`) and does not run in CI.
- A new Rust version cold-starts sccache: the first CI build after a bump is
  2-4x slower.

## History & references

- 2026-11-12: Rust 1.100.0 (toolchain file, both workflows) and the
  dependency cooldown. No source change was needed.
- `bb53c54`: Rust 1.99.1 and mold for the native side.
- `ec0e315`: dependencies within semver, wasm-bindgen 0.2.130.
- 2026-11-12: rivet-av1 as a second decoder core behind `rivet-av1` and
  `rivet-av1-pending` features, then, the same day, as the only one (0.3.0):
  rav1d, those two features and `bitdepth_8` / `bitdepth_16` removed;
  `FEATURES=` for a build without the demuxers; the threads variants tested
  in Node. [`../rivet-av1.md`](../rivet-av1.md).
- The repository README's "Testing" and "Performance" sections, and
  [`../performance.md`](../performance.md).

## Proposed / Ideas (backlog)

| Idea | Motivation | Sketch | Status |
|---|---|---|---|
| Portable `build.sh` | Builds on macOS | `wc -c < file` for `stat`; `p;}` in the sed expressions; `${arr[@]+"${arr[@]}"}` for the empty arrays | Proposed |
| Rebuild `pkg/` with each dependency bump | `main` consumers get what the source says | CI artifact committed by the release prep, or stop committing `pkg/` | Proposed |
