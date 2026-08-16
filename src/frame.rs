//! A decoded frame, packed for hand-off.
//!
//! Upstream `buffer_frame()` copied the three planes of a libaom image into
//! one tightly packed allocation (Y, then U, then V, no padding, 16-bit
//! samples when the build was high-bit-depth). This is the same thing with
//! the geometry made explicit: [`Frame::planes`] says where each plane starts,
//! its stride, and its size, so a consumer can build WebGL textures, a
//! WebCodecs `VideoFrame` (`format: "I420"` expects exactly this layout), or
//! run the RGBA conversion — without ever guessing at chroma subsampling.
//!
//! Sample size follows the *stream*: 8-bit streams give one byte per sample,
//! 10/12-bit streams give two (little-endian, the value in the low bits) —
//! i.e. `yuv420p` / `yuv420p10le` in ffmpeg's vocabulary.

use rav1d::{Picture, PixelLayout as Rav1dLayout, PlanarImageComponent};

/// Chroma subsampling of a frame, in the AV1 numbering.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum PixelLayout {
    /// Monochrome: only a Y plane. The U/V entries in [`Frame::planes`] are empty.
    I400 = 0,
    /// 4:2:0 — chroma is half width and half height.
    I420 = 1,
    /// 4:2:2 — chroma is half width, full height.
    I422 = 2,
    /// 4:4:4 — chroma is full size.
    I444 = 3,
}

impl PixelLayout {
    /// Horizontal and vertical chroma subsampling shifts.
    pub fn subsampling(self) -> (u32, u32) {
        match self {
            PixelLayout::I400 => (0, 0),
            PixelLayout::I420 => (1, 1),
            PixelLayout::I422 => (1, 0),
            PixelLayout::I444 => (0, 0),
        }
    }

    pub fn has_chroma(self) -> bool {
        self != PixelLayout::I400
    }

    pub fn from_u8(v: u8) -> Option<Self> {
        Some(match v {
            0 => PixelLayout::I400,
            1 => PixelLayout::I420,
            2 => PixelLayout::I422,
            3 => PixelLayout::I444,
            _ => return None,
        })
    }
}

impl From<Rav1dLayout> for PixelLayout {
    fn from(l: Rav1dLayout) -> Self {
        match l {
            Rav1dLayout::I400 => PixelLayout::I400,
            Rav1dLayout::I420 => PixelLayout::I420,
            Rav1dLayout::I422 => PixelLayout::I422,
            Rav1dLayout::I444 => PixelLayout::I444,
        }
    }
}

/// Where one plane lives inside [`Frame::data`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PlaneInfo {
    /// Byte offset of the first row.
    pub offset: usize,
    /// Bytes between the start of consecutive rows. Always exactly
    /// `width * bytes_per_sample` — planes are packed.
    pub stride: usize,
    /// Width in samples.
    pub width: usize,
    /// Height in rows.
    pub height: usize,
}

impl PlaneInfo {
    pub fn len(&self) -> usize {
        self.stride * self.height
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Colour metadata from the sequence header, as ISO/IEC 23091-2 codes.
///
/// The conversion in [`crate::convert`] uses `matrix` and `full_range`;
/// primaries and transfer are carried for a renderer that wants to do HDR
/// tone mapping itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ColorInfo {
    /// Matrix coefficients (`1` = BT.709, `5`/`6` = BT.601, `9` = BT.2020 NCL, `2` = unspecified…).
    pub matrix: u8,
    /// Colour primaries code.
    pub primaries: u8,
    /// Transfer characteristics code.
    pub transfer: u8,
    /// True for full-range ("PC") YUV, false for limited ("TV") range.
    pub full_range: bool,
}

impl Default for ColorInfo {
    fn default() -> Self {
        ColorInfo {
            matrix: 2,
            primaries: 2,
            transfer: 2,
            full_range: false,
        }
    }
}

/// A decoded, packed frame.
#[derive(Clone, Debug)]
pub struct Frame {
    pub width: usize,
    pub height: usize,
    /// Meaningful bits per sample: 8, 10 or 12.
    pub bit_depth: u8,
    /// 1 for 8-bit streams, 2 for 10/12-bit.
    pub bytes_per_sample: u8,
    pub layout: PixelLayout,
    /// Y, U, V in that order. U and V are zeroed for [`PixelLayout::I400`].
    pub planes: [PlaneInfo; 3],
    /// Presentation timestamp as given with the input (IVF pts, or whatever
    /// the caller passed to `push_temporal_unit`), or `None` if it had none.
    pub pts: Option<i64>,
    pub color: ColorInfo,
    /// The packed samples, `planes[0].len() + planes[1].len() + planes[2].len()` bytes.
    pub data: Vec<u8>,
}

impl Frame {
    /// Compute the packed geometry for a frame of this shape.
    pub fn geometry(
        width: usize,
        height: usize,
        bytes_per_sample: usize,
        layout: PixelLayout,
    ) -> ([PlaneInfo; 3], usize) {
        let (ss_x, ss_y) = layout.subsampling();
        let luma = PlaneInfo {
            offset: 0,
            stride: width * bytes_per_sample,
            width,
            height,
        };
        let mut planes = [luma, PlaneInfo::default(), PlaneInfo::default()];
        let mut total = luma.len();
        if layout.has_chroma() {
            let cw = (width + (1usize << ss_x) - 1) >> ss_x;
            let ch = (height + (1usize << ss_y) - 1) >> ss_y;
            for plane in planes.iter_mut().skip(1) {
                *plane = PlaneInfo {
                    offset: total,
                    stride: cw * bytes_per_sample,
                    width: cw,
                    height: ch,
                };
                total += plane.len();
            }
        }
        (planes, total)
    }

