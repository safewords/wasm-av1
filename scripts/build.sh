#!/usr/bin/env bash
# Build the two WebAssembly variants and their JS glue into pkg/:
#
#   pkg/baseline/wasm_av1.js + wasm_av1_bg.wasm   post-MVP wasm, no SIMD
#   pkg/simd/wasm_av1.js     + wasm_av1_bg.wasm   + simd128 (NEON / SSE in the browser's JIT)
#
# js/loader.js picks one at runtime by feature detection. Both are wasm-bindgen
# `--target web` modules (an `init(url_or_bytes)` default export), which work
# from a page, a Worker, Vite, and Node alike.
#
# Requires: the pinned Rust toolchain (rust-toolchain.toml), wasm-bindgen-cli at
# the version Cargo.lock pins for the wasm-bindgen crate, and — optionally —
# binaryen's wasm-opt, which shaves ~15% off and is skipped with a note if absent.
#
#   scripts/build.sh            # release, both variants
#   scripts/build.sh --dev      # unoptimised, with debug info
#   FEATURES=bitdepth_8 scripts/build.sh   # 8-bit-only decoder (smaller)
set -euo pipefail
cd "$(dirname "$0")/.."

PROFILE=release
CARGO_PROFILE_FLAG=--release
if [ "${1:-}" = "--dev" ]; then
  PROFILE=debug
  CARGO_PROFILE_FLAG=""
fi
FEATURES="${FEATURES:-}"
FEATURE_FLAGS=()
if [ -n "$FEATURES" ]; then
  FEATURE_FLAGS=(--no-default-features --features "$FEATURES")
fi

want_bindgen=$(sed -n '/^name = "wasm-bindgen"$/{n;s/version = "\(.*\)"/\1/p}' Cargo.lock)
have_bindgen=$(wasm-bindgen --version | awk '{print $2}')
if [ "$want_bindgen" != "$have_bindgen" ]; then
  echo "wasm-bindgen-cli $have_bindgen does not match the wasm-bindgen crate $want_bindgen in Cargo.lock." >&2
  echo "  cargo install wasm-bindgen-cli --version $want_bindgen --locked" >&2
  exit 1
fi

build_variant() {
  local name="$1" rustflags="$2"
  local target_dir="target/wasm-$name"
  echo "== $name  (RUSTFLAGS='$rustflags')"
  RUSTFLAGS="$rustflags" cargo build --lib --target wasm32-unknown-unknown $CARGO_PROFILE_FLAG \
    "${FEATURE_FLAGS[@]}" --target-dir "$target_dir"
  local wasm="$target_dir/wasm32-unknown-unknown/$PROFILE/wasm_av1.wasm"
  rm -rf "pkg/$name"
  mkdir -p "pkg/$name"
  wasm-bindgen "$wasm" --target web --out-dir "pkg/$name" --out-name wasm_av1 \
    $( [ "$PROFILE" = release ] && echo --remove-name-section --remove-producers-section || echo --keep-debug )
  if [ "$PROFILE" = release ]; then
    if command -v wasm-opt >/dev/null 2>&1; then
      local flags=(-O3 --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals --enable-reference-types --enable-multivalue)
      [ "$name" = simd ] && flags+=(--enable-simd)
      wasm-opt "${flags[@]}" "pkg/$name/wasm_av1_bg.wasm" -o "pkg/$name/wasm_av1_bg.wasm"
    else
      echo "   (wasm-opt not found; shipping the unoptimised .wasm — install binaryen for ~15% smaller)"
    fi
  fi
  ls -la "pkg/$name/wasm_av1_bg.wasm" | awk '{print "   " $5 " bytes  " $9}'
}

# Baseline: rustc's default feature set for wasm32-unknown-unknown
# (bulk-memory, sign-ext, mutable-globals, nontrapping-fptoint, reference-types,
# multivalue) — Chrome 96+, Firefox 89+, Safari 15+.
build_variant baseline ""
# SIMD: adds simd128 — Chrome 91+, Firefox 89+, Safari 16.4+. Same source; the
# whole of rav1d gets vectorised loops and convert.rs takes its v128 path.
build_variant simd "-C target-feature=+simd128"

# A tiny manifest so consumers can read sizes/versions without loading anything.
cat > pkg/manifest.json <<EOF
{
  "version": "$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)",
  "rav1d": "$(sed -n '/^name = "rav1d"$/{n;n;s/source = ".*#\(.*\)"/\1/p}' Cargo.lock)",
  "profile": "$PROFILE",
  "features": "${FEATURES:-default}",
  "variants": {
    "baseline": { "wasm": "baseline/wasm_av1_bg.wasm", "js": "baseline/wasm_av1.js", "bytes": $(stat -c %s pkg/baseline/wasm_av1_bg.wasm) },
    "simd":     { "wasm": "simd/wasm_av1_bg.wasm",     "js": "simd/wasm_av1.js",     "bytes": $(stat -c %s pkg/simd/wasm_av1_bg.wasm) }
  }
}
EOF
cat pkg/manifest.json
