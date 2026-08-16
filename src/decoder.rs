//! The decoder: rav1d driven the way upstream drove libaom.
//!
//! Upstream's `AVX_Decoder` (`decode-av1.c`) is a pull model built for a
//! `requestAnimationFrame` loop: the page calls `run()` once per tick, which
//! reads *one* compressed frame from the source and decodes it into a ring of
//! up to `NUM_FRAMES_BUFFERED` (10) frames; `get_frame()` pops the oldest;
//! `video_finished()` says when the source is exhausted. That shape survives
//! here because it is the right one for a browser main thread — bounded work
//! per call, frames ready ahead of display — and it maps one-to-one onto the
//! wasm-bindgen surface in [`crate::wasm`].
//!
//! Two things are different on purpose:
//!
//! * Input is an IVF file ([`Decoder::set_source_ivf`]), a container file
//!   demuxed by rivet ([`Decoder::set_source_container`] — MP4/fMP4/CMAF,
//!   WebM/MKV, TS; behind the `container` feature), **or** raw temporal units
//!   pushed one at a time ([`Decoder::push_temporal_unit`]). The last is the
//!   escape hatch for a caller that already has samples in hand; the decoder
//!   itself never needed a container.
//! * [`Decoder::finished`] is true only when the source is exhausted *and*
//!   the decoder has been drained *and* the ring is empty. Upstream's returned
//!   as soon as the source was empty, and its demo page stopped painting with
//!   frames still buffered.

use std::collections::VecDeque;
use std::fmt;

use rav1d::{Rav1dError, Settings};

use crate::frame::Frame;
use crate::ivf::{IvfError, IvfHeader, IvfReader};

#[cfg(feature = "container")]
use container::streaming::{DemuxHeader, StreamingDemuxer};

/// Upstream `NUM_FRAMES_BUFFERED`.
pub const DEFAULT_MAX_BUFFERED: usize = 10;

#[derive(Clone, Copy, Debug)]
pub struct Config {
    /// How many decoded frames [`Decoder::run`] keeps ahead. Memory cost is
    /// `max_buffered` packed frames (1.5 bytes/pixel at 8-bit 4:2:0).
    pub max_buffered: usize,
    /// Apply film grain synthesis in the decoder (a per-frame CPU cost; the
    /// stream is still valid without it, just cleaner than the encoder meant).
    pub apply_grain: bool,
    /// Frame threads. Only meaningful natively; on wasm there is one thread
    /// and this is forced to 1.
    pub threads: u32,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            max_buffered: DEFAULT_MAX_BUFFERED,
            apply_grain: true,
            threads: 1,
        }
    }
}

#[derive(Debug)]
pub enum Error {
    Ivf(IvfError),
    /// The IVF fourcc is not `AV01`.
    NotAv1([u8; 4]),
    /// rivet could not demux the container, or its video track is not AV1.
    #[cfg(feature = "container")]
    Container(String),
    /// The decoder could not be created.
    Open(Rav1dError),
    /// rav1d rejected the bitstream. The decoder is still usable; the offending
    /// temporal unit was dropped.
    Decode(Rav1dError),
    /// [`Decoder::run`] was called with no source and no pushed data.
    NoSource,
    /// Called an IVF-only or push-only method in the other mode.
    WrongMode,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Ivf(e) => write!(f, "{e}"),
            Error::NotAv1(fourcc) => write!(
                f,
                "IVF fourcc is {:?}, not AV01",
                String::from_utf8_lossy(fourcc)
            ),
            #[cfg(feature = "container")]
            Error::Container(msg) => write!(f, "container: {msg}"),
            Error::Open(e) => write!(f, "could not open rav1d: {e}"),
            Error::Decode(e) => write!(f, "rav1d: {e}"),
            Error::NoSource => write!(
                f,
                "no source: call set_source_ivf or push_temporal_unit first"
            ),
            Error::WrongMode => write!(f, "decoder is in the other input mode"),
        }
    }
}

impl std::error::Error for Error {}

