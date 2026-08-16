# rav1d: why a fork, and what is on it

The decoder is [memorysafety/rav1d](https://github.com/memorysafety/rav1d), the
Rust port of dav1d (BSD-2-Clause). We take it from
**`https://github.com/safewords/rav1d`, branch `main`**, which is upstream
`main` (`d3d1cd6`, 2026-08-14) plus three commits:

| commit | what | upstreamable |
|---|---|---|
| [`7546455`](https://github.com/safewords/rav1d/commit/7546455cb20fa82608c7363cf6f229030d80589d) | build for `wasm32-unknown-unknown`: `src/c_types.rs` instead of `libc::{ptrdiff_t,…,E*}` | yes, as is |
| [`74f87c8`](https://github.com/safewords/rav1d/commit/74f87c8) | `rav1d_submit_frame::on_error` no longer panics when the frame header is already gone (a damaged temporal unit took the whole decoder down; now it is an `Err` and decoding continues, matching libdav1d) | yes, as is |
| [`55c4d09`](https://github.com/safewords/rav1d/commit/55c4d09) | wasm32 SIMD128 kernels for MC 8-tap, warp 8×8, CDEF and the loop filter (8 bpc), see below | probably, if they take portable-SIMD kernels; otherwise it stays here |

(The first commit is also on the branch `wasm32-unknown-unknown` alone, for a
minimal upstream PR; `wasm32-simd` holds all three.)

## Why not upstream directly

Neither the crates.io release (1.1.0) nor `main` compiles for
`wasm32-unknown-unknown`: rav1d imports `libc::{ptrdiff_t, intptr_t, uintptr_t,
off_t}` and the `libc::E*` errno constants, and the `libc` crate defines none of
those for that target (there is no libc there — it has them only for `wasi`).
39 unresolved imports. Verified on 2026-08-15 with libc 0.2.189.

## What the commit does

Adds `src/c_types.rs`: on every target with a libc it re-exports those names
from `libc`; on `wasm32-unknown-unknown` it defines them (`isize`/`usize`
aliases, Linux errno values). Fourteen `use libc::…` lines now import from it.
No type or ABI change anywhere else. `cargo fmt` clean per rav1d's rustfmt.toml.
+25/−21 lines plus the 35-line module.

## Why `main` and not the release

`main` has `rust_api` (a dav1d-rs-compatible safe `Decoder`/`Settings`/
`Picture` API) that 1.1.0 lacks; the crate here builds on it.

## Runtime notes on wasm

- `n_threads` is forced to 1 (`Rav1dContextTaskType::Single`), so rav1d never
  spawns; `available_parallelism()` failing on wasm falls back to 1 anyway.
- rav1d's `Decoder::flush()` keeps input it had not finished consuming and
  `send_data` then panics; a reset here therefore recreates the rav1d instance
  (`decoder.rs::reset_state`).
- Film grain synthesis is on by default (rav1d applies it, like libdav1d);
  `Config::apply_grain` turns it off.

## The wasm SIMD128 kernels (`src/mc/wasm.rs`, `src/cdef/wasm.rs`, `src/loopfilter/wasm.rs`)

Each is reached by an early return at the top of the corresponding `_rust`
function under `cfg(all(target_arch = "wasm32", target_feature = "simd128"))`
for `BD::BITDEPTH == 8` (and `w >= 8` for the 8-tap filters); everything else
falls through to the scalar code, and nothing changes on any other target.
They are the scalar arithmetic — same widening, rounding, clipping — eight
lanes per `v128`, and are held bit-exact by this crate's tests (every fixture
and clip decodes to libdav1d's MD5 through the SIMD build). Notes that
matter if you touch them:

- MC: i32 accumulation via `i32x4_extmul_{low,high}_i16x8` (an 8-tap sum does
  not fit i16); the 2-D intermediate is an uninitialised 34 KB buffer written
  before read (the scalar path zeroes it per call, which for an 8×8 block cost
  more than the filter). Warp uses per-pixel `i32x4_dot_i16x8` + a 4-lane
  reduction horizontally and a transposed intermediate vertically.
- CDEF: the padding marker `i16::MIN` must behave as "very large": abs/shift/min
  on it are done as *unsigned* so its contribution is exactly 0, as in the
  scalar `constrain()`.
- Loop filter: four positions per call = four lanes; both orientations
  (positions along a row / down the rows); the wd 4/6/8/16 `if` chain becomes
  masks + `bitselect`.

Measured effect (V8, 720p BBB): decode 23.3 → 9.5 ms/frame; the whole SIMD
build 1.4–2.7× faster than baseline depending on content.

## Upstreaming

The first two commits are PR-ready against `memorysafety/rav1d`. When they
land, `Cargo.toml` can point at upstream plus only the kernels (or at
upstream alone if those are taken too). Until then `cargo update -p rav1d`
moves along `main` of the fork; rebasing on a newer upstream is a
cherry-pick of three commits.
