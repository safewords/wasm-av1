//! IVF container reader.
//!
//! IVF is the trivial container libaom/libvpx tools use: a 32-byte file header
//! followed by frames, each with a 12-byte header (`u32` size, `u64` pts). It is
//! what upstream wasm-av1 played (`init_avx` and the frame read in
//! `AVX_Decoder_run` in `decode-av1.c`, over the blob `DATA_Source` in
//! `blob-api.c`); this module is that logic over an owned byte buffer.
//!
//! The decoder proper does not need IVF — a temporal unit's OBUs can be pushed
//! directly (see [`crate::decoder::Decoder::push_temporal_unit`]), which is
//! how samples out of an fMP4/CMAF segment arrive. IVF is what test vectors and
//! the demo page use.
//!
//! Layout (all little-endian), per the libaom `ivfdec.c`/`ivfenc.c` pair:
//!
//! ```text
//! 0   "DKIF"
//! 4   u16 version            (0)
//! 6   u16 header length      (32; honoured if larger)
//! 8   fourcc                 ("AV01")
//! 12  u16 width
//! 14  u16 height
//! 16  u32 time base denominator
//! 20  u32 time base numerator
//! 24  u32 frame count        (often 0 = unknown)
//! 28  u32 unused
//! ---- per frame ----
//! 0   u32 frame size (bytes)
//! 4   u64 pts (in units of numerator/denominator seconds)
//! 12  frame data
//! ```
//!
//! Note the time base is stored denominator-first: for 24 fps content the
//! writer puts `24` at offset 16 and `1` at offset 20, and a pts of `n` is
//! `n * 1/24` s. libaom's reader calls those fields "numerator/denominator" of
//! a *frame rate*; ffmpeg's calls them `time_base.den/num`. We follow ffmpeg
//! and expose them so that `seconds = pts * num / den`.

use std::fmt;

/// Size of the file header we require. Longer headers are skipped.
pub const HEADER_LEN: usize = 32;
/// Size of each frame header.
pub const FRAME_HEADER_LEN: usize = 12;
/// Upstream `MAX_FRAME_SZ`: a frame claiming to be larger than this is treated
/// as corruption rather than allocated.
pub const MAX_FRAME_LEN: usize = 256 * 1024 * 1024;

const SIGNATURE: &[u8; 4] = b"DKIF";

/// What the 32-byte file header said.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IvfHeader {
    pub fourcc: [u8; 4],
    pub width: u16,
    pub height: u16,
    /// `seconds = pts * time_base_num / time_base_den`.
    pub time_base_num: u32,
    pub time_base_den: u32,
    /// Frame count from the header; `0` means the writer did not know.
    pub frame_count: u32,
    /// Where frame data starts (the header length field, at least 32).
    pub header_len: usize,
}

impl IvfHeader {
    /// True when the fourcc says AV1 (`AV01`). Anything else is not decodable
    /// here, but the reader still parses it so a caller can report *why*.
    pub fn is_av1(&self) -> bool {
        &self.fourcc == b"AV01"
    }

    /// Nominal frame duration in seconds if the time base is sane, else `None`.
    pub fn frame_duration_secs(&self) -> Option<f64> {
        if self.time_base_num == 0 || self.time_base_den == 0 {
            None
        } else {
            Some(self.time_base_num as f64 / self.time_base_den as f64)
        }
    }
}

/// One frame's worth of compressed data — in AV1 terms, one temporal unit.
#[derive(Clone, Copy, Debug)]
pub struct IvfFrame<'a> {
    pub pts: u64,
    pub data: &'a [u8],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IvfError {
    /// Shorter than a file header.
    Truncated,
    /// The first four bytes are not `DKIF`.
    BadSignature,
    /// The version field is not 0.
    UnsupportedVersion(u16),
    /// A frame header announces a size larger than [`MAX_FRAME_LEN`].
    FrameTooLarge(u32),
    /// A frame header announces more bytes than remain in the buffer.
    TruncatedFrame { wanted: usize, available: usize },
}

impl fmt::Display for IvfError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            IvfError::Truncated => write!(f, "IVF: shorter than the 32-byte file header"),
            IvfError::BadSignature => write!(f, "IVF: missing DKIF signature"),
            IvfError::UnsupportedVersion(v) => write!(f, "IVF: unsupported version {v}"),
            IvfError::FrameTooLarge(n) => write!(f, "IVF: frame size {n} exceeds {MAX_FRAME_LEN}"),
            IvfError::TruncatedFrame { wanted, available } => {
                write!(f, "IVF: frame wants {wanted} bytes, {available} remain")
            }
        }
    }
}