impl From<IvfError> for Error {
    fn from(e: IvfError) -> Self {
        Error::Ivf(e)
    }
}

/// What a call to [`Decoder::run`] did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunOutcome {
    /// The ring was already full; nothing was read.
    Full,
    /// One temporal unit was consumed (and whatever frames it produced buffered).
    Consumed,
    /// No input was available: the IVF is exhausted, or nothing has been
    /// pushed since the last call. Pending pictures, if any, were drained.
    Starved,
    /// Everything is done: no input, nothing pending, ring may still hold frames.
    EndOfStream,
}

/// Counters for the stats overlay / tests.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    pub temporal_units_in: u64,
    pub bytes_in: u64,
    pub frames_out: u64,
    pub decode_errors: u64,
}

struct Pushed {
    data: Vec<u8>,
    pts: i64,
}

enum Source {
    Ivf(IvfReader),
    #[cfg(feature = "container")]
    Container {
        demuxer: Box<dyn StreamingDemuxer>,
        header: DemuxHeader,
        /// `next_video_sample` returned `None`.
        exhausted: bool,
    },
    Push {
        queue: VecDeque<Pushed>,
        ended: bool,
    },
}

/// What a container told us about the stream — the subset of rivet's
/// `DemuxHeader` a player needs.
#[cfg(feature = "container")]
#[derive(Clone, Debug, PartialEq)]
pub struct ContainerInfo {
    /// rivet's codec label (`"av1"` — anything else is rejected before you see it).
    pub codec: String,
    pub width: u32,
    pub height: u32,
    /// Ticks per second of the sample pts (MP4 track timescale, MKV 1e9, TS 90 kHz).
    pub timescale: u32,
    pub frame_rate: f64,
    pub duration_secs: f64,
    /// Sample count if the container knew it (0 otherwise).
    pub total_frames: u64,
}

#[cfg(feature = "container")]
impl ContainerInfo {
    fn from_header(header: &DemuxHeader) -> ContainerInfo {
        ContainerInfo {
            codec: header.codec.clone(),
            width: header.info.width,
            height: header.info.height,
            timescale: header.timescale,
            frame_rate: header.info.frame_rate,
            duration_secs: header.info.duration,
            total_frames: header.info.total_frames,
        }
    }
}

/// The AV1 decoder with its ring of decoded frames.
pub struct Decoder {
    inner: rav1d::Decoder,
    config: Config,
    source: Option<Source>,
    ring: VecDeque<Frame>,
    /// The frame most recently handed out by [`Decoder::next_frame`]; upstream
    /// kept `ad_LastFrame` so the JS side could keep reading it until the next call.
    current: Option<Frame>,
    /// True once we know rav1d has no more pictures for the input it has seen.
    drained: bool,
    /// Set after rav1d returned `TryAgain` from `send_data`: it wants pictures
    /// pulled before it will take the rest of that data.
    input_pending: bool,
    /// Size of the most recent decoded frame — what `width()`/`height()`
    /// answer in push mode, where there is no container header to ask.
    last_size: Option<(usize, usize)>,
    stats: Stats,
}

fn open_rav1d(config: &Config) -> Result<rav1d::Decoder, Error> {
    let mut settings = Settings::new();
    settings.set_n_threads(if cfg!(target_arch = "wasm32") {
        1
    } else {
        config.threads.max(1)
    });
    settings.set_apply_grain(config.apply_grain);
    // With one thread, one frame of delay; more only buys anything with
    // frame threading.
    settings.set_max_frame_delay(1);
    rav1d::Decoder::with_settings(&settings).map_err(Error::Open)
}

impl Decoder {
    pub fn new(config: Config) -> Result<Decoder, Error> {
        let inner = open_rav1d(&config)?;
        Ok(Decoder {
            inner,
            config,
            source: None,
            ring: VecDeque::with_capacity(config.max_buffered),
            current: None,
            drained: true,
            input_pending: false,
            last_size: None,
            stats: Stats::default(),
        })
    }

    pub fn config(&self) -> &Config {
        &self.config
    }

