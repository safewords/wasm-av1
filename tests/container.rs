//! The rivet-container path: MP4, fragmented MP4 (CMAF shape) and WebM
//! remuxes of the 320x180 fixture must decode to exactly the frames the IVF
//! does, with pts in the container's own timescale.
#![cfg(feature = "container")]

use std::fs;
use std::path::Path;

use md5::{Digest, Md5};
use wasm_av1::{Config, Decoder, Error, RunOutcome};

fn testdata(name: &str) -> Vec<u8> {
    fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("testdata")
            .join(name),
    )
    .unwrap()
}

fn reference_md5() -> (String, u64) {
    let text = fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/testsrc-320x180-8bit.ref"),
    )
    .unwrap();
    let f: Vec<&str> = text.split_whitespace().collect();
    (f[4].to_string(), f[2].parse().unwrap())
}

fn decode_container(name: &str) -> (Vec<wasm_av1::Frame>, wasm_av1::ContainerInfo, Decoder) {
    let mut dec = Decoder::new(Config::default()).unwrap();
    let info = dec.set_source_container(testdata(name)).unwrap();
    let mut frames = Vec::new();
    while !dec.finished() {
        dec.run().unwrap();
        while let Some(f) = dec.next_frame() {
            frames.push(f.clone());
        }
    }
    (frames, info, dec)
}

fn md5_of(frames: &[wasm_av1::Frame]) -> String {
    let mut h = Md5::new();
    for f in frames {
        h.update(&f.data);
    }
    format!("{:x}", h.finalize())
}

#[test]
fn mp4_fmp4_and_webm_decode_to_the_ivf_reference() {
    let (want_md5, want_frames) = reference_md5();
    for (name, timescale) in [
        ("testsrc-320x180-8bit.mp4", 12288u32),
        ("testsrc-320x180-8bit.fmp4", 12288),
        ("testsrc-320x180-8bit.webm", 1_000_000_000),
    ] {
        let (frames, info, mut dec) = decode_container(name);
        assert_eq!(info.codec, "av1", "{name}");
        assert_eq!((info.width, info.height), (320, 180), "{name}");
        assert_eq!(info.timescale, timescale, "{name}: timescale");
        assert_eq!(dec.time_base(), Some((1, timescale)), "{name}: time_base");
        assert_eq!(dec.width(), Some(320), "{name}");
        assert_eq!(frames.len() as u64, want_frames, "{name}: frame count");
        assert_eq!(md5_of(&frames), want_md5, "{name}: MD5");
        // pts advance monotonically at one frame duration (24 fps) in the
        // container's ticks: exactly 512 ticks at 12288/s; WebM timestamps
        // are millisecond-granular (TimestampScale 1e6 ns), so ~41.67 ms ±1 ms.
        let (step, tolerance) = if timescale == 12288 {
            (512, 0)
        } else {
            (41_666_667, 1_000_000)
        };
        for w in frames.windows(2) {
            let (a, b) = (w[0].pts.unwrap(), w[1].pts.unwrap());
            assert!(
                (b - a - step).abs() <= tolerance,
                "{name}: pts step {} (want {step} ±{tolerance})",
                b - a
            );
        }
        assert_eq!(dec.run().unwrap(), RunOutcome::EndOfStream);
    }
}

#[test]
fn container_info_matches_ffprobe_shape() {
    let (_, info, _) = decode_container("testsrc-320x180-8bit.mp4");
    assert!((info.frame_rate - 24.0).abs() < 0.01, "{}", info.frame_rate);
    assert!(
        (info.duration_secs - 2.0).abs() < 0.05,
        "{}",
        info.duration_secs
    );
    assert_eq!(info.total_frames, 48);
}

#[test]
fn non_av1_or_garbage_containers_are_rejected_cleanly() {
    let mut dec = Decoder::new(Config::default()).unwrap();
    assert!(matches!(
        dec.set_source_container(vec![0u8; 64]),
        Err(Error::Container(_))
    ));
    // An IVF is not a container rivet knows.
    let ivf = testdata("testsrc-320x180-8bit.ivf");
    assert!(matches!(
        dec.set_source_container(ivf.clone()),
        Err(Error::Container(_))
    ));
    // …but the decoder is still fine.
    dec.set_source_ivf(ivf).unwrap();
    assert!(matches!(dec.run_until_full(), Ok(RunOutcome::Full)));
}

