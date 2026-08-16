//! Native harness — upstream `test.c`, grown up.
//!
//! ```text
//! cargo run --release --example decode_ivf -- FILE.ivf              # decode, print summary + MD5
//! cargo run --release --example decode_ivf -- FILE.ivf --md5        # just the MD5 (what tests compare)
//! cargo run --release --example decode_ivf -- FILE.ivf --dump 30 40 # write frame0030.yuv … frame0039.yuv (packed planes)
//! cargo run --release --example decode_ivf -- FILE.ivf --ppm 30     # write frame0030.ppm (RGBA conversion, as RGB)
//! cargo run --release --example decode_ivf -- FILE.ivf --no-grain   # decode without film grain synthesis
//! cargo run --release --example decode_ivf -- FILE.ivf --threads 4  # rav1d frame threads (native only)
//! ```
//!
//! The MD5 is over the packed planes of every frame in order — the same bytes
//! ffmpeg emits for `-f rawvideo -pix_fmt yuv420p` (or `…10le`, `yuv444p`,
//! `gray`), which is how `testdata/*.ref` were made.

use std::fs;
use std::io::Write;
use std::time::Instant;

use md5::{Digest, Md5};
use wasm_av1::{convert, Config, Decoder, RunOutcome};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(path) = args.first() else {
        eprintln!("usage: decode_ivf FILE.ivf [--md5] [--dump FROM TO] [--ppm N] [--no-grain] [--threads N]");
        std::process::exit(2);
    };
    let mut only_md5 = false;
    let mut dump: Option<(u64, u64)> = None;
    let mut ppm: Option<u64> = None;
    let mut config = Config::default();
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--md5" => only_md5 = true,
            "--dump" => {
                dump = Some((args[i + 1].parse().unwrap(), args[i + 2].parse().unwrap()));
                i += 2;
            }
            "--ppm" => {
                ppm = Some(args[i + 1].parse().unwrap());
                i += 1;
            }
            "--no-grain" => config.apply_grain = false,
            "--threads" => {
                config.threads = args[i + 1].parse().unwrap();
                i += 1;
            }
            other => {
                eprintln!("unknown argument {other}");
                std::process::exit(2);
            }
        }
        i += 1;
    }

    let data = fs::read(path).expect("read input");
    let mut dec = Decoder::new(config).expect("open decoder");
    let header = *dec.set_source_ivf(data).expect("IVF source");
    if !only_md5 {
        eprintln!(
            "Video has width {}, height {}, time base {}/{}, {} frames announced",
            header.width,
            header.height,
            header.time_base_num,
            header.time_base_den,
            header.frame_count
        );
    }

    let mut hasher = Md5::new();
    let mut frames = 0u64;
    let mut first: Option<String> = None;
    let started = Instant::now();
    let mut decode_time = std::time::Duration::ZERO;
    let mut convert_time = std::time::Duration::ZERO;
    let mut rgba = Vec::new();

    // Upstream's loop: run, pull a frame, run again, until finished.
    while !dec.finished() {
        let t = Instant::now();
        match dec.run() {
            Ok(RunOutcome::Full) | Ok(RunOutcome::Consumed) | Ok(RunOutcome::Starved) => {}
            Ok(RunOutcome::EndOfStream) => {}
            Err(e) => eprintln!("decode error: {e}"),
        }
        decode_time += t.elapsed();
        while let Some(frame) = dec.next_frame() {
            hasher.update(&frame.data);
            if first.is_none() {
                first = Some(format!(
                    "{}x{} {}-bit {:?} matrix={} full_range={} pts={:?}",
                    frame.width,
                    frame.height,
                    frame.bit_depth,
                    frame.layout,
                    frame.color.matrix,
                    frame.color.full_range,
                    frame.pts
                ));
            }
            if let Some((from, to)) = dump {
                if frames >= from && frames < to {
                    fs::write(format!("frame{frames:04}.yuv"), &frame.data).unwrap();
                }
            }
            if ppm == Some(frames) || !only_md5 {
                let t = Instant::now();
                rgba.resize(frame.rgba_len(), 0);
                convert::yuv_to_rgba(frame, &mut rgba);
                convert_time += t.elapsed();
                if ppm == Some(frames) {
                    let mut f = fs::File::create(format!("frame{frames:04}.ppm")).unwrap();
                    write!(f, "P6\n{} {}\n255\n", frame.width, frame.height).unwrap();
                    let rgb: Vec<u8> = rgba
                        .chunks_exact(4)
                        .flat_map(|p| [p[0], p[1], p[2]])
                        .collect();
                    f.write_all(&rgb).unwrap();
                }
            }
            frames += 1;
        }
    }
    let md5 = format!("{:x}", hasher.finalize());
    if only_md5 {
        println!("{md5}");
        return;
    }
    let total = started.elapsed();
    let stats = dec.stats();
    eprintln!("first frame: {}", first.as_deref().unwrap_or("(none)"));
    eprintln!(
        "{frames} frames in {:.1} ms: decode {:.1} ms ({:.2} ms/frame, {:.1} fps), yuv->rgba {:.1} ms ({:.3} ms/frame), simd={} errors={}",
        total.as_secs_f64() * 1e3,
        decode_time.as_secs_f64() * 1e3,
        decode_time.as_secs_f64() * 1e3 / frames.max(1) as f64,
        frames as f64 / decode_time.as_secs_f64().max(1e-9),
        convert_time.as_secs_f64() * 1e3,
        convert_time.as_secs_f64() * 1e3 / frames.max(1) as f64,
        convert::simd_enabled(),
        stats.decode_errors
    );
    println!("MD5={md5}");
}