    pub fn stats(&self) -> Stats {
        self.stats
    }

    /// Use a whole IVF file as the source. Replaces any previous source and
    /// resets the decoder.
    pub fn set_source_ivf(&mut self, data: Vec<u8>) -> Result<&IvfHeader, Error> {
        let reader = IvfReader::new(data)?;
        if !reader.header().is_av1() {
            return Err(Error::NotAv1(reader.header().fourcc));
        }
        self.reset_state()?;
        self.source = Some(Source::Ivf(reader));
        match &self.source {
            Some(Source::Ivf(r)) => Ok(r.header()),
            _ => unreachable!(),
        }
    }

    /// The IVF header, if the source is IVF.
    pub fn ivf_header(&self) -> Option<&IvfHeader> {
        match &self.source {
            Some(Source::Ivf(r)) => Some(r.header()),
            _ => None,
        }
    }

    /// Use a whole container file (MP4/fMP4/CMAF, WebM/MKV, TS) as the source,
    /// demuxed by rivet. Replaces any previous source and resets the decoder.
    /// Fails if rivet cannot read it or the video track is not AV1.
    #[cfg(feature = "container")]
    pub fn set_source_container(&mut self, data: Vec<u8>) -> Result<ContainerInfo, Error> {
        let demuxer = container::streaming::demux_streaming_shared(bytes::Bytes::from(data))
            .map_err(|e| Error::Container(format!("{e:#}")))?;
        let header = demuxer.header().clone();
        if !header.codec.eq_ignore_ascii_case("av1") {
            return Err(Error::Container(format!(
                "video track is {}, not av1",
                header.codec
            )));
        }
        self.reset_state()?;
        let info = ContainerInfo::from_header(&header);
        self.source = Some(Source::Container {
            demuxer,
            header,
            exhausted: false,
        });
        Ok(info)
    }

    /// The container's stream info, if the source is a container.
    #[cfg(feature = "container")]
    pub fn container_info(&self) -> Option<ContainerInfo> {
        match &self.source {
            Some(Source::Container { header, .. }) => Some(ContainerInfo::from_header(header)),
            _ => None,
        }
    }

    /// `(num, den)` such that `seconds = pts * num / den` for the pts on
    /// frames — the IVF time base or `(1, container timescale)`; `None` in
    /// push mode (the caller knows its own units).
    pub fn time_base(&self) -> Option<(u32, u32)> {
        match &self.source {
            Some(Source::Ivf(r)) => {
                let h = r.header();
                (h.time_base_num > 0 && h.time_base_den > 0)
                    .then_some((h.time_base_num, h.time_base_den))
            }
            #[cfg(feature = "container")]
            Some(Source::Container { header, .. }) => {
                (header.timescale > 0).then_some((1, header.timescale))
            }
            _ => None,
        }
    }

    /// Queue one temporal unit (the OBUs of one AV1 sample) with its pts.
    /// Switches the decoder to push mode; the first call after IVF mode resets it.
    pub fn push_temporal_unit(&mut self, data: Vec<u8>, pts: i64) -> Result<(), Error> {
        if !matches!(self.source, Some(Source::Push { .. })) {
            self.reset_state()?;
            self.source = Some(Source::Push {
                queue: VecDeque::new(),
                ended: false,
            });
        }
        if let Some(Source::Push { queue, ended }) = &mut self.source {
            *ended = false;
            queue.push_back(Pushed { data, pts });
        }
        Ok(())
    }

    /// In push mode: no more temporal units will come, so [`Decoder::finished`]
    /// may become true once everything queued has been decoded and shown.
    pub fn end_of_stream(&mut self) {
        if let Some(Source::Push { ended, .. }) = &mut self.source {
            *ended = true;
        }
    }

    /// Temporal units queued in push mode and not yet sent to the decoder.
    pub fn pending_input(&self) -> usize {
        match &self.source {
            Some(Source::Push { queue, .. }) => queue.len(),
            _ => 0,
        }
    }