#[test]
fn flush_drops_a_container_source() {
    let mut dec = Decoder::new(Config::default()).unwrap();
    dec.set_source_container(testdata("testsrc-320x180-8bit.mp4"))
        .unwrap();
    dec.run_until_full().unwrap();
    assert!(dec.frames_buffered() > 0);
    dec.flush().unwrap();
    assert_eq!(dec.frames_buffered(), 0);
    assert!(matches!(dec.run(), Err(Error::NoSource)));
    assert!(dec.container_info().is_none());
}

#[test]
fn cmaf_segments_pushed_one_by_one_decode_continuously() {
    cmaf_segments_decode_continuously(1);
}

#[test]
fn cmaf_segments_decode_continuously_with_worker_threads() {
    // The production path (segment-fed, frames popped as they come) with
    // rav1d's frame threading: frames cross the segment boundary in order,
    // and the last ones in flight come out on end_of_stream.
    cmaf_segments_decode_continuously(4);
}

fn cmaf_segments_decode_continuously(threads: u32) {
    // testdata/cmaf: init.mp4 + seg0.m4s + seg1.m4s (1 s each) of the same
    // stream as the 320x180 fixture, cut the way HLS serves CMAF.
    let (want_md5, want_frames) = reference_md5();
    let mut dec = Decoder::new(Config {
        max_buffered: 4,
        threads,
        ..Config::default()
    })
    .unwrap();
    dec.set_init_segment(testdata("cmaf/init.mp4")).unwrap();
    assert!(
        dec.time_base().is_none(),
        "no time base until a segment is seen"
    );
    let mut frames = Vec::new();
    let mut total_samples = 0;
    for seg in ["cmaf/seg0.m4s", "cmaf/seg1.m4s"] {
        let n = dec.push_segment(&testdata(seg)).unwrap();
        assert!(n > 0, "{seg}: no samples");
        total_samples += n;
        // Decode what is queued, popping frames as a player would, so the ring
        // never blocks the next segment.
        while let RunOutcome::Consumed | RunOutcome::Full = dec.run().unwrap() {
            while let Some(f) = dec.next_frame() {
                frames.push(f.clone());
            }
        }
        while let Some(f) = dec.next_frame() {
            frames.push(f.clone());
        }
    }
    assert_eq!(
        dec.time_base(),
        Some((1, 12288)),
        "container timescale surfaced"
    );
    assert!(!dec.finished(), "not finished until end_of_stream");
    dec.end_of_stream();
    while !dec.finished() {
        dec.run().unwrap();
        while let Some(f) = dec.next_frame() {
            frames.push(f.clone());
        }
    }
    assert_eq!(total_samples as u64, want_frames);
    assert_eq!(frames.len() as u64, want_frames);
    // pts continue across the segment boundary in the container's timescale.
    for w in frames.windows(2) {
        assert_eq!(w[1].pts.unwrap() - w[0].pts.unwrap(), 512, "pts step");
    }
    assert_eq!(md5_of(&frames), want_md5, "MD5 across segments");
    assert_eq!(dec.width(), Some(320));
}

/// Decode a whole CMAF rendition (init + every segment) the segment-fed way.
fn decode_segments(dir: &str, threads: u32) -> Vec<wasm_av1::Frame> {
    let mut dec = Decoder::new(Config {
        threads,
        ..Config::default()
    })
    .unwrap();
    dec.set_init_segment(testdata(&format!("{dir}/init.mp4")))
        .unwrap();
    for seg in ["seg0.m4s", "seg1.m4s"] {
        dec.push_segment(&testdata(&format!("{dir}/{seg}")))
            .unwrap();
    }
    dec.end_of_stream();
    let mut frames = Vec::new();
    while !dec.finished() {
        dec.run().unwrap();
        while let Some(f) = dec.next_frame() {
            frames.push(f.clone());
        }
    }
    frames
}

#[test]
fn a_rendition_switch_at_a_segment_boundary_is_seamless() {
    rendition_switch_is_seamless(1);
}

#[test]
fn a_rendition_switch_is_seamless_with_worker_threads() {
    rendition_switch_is_seamless(4);
}

