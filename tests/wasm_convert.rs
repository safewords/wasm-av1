//! Runs *inside* wasm (Node via wasm-bindgen-test-runner):
//!
//! ```text
//! cargo test --release --target wasm32-unknown-unknown                                   # baseline
//! RUSTFLAGS="-C target-feature=+simd128" cargo test --release --target wasm32-unknown-unknown   # simd
//! ```
//!
//! In the SIMD build `yuv_to_rgba` takes the v128 path for 8-bit 4:2:0 and
//! must equal `yuv_to_rgba_scalar` byte for byte on every width (the tail
//! after the last multiple of 8 goes through the scalar formula) and height
//! (odd heights share the last chroma row). In the baseline build both are
//! the scalar path and the test simply passes — which is fine: the Node suite
//! separately checks the two builds agree with each other.
#![cfg(target_arch = "wasm32")]

use wasm_av1::convert::{simd_enabled, yuv_to_rgba, yuv_to_rgba_scalar, Coefficients};
use wasm_av1::{ColorInfo, Frame, PixelLayout};
use wasm_bindgen_test::*;

fn lcg(seed: &mut u32) -> u8 {
    *seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
    (*seed >> 24) as u8
}

fn frame(w: usize, h: usize, seed: &mut u32, matrix: u8, full_range: bool) -> Frame {
    let (planes, total) = Frame::geometry(w, h, 1, PixelLayout::I420);
    let data: Vec<u8> = (0..total).map(|_| lcg(seed)).collect();
    Frame {
        width: w,
        height: h,
        bit_depth: 8,
        bytes_per_sample: 1,
        layout: PixelLayout::I420,
        planes,
        pts: None,
        color: ColorInfo {
            matrix,
            primaries: 1,
            transfer: 1,
            full_range,
        },
        data,
    }
}

#[wasm_bindgen_test]
fn dispatch_equals_scalar_for_every_shape() {
    let mut seed = 0xC0FFEE;
    let mut checked = 0;
    for &(w, h) in &[
        (1, 1),
        (7, 3),
        (8, 2),
        (9, 5),
        (15, 15),
        (16, 9),
        (17, 1),
        (31, 7),
        (64, 36),
        (177, 99),
        (320, 180),
    ] {
        for &(matrix, full) in &[(1u8, false), (6, false), (9, false), (1, true), (2, false)] {
            let f = frame(w, h, &mut seed, matrix, full);
            let coef = Coefficients::for_frame(&f);
            let mut a = vec![0u8; f.rgba_len()];
            let mut b = vec![0u8; f.rgba_len()];
            yuv_to_rgba(&f, &mut a);
            yuv_to_rgba_scalar(&f, &coef, &mut b);
            assert!(
                a == b,
                "{w}x{h} matrix {matrix} full {full}: dispatch differs from scalar (simd={})",
                simd_enabled()
            );
            checked += 1;
        }
    }
    assert_eq!(checked, 55);
}

#[wasm_bindgen_test]
fn build_reports_its_simd_flag() {
    // Both are legitimate; what matters is that the flag reflects the compile.
    assert_eq!(simd_enabled(), cfg!(target_feature = "simd128"));
}
