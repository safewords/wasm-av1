# rivet-av1: rivet's own AV1 decoder as the core

**Where this stands (2026-11-12).** wasm-av1 builds and passes its tests on
rivet's AV1 decoder instead of rav1d, behind the Cargo feature `rivet-av1`.
It is **not the default**, and `pkg/`, CI and the published package are
rav1d as before, for one reason above the others: in WebAssembly it decodes
8-bit video at about half rav1d's speed on one thread (0.33 to 0.63 times
across the streams measured, both variants), and it gains far less from
threads: on eight, a 720p or 1080p stream decodes at a sixth to a fifth of
rav1d's rate. A software decoder for devices that have no AV1 hardware is
judged on exactly that. The output is bit-exact, on every fixture, in every
variant, natively and in a browser.

Two further things are missing in rivet-av1 as rivet `develop` has it and are
written but not upstream: decoding without film grain, and threads on wasm.
They are three commits on a rivet-av1 branch, kept here as patches until
they land ([below](#the-rivet-av1-commits-it-waits-for)).

## What rivet-av1 is

`rivet-av1` (imported as `av1`) is `crates/av1` of
[rivet](https://github.com/rivet-transcoder/rivet), a git submodule there
whose own repository is `https://github.com/safewords/rivet-av1`. rivet
`develop` at `2100c31` pins it at `3abbfe2`. Read from its source and README,
and checked where it says so below:

- **A decoder and an encoder**, about 21 000 lines of Rust, written from the
  AV1 specification and not derived from dav1d, rav1d or libaom. One
  dependency (`thiserror`), no build script, no C, no libc. The encoder is
  dead code to this crate and LTO drops it.
- **The decoder is complete for what this crate serves**: profiles 0, 1 and
  2; 8, 10 and 12 bits; monochrome, 4:2:0, 4:2:2 and 4:4:4; film grain
  synthesis; scalable streams (operating point selection); Annex B as well
  as the low-overhead format. Not there: large-scale tile (tile list OBUs
  return `Error::Unsupported`; nothing here needs it), frame threading, and
  concealment of a damaged frame.
- **Conformance, as its README states it**: all 244 of AOMedia's public
  `av1-1-b8-*` / `av1-1-b10-*` vectors and all 3 015 Argon streams, every
  output byte. **Checked here**: the 12 vectors committed in its
  `tests/data` (`cargo test --release`, on one thread and with
  `AV1_DECODE_THREADS=4`), this crate's six fixtures, and four SVT-AV1 clips
  made for this comparison (720p and 1080p, 8 and 10 bit) against libdav1d's
  MD5. Not run here: the 244 (a download) and Argon (a 7 GB suite that is
  not on this machine).
- **It builds for `wasm32-unknown-unknown` as it is**, with std and without
  a libc. (rav1d needed a fork commit for that.)
- **SIMD**: AVX2 chosen at run time on x86-64 and NEON on aarch64, in the
  CDEF filter, the 8-tap interpolation filters, the inverse transforms and
  the loop filter. Nothing for wasm.
- **Threads**: `Decoder::set_threads(n)` decodes the tiles of a frame in
  parallel and runs the loop filter, CDEF and loop restoration in bands. It
  starts scoped threads (`std::thread::scope`) for every such job and joins
  them. Frames are decoded one after another.
- **The API**: `Decoder::new()`, then `decode_all(&temporal_unit)` returns
  the frames that unit shows, each one buffer of packed planes (Y, U, V, no
  padding, little-endian `u16` above 8 bits). That is the layout of this
  crate's `Frame`, so a frame is taken, not copied. No timestamps, no
  flush, no switch for film grain.
- **Licence**: the Open Encoding Attribution License 1.0, as
  `rivet-container`: source-available, attribution for commercial use, the
  NOTICE carried forward. rav1d is BSD-2-Clause. A rivet-av1 build has no
  BSD code left in it; a default build has both licences, as today.

## What this crate needs from a core, and where rivet-av1 stood

| Requirement here | rivet-av1 at `3abbfe2` | How it was closed |
|---|---|---|
| Bit-exact AV1 at 8 and 10 bits, 4:2:0, 4:4:4, mono, film grain, odd sizes | Yes | Nothing to do |
| Builds for `wasm32-unknown-unknown`, baseline and `+simd128` | Yes | Nothing to do |
| A temporal unit in, frames with its pts out | Frames, no pts | Glue: `src/core_rivet.rs` stamps the unit's pts on the frames it showed |
| A reset for a seek that keeps the threads | No flush | Glue: a new `av1::Decoder`; the threads are a pool outside it |
| Samples from MP4 or Matroska, which carry no temporal delimiter; a damaged unit must not end the stream | An unfinished frame is only forgotten at a temporal delimiter | Glue: a delimiter goes in front of every unit. Measured on an SVT-AV1 stream with one unit cut after its frame header: without it 3 frames of 60 and "OBU_FRAME while a frame is in progress" from then on; with it all 60. Worth fixing in rivet-av1 too (reset on error) |
| `Config::apply_grain = false` | Grain is always applied | **rivet-av1 commit 1** (`Decoder::set_apply_grain`); until then refused with `Error::Open` |
| Threads in the `threads` variants: no `std::thread::spawn` on wasm, a thread is a Worker the page creates | `std::thread::scope` | **rivet-av1 commit 2** (`av1::parallel`: an embedder registers a `Runner`) and a pool of Workers in `src/threads.rs`; until then one thread |
| The SIMD variant is faster than the baseline one | No wasm kernels: 1.05 to 1.16 times, and 0.23 to 0.64 of rav1d's SIMD variant | **rivet-av1 commit 3** (a SIMD128 CDEF kernel, vector lanes for the inverse transforms): 1.3 to 2.1 times the baseline |
| As fast as rav1d | With commit 3, on one thread in wasm: 0.33 to 0.63 times on 8-bit streams, 0.83 to 0.97 on 10-bit in the SIMD variant (rav1d's wasm kernels are 8-bit only) | **Open.** See [what would make it the default](#what-would-make-it-the-default) |
| Scales with threads as rav1d does (3.5 times on 8 here; 5 times at 1080p in Chromium, [performance.md](performance.md)) | Tiles and filter bands only: 1.2 to 1.3 times on 8 for a one-tile stream, 3.3 for eight tiles | **Open.** Frame threading in rivet-av1 |
| `bitdepth_8` alone gives a smaller 8-bit-only decoder | One code path for every depth | **Not met.** Under `rivet-av1` the `bitdepth_*` features select nothing; every depth decodes and the size does not change |
| `Error::Open` / `Error::Decode` carry `rav1d::Rav1dError` | Its own `av1::Error` | The payload is the core's error, exported as `wasm_av1::CoreError`. Unchanged for a default build; a different type under `rivet-av1`. The variants, and the JS surface (a thrown `Error` with a message), are the same |
| `Frame::from_picture(&rav1d::Picture)` is public | — | Kept for a default build (`src/core_rav1d.rs`); absent under `rivet-av1` |

Everything else in the public surface is untouched: the `Decoder` API, the
wasm-bindgen exports, `js/`, the four variants.

## How it is wired in

`src/decoder.rs` drives a private `Core` through five calls (`open`,
`flush`, `send`, `send_pending`, `picture`) that are dav1d's shape. rav1d
sits behind them in `src/core_rav1d.rs`, rivet-av1 in `src/core_rivet.rs`;
`src/lib.rs` compiles one. rivet-av1 decodes a unit inside `send`, so with
it nothing is ever pending or in flight and the ring logic simply never
takes those branches.

Three feature sets:

| Build | Core | Notes |
|---|---|---|
| default (`bitdepth_8`, `bitdepth_16`, `container`) | rav1d | What CI builds and `pkg/` holds |
| `--no-default-features --features rivet-av1,container` | rivet-av1 from rivet `develop` | Builds from a clean checkout. `apply_grain: false` is refused; the threads variants report `threadsSupported() == false` and decode on one thread; no wasm SIMD kernels |
| `--no-default-features --features rivet-av1-pending,container` | rivet-av1 with the three commits below | Everything rav1d does here. Builds only with a checkout of that branch overriding the dependency |

`bitdepth_8` and `bitdepth_16` are what link rav1d in (it is an optional
dependency they switch on), so a rivet-av1 build leaves them out. With both
`rivet-av1` and a `bitdepth_*` feature rivet-av1 is the core and all of
rav1d comes along unused: its C API is `#[no_mangle]` and a `cdylib` keeps
it.

On wasm with threads (`src/threads.rs`, `mod pool`): rivet-av1 hands each
parallel job to a registered `Runner`. The pool is that runner. It asks the
page for `threads - 1` Workers once (the same `__wasmAv1SpawnThread` request
and `pkg/thread-worker.js` rav1d's threads use), each waits on a condvar,
and a job goes to those that are waiting. The decoding thread always works
on the job itself and a job is a loop over a shared queue, so a Worker that
has not started yet is not waited for, and a decoder that is flushed or
dropped leaves the pool as it is.

## The rivet-av1 commits it waits for

On branch `wasm-embedding` of a rivet-av1 clone, on top of `3abbfe2`, and as
`git format-patch` files in [`rivet-av1-patches/`](rivet-av1-patches/) so
that they exist somewhere durable (`git am` applies them). Nothing has been
pushed and no pull request opened.

1. **`0001` — `Decoder::set_apply_grain(bool)`** (`src/decoder/mod.rs`).
   One field, one setter, one condition in the output process
   (`grain_on = self.apply_grain && …`). Default on. Test:
   `tests/committed_vectors.rs::film_grain_can_be_switched_off` (both grain
   vectors: on equals the reference MD5s, off differs on every frame; a
   stream without grain is unaffected).
2. **`0002` — `av1::parallel`** (new `src/parallel.rs`; `tiles_in_parallel`
   and `parallel_map` in `src/decoder/mod.rs`). A `Runner` trait with one
   method, `run(n, job)`: call `job(0)` on the calling thread and `job(k)`
   for any of `1..n` on other threads, return when all have returned.
   `set_runner` registers one for the process; without one the two
   functions use scoped threads exactly as before, except that the caller
   is now one of the tile workers instead of waiting for them. Tests:
   `tests/parallel.rs` (a runner that starts every thread, and one that
   starts none, both decode the committed vectors exactly) and two unit
   tests. The encoder's wavefront search still starts its own threads.
3. **`0003` — wasm32 SIMD128** (`src/dsp/cdef.rs`, `src/dsp/itx.rs`). A
   `v128` version of the CDEF block filter, the NEON one's arithmetic, in a
   module built with `simd128`; and the inverse transforms' existing vector
   lanes switched on there. Checked against the scalar filter on 200 000
   random windows times four block shapes in a `+simd128` wasm in Node (no
   mismatch), and by every MD5 here through the SIMD variants. rivet-av1 has
   no way to run its own kernel test on wasm, so that test does not cover
   it. Also silences two dead-code warnings a wasm build of rivet-av1 had.

rivet itself then needs its `crates/av1` submodule moved to the commit that
has them.

Verified in the rivet-av1 clone with the three applied: `cargo fmt --all
--check`, `cargo clippy --all-targets --all-features -- -D warnings`,
`cargo doc --no-deps`, `cargo test --release` (unit tests, committed
vectors, encoder, fuzz), `cargo test --test fuzz --test encode` in debug,
and clippy for `wasm32-unknown-unknown` with and without `simd128`, all
clean. Not run: the 244 vectors, Argon, and rivet's own workspace tests
(the change to rivet is the submodule pointer).

## Building and testing it

```bash
# rivet-av1 as rivet develop has it
cargo test --release --no-default-features --features rivet-av1,container
FEATURES=rivet-av1,container scripts/build.sh && node --test test/decode.test.mjs

# with the three commits: a clone of rivet-av1 with docs/rivet-av1-patches applied
git clone https://github.com/safewords/rivet-av1 ../rivet-av1
git -C ../rivet-av1 checkout -b wasm-embedding 3abbfe2
git -C ../rivet-av1 am "$PWD"/docs/rivet-av1-patches/*.patch
cargo test --release --config "paths=['$PWD/../rivet-av1']" \
  --no-default-features --features rivet-av1-pending,container
```

`paths` is Cargo's path override: the dependency is compiled from that
directory and `Cargo.lock` is not rewritten. Put `--config` after the
subcommand (`cargo clippy --config …`), or `cargo clippy` does not pass it
on. `scripts/build.sh` takes no such flag; it was run for this feature set
with a `cargo` wrapper on `PATH` that adds it.

`git checkout -- pkg` afterwards: `build.sh` writes into the committed
`pkg/`, and that stays rav1d.

## What was run, and what it gave

All on 2026-11-12, one machine (Apple silicon, macOS, Rust 1.100.0, Node 26
/ V8), `.wasm` built by `scripts/build.sh` without `wasm-opt` for both cores.

**Correctness.** `cargo test --release` with each of the three feature
sets, and each without `container`: every fixture's MD5 (8-bit, 10-bit,
4:4:4, mono, film grain, 177×99), 2 and 4 threads, flush at every point,
push mode, MP4 / fMP4 / WebM, CMAF segments, rendition switches.
`node --test test/decode.test.mjs` against the baseline and SIMD builds of
each: 10 of 10. The four SVT-AV1 clips and four AOM vectors below: the same
MD5 from both cores natively and in the baseline and SIMD builds, and
libdav1d's where there is one. In a
browser (Chromium 156, a cross-origin-isolated page, a decode Worker through
`WorkerDecoder`, thread Workers through `pkg/thread-worker.js`): all four
variants of the `rivet-av1-pending` build, on 1, 2, 4 and 8 threads, give
the same SHA-256 of the decoded planes as the rav1d build on three fixtures
(8-bit, 10-bit, film grain) and as the committed `pkg/` on a fourth (mono).
`Av1Player` on that build showed 48 of 48 frames with 4, 2 and `'auto'` (8)
threads in two runs. In later runs, with the browser pane hidden, the
player timed out for both cores and for the committed `pkg/` alike (a
hidden page gets no animation frames), so there is no player run of rav1d
to set beside it. `test/browser.mjs` (Playwright: Chromium, Firefox, WebKit)
was not run: Playwright is not installed here. Firefox and WebKit have not
run a rivet-av1 build at all.

**Throughput, one thread**, frames per second, median of 7 runs, decode
time only. `rivet-av1` is rivet `develop`; `+3` is with the three commits.

| stream | native: rav1d | rivet-av1 | +3 | wasm baseline: rav1d | rivet-av1 | +3 | wasm SIMD: rav1d | rivet-av1 | +3 |
|---|---|---|---|---|---|---|---|---|---|
| fixture 320×180, 8-bit | 1496 | 963 | 970 (0.65×) | 1163 | 574 | 576 (0.50×) | 1703 | 655 | 839 (0.49×) |
| fixture 160×90, 10-bit | 3534 | 2552 | 2621 (0.74×) | 2890 | 1675 | 1688 (0.58×) | 2817 | 1808 | 2326 (0.83×) |
| fixture 128×72, film grain | 2870 | 2022 | 1995 (0.70×) | 2216 | 1353 | 1355 (0.61×) | 3052 | 1420 | 1748 (0.57×) |
| fixture 177×99, 8-bit | 2294 | 1965 | 1985 (0.87×) | 1874 | 1133 | 1140 (0.61×) | 3179 | 1235 | 1755 (0.55×) |
| fixture 96×64, 4:4:4 | 4220 | 3028 | 3125 (0.74×) | 3478 | 1969 | 1964 (0.56×) | 5579 | 2168 | 3175 (0.57×) |
| fixture 96×64, mono | 10280 | 7447 | 7102 (0.69×) | 10562 | 5942 | 6003 (0.57×) | 15781 | 6715 | 7755 (0.49×) |
| AOM `av1-1-b8-05-mv`, 352×288 | 197 | 166 | 166 (0.84×) | 156 | 89.2 | 89.2 (0.57×) | 254 | 95.7 | 146 (0.58×) |
| AOM `av1-1-b10-00-quantizer-10`, 352×288 10-bit | 87.2 | 72.2 | 72.4 (0.83×) | 70.9 | 37.6 | 37.8 (0.53×) | 72.9 | 40.1 | 62.9 (0.86×) |
| AOM `av1-1-b8-23-film_grain-50`, 352×288 | 420 | 298 | 300 (0.72×) | 339 | 150 | 149 (0.44×) | 510 | 159 | 266 (0.52×) |
| AOM `av1-1-b8-00-quantizer-20`, 352×288 | 234 | 191 | 193 (0.82×) | 188 | 100 | 101 (0.54×) | 281 | 110 | 176 (0.63×) |
| SVT-AV1 testsrc2, 1280×720 | 228 | 122 | 123 (0.54×) | 175 | 58.1 | 58.1 (0.33×) | 296 | 67.4 | 107 (0.36×) |
| SVT-AV1 mandelbrot + noise, 1280×720 | 82.5 | 70.1 | 70.9 (0.86×) | 65.0 | 30.1 | 29.7 (0.46×) | 145 | 33.8 | 60.8 (0.42×) |
| SVT-AV1 mandelbrot + noise, 1280×720 10-bit | 95.6 | 88.0 | 89.1 (0.93×) | 73.4 | 36.0 | 36.2 (0.49×) | 80.4 | 41.0 | 77.8 (0.97×) |
| SVT-AV1 mandelbrot + noise, 1920×1080 | 40.6 | 36.6 | 36.3 (0.89×) | 31.8 | 15.0 | 15.1 (0.47×) | 73.8 | 17.0 | 31.5 (0.43×) |

The clips are synthetic (ffmpeg's `testsrc2` and `mandelbrot` with noise,
encoded by SVT-AV1 at preset 8, CRF 35); the Big Buck Bunny and Sintel clips
of [performance.md](performance.md) were not fetched. The AOM vectors are
the ones rivet-av1 commits.

Read: natively, where rivet-av1 has NEON and rav1d (built without its
assembly, as this crate builds it) has none, rivet-av1 is at 0.54 to 0.93 of
rav1d. In wasm it is at a third to six tenths in the baseline variant, and
the same on 8-bit streams in the SIMD variant. The third commit is what
makes its SIMD variant worth having: without it that variant ran at a
quarter of rav1d's at 720p and 1080p. 10-bit streams come close to rav1d
there, because rav1d's wasm kernels are 8-bit only.

**Threads**, the SIMD + threads variant in Node (the decoder on the main
thread, each wasm thread a `worker_threads` Worker on the shared memory),
frames per second, median of 5:

| clip | core | 1 thread | 2 | 4 | 8 |
|---|---|---|---|---|---|
| mandelbrot + noise 1280×720, one tile | rav1d | 141 | 256 | 375 | 497 (3.5×) |
| | rivet-av1 +3 | 60.1 | 68.7 | 73.7 | 77.9 (1.3×) |
| testsrc2 1280×720, one tile | rav1d | 282 | 500 | 648 | 794 (2.8×) |
| | rivet-av1 +3 | 105 | 116 | 122 | 127 (1.2×) |
| mandelbrot + noise 1920×1080, one tile | rav1d | 73.9 | 132 | 197 | 265 (3.6×) |
| | rivet-av1 +3 | 31.5 | 36.2 | 31.7 | 42.3 (1.3×) |
| mandelbrot + noise 1280×720, eight tiles | rav1d | 151 | 290 | 530 | 954 (6.3×) |
| | rivet-av1 +3 | 62.8 | 112 | 174 | 210 (3.3×) |

Read: on a stream with one tile, which is what an encoder produces at these
sizes unless told otherwise, rivet-av1 has only its post-filters to spread
over the threads, and with the SIMD kernels those are a small share: 1.2 to
1.3 times on eight. rav1d threads frames and reaches 2.8 to 3.6. With eight
tiles rivet-av1's tile threading shows (3.3 times), and rav1d's more (6.3).
On eight threads rivet-av1 is at a sixth to a fifth of rav1d. The same
shape natively (`decode_ivf --threads`, 720p one tile, 1/2/4/8 threads:
rav1d 83, 156, 239, 326; rivet-av1 72, 83, 89, 91).

**Size** of the `.wasm`, bytes, without `wasm-opt` (CI's builds, with it,
are about half: the README's table is CI's):

| variant | rav1d | rivet-av1 (rivet `develop`) | rivet-av1 +3 |
|---|---|---|---|
| baseline | 3 499 130 (1 088 925 gzip) | 3 030 581 (964 959) | 3 029 839 (964 657) |
| simd | 3 836 610 (1 213 343) | 3 297 245 (1 063 212) | 3 471 720 (1 101 730) |
| threads | 3 519 437 (1 087 402) | 3 072 972 (967 803) | 3 074 489 (968 688) |
| simd-threads | 3 858 441 (1 213 393) | 3 342 156 (1 070 313) | 3 518 893 (1 108 327) |

All with the `container` feature. rivet-av1 is 9 to 13 % smaller. (A first
measurement showed it larger: that build still had the `bitdepth_*`
features on, and so all of rav1d in it.)

## What would make it the default

Speed, and nothing else that is not already written. In the SIMD variant at
720p, after commit 3, V8's profile of the decode puts the time in inter
prediction (20 %), coefficient reading (13 %), CDEF (12 %), the symbol
decoder (11 %), the rest of prediction (9 %), the loop filter (9 %) and the
inverse transforms (9 %): no single kernel is left to write. (Before commit
3, CDEF alone was about 40 %; in the baseline variant it still is more than
a third.) rivet-av1 is shaped like the specification —
16-bit samples and 32-bit arithmetic at every depth, a frame state copied
per tile worker, buffers allocated per frame — where dav1d and rav1d are
shaped for speed: 8-bit paths with 16-bit lanes, frame threading, pooled
buffers. Closing a factor of two in wasm means doing that in rivet-av1:

- **8-bit sample paths** for prediction, the loop filter and CDEF (most of
  what browsers are sent is 8-bit), with SIMD128 kernels for them. The
  largest piece: weeks, not days, and it has to stay bit-exact against 3 000
  conformance streams.
- **Frame threading**, or at least tile-row parallelism inside one tile, so
  that a single-tile stream (what most encoders produce below 4K) uses the
  cores. A design change to the decoder's frame state. Without it the
  threads variants stay near 1.3 times on the streams most encoders make.
- **The entropy decoder and coefficient reader** tuned for a 32-bit target.

Smaller, and worth doing whatever happens to the above: upstream the three
commits (each stands alone and is additive); reset `seen_frame_header` in
rivet-av1 when a unit fails, so that an embedder need not put delimiters
back; a `flush()`.

When the three commits are in rivet `develop`: `cargo update -p rivet-av1`,
delete the `rivet-av1-pending` feature and its `cfg`s (the code under them
becomes plain `rivet-av1`), delete `docs/rivet-av1-patches/`. Making it the
default after that is a `Cargo.toml` default-features change, a `pkg/`
rebuild and this file's first paragraph.