/// testdata/cmaf (320x180) and testdata/cmaf-lo (160x90) are two rungs of
/// the same content: same GOP, same 1 s segments, same timescale. Play the
/// high rung with its whole future already queued, then — as a player does
/// when the device stutters — replace the not-yet-decoded future from the
/// next segment boundary with the low rung: truncate the queue there, new
/// init, other rung's segment. No flush: nothing decoded is lost, pts run
/// on, and each half is bit-exact with that rung decoded on its own.
fn rendition_switch_is_seamless(threads: u32) {
    let hi = decode_segments("cmaf", 1);
    let lo = decode_segments("cmaf-lo", 1);
    assert_eq!(hi.len(), 48);
    assert_eq!(lo.len(), 48);

    let mut dec = Decoder::new(Config {
        max_buffered: 4,
        threads,
        ..Config::default()
    })
    .unwrap();
    dec.set_init_segment(testdata("cmaf/init.mp4")).unwrap();
    dec.push_segment(&testdata("cmaf/seg0.m4s")).unwrap();
    // The future is already queued, as a prefetching player would have it.
    dec.push_segment(&testdata("cmaf/seg1.m4s")).unwrap();
    assert_eq!(dec.pending_input(), 48);

    // Watch ten frames of the high rung.
    let mut frames = Vec::new();
    while frames.len() < 10 {
        dec.run().unwrap();
        while let Some(f) = dec.next_frame() {
            frames.push(f.clone());
        }
    }

    // Switch at the seg1 boundary (frame 24: 24 × 512 ticks at 12288/s).
    let boundary = 24 * 512;
    assert!(
        dec.next_queued_pts().unwrap() < boundary,
        "the decoder must not have reached the boundary yet"
    );
    assert!(dec.last_sent_pts().unwrap() < boundary);
    let dropped = dec.truncate_queued_from(boundary);
    assert_eq!(dropped, 24, "seg1's samples were un-queued");
    dec.set_init_segment(testdata("cmaf-lo/init.mp4")).unwrap();
    assert_eq!(dec.push_segment(&testdata("cmaf-lo/seg1.m4s")).unwrap(), 24);
    dec.end_of_stream();
    while !dec.finished() {
        dec.run().unwrap();
        while let Some(f) = dec.next_frame() {
            frames.push(f.clone());
        }
    }

    assert_eq!(
        frames.len(),
        48,
        "{threads} threads: every frame of both halves"
    );
    assert_eq!(dec.stats().decode_errors, 0);
    for w in frames.windows(2) {
        assert_eq!(
            w[1].pts.unwrap() - w[0].pts.unwrap(),
            512,
            "pts run on across the switch"
        );
    }
    assert!(frames[..24]
        .iter()
        .all(|f| f.width == 320 && f.height == 180));
    assert!(frames[24..]
        .iter()
        .all(|f| f.width == 160 && f.height == 90));
    assert_eq!(
        md5_of(&frames[..24]),
        md5_of(&hi[..24]),
        "high rung half is exact"
    );
    assert_eq!(
        md5_of(&frames[24..]),
        md5_of(&lo[24..]),
        "low rung half is exact"
    );
}

#[test]
fn truncating_at_a_boundary_the_decoder_passed_drops_nothing_useful() {
    // The guard a player must apply: once rav1d has been handed a temporal
    // unit at or beyond the boundary, the boundary is gone — `next_queued_pts`
    // / `last_sent_pts` say so, and the player picks the next one.
    let mut dec = Decoder::new(Config::default()).unwrap();
    dec.set_init_segment(testdata("cmaf/init.mp4")).unwrap();
    dec.push_segment(&testdata("cmaf/seg0.m4s")).unwrap();
    dec.push_segment(&testdata("cmaf/seg1.m4s")).unwrap();
    // Decode well into seg1.
    let mut n = 0;
    while n < 30 {
        dec.run().unwrap();
        while dec.next_frame().is_some() {
            n += 1;
        }
    }
    let boundary = 24 * 512;
    let front = dec.next_queued_pts().unwrap();
    assert!(
        front > boundary,
        "queue front is past the boundary: {front}"
    );
    assert!(dec.last_sent_pts().unwrap() >= boundary);
    // A player that checked would not do this; if it did, it drops seg1's
    // remaining samples — legal, just a gap it must then refill.
    let dropped = dec.truncate_queued_from(boundary);
    assert_eq!(dropped as u64, 48 - dec.stats().temporal_units_in);
    assert_eq!(dec.pending_input(), 0);
}
