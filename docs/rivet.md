# rivet-container: containers demuxed inside the wasm

`rivet` (https://github.com/rivet-transcoder/rivet) is a source-available
transcoding library in Rust. Its `rivet-container` crate demuxes MP4/MOV, fragmented MP4 (moof/trun,
i.e. CMAF), Matroska/WebM, MPEG-TS and AVI, and hands out video samples as
codec-native bitstreams — raw OBUs for AV1 — with pts and duration:

```rust
let d = container::streaming::demux_streaming_shared(bytes)?;   // Box<dyn StreamingDemuxer>
d.header()                       // codec, StreamInfo, timescale
d.next_video_sample()?           // Sample { data, pts_ticks, duration_ticks }
```

That is exactly what `Decoder::push_temporal_unit` wants, so with the
`container` feature (default on) `Decoder::set_source_container` /
`Av1Decoder.setSourceContainer` / `Decoder.setSource` in JS take a whole file
and the demux happens in wasm. Verified: MP4, fMP4 and WebM remuxes of the
320×180 fixture decode to the IVF's MD5, natively and in both wasm variants;
Playwright plays fMP4/MP4/WebM in Chromium and Firefox.

## What had to change in rivet (merged into `develop` as `89be431`)

`rivet-container` hard-depended on `rivet-codec`, whose dependency tree
(`libloading` dlopen for the GPU SDKs, `nvml-wrapper-sys`, the `minimp3` and
`audiopus` C builds, crates.io rav1d) cannot build for wasm32; the check dies
in `nvml-wrapper-sys` before reaching the demuxer. All that container used
from codec was nine plain value types (`codec::frame::*`), the 3-field
`EncodedPacket`, and the pure-Rust bitstream sniffing in `codec::pixel_format`.

The change (`89be431`, off `develop` at `1a6682a`, fast-forwarded into
`develop`) moves those into a new dependency-free crate **`rivet-frame`** (imported as `frame`), makes
`rivet-container` depend on that instead (rivet-codec becomes a
dev-dependency for one test), and has `rivet-codec` re-export everything at
the old paths (`codec::frame`, `codec::pixel_format`,
`codec::encode::EncodedPacket`) so no caller changes. It also adds
`DemuxHeader::timescale` (+ `pts_seconds()`), because pts without a unit
cannot pace playback.

Verified there: `cargo check -p rivet-container --target wasm32-unknown-unknown`
clean; on the Linux dev box `cargo check --workspace --lib --bins` clean and
`cargo test -p rivet-frame -p rivet-container` green except one pre-existing
failure (`create_decoder_accepts_prores_codec_label`, needs a ProRes decoder
feature; fails identically on `develop`). `--all-targets` additionally hits
`crates/codec/tests/nvdec_smoke.rs` needing `--features nvidia` — also
pre-existing.

`Cargo.toml` here points at rivet `develop`; `Cargo.lock` pins the revision.
**Nothing of rivet is vendored here.**

## Segment-fed input (what HLS/CMAF needs)

rivet's demuxers are whole-buffer and forward-only, so for segmented delivery
the decoder keeps the initialisation segment and demuxes each media segment
as `init ‖ segment` (`Decoder::set_init_segment` / `push_segment`,
`setInitSegment` / `pushSegment` in wasm and JS): rivet yields the samples
with pts in the track timescale and they are queued as temporal units — the
decoder is *not* reset between segments, so frames flow continuously across
segment boundaries. Tested with `testdata/cmaf/` (init + two 1 s segments):
same MD5 as the whole file, pts continuous. `js/hls.js` builds on it.

## Cost and how to shrink it

Most of every `.wasm` is the demuxers. Measured on 2026-11-12 without
`wasm-opt`: the baseline variant is 3 026 836 bytes (963 810 gzip) with the
`container` feature and 681 404 (268 412 gzip) without it. (An earlier
measurement, of a `wasm-opt` build of 0.x with rav1d, had them add ~600 KB
uncompressed / ~220 KB gzipped: 1.09 → 1.69 MB baseline.) `twiggy` then
attributed ~446 KB to
`setSourceContainer`: three monomorphisations of the `mp4` crate's box readers
(probe + streaming + legacy paths), Matroska open, and the audio-track and
subtitle extraction rivet does at construction. It is all reachable through
`demux_streaming_shared`, so LTO cannot drop it. The trim is rivet-side:
cargo features on `rivet-container` for per-format demuxers and for audio
extraction, and constructing the MP4 reader once. Until then, builds that do
not need containers use `FEATURES= scripts/build.sh` (`FEATURES` set to
nothing: no default features).

## rivet's AV1 decoder

rivet has an AV1 decoder of its own, `rivet-av1` (`crates/av1`, a submodule:
`safewords/rivet-av1`). Since 0.3.0 it is this crate's decoder — the same
git dependency on rivet `develop`, a second package of it, so one revision
in `Cargo.lock` pins both and `cargo update -p rivet-av1` moves both. It
needed changes in rivet-av1 as `rivet-container` once needed the one above;
they are upstream: [rivet-av1.md](rivet-av1.md).

## Licence note

rivet is under the Open Encoding Attribution License 1.0: source-available,
not open source, with a short visible credit required of commercial use
that reaches third parties. Every `.wasm` built here contains `rivet-av1`,
and `rivet-container` too with the `container` feature; shipping one is
distribution under that licence, which asks for a copy of the licence and
its notices to go with it (see NOTICE here).
