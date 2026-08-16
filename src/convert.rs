//! YUV → RGBA conversion.
//!
//! Upstream `yuv-to-rgb.c` was a lookup-table loop hard-wired to 16-bit 4:2:0
//! with approximate BT.601 coefficients, and its own comment said "replace with
//! WebGL shader conversion ASAP". The renderers in `js/` do exactly that when
//! WebGL is available; this module is for everything else — a 2D canvas, an
//! `ImageData`, a PNG in a test — and for the baseline build on hardware where
//! CPU conversion is what you have.
//!
//! Two implementations of one formula:
//!
//! * [`yuv_to_rgba_scalar`] handles every layout (4:0:0/4:2:0/4:2:2/4:4:4) and
//!   depth (8/10/12-bit) and is always compiled.
//! * [`yuv420_to_rgba_simd128`] handles 8-bit 4:2:0 — the common case — eight
//!   pixels at a time with wasm SIMD128 (`v128`) and exists only when the crate
//!   is compiled with `-C target-feature=+simd128`. It uses the same integer
//!   arithmetic as the scalar path and is tested to be byte-identical to it,
//!   so switching builds can never change the picture.
//!
//! [`yuv_to_rgba`] picks. Coefficients come from the stream's matrix and range
//! ([`Coefficients::for_frame`]) — BT.709 for HD, BT.601 for SD, BT.2020 —
//! derived from Kr/Kb rather than typed in, in Q16 fixed point.

use crate::frame::{Frame, PixelLayout};

/// Q16 fixed-point conversion coefficients.
///
/// `R = (y * (Y - y_offset) + rv * (V - c_off) + round) >> shift` and so on,
/// where `c_off = 128 << (bit_depth - 8)` and `shift = 16 + bit_depth - 8`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Coefficients {
    /// 16 for limited range, 0 for full range — at 8-bit scale.
    pub y_offset: i32,
    /// Luma gain: 255/219 limited, 1 full.
    pub y: i32,
    pub rv: i32,
    pub gu: i32,
    pub gv: i32,
    pub bu: i32,
}

const Q: f64 = 65536.0;

impl Coefficients {
    /// Derive from the matrix's Kr/Kb (BT.601 is Kr=0.299, Kb=0.114).
    pub fn from_kr_kb(kr: f64, kb: f64, full_range: bool) -> Coefficients {
        let kg = 1.0 - kr - kb;
        let (ys, cs, y_offset) = if full_range {
            (1.0, 1.0, 0)
        } else {
            (255.0 / 219.0, 255.0 / 224.0, 16)
        };
        let q = |v: f64| (v * Q).round() as i32;
        Coefficients {
            y_offset,
            y: q(ys),
            rv: q(2.0 * (1.0 - kr) * cs),
            gu: q(-2.0 * kb * (1.0 - kb) / kg * cs),
            gv: q(-2.0 * kr * (1.0 - kr) / kg * cs),
            bu: q(2.0 * (1.0 - kb) * cs),
        }
    }

    /// Coefficients for an ISO 23091-2 matrix code. Unknown/unspecified codes
    /// follow the usual player heuristic: BT.709 for HD (`height > 576`),
    /// BT.601 otherwise.
    pub fn for_matrix(matrix: u8, full_range: bool, height: usize) -> Coefficients {
        let (kr, kb) = match matrix {
            1 => (0.2126, 0.0722),      // BT.709
            4 => (0.30, 0.11),          // FCC / BT.470M
            5 | 6 => (0.299, 0.114),    // BT.470BG / BT.601
            7 => (0.212, 0.087),        // SMPTE 240M
            9 | 10 => (0.2627, 0.0593), // BT.2020 (NCL; CL treated the same)
            _ if height > 576 => (0.2126, 0.0722),
            _ => (0.299, 0.114),
        };
        Coefficients::from_kr_kb(kr, kb, full_range)
    }

    /// Coefficients for a frame, from its own colour metadata.
    pub fn for_frame(frame: &Frame) -> Coefficients {
        Coefficients::for_matrix(frame.color.matrix, frame.color.full_range, frame.height)
    }

    /// The generic default: BT.601 limited range, what upstream approximated.
    pub fn bt601_limited() -> Coefficients {
        Coefficients::from_kr_kb(0.299, 0.114, false)
    }
}

/// True when this build carries the SIMD128 conversion (and, since it is the
/// same compiler flag, when rav1d itself was compiled with SIMD128 enabled).
pub const fn simd_enabled() -> bool {
    cfg!(all(target_arch = "wasm32", target_feature = "simd128"))
}

