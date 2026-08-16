//! The wasm-bindgen surface — upstream's `EXPORTED_FUNCTIONS` list, as one object.
//!
//! Upstream exported flat C functions (`_AVX_Decoder_new`, `_AVX_Decoder_run`,
//! `_AVX_Decoder_get_frame`, `_AVX_Video_Frame_get_buffer`, `_AVX_YUV_to_RGB`,
//! `_DS_open`/`_DS_set_blob`, `_malloc`/`_free`) and the page did pointer
//! arithmetic on `Module.HEAPU8`. Here the same operations hang off one
//! [`Av1Decoder`] instance and JS never allocates: it copies input in
//! (`setSourceIvf` / `pushTemporalUnit`) and reads output out as views over
//! wasm memory (`framePtr`/`frameLen`, `rgbaPtr`/`rgbaLen`).
//!
//! **Views are transient.** Any call that decodes may grow wasm memory, which
//! detaches every `Uint8Array` a caller built over it. Build the view, use it,
//! drop it — the JS wrapper in `js/` does this for you.
//!
//! The "current frame" accessors refer to the frame most recently made current
//! by [`Av1Decoder::next_frame`]; it stays valid until the next `nextFrame`,
//! `flush`, or source change.

use wasm_bindgen::prelude::*;

use crate::convert;
use crate::decoder::{Config, Decoder, RunOutcome};
use crate::frame::Frame;

/// True when this .wasm was built with SIMD128.
#[wasm_bindgen(js_name = "simdEnabled")]
pub fn simd_enabled() -> bool {
    convert::simd_enabled()
}

/// Crate version.
#[wasm_bindgen]
pub fn version() -> String {
    crate::VERSION.to_string()
}

/// True when this .wasm can demux containers (`setSourceContainer`), i.e.
/// was built with the `container` feature (rivet-container).
#[wasm_bindgen(js_name = "containerSupport")]
pub fn container_support() -> bool {
    cfg!(feature = "container")
}

/// [`RunOutcome`] as a small integer for JS.
#[wasm_bindgen]
#[derive(Clone, Copy)]
pub enum RunResult {
    Full = 0,
    Consumed = 1,
    Starved = 2,
    EndOfStream = 3,
}

impl From<RunOutcome> for RunResult {
    fn from(o: RunOutcome) -> Self {
        match o {
            RunOutcome::Full => RunResult::Full,
            RunOutcome::Consumed => RunResult::Consumed,
            RunOutcome::Starved => RunResult::Starved,
            RunOutcome::EndOfStream => RunResult::EndOfStream,
        }
    }
}

/// Decoder counters.
#[wasm_bindgen]
#[derive(Clone, Copy, Default)]
pub struct DecoderStats {
    #[wasm_bindgen(js_name = "temporalUnitsIn")]
    pub temporal_units_in: f64,
    #[wasm_bindgen(js_name = "bytesIn")]
    pub bytes_in: f64,
    #[wasm_bindgen(js_name = "framesOut")]
    pub frames_out: f64,
    #[wasm_bindgen(js_name = "decodeErrors")]
    pub decode_errors: f64,
}

/// One AV1 decoder with its frame ring and a reusable RGBA scratch buffer.
#[wasm_bindgen]
pub struct Av1Decoder {
    inner: Decoder,
    rgba: Vec<u8>,
}

fn js_err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

#[wasm_bindgen]
impl Av1Decoder {
    /// `maxBuffered` frames kept ahead (default 10, upstream's
    /// `NUM_FRAMES_BUFFERED`); `applyGrain` toggles film-grain synthesis
    /// (default true).
    #[wasm_bindgen(constructor)]
    pub fn new(
        max_buffered: Option<u32>,
        apply_grain: Option<bool>,
    ) -> Result<Av1Decoder, JsError> {
        let config = Config {
            max_buffered: max_buffered
                .map(|n| n.max(1) as usize)
                .unwrap_or(Config::default().max_buffered),
            apply_grain: apply_grain.unwrap_or(true),
            threads: 1,
        };
        Ok(Av1Decoder {
            inner: Decoder::new(config).map_err(js_err)?,
            rgba: Vec::new(),
        })
    }

