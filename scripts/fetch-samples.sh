#!/usr/bin/env bash
# Pull real-content AV1 clips into testdata/samples/ for the demo page and
# scripts/bench.mjs — not committed (the "pull from upstream rather than
# vendor" rule applied to test data).
#
# Why not upstream wasm-av1's own two clips: they were encoded in 2018 with a
# pre-1.0 libaom, before the AV1 bitstream froze. Nothing current decodes them
# (libdav1d and today's libaom both refuse), only the libaom snapshot upstream
# vendored. These are Big Buck Bunny / Sintel (CC-BY) as AV1-in-MP4 from
# test-videos.co.uk, 10 s at 30 fps, remuxed to IVF by ffmpeg with `-c copy`.
# The .mp4 is kept next to it for a future fMP4 → temporal-unit path test.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p testdata/samples
base=https://test-videos.co.uk/vids
clips=(
  "bbb-360p   bigbuckbunny/mp4/av1/360/Big_Buck_Bunny_360_10s_5MB.mp4"
  "bbb-720p   bigbuckbunny/mp4/av1/720/Big_Buck_Bunny_720_10s_5MB.mp4"
  "bbb-1080p  bigbuckbunny/mp4/av1/1080/Big_Buck_Bunny_1080_10s_5MB.mp4"
  "sintel-1080p sintel/mp4/av1/1080/Sintel_1080_10s_5MB.mp4"
)
for spec in "${clips[@]}"; do
  read -r name rel <<<"$spec"
  mp4="testdata/samples/$name.mp4"
  ivf="testdata/samples/$name.ivf"
  if [ ! -s "$mp4" ]; then
    echo "fetching $name"
    curl -fsSL -A "wasm-av1-samples/1.0" "$base/$rel" -o "$mp4.part" && mv "$mp4.part" "$mp4"
  fi
  if [ ! -s "$ivf" ]; then
    ffmpeg -hide_banner -loglevel error -y -i "$mp4" -an -c:v copy -f ivf "$ivf"
    # Reference MD5 of the decoded planes (libdav1d), for bench.mjs --verify.
    ffmpeg -hide_banner -loglevel error -c:v libdav1d -i "$ivf" -fps_mode passthrough -f rawvideo -pix_fmt yuv420p - \
      | md5sum | cut -d' ' -f1 > "$ivf.md5"
  fi
  printf '%-14s %s  md5 %s\n' "$name" "$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate,nb_frames -of csv=p=0 "$ivf")" "$(cat "$ivf.md5")"
done