/// Convert `frame` to tightly packed RGBA8 in `out` (`frame.rgba_len()` bytes),
/// choosing the fastest implementation this build has for the frame's shape.
///
/// # Panics
///
/// If `out` is shorter than [`Frame::rgba_len`].
pub fn yuv_to_rgba(frame: &Frame, out: &mut [u8]) {
    let coef = Coefficients::for_frame(frame);
    yuv_to_rgba_with(frame, &coef, out)
}

/// [`yuv_to_rgba`] with explicit coefficients.
pub fn yuv_to_rgba_with(frame: &Frame, coef: &Coefficients, out: &mut [u8]) {
    assert!(
        out.len() >= frame.rgba_len(),
        "RGBA buffer too small: {} < {}",
        out.len(),
        frame.rgba_len()
    );
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    {
        if frame.bytes_per_sample == 1 && frame.layout == PixelLayout::I420 {
            return yuv420_to_rgba_simd128(frame, coef, out);
        }
    }
    yuv_to_rgba_scalar(frame, coef, out)
}

#[inline(always)]
fn clamp8(v: i32) -> u8 {
    v.clamp(0, 255) as u8
}

/// Read samples of one or two bytes as `i32`.
trait Sample {
    const BYTES: usize;
    fn get(row: &[u8], i: usize) -> i32;
}

struct U8;
struct U16Le;

impl Sample for U8 {
    const BYTES: usize = 1;
    #[inline(always)]
    fn get(row: &[u8], i: usize) -> i32 {
        row[i] as i32
    }
}

impl Sample for U16Le {
    const BYTES: usize = 2;
    #[inline(always)]
    fn get(row: &[u8], i: usize) -> i32 {
        u16::from_le_bytes([row[2 * i], row[2 * i + 1]]) as i32
    }
}

/// The scalar conversion, any layout and depth.
pub fn yuv_to_rgba_scalar(frame: &Frame, coef: &Coefficients, out: &mut [u8]) {
    if frame.bytes_per_sample == 2 {
        convert_generic::<U16Le>(frame, coef, out)
    } else {
        convert_generic::<U8>(frame, coef, out)
    }
}

fn convert_generic<S: Sample>(frame: &Frame, coef: &Coefficients, out: &mut [u8]) {
    let w = frame.width;
    let h = frame.height;
    if w == 0 || h == 0 {
        return;
    }
    let extra_bits = frame.bit_depth.saturating_sub(8) as u32;
    let shift = 16 + extra_bits;
    let round = 1i32 << (shift - 1);
    let y_off = coef.y_offset << extra_bits;
    let c_off = 128i32 << extra_bits;
    let (ss_x, ss_y) = frame.layout.subsampling();
    let has_chroma = frame.layout.has_chroma();
    let gbr = frame.color.matrix == 0 && frame.layout == PixelLayout::I444;

    let yp = frame.plane(0);
    let up = frame.plane(1);
    let vp = frame.plane(2);
    let ystride = frame.planes[0].stride;
    let cstride = frame.planes[1].stride;

    for y in 0..h {
        let yrow = &yp[y * ystride..y * ystride + w * S::BYTES];
        let out_row = &mut out[y * w * 4..(y + 1) * w * 4];
        let (urow, vrow) = if has_chroma {
            let cy = y >> ss_y;
            (
                &up[cy * cstride..(cy + 1) * cstride],
                &vp[cy * cstride..(cy + 1) * cstride],
            )
        } else {
            (&[][..], &[][..])
        };

        if gbr {
            // Matrix 0 with 4:4:4 is planar GBR: Y carries G, U carries B, V carries R.
            let scale_shift = extra_bits;
            for (x, px) in out_row.chunks_exact_mut(4).enumerate() {
                let g = S::get(yrow, x) >> scale_shift;
                let b = S::get(urow, x) >> scale_shift;
                let r = S::get(vrow, x) >> scale_shift;
                px.copy_from_slice(&[clamp8(r), clamp8(g), clamp8(b), 255]);
            }
            continue;
        }

        for (x, px) in out_row.chunks_exact_mut(4).enumerate() {
            let yv = coef.y * (S::get(yrow, x) - y_off) + round;
            let (u, v) = if has_chroma {
                let cx = x >> ss_x;
                (S::get(urow, cx) - c_off, S::get(vrow, cx) - c_off)
            } else {
                (0, 0)
            };
            let r = (yv + coef.rv * v) >> shift;
            let g = (yv + coef.gu * u + coef.gv * v) >> shift;
            let b = (yv + coef.bu * u) >> shift;
            px.copy_from_slice(&[clamp8(r), clamp8(g), clamp8(b), 255]);
        }
    }
}

