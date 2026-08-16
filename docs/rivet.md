# rivet-container: containers demuxed inside the wasm

`rivet` (https://github.com/rivet-transcoder/rivet) is an open-source
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

The demuxers add ~600 KB uncompressed / ~220 KB gzipped to each variant
(1.09 → 1.69 MB baseline). `twiggy` attributes ~446 KB to
`setSourceContainer`: three monomorphisations of the `mp4` crate's box readers
(probe + streaming + legacy paths), Matroska open, and the audio-track and
subtitle extraction rivet does at construction. It is all reachable through
`demux_streaming_shared`, so LTO cannot drop it. The trim is rivet-side:
cargo features on `rivet-container` for per-format demuxers and for audio
extraction, and constructing the MP4 reader once. Until then, builds that do
not need containers use `FEATURES=bitdepth_8,bitdepth_16 scripts/build.sh`.

## Licence note

rivet is under the Open Encoding Attribution License 1.0 (source-available,
attribution for commercial use). Bundling `rivet-container` into a shipped
.wasm is distribution under that licence; keep its notice (see NOTICE here).
