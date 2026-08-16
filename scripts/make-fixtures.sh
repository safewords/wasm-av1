#!/usr/bin/env bash
# Regenerate testdata/: small AV1 IVF fixtures plus the MD5 of their decoded
# output as ffmpeg's libdav1d sees it. The Rust tests and the Node tests decode
# each fixture and must reproduce that MD5 exactly — AV1 decoding is normative,
# so any difference is a bug in this crate (or in rav1d).
#
# Needs an ffmpeg with libaom-av1 (encoder) and libdav1d (decoder). Run from the
# repo root. Fixtures are a few hundred KB in total and are committed.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p testdata

# name  size     frames  pix_fmt       extra encoder args
FIXTURES=(
  "testsrc-320x180-8bit     320x180  48  yuv420p     "
  "testsrc-177x99-8bit      177x99   24  yuv420p     "
  "testsrc-160x90-10bit     160x90   24  yuv420p10le "
  "testsrc-96x64-444        96x64    12  yuv444p     "
  "testsrc-96x64-mono       96x64    12  gray        "
  "testsrc-128x72-grain     128x72   24  yuv420p     -denoise-noise-level 25"
)

for spec in "${FIXTURES[@]}"; do
  read -r name size frames pix_fmt extra <<<"$spec"
  ivf="testdata/$name.ivf"
  echo "== $name ($size, $frames frames, $pix_fmt ${extra:-})"
  # testsrc2 is a moving pattern with text; -g 12 forces keyframes so a
  # decoder bug in inter prediction cannot hide behind one long GOP.
  # `-vf format=…` plus an explicit `-s` keeps odd sizes odd; a bare `-pix_fmt`
  # would silently round 177x99 down to 176x98 for subsampled formats.
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "testsrc2=size=${size}:rate=24" -frames:v "$frames" \
    -vf "format=${pix_fmt}" -s "$size" -c:v libaom-av1 -cpu-used 6 -crf 36 -g 12 -row-mt 0 -threads 1 \
    $extra "$ivf"
  # Record what actually got encoded, not what was asked for.
  actual=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$ivf")
  actual_w=${actual%,*}; actual_h=${actual#*,}
  if [ "$actual" != "${size%x*},${size#*x}" ]; then
    echo "note: $name encoded at ${actual_w}x${actual_h}, not $size" >&2
  fi
  # Reference: decode with libdav1d, raw planar output in the stream's own
  # layout, MD5 over all frames concatenated.
  case "$pix_fmt" in
    gray) out_fmt=gray ;;
    *)    out_fmt="$pix_fmt" ;;
  esac
  md5=$(ffmpeg -hide_banner -loglevel error -c:v libdav1d -i "$ivf" \
          -fps_mode passthrough -f rawvideo -pix_fmt "$out_fmt" - | md5sum | cut -d' ' -f1)
  # And a second opinion from libaom, which must agree.
  md5_aom=$(ffmpeg -hide_banner -loglevel error -c:v libaom-av1 -i "$ivf" \
          -fps_mode passthrough -f rawvideo -pix_fmt "$out_fmt" - | md5sum | cut -d' ' -f1)
  if [ "$md5" != "$md5_aom" ]; then
    echo "libdav1d and libaom disagree on $name: $md5 vs $md5_aom" >&2
    exit 1
  fi
  # width height frames pix_fmt md5 — one line, read by tests/decode.rs and test/decode.test.mjs
  echo "$actual_w $actual_h $frames $out_fmt $md5" > "testdata/$name.ref"
  cat "testdata/$name.ref"
done
ls -la testdata/*.ivf

# Container fixtures for the rivet-container path: the same AV1 stream as
# testsrc-320x180-8bit.ivf remuxed (no re-encode) into a plain MP4, a
# fragmented/CMAF-style MP4 (init + moof/mdat per keyframe, the shape lewd.net
# serves), and WebM. Decoding any of them must reproduce that fixture's MD5.
src=testdata/testsrc-320x180-8bit.ivf
ffmpeg -hide_banner -loglevel error -y -i "$src" -c:v copy -movflags +faststart testdata/testsrc-320x180-8bit.mp4
ffmpeg -hide_banner -loglevel error -y -i "$src" -c:v copy -f mp4 -movflags frag_keyframe+empty_moov+default_base_moof+dash testdata/testsrc-320x180-8bit.fmp4
ffmpeg -hide_banner -loglevel error -y -i "$src" -c:v copy -f webm testdata/testsrc-320x180-8bit.webm
for f in mp4 fmp4 webm; do
  printf '%-40s %s bytes  %s\n' "testsrc-320x180-8bit.$f" "$(stat -c %s testdata/testsrc-320x180-8bit.$f)" \
    "$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height,time_base -of csv=p=0 testdata/testsrc-320x180-8bit.$f)"
done

# CMAF as HLS serves it: an init segment plus 1-second fMP4 media segments,
# for the segment-fed API (setInitSegment / pushSegment). Same stream again.
rm -rf testdata/cmaf && mkdir -p testdata/cmaf
ffmpeg -hide_banner -loglevel error -y -i "$src" -c:v copy -f hls -hls_segment_type fmp4 -hls_time 1 \
  -hls_playlist_type vod -hls_fmp4_init_filename init.mp4 -hls_segment_filename testdata/cmaf/seg%d.m4s testdata/cmaf/index.m3u8
ls testdata/cmaf