    // ---- input -----------------------------------------------------------

    /// Load a whole IVF file (copied into wasm memory). Resets the decoder.
    #[wasm_bindgen(js_name = "setSourceIvf")]
    pub fn set_source_ivf(&mut self, data: &[u8]) -> Result<(), JsError> {
        self.inner
            .set_source_ivf(data.to_vec())
            .map(|_| ())
            .map_err(js_err)
    }

    /// Load a whole container file — MP4 / fragmented MP4 / CMAF, WebM / MKV,
    /// MPEG-TS — demuxed by rivet (copied into wasm memory). Resets the
    /// decoder. Throws if the build lacks the `container` feature, rivet
    /// cannot read the file, or the video track is not AV1.
    #[wasm_bindgen(js_name = "setSourceContainer")]
    pub fn set_source_container(&mut self, data: &[u8]) -> Result<(), JsError> {
        #[cfg(feature = "container")]
        {
            self.inner
                .set_source_container(data.to_vec())
                .map(|_| ())
                .map_err(js_err)
        }
        #[cfg(not(feature = "container"))]
        {
            let _ = data;
            Err(JsError::new(
                "this build has no container support (feature `container`)",
            ))
        }
    }

    /// Queue one temporal unit (an AV1 sample's OBUs) with its pts.
    #[wasm_bindgen(js_name = "pushTemporalUnit")]
    pub fn push_temporal_unit(&mut self, data: &[u8], pts: f64) -> Result<(), JsError> {
        self.inner
            .push_temporal_unit(data.to_vec(), pts as i64)
            .map_err(js_err)
    }

    /// Push mode: nothing more is coming.
    #[wasm_bindgen(js_name = "endOfStream")]
    pub fn end_of_stream(&mut self) {
        self.inner.end_of_stream();
    }

    /// Temporal units queued and not yet decoded (push mode).
    #[wasm_bindgen(js_name = "pendingInput")]
    pub fn pending_input(&self) -> u32 {
        self.inner.pending_input() as u32
    }

    /// Drop everything buffered, reset rav1d; IVF sources rewind.
    pub fn flush(&mut self) -> Result<(), JsError> {
        self.inner.flush().map_err(js_err)
    }

    // ---- driving ---------------------------------------------------------

    /// One bounded step of decoding — see `Decoder::run`. A rejected temporal
    /// unit throws; the decoder stays usable, keep calling.
    pub fn run(&mut self) -> Result<RunResult, JsError> {
        self.inner.run().map(RunResult::from).map_err(js_err)
    }

    /// `run()` until the ring is full or input runs out.
    #[wasm_bindgen(js_name = "runUntilFull")]
    pub fn run_until_full(&mut self) -> Result<RunResult, JsError> {
        self.inner
            .run_until_full()
            .map(RunResult::from)
            .map_err(js_err)
    }

    #[wasm_bindgen(js_name = "framesBuffered")]
    pub fn frames_buffered(&self) -> u32 {
        self.inner.frames_buffered() as u32
    }

    /// Nothing left to decode or show.
    pub fn finished(&self) -> bool {
        self.inner.finished()
    }

    pub fn stats(&self) -> DecoderStats {
        let s = self.inner.stats();
        DecoderStats {
            temporal_units_in: s.temporal_units_in as f64,
            bytes_in: s.bytes_in as f64,
            frames_out: s.frames_out as f64,
            decode_errors: s.decode_errors as f64,
        }
    }

    // ---- stream info -----------------------------------------------------

    /// Stream width: the IVF header's, else the last decoded frame's; 0 if unknown yet.
    pub fn width(&self) -> u32 {
        self.inner.width().unwrap_or(0) as u32
    }

    pub fn height(&self) -> u32 {
        self.inner.height().unwrap_or(0) as u32
    }