impl std::error::Error for IvfError {}

/// A whole IVF file in memory, read frame by frame.
///
/// This is upstream's blob `DATA_Source` and its IVF parsing folded together:
/// the buffer is owned, a cursor walks it, and each [`next_frame`] hands back a
/// borrowed slice, so nothing is copied after the initial upload.
///
/// [`next_frame`]: IvfReader::next_frame
pub struct IvfReader {
    data: Vec<u8>,
    pos: usize,
    header: IvfHeader,
    frames_read: u64,
}

impl IvfReader {
    /// Parse the file header; fails if it is not IVF. Does not look at frames.
    pub fn new(data: Vec<u8>) -> Result<Self, IvfError> {
        let header = parse_header(&data)?;
        Ok(IvfReader {
            pos: header.header_len,
            data,
            header,
            frames_read: 0,
        })
    }

    pub fn header(&self) -> &IvfHeader {
        &self.header
    }

    /// Bytes not yet consumed.
    pub fn remaining(&self) -> usize {
        self.data.len().saturating_sub(self.pos)
    }

    /// True once every frame has been handed out — upstream's `DS_empty`.
    ///
    /// Trailing garbage shorter than a frame header also counts as empty; a
    /// truncated *frame* does not, and surfaces as an error from
    /// [`next_frame`](Self::next_frame) instead.
    pub fn is_empty(&self) -> bool {
        self.remaining() < FRAME_HEADER_LEN
    }

    /// Frames handed out so far.
    pub fn frames_read(&self) -> u64 {
        self.frames_read
    }

    /// Rewind to the first frame.
    pub fn rewind(&mut self) {
        self.pos = self.header.header_len;
        self.frames_read = 0;
    }

    /// The next frame, `Ok(None)` at end of data.
    pub fn next_frame(&mut self) -> Result<Option<IvfFrame<'_>>, IvfError> {
        if self.is_empty() {
            return Ok(None);
        }
        let hdr = &self.data[self.pos..self.pos + FRAME_HEADER_LEN];
        let size = u32::from_le_bytes([hdr[0], hdr[1], hdr[2], hdr[3]]);
        let pts = u64::from_le_bytes([
            hdr[4], hdr[5], hdr[6], hdr[7], hdr[8], hdr[9], hdr[10], hdr[11],
        ]);
        let size_usize = size as usize;
        if size_usize > MAX_FRAME_LEN {
            return Err(IvfError::FrameTooLarge(size));
        }
        let start = self.pos + FRAME_HEADER_LEN;
        let available = self.data.len() - start;
        if size_usize > available {
            return Err(IvfError::TruncatedFrame {
                wanted: size_usize,
                available,
            });
        }
        self.pos = start + size_usize;
        self.frames_read += 1;
        Ok(Some(IvfFrame {
            pts,
            data: &self.data[start..start + size_usize],
        }))
    }
}

/// Parse just the 32-byte file header out of `data`.
pub fn parse_header(data: &[u8]) -> Result<IvfHeader, IvfError> {
    if data.len() < HEADER_LEN {
        return Err(IvfError::Truncated);
    }
    if &data[0..4] != SIGNATURE {
        return Err(IvfError::BadSignature);
    }
    let le16 = |o: usize| u16::from_le_bytes([data[o], data[o + 1]]);
    let le32 = |o: usize| u32::from_le_bytes([data[o], data[o + 1], data[o + 2], data[o + 3]]);
    let version = le16(4);
    if version != 0 {
        return Err(IvfError::UnsupportedVersion(version));
    }
    let header_len = (le16(6) as usize).max(HEADER_LEN);
    Ok(IvfHeader {
        fourcc: [data[8], data[9], data[10], data[11]],
        width: le16(12),
        height: le16(14),
        time_base_den: le32(16),
        time_base_num: le32(20),
        frame_count: le32(24),
        header_len,
    })
}

