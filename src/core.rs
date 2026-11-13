//! The decoder core: rivet's own AV1 decoder (`rivet-av1`, imported as `av1`).
//!
//! Besides the thread pool in `threads.rs`, the one place that names it.
//! rivet-av1 decodes a temporal unit in one call and hands back the frames
//! it shows, already packed the way [`Frame`] is (Y, U, V one after another,
//! no padding, little-endian `u16` above 8 bits), so this is a thin adapter:
//! it keeps the frames of the last unit until [`crate::decoder`] pulls them,
//! and gives them the pts the unit came with. There is no frame delay and
//! nothing in flight.

use std::collections::VecDeque;

use crate::decoder::Config;
use crate::frame::{ColorInfo, Frame, PixelLayout};

/// What the decoder core reports when it rejects a temporal unit: rivet-av1's
/// error (`Bitstream`, `Unsupported` or `InvalidInput`, each with a message).
pub type CoreError = av1::Error;

/// The name the core goes by in error messages.
pub(crate) const NAME: &str = "rivet-av1";

/// A temporal delimiter OBU (type 2, with a size field of 0).
const TEMPORAL_DELIMITER: [u8; 2] = [0x12, 0x00];

pub(crate) struct Core {
    inner: av1::Decoder,
    threads: usize,
    apply_grain: bool,
    /// Frames the last temporal unit showed, not yet pulled.
    ready: VecDeque<Frame>,
}

fn new_decoder(threads: usize, apply_grain: bool) -> av1::Decoder {
    let mut dec = av1::Decoder::new();
    dec.set_threads(threads);
    dec.set_apply_grain(apply_grain);
    dec
}

impl Core {
    pub(crate) fn open(config: &Config) -> Core {
        let threads = crate::decoder::effective_threads(config) as usize;
        #[cfg(all(target_arch = "wasm32", target_feature = "atomics"))]
        if threads > 1 {
            crate::threads::install(threads);
        }
        Core {
            inner: new_decoder(threads, config.apply_grain),
            threads,
            apply_grain: config.apply_grain,
            ready: VecDeque::new(),
        }
    }

    /// Forget the stream: reference frames, headers, anything decoded and
    /// not yet pulled. A new `av1::Decoder` is exactly that and costs
    /// nothing — the worker threads belong to the pool in
    /// [`crate::threads`], not to the decoder, so a seek does not respawn
    /// them.
    pub(crate) fn flush(&mut self) {
        self.inner = new_decoder(self.threads, self.apply_grain);
        self.ready.clear();
    }

    /// Decode one temporal unit; the frames it shows wait for
    /// [`Core::picture`]. On an error the unit is dropped and the next one
    /// is decoded as usual.
    pub(crate) fn send(&mut self, data: &[u8], pts: i64) -> Result<(), CoreError> {
        // A temporal unit begins with a temporal delimiter; MP4 and Matroska
        // samples come without theirs. rivet-av1 takes the delimiter as the
        // sign that whatever the last unit left unfinished (a frame header
        // with no tiles, a frame that failed half way) is over; without it
        // every later frame would be "a frame in progress". Give it one —
        // a second in front of a unit that has its own changes nothing.
        self.inner.decode_all(&TEMPORAL_DELIMITER)?;
        for f in self.inner.decode_all(data)? {
            self.ready.push_back(frame_from_av1(f, pts));
        }
        Ok(())
    }

    /// The next frame of the last temporal unit, `None` when all have been
    /// pulled.
    pub(crate) fn picture(&mut self) -> Option<Frame> {
        self.ready.pop_front()
    }

    /// True while frames of the last temporal unit have not been pulled.
    pub(crate) fn has_pictures(&self) -> bool {
        !self.ready.is_empty()
    }
}

/// Take a decoded rivet-av1 frame as ours: the sample buffer moves, nothing
/// is copied.
fn frame_from_av1(f: av1::Frame, pts: i64) -> Frame {
    let layout = match f.chroma {
        av1::ChromaFormat::Mono => PixelLayout::I400,
        av1::ChromaFormat::Yuv420 => PixelLayout::I420,
        av1::ChromaFormat::Yuv422 => PixelLayout::I422,
        av1::ChromaFormat::Yuv444 => PixelLayout::I444,
    };
    let (width, height) = (f.width as usize, f.height as usize);
    let bytes_per_sample = f.bytes_per_sample();
    let (planes, total) = Frame::geometry(width, height, bytes_per_sample, layout);
    debug_assert_eq!(total, f.data.len(), "rivet-av1 packs planes as we do");
    Frame {
        width,
        height,
        bit_depth: f.bit_depth as u8,
        bytes_per_sample: bytes_per_sample as u8,
        layout,
        planes,
        pts: Some(pts),
        color: ColorInfo {
            matrix: f.color.matrix_coefficients as u8,
            primaries: f.color.color_primaries as u8,
            transfer: f.color.transfer_characteristics as u8,
            full_range: f.color.full_range,
        },
        data: f.data,
    }
}
