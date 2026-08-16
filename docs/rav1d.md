# rav1d: why a fork branch, and what is on it

The decoder is [memorysafety/rav1d](https://github.com/memorysafety/rav1d), the
Rust port of dav1d (BSD-2-Clause). We take it from
**`https://github.com/safewords/rav1d`, branch `wasm32-unknown-unknown`**, which is
upstream `main` plus one commit
([`7546455`](https://github.com/safewords/rav1d/commit/7546455cb20fa82608c7363cf6f229030d80589d)).

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

## Upstreaming

The branch is PR-ready against `memorysafety/rav1d`. When it (or an
equivalent) lands, `Cargo.toml` flips back to upstream and the fork can go.
Until then `cargo update -p rav1d` moves along our branch; rebasing it on a
newer upstream `main` is one cherry-pick.
