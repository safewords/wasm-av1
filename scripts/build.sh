#!/usr/bin/env bash
# Build the four WebAssembly variants and their JS glue into pkg/:
#
#   pkg/baseline/      post-MVP wasm, no SIMD
#   pkg/simd/          + simd128 (NEON / SSE in the browser's JIT)
#   pkg/threads/       baseline + atomics and shared memory: rav1d's worker
#                      threads run as Web Workers (pkg/thread-worker.js)
#   pkg/simd-threads/  both
#
# each `wasm_av1.js + wasm_av1_bg.wasm`. js/loader.js picks one at runtime by
# feature detection (the threads ones only on a cross-origin-isolated page).
# All are wasm-bindgen `--target web` modules (an `init(...)` default export),
# which work from a page, a Worker, Vite, and Node alike.
#
# The threads variants need std rebuilt with atomics (`-Zbuild-std`, hence
# `rust-src` in rust-toolchain.toml and RUSTC_BOOTSTRAP=1 on the pinned stable
# toolchain) and the shared-memory linker flags rustc no longer adds itself.
#
# Requires: the pinned Rust toolchain (rust-toolchain.toml), wasm-bindgen-cli at
# the version Cargo.lock pins for the wasm-bindgen crate, and — optionally —
# binaryen's wasm-opt, which shaves ~15% off and is skipped with a note if absent.
#
#   scripts/build.sh            # release, all variants
#   scripts/build.sh --dev      # unoptimised, with debug info
#   FEATURES=bitdepth_8 scripts/build.sh   # 8-bit-only decoder (smaller)
#   VARIANTS="simd simd-threads" scripts/build.sh   # a subset
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

# Shared memory + atomics: the linker flags rustc used to add for `+atomics`
# on wasm32-unknown-unknown and no longer does. 1 GiB maximum (shared memory
# must declare one; virtual until grown into). The TLS exports are what
# wasm-bindgen's threads transform needs to give each thread its own TLS.
THREADS_LINK="-C link-arg=--shared-memory -C link-arg=--max-memory=1073741824 -C link-arg=--import-memory -C link-arg=--export=__wasm_init_tls -C link-arg=--export=__tls_size -C link-arg=--export=__tls_align -C link-arg=--export=__tls_base"

build_variant() {
  local name="$1" rustflags="$2" threads="${3:-no}"
  local target_dir="target/wasm-$name"
  echo "== $name  (RUSTFLAGS='$rustflags')"
  local -a std_flags=()
  local bootstrap=""
  if [ "$threads" = threads ]; then
    std_flags=(-Zbuild-std=std,panic_abort)
    bootstrap=1
  fi
  RUSTC_BOOTSTRAP="$bootstrap" RUSTFLAGS="$rustflags" cargo build --lib --target wasm32-unknown-unknown $CARGO_PROFILE_FLAG \
    "${FEATURE_FLAGS[@]}" "${std_flags[@]}" --target-dir "$target_dir"
  local wasm="$target_dir/wasm32-unknown-unknown/$PROFILE/wasm_av1.wasm"
  rm -rf "pkg/$name"
  mkdir -p "pkg/$name"
  wasm-bindgen "$wasm" --target web --out-dir "pkg/$name" --out-name wasm_av1 \
    $( [ "$PROFILE" = release ] && echo --remove-name-section --remove-producers-section || echo --keep-debug )
  if [ "$PROFILE" = release ]; then
    if command -v wasm-opt >/dev/null 2>&1; then
      local flags=(-O3 --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals --enable-reference-types --enable-multivalue)
      case "$name" in simd*) flags+=(--enable-simd);; esac
      [ "$threads" = threads ] && flags+=(--enable-threads)
      wasm-opt "${flags[@]}" "pkg/$name/wasm_av1_bg.wasm" -o "pkg/$name/wasm_av1_bg.wasm"
    else
      echo "   (wasm-opt not found; shipping the unoptimised .wasm — install binaryen for ~15% smaller)"
    fi
  fi
  ls -la "pkg/$name/wasm_av1_bg.wasm" | awk '{print "   " $5 " bytes  " $9}'
}

VARIANTS="${VARIANTS:-baseline simd threads simd-threads}"
for v in $VARIANTS; do
  case "$v" in
    # Baseline: rustc's default feature set for wasm32-unknown-unknown
    # (bulk-memory, sign-ext, mutable-globals, nontrapping-fptoint, reference-types,
    # multivalue) — Chrome 96+, Firefox 89+, Safari 15+.
    baseline) build_variant baseline "" ;;
    # SIMD: adds simd128 — Chrome 91+, Firefox 89+, Safari 16.4+. Same source; the
    # whole of rav1d gets vectorised loops and convert.rs takes its v128 path.
    simd) build_variant simd "-C target-feature=+simd128" ;;
    # Threads: atomics + shared memory (Chrome 74+/Firefox 79+/Safari 15.2+ on
    # a cross-origin-isolated page). rav1d's worker threads become Workers.
    threads) build_variant threads "-C target-feature=+atomics,+bulk-memory,+mutable-globals $THREADS_LINK" threads ;;
    simd-threads) build_variant simd-threads "-C target-feature=+simd128,+atomics,+bulk-memory,+mutable-globals $THREADS_LINK" threads ;;
    *) echo "unknown variant $v" >&2; exit 1 ;;
  esac
done

# The thread Worker script sits in pkg/ next to the variants it instantiates
# (loader.js resolves ../thread-worker.js from a variant's glue URL).
cp js/thread-worker.js pkg/thread-worker.js

# A tiny manifest so consumers can read sizes/versions without loading anything.
cat > pkg/manifest.json <<EOF
{
  "version": "$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)",
  "rav1d": "$(sed -n '/^name = "rav1d"$/{n;n;s/source = ".*#\(.*\)"/\1/p}' Cargo.lock)",
  "profile": "$PROFILE",
  "features": "${FEATURES:-default}",
  "threadWorker": "thread-worker.js",
  "variants": {
$(first=1; for v in $VARIANTS; do
    [ -n "$first" ] || echo ","
    first=""
    printf '    "%s": { "wasm": "%s/wasm_av1_bg.wasm", "js": "%s/wasm_av1.js", "bytes": %s }' "$v" "$v" "$v" "$(stat -c %s pkg/$v/wasm_av1_bg.wasm)"
  done; echo)
  }
}
EOF
cat pkg/manifest.json
