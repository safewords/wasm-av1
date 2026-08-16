//! Decode every fixture in `testdata/` and reproduce ffmpeg's MD5 of the
//! decoded planes. AV1 decoding is normative: rav1d, libdav1d and libaom must
//! agree bit for bit, so any mismatch here is a real bug — in plane packing,
//! stride handling, bit depth, or the driving of rav1d.
//!
//! `testdata/NAME.ref` is `width height frames pix_fmt md5`, written by
//! `scripts/make-fixtures.sh`.

use std::fs;
use std::path::{Path, PathBuf};

use md5::{Digest, Md5};
use wasm_av1::{convert, Config, Decoder, PixelLayout, RunOutcome};

struct Fixture {
    name: String,
    ivf: PathBuf,
    width: usize,
    height: usize,
    frames: u64,
    pix_fmt: String,
    md5: String,
}

fn fixtures() -> Vec<Fixture> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata");
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) != Some("ref") {
            continue;
        }
        let text = fs::read_to_string(&path).unwrap();
        let mut it = text.split_whitespace();
        let name = path.file_stem().unwrap().to_string_lossy().to_string();
        out.push(Fixture {
            ivf: dir.join(format!("{name}.ivf")),
            name,
            width: it.next().unwrap().parse().unwrap(),
            height: it.next().unwrap().parse().unwrap(),
            frames: it.next().unwrap().parse().unwrap(),
            pix_fmt: it.next().unwrap().to_string(),
            md5: it.next().unwrap().to_string(),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    assert!(
        out.len() >= 6,
        "expected the committed fixtures, found {}",
        out.len()
    );
    out
}

/// Decode a whole file the way the demo page does: run, pop, run…
fn decode_all(data: Vec<u8>, config: Config) -> (Vec<wasm_av1::Frame>, wasm_av1::Stats) {
    let mut dec = Decoder::new(config).unwrap();
    dec.set_source_ivf(data).unwrap();
    let mut frames = Vec::new();
    let mut guard = 0;
    while !dec.finished() {
        dec.run().unwrap();
        while let Some(f) = dec.next_frame() {
            frames.push(f.clone());
        }
        guard += 1;
        assert!(guard < 100_000, "decoder never finished");
    }
    (frames, dec.stats())
}

fn md5_of(frames: &[wasm_av1::Frame]) -> String {
    let mut h = Md5::new();
    for f in frames {
        h.update(&f.data);
    }
    format!("{:x}", h.finalize())
}

#[test]
fn every_fixture_matches_ffmpeg() {
    for fx in fixtures() {
        let data = fs::read(&fx.ivf).unwrap();
        let (frames, stats) = decode_all(data, Config::default());
        assert_eq!(frames.len() as u64, fx.frames, "{}: frame count", fx.name);
        assert_eq!(stats.frames_out, fx.frames, "{}: stats", fx.name);
        assert_eq!(stats.decode_errors, 0, "{}: errors", fx.name);
        let f0 = &frames[0];
        assert_eq!(
            (f0.width, f0.height),
            (fx.width, fx.height),
            "{}: size",
            fx.name
        );
        let (layout, bps) = match fx.pix_fmt.as_str() {
            "yuv420p" => (PixelLayout::I420, 1),
            "yuv420p10le" => (PixelLayout::I420, 2),
            "yuv444p" => (PixelLayout::I444, 1),
            "gray" => (PixelLayout::I400, 1),
            other => panic!("unexpected pix_fmt {other}"),
        };
        assert_eq!(f0.layout, layout, "{}: layout", fx.name);
        assert_eq!(f0.bytes_per_sample, bps, "{}: bytes/sample", fx.name);
        if bps == 2 {
            assert_eq!(f0.bit_depth, 10, "{}: bit depth", fx.name);
        }
        // pts came through from the IVF frame headers, in order.
        for (i, f) in frames.iter().enumerate() {
            assert_eq!(f.pts, Some(i as i64), "{}: pts of frame {i}", fx.name);
        }
        assert_eq!(
            md5_of(&frames),
            fx.md5,
            "{}: MD5 of decoded planes",
            fx.name
        );
    }
}

#[test]
fn film_grain_is_applied_by_default_and_can_be_disabled() {
    let fx = fixtures()
        .into_iter()
        .find(|f| f.name.contains("grain"))
        .expect("grain fixture");
    let data = fs::read(&fx.ivf).unwrap();
    let (with, _) = decode_all(data.clone(), Config::default());
    let (without, _) = decode_all(
        data,
        Config {
            apply_grain: false,
            ..Config::default()
        },
    );
    assert_eq!(
        md5_of(&with),
        fx.md5,
        "grain applied should match ffmpeg (which applies grain)"
    );
    assert_ne!(
        md5_of(&with),
        md5_of(&without),
        "disabling grain must change the output"
    );
    assert_eq!(with.len(), without.len());
}

#[test]
fn ring_never_exceeds_max_buffered_and_run_reports_full() {
    let fx = &fixtures()[0];
    let data = fs::read(&fx.ivf).unwrap();
    let mut dec = Decoder::new(Config {
        max_buffered: 3,
        ..Config::default()
    })
    .unwrap();
    dec.set_source_ivf(data).unwrap();
    // Fill it.
    let outcome = dec.run_until_full().unwrap();
    assert_eq!(outcome, RunOutcome::Full);
    assert_eq!(dec.frames_buffered(), 3);
    assert_eq!(dec.run().unwrap(), RunOutcome::Full);
    // Pop one, room for one.
    assert!(dec.next_frame().is_some());
    assert_eq!(dec.frames_buffered(), 2);
    let mut total = 1;
    while !dec.finished() {
        dec.run().unwrap();
        assert!(dec.frames_buffered() <= 3);
        if dec.next_frame().is_some() {
            total += 1;
        }
    }
    assert_eq!(total, fx.frames);
    // Once finished, `run` keeps saying so and nothing appears.
    assert_eq!(dec.run().unwrap(), RunOutcome::EndOfStream);
    assert!(dec.next_frame().is_none());
}

#[test]
fn push_mode_decodes_the_same_frames_as_ivf_mode() {
    let fx = &fixtures()[0];
    let data = fs::read(&fx.ivf).unwrap();
    let (reference, _) = decode_all(data.clone(), Config::default());

    // Feed the same temporal units through push_temporal_unit, a few at a time,
    // interleaved with runs, as a segment-fed player would.
    let mut reader = wasm_av1::IvfReader::new(data).unwrap();
    let mut units = Vec::new();
    while let Some(f) = reader.next_frame().unwrap() {
        units.push((f.data.to_vec(), f.pts as i64));
    }
    let mut dec = Decoder::new(Config::default()).unwrap();
    assert!(matches!(dec.run(), Err(wasm_av1::Error::NoSource)));
    let mut got = Vec::new();
    for chunk in units.chunks(5) {
        for (d, pts) in chunk {
            dec.push_temporal_unit(d.clone(), *pts).unwrap();
        }
        assert!(!dec.finished());
        while let RunOutcome::Consumed | RunOutcome::Full = dec.run().unwrap() {
            while let Some(f) = dec.next_frame() {
                got.push(f.clone());
            }
        }
        while let Some(f) = dec.next_frame() {
            got.push(f.clone());
        }
    }
    assert!(
        !dec.finished(),
        "not finished until end_of_stream is declared"
    );
    dec.end_of_stream();
    while !dec.finished() {
        dec.run().unwrap();
        while let Some(f) = dec.next_frame() {
            got.push(f.clone());
        }
    }
    assert_eq!(got.len(), reference.len());
    assert_eq!(md5_of(&got), md5_of(&reference));
    assert_eq!(dec.width(), Some(fx.width));
}

#[test]
fn flush_rewinds_an_ivf_source_and_decodes_it_again() {
    let fx = &fixtures()[1];
    let data = fs::read(&fx.ivf).unwrap();
    let mut dec = Decoder::new(Config::default()).unwrap();
    dec.set_source_ivf(data).unwrap();
    dec.run_until_full().unwrap();
    assert!(dec.next_frame().is_some());
    dec.flush().unwrap();
    assert_eq!(dec.frames_buffered(), 0);
    assert!(dec.current_frame().is_none());
    let mut n = 0;
    while !dec.finished() {
        dec.run().unwrap();
        while dec.next_frame().is_some() {
            n += 1;
        }
    }
    assert_eq!(n, fx.frames);
}

#[test]
fn garbage_input_errors_without_wedging_the_decoder() {
    let fx = &fixtures()[0];
    let data = fs::read(&fx.ivf).unwrap();
    let mut reader = wasm_av1::IvfReader::new(data).unwrap();
    let mut units = Vec::new();
    while let Some(f) = reader.next_frame().unwrap() {
        units.push((f.data.to_vec(), f.pts as i64));
    }
    let mut dec = Decoder::new(Config::default()).unwrap();
    // A unit of noise first: rejected (or produces nothing), decoder survives.
    dec.push_temporal_unit(vec![0xFF; 64], 0).unwrap();
    let first = dec.run();
    assert!(first.is_err() || dec.frames_buffered() == 0);
    // Then the real stream decodes fine.
    for (d, pts) in &units {
        dec.push_temporal_unit(d.clone(), *pts).unwrap();
    }
    dec.end_of_stream();
    let mut n = 0;
    while !dec.finished() {
        let _ = dec.run();
        while dec.next_frame().is_some() {
            n += 1;
        }
    }
    assert_eq!(n, fx.frames);
}

#[test]
fn rgba_conversion_of_a_real_frame_is_sane() {
    // testsrc2 has a mostly-grey backdrop with saturated bars and text; just
    // check the conversion produces a plausible spread rather than garbage,
    // for the 8-bit, 10-bit, 4:4:4 and mono fixtures alike.
    for fx in fixtures() {
        let data = fs::read(&fx.ivf).unwrap();
        let (frames, _) = decode_all(data, Config::default());
        let f = &frames[frames.len() / 2];
        let mut rgba = vec![0u8; f.rgba_len()];
        convert::yuv_to_rgba(f, &mut rgba);
        assert!(
            rgba.chunks_exact(4).all(|p| p[3] == 255),
            "{}: alpha",
            fx.name
        );
        let (mut lo, mut hi) = (255u8, 0u8);
        for p in rgba.chunks_exact(4) {
            lo = lo.min(p[0]).min(p[1]).min(p[2]);
            hi = hi.max(p[0]).max(p[1]).max(p[2]);
        }
        assert!(
            hi - lo > 100,
            "{}: RGB spread {lo}..{hi} looks wrong",
            fx.name
        );
        if f.layout != PixelLayout::I400 {
            // Colour: some pixel must be clearly non-grey.
            let colourful = rgba
                .chunks_exact(4)
                .any(|p| (p[0] as i32 - p[2] as i32).abs() > 60);
            assert!(colourful, "{}: no colour survived conversion", fx.name);
        }
    }
}
