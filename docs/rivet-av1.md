# rivet-av1: the decoder core

**Where this stands (2026-11-12).** Since 0.3.0 wasm-av1 decodes with
rivet's own AV1 decoder and nothing else. rav1d, the core of 0.1.0 to 0.2.2,
is gone: the dependency, its fork, its adapter and the Cargo features that
selected it.

**It is slower than what it replaced, and that is the state of this
project.** In WebAssembly rivet-av1 decodes 8-bit video at a third to two
thirds of rav1d's rate on one thread (0.33 to 0.63 times across the streams
measured, baseline and SIMD variants alike), and it gains far less from
threads: on eight, a 720p or 1080p stream with one tile decodes at a sixth
to a fifth of rav1d's rate. A software decoder for devices that have no AV1
hardware is judged on exactly that. The work to close it is under way in
rivet-av1 ([below](#closing-the-gap)); the tables on this page are the
baseline it is measured against, which is why the rav1d columns stay. The
output is bit-exact, on every fixture, in every variant, natively and in
Node, and (as measured before rav1d was removed) in a browser.

## What rivet-av1 is

`rivet-av1` (imported as `av1`) is `crates/av1` of
[rivet](https://github.com/rivet-transcoder/rivet), a git submodule there
whose own repository is `https://github.com/safewords/rivet-av1`. This crate
takes it from rivet `main` (`develop` until 2026-11-13, when rivet's `main` was brought up to it), the same git source as `rivet-container`;
`Cargo.lock` pins the rivet revision, and rivet pins the submodule: rivet
`develop` at `b580fc6`, which has rivet-av1 at `3c2c549`, the first
revision with everything 0.3.0 needs. Read from its
source and README, and checked where it says so below:

- **A decoder and an encoder**, about 21 000 lines of Rust, written from the
  AV1 specification and not derived from dav1d, rav1d or libaom. One
  dependency (`thiserror`), no build script, no C, no libc. The encoder is
  dead code to this crate and LTO drops it.
- **The decoder is complete for what this crate serves**: profiles 0, 1 and
  2; 8, 10 and 12 bits; monochrome, 4:2:0, 4:2:2 and 4:4:4; film grain
  synthesis, which `Decoder::set_apply_grain(false)` leaves out; scalable
  streams (operating point selection); Annex B as well as the low-overhead
  format. Not there: large-scale tile (tile list OBUs return
  `Error::Unsupported`; nothing here needs it), frame threading, and
  concealment of a damaged frame.
- **Conformance, as its README states it**: all 244 of AOMedia's public
  `av1-1-b8-*` / `av1-1-b10-*` vectors and all 3 015 Argon streams, every
  output byte. **Checked here**: this crate's six fixtures on every commit
  (CI), and on 2026-11-12 the 12 vectors committed in its `tests/data` and
  four SVT-AV1 clips (720p and 1080p, 8 and 10 bit) against libdav1d's MD5.
  Not run here: the 244 (a download) and Argon (a 7 GB suite).
- **It builds for `wasm32-unknown-unknown` as it is**, with std and without
  a libc.
- **SIMD**: AVX2 chosen at run time on x86-64 and NEON on aarch64, in the
  CDEF filter, the 8-tap interpolation filters, the inverse transforms and
  the loop filter. On wasm32, in a module built with `simd128`: a `v128`
  CDEF block filter and the inverse transforms' vector lanes. Nothing else
  has a wasm kernel.
- **Threads**: `Decoder::set_threads(n)` decodes the tiles of a frame in
  parallel and runs the loop filter, CDEF and loop restoration in bands.
  Frames are decoded one after another. Each parallel job goes to scoped
  threads (`std::thread::scope`), or to the `av1::parallel::Runner` an
  embedder registered, which is how this crate gives it Web Workers.
- **The API**: `Decoder::new()`, then `decode_all(&temporal_unit)` returns
  the frames that unit shows, each one buffer of packed planes (Y, U, V, no
  padding, little-endian `u16` above 8 bits). That is the layout of this
  crate's `Frame`, so a frame is taken, not copied. No timestamps and no
  flush.
- **Licence**: the Open Encoding Attribution License 1.0, as
  `rivet-container`: source-available and not open source, the NOTICE
  carried forward with any distribution, a short credit for commercial use
  that reaches third parties. This crate's own code stays Apache-2.0; every
  `.wasm` it builds now contains code under the other licence, with or
  without the `container` feature. `NOTICE` says so. (0.2.x linked rav1d,
  BSD-2-Clause; no BSD code is left.)

## What this crate needs from a core, and how rivet-av1 meets it

| Requirement here | rivet-av1 | How it is met |
|---|---|---|
| Bit-exact AV1 at 8 and 10 bits, 4:2:0, 4:4:4, mono, film grain, odd sizes | Yes | Nothing to do |
| Builds for `wasm32-unknown-unknown`, baseline and `+simd128` | Yes | Nothing to do |
| A temporal unit in, frames with its pts out | Frames, no pts | Glue: `src/core.rs` stamps the unit's pts on the frames it showed |
| A reset for a seek that keeps the threads | No flush | Glue: a new `av1::Decoder`; the threads are a pool outside it |
| Samples from MP4 or Matroska, which carry no temporal delimiter; a damaged unit must not end the stream | An unfinished frame is only forgotten at a temporal delimiter | Glue: a delimiter goes in front of every unit. Measured on an SVT-AV1 stream with one unit cut after its frame header: without it 3 frames of 60 and "OBU_FRAME while a frame is in progress" from then on; with it all 60. Worth fixing in rivet-av1 too (reset on error) |
| `Config::apply_grain = false` | `Decoder::set_apply_grain` (rivet-av1 `baeb7e8`) | `src/core.rs` passes it on |
| Threads in the `threads` variants: no `std::thread::spawn` on wasm, a thread is a Worker the page creates | `av1::parallel`: an embedder registers a `Runner` (rivet-av1 `d041af0`) | A pool of Workers in `src/threads.rs` is that runner |
| The SIMD variant is faster than the baseline one | A SIMD128 CDEF kernel and vector lanes for the inverse transforms (rivet-av1 `3c2c549`) | 1.3 to 2.1 times the baseline. Before that commit: 1.05 to 1.16 |
| As fast as the core it replaced | On one thread in wasm: 0.33 to 0.63 times rav1d on 8-bit streams, 0.83 to 0.97 on 10-bit in the SIMD variant (rav1d's wasm kernels were 8-bit only) | **Open.** See [closing the gap](#closing-the-gap) |
| Scales with threads as rav1d did (3.5 times on 8 here; 5 times at 1080p in Chromium, [performance.md](performance.md)) | Tiles and filter bands only: 1.2 to 1.3 times on 8 for a one-tile stream, 3.3 for eight tiles | **Open.** Frame threading in rivet-av1 |
| An 8-bit-only build that is smaller (`bitdepth_8` in 0.2.x) | One code path for every depth | **Gone.** The `bitdepth_8` and `bitdepth_16` features are removed; every build decodes every depth. The decoder is also much smaller than rav1d was, see [size](#size) |

## How it is wired in

`src/decoder.rs` drives a private `Core` (`src/core.rs`) through four calls:
`open`, `flush`, `send` and `picture`. rivet-av1 decodes a unit inside
`send`, so nothing is ever half taken or in flight; the only frames waiting
between calls are those of the last unit that did not fit into the ring.
`Error::Decode` carries rivet-av1's error, exported as
`wasm_av1::CoreError` (`av1::Error`: `Bitstream`, `Unsupported` or
`InvalidInput`, each with a message).

On wasm with threads (`src/threads.rs`, `mod pool`): rivet-av1 hands each
parallel job to the registered `Runner`. The pool is that runner. It asks the
page for `threads - 1` Workers once (`__wasmAv1SpawnThread`, answered with
`pkg/thread-worker.js`), each waits on a condvar, and a job goes to those
that are waiting. The decoding thread always works on the job itself and a
job is a loop over a shared queue, so a Worker that has not started yet is
not waited for, and a decoder that is flushed or dropped leaves the pool as
it is.

Three commits in rivet-av1 made this possible without a fork: `baeb7e8`
(`Decoder::set_apply_grain`), `d041af0` (`av1::parallel`) and `3c2c549` (the
wasm32 SIMD128 kernels). They were written for this crate on 2026-11-12,
carried here as patches for a day behind a `rivet-av1-pending` feature, and
are in rivet-av1 `develop`; the feature and the patches are gone.

## What it replaced

0.1.0 to 0.2.2 decoded with [rav1d](https://github.com/memorysafety/rav1d),
the Rust port of dav1d (BSD-2-Clause), from the fork
`https://github.com/safewords/rav1d` at `6f780a0`: upstream `main` of
2026-08-14 plus five commits (a build without libc for
`wasm32-unknown-unknown`, no panic on a damaged temporal unit, wasm32
SIMD128 kernels for 8-bit motion compensation, warp, CDEF and the loop
filter, worker threads on wasm through an embedder spawner, and a flush that
drops pending input). That build is the "rav1d" column of every table here
and in [performance.md](performance.md), and the committed `pkg/` of 0.2.2.

What went with it, besides speed:

- **Frame threading.** rav1d decoded several frames at once (dav1d's task
  pool) and delivered them a few frames late; `Decoder` had an end-of-input
  drain for that. rivet-av1 threads tiles and post-filter bands inside one
  frame; the drain is gone and `finished()` is true as soon as the last
  frame is popped.
- **Concealment.** rav1d carried on from a damaged frame with what it had.
  rivet-av1 returns an error and decoding resumes cleanly at the next
  keyframe. Either way the unit counts in `decode_errors` and the decoder
  stays usable.
- **The fork**, and `parking_lot_core`'s `nightly` feature that rav1d's
  mutexes needed on wasm with atomics. rivet-av1 waits on std's.
- **rav1d's C API in the `.wasm`** (`dav1d_open` and the rest, 20
  `#[no_mangle]` symbols in the 0.2.2 build, which a `cdylib` kept and
  nothing called).

## Building and testing it

There is nothing to switch on:

```bash
cargo test --release                       # and --no-default-features, without the demuxers
scripts/build.sh && node --test test/decode.test.mjs
```

To build against a rivet-av1 checkout of your own (a change you are making
there), use Cargo's path override; `Cargo.lock` is not rewritten:

```bash
git clone https://github.com/safewords/rivet-av1 ../rivet-av1
cargo test --release --config "paths=['$PWD/../rivet-av1']"
```

Put `--config` after the subcommand (`cargo clippy --config …`), or `cargo
clippy` does not pass it on. `scripts/build.sh` takes no such flag; run it
with a `cargo` wrapper on `PATH` that adds it.

`scripts/build.sh` writes into the committed `pkg/`. Commit a `pkg/` only
from CI's build (it runs a pinned `wasm-opt`); `git checkout -- pkg` undoes
a local one.

## What was run, and what it gave

Two rounds, both on 2026-11-12, one machine (Apple silicon, macOS, Rust
1.100.0, Node 26 / V8), `.wasm` built by `scripts/build.sh` without
`wasm-opt`.

**The comparison** was made while both cores were in the tree. In the
tables, `rivet-av1` is rivet-av1 at `3abbfe2`, before the three commits
above; `+3` is with them, which is what 0.3.0 builds.

**Correctness.** `cargo test --release` with each core, and each without
`container`: every fixture's MD5 (8-bit, 10-bit,
4:4:4, mono, film grain, 177×99), 2 and 4 threads, flush at every point,
push mode, MP4 / fMP4 / WebM, CMAF segments, rendition switches.
`node --test test/decode.test.mjs` against the baseline and SIMD builds of
each: 10 of 10. The four SVT-AV1 clips and four AOM vectors below: the same
MD5 from both cores natively and in the baseline and SIMD builds, and
libdav1d's where there is one. In a
browser (Chromium 156, a cross-origin-isolated page, a decode Worker through
`WorkerDecoder`, thread Workers through `pkg/thread-worker.js`): all four
variants of the rivet-av1 build with the three commits, on 1, 2, 4 and 8 threads, give
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
time only.

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

### Size

Bytes of the `.wasm`, without `wasm-opt` (CI's builds, with it, are about
5% smaller: 2 862 132 for the rivet-av1 baseline and 3 302 417 for the last
rav1d commit, both on 2026-11-12; the 1 700 331 that 0.2.2 shipped predates
the rivet-container update of 2026-11-06), all with the `container` feature:

| variant | rav1d | rivet-av1 at `3abbfe2` | rivet-av1 +3 |
|---|---|---|---|
| baseline | 3 499 130 (1 088 925 gzip) | 3 030 581 (964 959) | 3 029 839 (964 657) |
| simd | 3 836 610 (1 213 343) | 3 297 245 (1 063 212) | 3 471 720 (1 101 730) |
| threads | 3 519 437 (1 087 402) | 3 072 972 (967 803) | 3 074 489 (968 688) |
| simd-threads | 3 858 441 (1 213 393) | 3 342 156 (1 070 313) | 3 518 893 (1 108 327) |

rivet-av1 is 9 to 13 % smaller. Most of either is the demuxers: 0.3.0
without the `container` feature (`FEATURES= scripts/build.sh`) is 681 404
bytes baseline (268 412 gzip) and 871 349 SIMD (314 461 gzip), so
`rivet-container` is 2.3 MB of the 3.0.

**After rav1d was removed** (the tree of 0.3.0, built from `Cargo.lock`
alone: rivet `b580fc6`, rivet-av1 `3c2c549`): `cargo fmt --all --check`, `cargo clippy
--all-targets -- -D warnings`, `cargo test --release` with and without
`container` (every fixture's MD5 on 1, 2 and 4 threads; film grain on and
off; flush at every point; push mode; MP4 / fMP4 / WebM; CMAF segments;
rendition switches), the `wasm_convert` tests in wasm with and without
`+simd128`, `scripts/build.sh` for the four variants and `node --test
test/decode.test.mjs` against them: 20 of 20, among them every fixture's MD5
in the baseline and SIMD builds, with film grain left out, and in the
`threads` and `simd-threads` builds on 1, 2, 4 and 8 threads with each wasm
thread a `worker_threads` Worker (`test/threads-node.mjs`). Sizes: 3 026 836
baseline (963 810 gzip), 3 468 802 SIMD (1 100 981), 3 071 679 threads
(968 050), 3 516 203 SIMD + threads (1 107 984). The SIMD + threads build
in Node on the two mandelbrot 720p clips of the threads table, median of 3
with other builds running on the machine: one tile 63.3, 59.3, 76.3, 79.9
frames per second on 1, 2, 4 and 8 threads; eight tiles 63.5, 110.5, 164.5,
211.8 (3.3 times); libdav1d's MD5 every time. Those agree with the rows
above: taking rav1d out changed nothing in rivet-av1's own numbers. Not run in this round: any browser
(`test/browser.mjs` needs Playwright, which is not installed here), and the
single-thread throughput table.

## Closing the gap

Speed is what is missing, and the work on it is under way in rivet-av1, not
here: this crate is glue, and nothing in the glue is measurable next to the
decoder. In the SIMD variant at 720p, V8's profile of the decode puts the
time in inter prediction (20 %), coefficient reading (13 %), CDEF (12 %),
the symbol decoder (11 %), the rest of prediction (9 %), the loop filter
(9 %) and the inverse transforms (9 %): no single kernel is left to write.
(Before the CDEF kernel, CDEF alone was about 40 %; in the baseline variant
it still is more than a third.) rivet-av1 is shaped like the specification —
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

Smaller, and worth doing whatever happens to the above: reset
`seen_frame_header` in rivet-av1 when a unit fails, so that an embedder need
not put delimiters back; a `flush()`.

Taking an improvement from rivet-av1 here is `cargo update -p rivet-av1`
once rivet `develop` has moved its submodule (it moves `rivet-container`
with it: run the container tests), then CI's `pkg/`. Re-measure with the
tables above; the rav1d columns do not change.