    /// Copy a decoded rav1d picture into a packed frame — `buffer_frame()`.
    pub fn from_picture(pic: &Picture) -> Frame {
        let width = pic.width() as usize;
        let height = pic.height() as usize;
        // rav1d reports the storage width (8 or 16) as `bit_depth` and the
        // stream's precision (8/10/12) as `bits_per_component`.
        let bytes_per_sample = if pic.bit_depth() > 8 { 2 } else { 1 };
        let bit_depth = pic
            .bits_per_component()
            .map(|b| b.0)
            .unwrap_or(if bytes_per_sample == 2 { 10 } else { 8 });
        let layout = PixelLayout::from(pic.pixel_layout());
        let (planes, total) = Self::geometry(width, height, bytes_per_sample, layout);

        let mut data = vec![0u8; total];
        let components = [
            PlanarImageComponent::Y,
            PlanarImageComponent::U,
            PlanarImageComponent::V,
        ];
        for (info, comp) in planes.iter().zip(components) {
            if info.is_empty() {
                continue;
            }
            // Picture strides are in bytes (dav1d semantics), possibly larger
            // than the visible row and padded; copy row by row, visible part only.
            let src = pic.plane(comp);
            let src_stride = pic.stride(comp) as usize;
            let row_bytes = info.stride;
            let dst = &mut data[info.offset..info.offset + info.len()];
            for (y, dst_row) in dst.chunks_exact_mut(row_bytes).enumerate() {
                let s = y * src_stride;
                dst_row.copy_from_slice(&src[s..s + row_bytes]);
            }
        }

        Frame {
            width,
            height,
            bit_depth,
            bytes_per_sample: bytes_per_sample as u8,
            layout,
            planes,
            pts: pic.timestamp(),
            color: ColorInfo {
                matrix: pic.matrix_coefficients() as u8,
                primaries: pic.color_primaries() as u8,
                transfer: pic.transfer_characteristic() as u8,
                full_range: matches!(pic.color_range(), rav1d::pixel::YUVRange::Full),
            },
            data,
        }
    }

    /// The bytes of one plane.
    pub fn plane(&self, index: usize) -> &[u8] {
        let p = &self.planes[index];
        &self.data[p.offset..p.offset + p.len()]
    }

    /// Bytes an RGBA rendering of this frame needs.
    pub fn rgba_len(&self) -> usize {
        self.width * self.height * 4
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn geometry_420_odd_dimensions_round_chroma_up() {
        let (p, total) = Frame::geometry(5, 3, 1, PixelLayout::I420);
        assert_eq!(
            p[0],
            PlaneInfo {
                offset: 0,
                stride: 5,
                width: 5,
                height: 3
            }
        );
        assert_eq!(
            p[1],
            PlaneInfo {
                offset: 15,
                stride: 3,
                width: 3,
                height: 2
            }
        );
        assert_eq!(
            p[2],
            PlaneInfo {
                offset: 21,
                stride: 3,
                width: 3,
                height: 2
            }
        );
        assert_eq!(total, 27);
    }

    #[test]
    fn geometry_hbd_doubles_strides() {
        let (p, total) = Frame::geometry(4, 2, 2, PixelLayout::I422);
        assert_eq!(p[0].stride, 8);
        assert_eq!(
            p[1],
            PlaneInfo {
                offset: 16,
                stride: 4,
                width: 2,
                height: 2
            }
        );
        assert_eq!(total, 16 + 8 + 8);
    }

    #[test]
    fn geometry_400_has_no_chroma() {
        let (p, total) = Frame::geometry(4, 4, 1, PixelLayout::I400);
        assert_eq!(total, 16);
        assert!(p[1].is_empty() && p[2].is_empty());
    }
}