/// 8-bit 4:2:0 → RGBA with wasm SIMD128, eight pixels per step.
///
/// Byte-identical to [`yuv_to_rgba_scalar`] on the same input: the lanes do
/// the same Q16 integer arithmetic, and the final `i32 → i16 → u8` narrowing
/// saturates, which is the clamp.
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
pub fn yuv420_to_rgba_simd128(frame: &Frame, coef: &Coefficients, out: &mut [u8]) {
    use core::arch::wasm32::*;

    debug_assert_eq!(frame.bytes_per_sample, 1);
    debug_assert_eq!(frame.layout, PixelLayout::I420);
    let w = frame.width;
    let h = frame.height;
    if w == 0 || h == 0 {
        return;
    }
    let cw = frame.planes[1].width;
    let yp = frame.plane(0);
    let up = frame.plane(1);
    let vp = frame.plane(2);

    let round = 1i32 << 15;
    let v_y = i32x4_splat(coef.y);
    let v_rv = i32x4_splat(coef.rv);
    let v_gu = i32x4_splat(coef.gu);
    let v_gv = i32x4_splat(coef.gv);
    let v_bu = i32x4_splat(coef.bu);
    let v_round = i32x4_splat(round);
    let v_yoff = i32x4_splat(coef.y_offset);
    let v_coff = i32x4_splat(128);
    let v_alpha = i32x4_splat(255);

    // Four pixels of (Y - off), (U - 128), (V - 128) in i32 lanes → 16 bytes of RGBA.
    #[inline(always)]
    fn px4(
        y: v128,
        u: v128,
        v: v128,
        (v_y, v_rv, v_gu, v_gv, v_bu, v_round, v_alpha): (v128, v128, v128, v128, v128, v128, v128),
    ) -> v128 {
        let yv = i32x4_add(i32x4_mul(y, v_y), v_round);
        let r = i32x4_shr(i32x4_add(yv, i32x4_mul(v, v_rv)), 16);
        let g = i32x4_shr(
            i32x4_add(yv, i32x4_add(i32x4_mul(u, v_gu), i32x4_mul(v, v_gv))),
            16,
        );
        let b = i32x4_shr(i32x4_add(yv, i32x4_mul(u, v_bu)), 16);
        // [r0 r1 r2 r3 g0 g1 g2 g3] and [b0 b1 b2 b3 255 255 255 255] as i16, saturating,
        let rg = i16x8_narrow_i32x4(r, g);
        let ba = i16x8_narrow_i32x4(b, v_alpha);
        // then to u8 (saturating: this is the 0..255 clamp) ...
        let planar = u8x16_narrow_i16x8(rg, ba);
        // ... and interleave r0 g0 b0 a0 r1 g1 b1 a1 …
        i8x16_shuffle::<0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15>(planar, planar)
    }
    let consts = (v_y, v_rv, v_gu, v_gv, v_bu, v_round, v_alpha);

    let vec_w = w & !7;
    for y in 0..h {
        let yrow = &yp[y * w..(y + 1) * w];
        let cy = y >> 1;
        let urow = &up[cy * cw..(cy + 1) * cw];
        let vrow = &vp[cy * cw..(cy + 1) * cw];
        let out_row = &mut out[y * w * 4..(y + 1) * w * 4];

        let mut x = 0;
        while x < vec_w {
            // Bounds are established by the slices; the loads/stores below are
            // unaligned by construction (wasm memory ops carry alignment 1).
            let y8 = &yrow[x..x + 8];
            let u4 = &urow[x / 2..x / 2 + 4];
            let v4 = &vrow[x / 2..x / 2 + 4];
            // SAFETY: the three slices above are each at least as long as the load;
            // v128_load64_zero/v128_load32_zero read exactly 8/4 bytes.
            let (y8, u4, v4) = unsafe {
                (
                    v128_load64_zero(y8.as_ptr() as *const u64),
                    v128_load32_zero(u4.as_ptr() as *const u32),
                    v128_load32_zero(v4.as_ptr() as *const u32),
                )
            };
            let y16 = u16x8_extend_low_u8x16(y8);
            let y_lo = i32x4_sub(u32x4_extend_low_u16x8(y16), v_yoff);
            let y_hi = i32x4_sub(u32x4_extend_high_u16x8(y16), v_yoff);
            // Each chroma sample covers two luma pixels: u0 u0 u1 u1 u2 u2 u3 u3.
            let u16 = u16x8_extend_low_u8x16(u4);
            let u16 = i16x8_shuffle::<0, 0, 1, 1, 2, 2, 3, 3>(u16, u16);
            let v16 = u16x8_extend_low_u8x16(v4);
            let v16 = i16x8_shuffle::<0, 0, 1, 1, 2, 2, 3, 3>(v16, v16);
            let u_lo = i32x4_sub(u32x4_extend_low_u16x8(u16), v_coff);
            let u_hi = i32x4_sub(u32x4_extend_high_u16x8(u16), v_coff);
            let v_lo = i32x4_sub(u32x4_extend_low_u16x8(v16), v_coff);
            let v_hi = i32x4_sub(u32x4_extend_high_u16x8(v16), v_coff);

            let lo = px4(y_lo, u_lo, v_lo, consts);
            let hi = px4(y_hi, u_hi, v_hi, consts);
            let dst = &mut out_row[x * 4..x * 4 + 32];
            // SAFETY: `dst` is exactly 32 bytes; two 16-byte stores.
            unsafe {
                v128_store(dst.as_mut_ptr() as *mut v128, lo);
                v128_store(dst.as_mut_ptr().add(16) as *mut v128, hi);
            }
            x += 8;
        }

        // Tail (width not a multiple of 8): the scalar formula, verbatim.
        while x < w {
            let yv = coef.y * (yrow[x] as i32 - coef.y_offset) + round;
            let u = urow[x >> 1] as i32 - 128;
            let v = vrow[x >> 1] as i32 - 128;
            let r = (yv + coef.rv * v) >> 16;
            let g = (yv + coef.gu * u + coef.gv * v) >> 16;
            let b = (yv + coef.bu * u) >> 16;
            out_row[x * 4..x * 4 + 4].copy_from_slice(&[clamp8(r), clamp8(g), clamp8(b), 255]);
            x += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::{ColorInfo, PlaneInfo};

    /// Build a frame from per-plane sample generators.
    pub(crate) fn synth(
        w: usize,
        h: usize,
        bit_depth: u8,
        layout: PixelLayout,
        color: ColorInfo,
        f: impl Fn(usize, usize, usize) -> u32,
    ) -> Frame {
        let bps = if bit_depth > 8 { 2 } else { 1 };
        let (planes, total) = Frame::geometry(w, h, bps, layout);
        let mut data = vec![0u8; total];
        for (p, info) in planes.iter().enumerate() {
            for y in 0..info.height {
                for x in 0..info.width {
                    let v = f(p, x, y);
                    let o = info.offset + y * info.stride + x * bps;
                    if bps == 2 {
                        data[o..o + 2].copy_from_slice(&(v as u16).to_le_bytes());
                    } else {
                        data[o] = v as u8;
                    }
                }
            }
        }
        Frame {
            width: w,
            height: h,
            bit_depth,
            bytes_per_sample: bps as u8,
            layout,
            planes,
            pts: None,
            color,
            data,
        }
    }

    fn rgba_of(frame: &Frame) -> Vec<u8> {
        let mut out = vec![0; frame.rgba_len()];
        yuv_to_rgba(frame, &mut out);
        out
    }

    fn c601() -> ColorInfo {
        ColorInfo {
            matrix: 6,
            primaries: 6,
            transfer: 6,
            full_range: false,
        }
    }

    #[test]
    fn coefficients_match_the_textbook_bt601() {
        let c = Coefficients::bt601_limited();
        // 1.164, 1.596, -0.391, -0.813, 2.018 — to Q16.
        assert_eq!(c.y, 76309);
        assert_eq!(c.rv, 104597);
        assert_eq!(c.gu, -25675);
        assert_eq!(c.gv, -53279);
        assert_eq!(c.bu, 132201);
        assert_eq!(c.y_offset, 16);
    }

    #[test]
    fn coefficients_bt709_full_range() {
        let c = Coefficients::for_matrix(1, true, 1080);
        assert_eq!(c.y_offset, 0);
        assert_eq!(c.y, 65536);
        assert_eq!(c.rv, (1.5748f64 * 65536.0).round() as i32);
    }

    #[test]
    fn unspecified_matrix_picks_by_height() {
        assert_eq!(
            Coefficients::for_matrix(2, false, 480),
            Coefficients::for_matrix(6, false, 480)
        );
        assert_eq!(
            Coefficients::for_matrix(2, false, 720),
            Coefficients::for_matrix(1, false, 720)
        );
    }

    #[test]
    fn black_white_and_primaries_bt601_limited() {
        // Y U V → expected RGB (BT.601 limited-range reference values).
        let cases: [([u32; 3], [u8; 3]); 5] = [
            ([16, 128, 128], [0, 0, 0]),
            ([235, 128, 128], [255, 255, 255]),
            ([81, 90, 240], [255, 0, 0]),
            ([145, 54, 34], [0, 255, 0]),
            ([41, 240, 110], [0, 0, 255]),
        ];
        for (yuv, rgb) in cases {
            let f = synth(2, 2, 8, PixelLayout::I420, c601(), |p, _, _| yuv[p]);
            let out = rgba_of(&f);
            for px in out.chunks_exact(4) {
                for i in 0..3 {
                    assert!(
                        (px[i] as i32 - rgb[i] as i32).abs() <= 2,
                        "yuv {yuv:?}: got {:?}, want {rgb:?}",
                        &px[..3]
                    );
                }
                assert_eq!(px[3], 255);
            }
        }
    }

    #[test]
    fn ten_bit_matches_eight_bit_within_rounding() {
        let f8 = synth(4, 4, 8, PixelLayout::I420, c601(), |p, x, y| {
            [
                60 + 10 * x as u32 + y as u32,
                100 + 3 * x as u32,
                200 - 5 * y as u32,
            ][p]
        });
        let f10 = synth(4, 4, 10, PixelLayout::I420, c601(), |p, x, y| {
            [
                60 + 10 * x as u32 + y as u32,
                100 + 3 * x as u32,
                200 - 5 * y as u32,
            ][p] << 2
        });
        let a = rgba_of(&f8);
        let b = rgba_of(&f10);
        for (pa, pb) in a.iter().zip(&b) {
            assert!((*pa as i32 - *pb as i32).abs() <= 1);
        }
    }

    #[test]
    fn monochrome_is_grey_and_444_uses_every_chroma_sample() {
        let mono = synth(3, 1, 8, PixelLayout::I400, c601(), |_, x, _| {
            16 + 100 * x as u32
        });
        let out = rgba_of(&mono);
        assert_eq!(&out[0..4], &[0, 0, 0, 255]);
        assert_eq!(out[4], out[5]);
        assert_eq!(out[5], out[6]);

        // 4:4:4 with chroma varying per pixel: neighbours must differ.
        let f = synth(2, 1, 8, PixelLayout::I444, c601(), |p, x, _| {
            [128, 128, if x == 0 { 240 } else { 16 }][p]
        });
        let out = rgba_of(&f);
        assert!(out[0] > 200 && out[4] < 60, "{:?}", out);
    }

    #[test]
    fn scalar_tracks_floating_point_reference() {
        // Deterministic pseudo-random samples; compare against f64 math, ±1.
        let mut seed = 0x9E37_79B9u32;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed
        };
        let w: usize = 17;
        let h: usize = 9;
        let ys: Vec<u32> = (0..w * h).map(|_| next() % 256).collect();
        let cw = w.div_ceil(2);
        let ch = h.div_ceil(2);
        let us: Vec<u32> = (0..cw * ch).map(|_| next() % 256).collect();
        let vs: Vec<u32> = (0..cw * ch).map(|_| next() % 256).collect();
        let f = synth(w, h, 8, PixelLayout::I420, c601(), |p, x, y| match p {
            0 => ys[y * w + x],
            1 => us[y * cw + x],
            _ => vs[y * cw + x],
        });
        let out = rgba_of(&f);
        for y in 0..h {
            for x in 0..w {
                let yy = 1.164_383_6 * (ys[y * w + x] as f64 - 16.0);
                let u = us[(y / 2) * cw + x / 2] as f64 - 128.0;
                let v = vs[(y / 2) * cw + x / 2] as f64 - 128.0;
                let want = [
                    yy + 1.596_026_8 * v,
                    yy - 0.391_762_3 * u - 0.812_967_5 * v,
                    yy + 2.017_232_1 * u,
                ];
                let px = &out[(y * w + x) * 4..][..4];
                for i in 0..3 {
                    let w8 = want[i].round().clamp(0.0, 255.0) as i32;
                    assert!(
                        (px[i] as i32 - w8).abs() <= 1,
                        "({x},{y}) ch{i}: got {} want {w8}",
                        px[i]
                    );
                }
            }
        }
    }

    #[test]
    fn output_buffer_geometry() {
        let f = synth(3, 2, 8, PixelLayout::I420, c601(), |_, _, _| 128);
        assert_eq!(f.rgba_len(), 24);
        assert_eq!(
            f.planes[1],
            PlaneInfo {
                offset: 6,
                stride: 2,
                width: 2,
                height: 1
            }
        );
    }
}