    /// Drop everything decoded or queued and reset rav1d, e.g. for a seek.
    /// The IVF source, if any, rewinds to its first frame; a container source
    /// is forward-only in rivet and is dropped (set it again to replay).
    pub fn flush(&mut self) -> Result<(), Error> {
        self.reset_state()?;
        match &mut self.source {
            Some(Source::Ivf(r)) => r.rewind(),
            #[cfg(feature = "container")]
            Some(Source::Container { .. }) => self.source = None,
            Some(Source::Push { queue, ended }) => {
                queue.clear();
                *ended = false;
            }
            None => {}
        }
        Ok(())
    }

    /// Start rav1d over. A fresh instance rather than `flush()`: rav1d's
    /// `flush` keeps any input it had not finished taking (`send_data` would
    /// then panic), and it leaves decoded pictures retrievable, both of which
    /// are exactly what a seek must not carry across.
    fn reset_state(&mut self) -> Result<(), Error> {
        self.inner = open_rav1d(&self.config)?;
        self.ring.clear();
        self.current = None;
        self.drained = true;
        self.input_pending = false;
        Ok(())
    }

    /// Frames decoded and waiting.
    pub fn frames_buffered(&self) -> usize {
        self.ring.len()
    }

    fn source_done(&self) -> bool {
        match &self.source {
            None => false,
            Some(Source::Ivf(r)) => r.is_empty(),
            #[cfg(feature = "container")]
            Some(Source::Container { exhausted, .. }) => *exhausted,
            Some(Source::Push { queue, ended }) => *ended && queue.is_empty(),
        }
    }

    /// True when there is nothing left to decode or show.
    pub fn finished(&self) -> bool {
        self.source_done() && !self.input_pending && self.drained && self.ring.is_empty()
    }

    fn header_size(&self) -> Option<(usize, usize)> {
        match &self.source {
            Some(Source::Ivf(r)) => Some((r.header().width as usize, r.header().height as usize)),
            #[cfg(feature = "container")]
            Some(Source::Container { header, .. }) => (header.info.width > 0
                && header.info.height > 0)
                .then_some((header.info.width as usize, header.info.height as usize)),
            _ => None,
        }
    }

    /// Stream width: the IVF/container header's, else the most recent decoded
    /// frame's. `None` until either is known.
    pub fn width(&self) -> Option<usize> {
        self.header_size()
            .map(|s| s.0)
            .or(self.last_size.map(|s| s.0))
    }

    /// Stream height, likewise.
    pub fn height(&self) -> Option<usize> {
        self.header_size()
            .map(|s| s.1)
            .or(self.last_size.map(|s| s.1))
    }