    /// Time base numerator: `seconds = pts * num / den` for frame pts. From
    /// the IVF header or the container timescale; 0 in push mode (you know
    /// your own units).
    #[wasm_bindgen(js_name = "timeBaseNum")]
    pub fn time_base_num(&self) -> u32 {
        self.inner.time_base().map(|t| t.0).unwrap_or(0)
    }

    #[wasm_bindgen(js_name = "timeBaseDen")]
    pub fn time_base_den(&self) -> u32 {
        self.inner.time_base().map(|t| t.1).unwrap_or(0)
    }

    /// Frame count announced by the IVF header or container (0 = unknown).
    #[wasm_bindgen(js_name = "frameCountHint")]
    pub fn frame_count_hint(&self) -> f64 {
        if let Some(h) = self.inner.ivf_header() {
            return h.frame_count as f64;
        }
        #[cfg(feature = "container")]
        if let Some(c) = self.inner.container_info() {
            return c.total_frames as f64;
        }
        0.0
    }

    /// Frame rate as the container (or IVF time base) suggests; 0 if unknown.
    #[wasm_bindgen(js_name = "frameRateHint")]
    pub fn frame_rate_hint(&self) -> f64 {
        #[cfg(feature = "container")]
        if let Some(c) = self.inner.container_info() {
            return c.frame_rate;
        }
        if let Some(h) = self.inner.ivf_header() {
            if let Some(d) = h.frame_duration_secs() {
                return 1.0 / d;
            }
        }
        0.0
    }

    /// Container duration in seconds (0 if unknown / not a container).
    #[wasm_bindgen(js_name = "durationHint")]
    pub fn duration_hint(&self) -> f64 {
        #[cfg(feature = "container")]
        if let Some(c) = self.inner.container_info() {
            return c.duration_secs;
        }
        0.0
    }

    // ---- frames ----------------------------------------------------------

    /// Make the oldest buffered frame current; false if none is buffered.
    #[wasm_bindgen(js_name = "nextFrame")]
    pub fn next_frame(&mut self) -> bool {
        self.inner.next_frame().is_some()
    }

    #[wasm_bindgen(js_name = "hasFrame")]
    pub fn has_frame(&self) -> bool {
        self.inner.current_frame().is_some()
    }

    /// pts of the oldest buffered frame (the one `nextFrame` would return),
    /// without popping it; NaN if none is buffered or it has no pts.
    #[wasm_bindgen(js_name = "peekPts")]
    pub fn peek_pts(&self) -> f64 {
        self.inner
            .peek_next()
            .and_then(|f| f.pts)
            .map(|p| p as f64)
            .unwrap_or(f64::NAN)
    }

    fn cur(&self) -> Option<&Frame> {
        self.inner.current_frame()
    }

    #[wasm_bindgen(js_name = "frameWidth")]
    pub fn frame_width(&self) -> u32 {
        self.cur().map(|f| f.width as u32).unwrap_or(0)
    }

    #[wasm_bindgen(js_name = "frameHeight")]
    pub fn frame_height(&self) -> u32 {
        self.cur().map(|f| f.height as u32).unwrap_or(0)
    }

    /// 8, 10 or 12.
    #[wasm_bindgen(js_name = "frameBitDepth")]
    pub fn frame_bit_depth(&self) -> u32 {
        self.cur().map(|f| f.bit_depth as u32).unwrap_or(0)
    }

    /// 1 or 2.
    #[wasm_bindgen(js_name = "frameBytesPerSample")]
    pub fn frame_bytes_per_sample(&self) -> u32 {
        self.cur().map(|f| f.bytes_per_sample as u32).unwrap_or(0)
    }

    /// 0 = I400, 1 = I420, 2 = I422, 3 = I444.
    #[wasm_bindgen(js_name = "frameLayout")]
    pub fn frame_layout(&self) -> u32 {
        self.cur().map(|f| f.layout as u32).unwrap_or(1)
    }

