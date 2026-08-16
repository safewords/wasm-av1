//! # wasm-av1
//!
//! AV1 decoding for the browser, in Rust: [rav1d] (the Rust port of dav1d)
//! compiled to WebAssembly, behind the small streaming API that
//! [GoogleChromeLabs/wasm-av1] put in front of libaom — ported here from C.
//!
//! The crate builds three ways:
//!
//! * **native** (`cargo build`, `cargo test`): the same decoder as a Rust
//!   library, used by the CLI harness in `examples/` and the tests, which
//!   compare against ffmpeg-decoded reference MD5s.
//! * **wasm32 baseline**: `cargo build --target wasm32-unknown-unknown` — runs
//!   in every browser with post-MVP wasm (Chrome 96 / Firefox 89 / Safari 15).
//! * **wasm32 SIMD**: the same, with `-C target-feature=+simd128`; rav1d's
//!   inner loops autovectorise and the RGBA conversion has an explicit `v128`
//!   path. On ARM this is what becomes NEON. `scripts/build.sh` produces both;
//!   `js/` picks at runtime.
//!
//! Module map — each is a piece of the upstream C, named in its docs:
//!
//! | module | upstream | job |
//! |---|---|---|
//! | [`ivf`] | `init_avx`, `blob-api.c` | IVF container over an owned buffer |
//! | [`decoder`] | `AVX_Decoder_*` | run/next_frame/finished ring around rav1d |
//! | [`frame`] | `buffer_frame`, `AVX_Video_Frame` | packed planes + geometry + colour |
//! | [`convert`] | `yuv-to-rgb.c` | YUV→RGBA, scalar and SIMD128 |
//! | [`wasm`] | `EXPORTED_FUNCTIONS` | the wasm-bindgen surface |
//!
//! [rav1d]: https://github.com/memorysafety/rav1d
//! [GoogleChromeLabs/wasm-av1]: https://github.com/GoogleChromeLabs/wasm-av1

pub mod convert;
pub mod decoder;
pub mod frame;
pub mod ivf;

#[cfg(target_arch = "wasm32")]
pub mod wasm;

pub use convert::{simd_enabled, yuv_to_rgba, Coefficients};
#[cfg(feature = "container")]
pub use decoder::ContainerInfo;
pub use decoder::{Config, Decoder, Error, RunOutcome, Stats};
pub use frame::{ColorInfo, Frame, PixelLayout, PlaneInfo};
pub use ivf::{IvfHeader, IvfReader};

/// Crate version, for the JS side to report.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