/// Serialise an IVF file header — used by tests and the fixture generator.
pub fn write_header(
    fourcc: [u8; 4],
    width: u16,
    height: u16,
    time_base_num: u32,
    time_base_den: u32,
    frame_count: u32,
) -> [u8; HEADER_LEN] {
    let mut h = [0u8; HEADER_LEN];
    h[0..4].copy_from_slice(SIGNATURE);
    h[4..6].copy_from_slice(&0u16.to_le_bytes());
    h[6..8].copy_from_slice(&(HEADER_LEN as u16).to_le_bytes());
    h[8..12].copy_from_slice(&fourcc);
    h[12..14].copy_from_slice(&width.to_le_bytes());
    h[14..16].copy_from_slice(&height.to_le_bytes());
    h[16..20].copy_from_slice(&time_base_den.to_le_bytes());
    h[20..24].copy_from_slice(&time_base_num.to_le_bytes());
    h[24..28].copy_from_slice(&frame_count.to_le_bytes());
    h
}

/// Serialise one frame header.
pub fn write_frame_header(size: u32, pts: u64) -> [u8; FRAME_HEADER_LEN] {
    let mut h = [0u8; FRAME_HEADER_LEN];
    h[0..4].copy_from_slice(&size.to_le_bytes());
    h[4..12].copy_from_slice(&pts.to_le_bytes());
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(frames: &[(u64, &[u8])]) -> Vec<u8> {
        let mut v = write_header(*b"AV01", 320, 180, 1, 24, frames.len() as u32).to_vec();
        for (pts, data) in frames {
            v.extend_from_slice(&write_frame_header(data.len() as u32, *pts));
            v.extend_from_slice(data);
        }
        v
    }

    #[test]
    fn header_round_trips() {
        let r = IvfReader::new(file(&[])).unwrap();
        let h = r.header();
        assert!(h.is_av1());
        assert_eq!((h.width, h.height), (320, 180));
        assert_eq!((h.time_base_num, h.time_base_den), (1, 24));
        assert_eq!(h.frame_duration_secs(), Some(1.0 / 24.0));
        assert!(r.is_empty());
    }

    #[test]
    fn frames_come_out_in_order_with_pts() {
        let mut r = IvfReader::new(file(&[(0, b"abc"), (1, b""), (2, b"defgh")])).unwrap();
        let f = r.next_frame().unwrap().unwrap();
        assert_eq!((f.pts, f.data), (0, &b"abc"[..]));
        let f = r.next_frame().unwrap().unwrap();
        assert_eq!((f.pts, f.data), (1, &b""[..]));
        assert!(!r.is_empty());
        let f = r.next_frame().unwrap().unwrap();
        assert_eq!((f.pts, f.data), (2, &b"defgh"[..]));
        assert!(r.is_empty());
        assert!(r.next_frame().unwrap().is_none());
        assert_eq!(r.frames_read(), 3);
        r.rewind();
        assert_eq!(r.next_frame().unwrap().unwrap().pts, 0);
    }

    #[test]
    fn rejects_non_ivf() {
        assert_eq!(IvfReader::new(vec![0; 10]).err(), Some(IvfError::Truncated));
        let mut bad = file(&[]);
        bad[0] = b'X';
        assert_eq!(IvfReader::new(bad).err(), Some(IvfError::BadSignature));
        let mut v1 = file(&[]);
        v1[4] = 1;
        assert_eq!(
            IvfReader::new(v1).err(),
            Some(IvfError::UnsupportedVersion(1))
        );
    }

    #[test]
    fn truncated_frame_is_an_error_not_eof() {
        let mut v = file(&[(0, b"abcdef")]);
        v.truncate(v.len() - 2);
        let mut r = IvfReader::new(v).unwrap();
        assert!(matches!(
            r.next_frame(),
            Err(IvfError::TruncatedFrame {
                wanted: 6,
                available: 4
            })
        ));
    }

    #[test]
    fn honours_longer_header_length() {
        let mut v = write_header(*b"AV01", 8, 8, 1, 30, 1).to_vec();
        v[6..8].copy_from_slice(&40u16.to_le_bytes());
        v.extend_from_slice(&[0; 8]); // 8 bytes of extra header
        v.extend_from_slice(&write_frame_header(1, 7));
        v.push(0xAA);
        let mut r = IvfReader::new(v).unwrap();
        let f = r.next_frame().unwrap().unwrap();
        assert_eq!((f.pts, f.data), (7, &[0xAA][..]));
    }
}