    /// pts as given with the input; NaN if it had none.
    #[wasm_bindgen(js_name = "framePts")]
    pub fn frame_pts(&self) -> f64 {
        self.cur()
            .and_then(|f| f.pts)
            .map(|p| p as f64)
            .unwrap_or(f64::NAN)
    }

    /// ISO 23091-2 matrix code (1 BT.709, 5/6 BT.601, 9 BT.2020, 2 unspecified).
    #[wasm_bindgen(js_name = "frameMatrix")]
    pub fn frame_matrix(&self) -> u32 {
        self.cur().map(|f| f.color.matrix as u32).unwrap_or(2)
    }

    #[wasm_bindgen(js_name = "framePrimaries")]
    pub fn frame_primaries(&self) -> u32 {
        self.cur().map(|f| f.color.primaries as u32).unwrap_or(2)
    }

    #[wasm_bindgen(js_name = "frameTransfer")]
    pub fn frame_transfer(&self) -> u32 {
        self.cur().map(|f| f.color.transfer as u32).unwrap_or(2)
    }

    #[wasm_bindgen(js_name = "frameFullRange")]
    pub fn frame_full_range(&self) -> bool {
        self.cur().map(|f| f.color.full_range).unwrap_or(false)
    }

    /// Pointer to the packed planes of the current frame in wasm memory.
    #[wasm_bindgen(js_name = "framePtr")]
    pub fn frame_ptr(&self) -> u32 {
        self.cur().map(|f| f.data.as_ptr() as u32).unwrap_or(0)
    }

    #[wasm_bindgen(js_name = "frameLen")]
    pub fn frame_len(&self) -> u32 {
        self.cur().map(|f| f.data.len() as u32).unwrap_or(0)
    }

    /// Byte offset of plane `i` (0 Y, 1 U, 2 V) within the frame buffer.
    #[wasm_bindgen(js_name = "planeOffset")]
    pub fn plane_offset(&self, i: u32) -> u32 {
        self.plane(i).map(|p| p.offset as u32).unwrap_or(0)
    }

    #[wasm_bindgen(js_name = "planeStride")]
    pub fn plane_stride(&self, i: u32) -> u32 {
        self.plane(i).map(|p| p.stride as u32).unwrap_or(0)
    }

    #[wasm_bindgen(js_name = "planeWidth")]
    pub fn plane_width(&self, i: u32) -> u32 {
        self.plane(i).map(|p| p.width as u32).unwrap_or(0)
    }

    #[wasm_bindgen(js_name = "planeHeight")]
    pub fn plane_height(&self, i: u32) -> u32 {
        self.plane(i).map(|p| p.height as u32).unwrap_or(0)
    }

    fn plane(&self, i: u32) -> Option<&crate::frame::PlaneInfo> {
        self.cur().and_then(|f| f.planes.get(i as usize))
    }

    // ---- RGBA ------------------------------------------------------------

    /// Convert the current frame to RGBA8 into the internal scratch buffer
    /// (SIMD128 in the SIMD build) and return its pointer; `rgbaLen` bytes.
    #[wasm_bindgen(js_name = "convertToRgba")]
    pub fn convert_to_rgba(&mut self) -> Result<u32, JsError> {
        let frame = self
            .inner
            .current_frame()
            .ok_or_else(|| JsError::new("no current frame"))?;
        let need = frame.rgba_len();
        if self.rgba.len() < need {
            self.rgba.resize(need, 0);
        }
        convert::yuv_to_rgba(frame, &mut self.rgba[..need]);
        Ok(self.rgba.as_ptr() as u32)
    }

    #[wasm_bindgen(js_name = "rgbaPtr")]
    pub fn rgba_ptr(&self) -> u32 {
        self.rgba.as_ptr() as u32
    }

    /// Bytes of RGBA the *current frame* needs (`width * height * 4`).
    #[wasm_bindgen(js_name = "rgbaLen")]
    pub fn rgba_len(&self) -> u32 {
        self.cur().map(|f| f.rgba_len() as u32).unwrap_or(0)
    }
}
