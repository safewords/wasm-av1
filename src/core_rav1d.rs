//! The decoder core: rav1d.
//!
//! The one place that names rav1d. [`crate::decoder`] drives a [`Core`]
//! through dav1d's shape — offer data, pull pictures, be told to try again —
//! and the other core (`core_rivet.rs`, feature `rivet-av1`) presents the
//! same five calls.

use rav1d::{Picture, PixelLayout as Rav1dLayout, PlanarImageComponent, Rav1dError, Settings};

use crate::decoder::Config;
use crate::frame::{ColorInfo, Frame, PixelLayout};

/// What the core reports when it cannot open or cannot decode.
pub type CoreError = Rav1dError;

/// The name the core goes by in error messages.
pub(crate) const NAME: &str = "rav1d";

pub(crate) struct Core {
    inner: rav1d::Decoder,
}

impl Core {
    pub(crate) fn open(config: &Config) -> Result<Core, CoreError> {
        let threads = crate::decoder::effective_threads(config);
        #[cfg(all(target_arch = "wasm32", target_feature = "atomics"))]
        if threads > 1 {
            crate::threads::install();
        }
        let mut settings = Settings::new();
        settings.set_n_threads(threads);
        settings.set_apply_grain(config.apply_grain);
        // One thread: one frame of delay, nothing to overlap. More: let rav1d
        // pick its frame-thread count from the thread count (dav1d's default,
        // ceil(sqrt(n)) capped at 8); frames come out a few later, which the
        // ring absorbs.
        settings.set_max_frame_delay(if threads > 1 { 0 } else { 1 });
        Ok(Core {
            inner: rav1d::Decoder::with_settings(&settings)?,
        })
    }

    /// rav1d's own flush: drops in-flight and delayed frames and the
    /// headers, keeps the context — and with it the worker threads, which
    /// on wasm are Workers that would otherwise be torn down and re-spawned
    /// on every seek.
    pub(crate) fn flush(&mut self) {
        self.inner.flush();
    }

    /// Offer one temporal unit. `Ok(false)`: rav1d kept part of it and wants
    /// pictures pulled before [`Core::send_pending`] offers the rest.
    pub(crate) fn send(&mut self, data: Vec<u8>, pts: i64) -> Result<bool, CoreError> {
        match self
            .inner
            .send_data(data.into_boxed_slice(), None, Some(pts), None)
        {
            Ok(()) => Ok(true),
            Err(Rav1dError::TryAgain) => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// Offer the rest of the temporal unit [`Core::send`] did not finish.
    pub(crate) fn send_pending(&mut self) -> Result<bool, CoreError> {
        match self.inner.send_pending_data() {
            Ok(()) => Ok(true),
            Err(Rav1dError::TryAgain) => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// The next decoded picture, `Ok(None)` when rav1d has none ready. Called
    /// again right after a `None` it waits for a frame still in flight in the
    /// worker threads (rav1d's drain state, reset by the next `send`).
    pub(crate) fn picture(&mut self) -> Result<Option<Frame>, CoreError> {
        match self.inner.get_picture() {
            Ok(pic) => Ok(Some(Frame::from_picture(&pic))),
            Err(Rav1dError::TryAgain) => Ok(None),
            Err(e) => Err(e),
        }
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

impl Frame {
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
}