    /// Do a bounded slice of work — upstream `AVX_Decoder_run`.
    ///
    /// If the ring has room: feed the next temporal unit to rav1d (or the rest
    /// of one it did not finish taking) and move every picture that yields
    /// into the ring. Call it once per animation frame, or in a loop until
    /// [`RunOutcome::Full`]/[`RunOutcome::EndOfStream`] to fill up.
    pub fn run(&mut self) -> Result<RunOutcome, Error> {
        if self.source.is_none() {
            return Err(Error::NoSource);
        }
        if self.ring.len() >= self.config.max_buffered {
            return Ok(RunOutcome::Full);
        }

        // Pictures the last call could not fit into the ring come first.
        if !self.drained {
            self.collect_pictures();
            if self.ring.len() >= self.config.max_buffered {
                return Ok(RunOutcome::Full);
            }
        }

        // rav1d asked us to pull pictures before it takes the rest of the last input.
        if self.input_pending {
            match self.inner.send_pending_data() {
                Ok(()) => self.input_pending = false,
                Err(Rav1dError::TryAgain) => {
                    self.collect_pictures();
                    return Ok(RunOutcome::Consumed);
                }
                Err(e) => {
                    self.input_pending = false;
                    self.stats.decode_errors += 1;
                    return Err(Error::Decode(e));
                }
            }
            self.collect_pictures();
            return Ok(RunOutcome::Consumed);
        }

        // Next temporal unit from whichever source.
        let next: Option<(Vec<u8>, i64)> = match self.source.as_mut().unwrap() {
            Source::Ivf(r) => r.next_frame()?.map(|f| (f.data.to_vec(), f.pts as i64)),
            #[cfg(feature = "container")]
            Source::Container {
                demuxer, exhausted, ..
            } => match demuxer.next_video_sample() {
                Ok(Some(s)) => Some((s.data, s.pts_ticks)),
                Ok(None) => {
                    *exhausted = true;
                    None
                }
                Err(e) => {
                    // A damaged sample: report it; the demuxer stays usable.
                    self.stats.decode_errors += 1;
                    return Err(Error::Container(format!("{e:#}")));
                }
            },
            Source::Push { queue, .. } => queue.pop_front().map(|p| (p.data, p.pts)),
        };

        let Some((data, pts)) = next else {
            // Starved. Drain what rav1d still holds so `finished` can settle.
            self.collect_pictures();
            let source_done = self.source_done();
            return Ok(if source_done && self.drained {
                RunOutcome::EndOfStream
            } else {
                RunOutcome::Starved
            });
        };

        self.stats.temporal_units_in += 1;
        self.stats.bytes_in += data.len() as u64;
        self.drained = false;
        match self
            .inner
            .send_data(data.into_boxed_slice(), None, Some(pts), None)
        {
            Ok(()) => {}
            Err(Rav1dError::TryAgain) => self.input_pending = true,
            Err(e) => {
                self.stats.decode_errors += 1;
                // The unit is dropped; the decoder itself is fine to continue.
                self.drained = true;
                return Err(Error::Decode(e));
            }
        }
        self.collect_pictures();
        Ok(RunOutcome::Consumed)
    }

    /// Move every picture rav1d has ready into the ring, up to capacity.
    fn collect_pictures(&mut self) {
        while self.ring.len() < self.config.max_buffered {
            match self.inner.get_picture() {
                Ok(pic) => {
                    let frame = Frame::from_picture(&pic);
                    self.last_size = Some((frame.width, frame.height));
                    self.ring.push_back(frame);
                    self.stats.frames_out += 1;
                }
                Err(Rav1dError::TryAgain) => {
                    self.drained = true;
                    return;
                }
                Err(_) => {
                    // A picture-level error (e.g. a corrupt frame). Count it and
                    // keep pulling; rav1d recovers at the next keyframe.
                    self.stats.decode_errors += 1;
                    self.drained = true;
                    return;
                }
            }
        }
        // Ring is full; there may be more. `drained` stays as it was.
    }

    /// Pop the oldest buffered frame — upstream `AVX_Decoder_get_frame`.
    ///
    /// The returned reference stays valid (as [`Decoder::current_frame`])
    /// until the next call to this method or to [`Decoder::flush`].
    pub fn next_frame(&mut self) -> Option<&Frame> {
        self.current = self.ring.pop_front();
        self.current.as_ref()
    }

    /// The oldest buffered frame — what the next [`Decoder::next_frame`] will
    /// return — without popping it. Lets a caller pace on its pts first.
    pub fn peek_next(&self) -> Option<&Frame> {
        self.ring.front()
    }

    /// The frame most recently returned by [`Decoder::next_frame`].
    pub fn current_frame(&self) -> Option<&Frame> {
        self.current.as_ref()
    }

    /// Take the current frame out, leaving none.
    pub fn take_current_frame(&mut self) -> Option<Frame> {
        self.current.take()
    }

    /// Decode everything available right now, filling the ring.
    pub fn run_until_full(&mut self) -> Result<RunOutcome, Error> {
        loop {
            match self.run()? {
                RunOutcome::Consumed => continue,
                other => return Ok(other),
            }
        }
    }
}

impl fmt::Debug for Decoder {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Decoder")
            .field("buffered", &self.ring.len())
            .field("finished", &self.finished())
            .field("stats", &self.stats)
            .finish()
    }
}
