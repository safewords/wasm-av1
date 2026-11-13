//! The decoder core: rivet's own AV1 decoder (`rivet-av1`, imported as `av1`).
//!
//! Besides the thread pool in `threads.rs`, the one place that names it.
//! rivet-av1 hands back the frames a temporal unit shows already packed the
//! way [`Frame`] is (Y, U, V one after another, no padding, little-endian
//! `u16` above 8 bits), so this is a thin adapter: it queues each unit
//! (`av1::Decoder::queue`), keeps the frames of the units that are decoded
//! until [`crate::decoder`] pulls them, and gives them the pts their unit
//! came with.
//!
//! With one thread a unit is decoded when it is queued. With more,
//! rivet-av1 has several frames in flight (`set_frames_in_flight`): a
//! unit's frames then come out a few units later, or when the input ends
//! ([`Core::finish`]), in the order the units went in.

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

/// The most frames rivet-av1 decodes at once, and the most luma samples
/// they may have between them (eight frames of 1920x1088; two of
/// 3840x2160): each frame in flight holds its own buffers, some 20 bytes a
/// luma sample at 4:2:0, so this bounds the memory (about 330 MB of the
/// threads builds' 1 GiB at the most, however large the frames).
const MAX_FRAMES_IN_FLIGHT: usize = 8;
const MAX_SAMPLES_IN_FLIGHT: u64 = 8 * 1920 * 1088;

pub(crate) struct Core {
    inner: av1::Decoder,
    /// The pts of the units queued in the decoder, oldest first.
    pts: VecDeque<i64>,
    /// Frames decoded, not yet pulled.
    ready: VecDeque<Frame>,
    /// Units that failed in [`Core::picture`], not yet counted.
    dropped: u64,
}

fn new_decoder(threads: usize, apply_grain: bool) -> av1::Decoder {
    let mut dec = av1::Decoder::new();
    dec.set_threads(threads);
    dec.set_apply_grain(apply_grain);
    // A frame in flight for each thread: frames that do not depend on each
    // other are decoded side by side, which is what lets a stream of one
    // tile per frame use more than two or three threads.
    dec.set_frames_in_flight(threads.clamp(1, MAX_FRAMES_IN_FLIGHT));
    dec.set_samples_in_flight(MAX_SAMPLES_IN_FLIGHT);
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
            pts: VecDeque::new(),
            ready: VecDeque::new(),
            dropped: 0,
        }
    }

    /// Forget the stream: reference frames, headers, anything queued, in
    /// flight, or decoded and not yet pulled. The decoder keeps its settings
    /// and its threads (which are the pool's in [`crate::threads`] anyway),
    /// so a seek does not respawn them.
    pub(crate) fn flush(&mut self) {
        self.inner.reset();
        self.pts.clear();
        self.ready.clear();
        self.dropped = 0;
    }

    /// Queue one temporal unit for decoding; the frames it shows come out
    /// of [`Core::picture`], at once with one thread and a few units later
    /// with more. An error is that of the oldest unit not reported yet
    /// (this one, with one thread): that unit is dropped, and the units
    /// after it are decoded as usual.
    pub(crate) fn send(&mut self, data: &[u8], pts: i64) -> Result<(), CoreError> {
        // A temporal unit begins with a temporal delimiter; MP4 and Matroska
        // samples come without theirs. rivet-av1 takes the delimiter as the
        // sign that whatever the last unit left unfinished (a frame header
        // with no tiles, a frame that failed half way) is over; without it
        // every later frame would be "a frame in progress". Give it one —
        // a second in front of a unit that has its own changes nothing.
        let mut unit = Vec::with_capacity(TEMPORAL_DELIMITER.len() + data.len());
        unit.extend_from_slice(&TEMPORAL_DELIMITER);
        unit.extend_from_slice(data);
        self.inner.queue(&unit);
        self.pts.push_back(pts);
        self.take(false)
    }

    /// Moves the frames of the units that are decoded to `ready` (of all
    /// the units queued, if `wait`: decoding goes on, on this thread too,
    /// until they are). Stops at a unit's error: that unit is dropped, and
    /// the units after it stay for the next call.
    fn take(&mut self, wait: bool) -> Result<(), CoreError> {
        loop {
            let result = if wait {
                self.inner.wait()
            } else {
                self.inner.poll()
            };
            let Some(result) = result else {
                return Ok(());
            };
            let pts = self.pts.pop_front().unwrap_or_default();
            for f in result? {
                self.ready.push_back(frame_from_av1(f, pts));
            }
        }
    }

    /// The end of the input: every unit still queued is decoded before this
    /// returns, and its frames wait in [`Core::picture`]. Returns how many
    /// units failed (each is dropped).
    pub(crate) fn finish(&mut self) -> u64 {
        let mut failed = 0;
        while self.inner.queued() > 0 {
            if self.take(true).is_err() {
                failed += 1;
            }
        }
        failed
    }

    /// The next decoded frame, `None` when none is ready: all have been
    /// pulled, or the next is still being decoded.
    pub(crate) fn picture(&mut self) -> Option<Frame> {
        if self.ready.is_empty() && self.take(false).is_err() {
            self.dropped += 1;
        }
        self.ready.pop_front()
    }

    /// Units that failed while their frames were being collected by
    /// [`Core::picture`], since the last call (the caller counts them).
    pub(crate) fn take_dropped(&mut self) -> u64 {
        std::mem::take(&mut self.dropped)
    }

    /// Units queued whose frames have not come out yet: being decoded on
    /// the threads, or waiting for a frame that is. Always 0 with one
    /// thread.
    pub(crate) fn in_flight(&self) -> usize {
        self.inner.queued()
    }

    /// True while frames are decoded and not pulled, or units are queued
    /// whose frames have not come out yet.
    pub(crate) fn has_pictures(&self) -> bool {
        !self.ready.is_empty() || self.inner.queued() > 0
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
