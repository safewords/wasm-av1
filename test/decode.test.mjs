// Drive the built .wasm (both variants) from Node exactly as a page would, and
// hold it to the same reference MD5s as the native tests. Run `scripts/build.sh`
// first; `npm test` does both.
//
// What this proves that `cargo test` cannot: the wasm-bindgen surface, the
// pointer/length hand-off through wasm memory, that the SIMD build's RGBA is
// byte-identical to the baseline's, and how fast each variant is under V8.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testdata = path.join(root, 'testdata');

const fixtures = readdirSync(testdata)
  .filter((f) => f.endsWith('.ref'))
  .map((f) => {
    const name = f.replace(/\.ref$/, '');
    const [w, h, frames, pixFmt, md5] = readFileSync(path.join(testdata, f), 'utf8').trim().split(/\s+/);
    return { name, w: +w, h: +h, frames: +frames, pixFmt, md5, ivf: readFileSync(path.join(testdata, `${name}.ivf`)) };
  })
  .sort((a, b) => a.name.localeCompare(b.name));
assert.ok(fixtures.length >= 6, 'committed fixtures present');

// The same probe js/detect.js uses: a module containing one v128 op.
const nodeHasSimd = WebAssembly.validate(
  new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]),
);

async function load(variant) {
  const dir = path.join(root, 'pkg', variant);
  const mod = await import(pathToFileURL(path.join(dir, 'wasm_av1.js')).href);
  const bytes = readFileSync(path.join(dir, 'wasm_av1_bg.wasm'));
  const wasm = await mod.default({ module_or_path: bytes });
  return { mod, wasm, variant };
}

/** Decode a whole IVF, hashing packed frames; returns {frames, md5, first, decodeMs}. */
function decodeAll({ mod, wasm }, ivf, { rgba = false } = {}) {
  const dec = new mod.Av1Decoder();
  dec.setSourceIvf(ivf);
  const md5 = createHash('md5');
  const rgbaMd5 = createHash('md5');
  let frames = 0;
  let first = null;
  let decodeMs = 0;
  let convertMs = 0;
  let guard = 0;
  while (!dec.finished()) {
    const t0 = performance.now();
    dec.run();
    decodeMs += performance.now() - t0;
    while (dec.nextFrame()) {
      // Views are rebuilt per frame: memory may have grown during run().
      const view = new Uint8Array(wasm.memory.buffer, dec.framePtr(), dec.frameLen());
      md5.update(view);
      if (!first) {
        first = {
          w: dec.frameWidth(), h: dec.frameHeight(), bitDepth: dec.frameBitDepth(),
          bps: dec.frameBytesPerSample(), layout: dec.frameLayout(), pts: dec.framePts(),
          matrix: dec.frameMatrix(), fullRange: dec.frameFullRange(),
          planes: [0, 1, 2].map((i) => [dec.planeOffset(i), dec.planeStride(i), dec.planeWidth(i), dec.planeHeight(i)]),
        };
      }
      if (rgba) {
        const t1 = performance.now();
        const ptr = dec.convertToRgba();
        convertMs += performance.now() - t1;
        rgbaMd5.update(new Uint8Array(wasm.memory.buffer, ptr, dec.rgbaLen()));
      }
      frames++;
    }
    assert.ok(++guard < 100000, 'decoder never finished');
  }
  const stats = dec.stats();
  dec.free();
  return { frames, md5: md5.digest('hex'), rgbaMd5: rgba ? rgbaMd5.digest('hex') : null, first, decodeMs, convertMs, stats };
}

const layoutOf = { yuv420p: 1, yuv420p10le: 1, yuv444p: 3, gray: 0 };

for (const variant of ['baseline', 'simd']) {
  test(`${variant}: every fixture matches ffmpeg's MD5`, { skip: variant === 'simd' && !nodeHasSimd && 'node lacks wasm SIMD' }, async () => {
    const m = await load(variant);
    assert.equal(m.mod.simdEnabled(), variant === 'simd', 'simdEnabled() reports the build');
    assert.match(m.mod.version(), /^\d+\.\d+\.\d+/);
    for (const fx of fixtures) {
      const r = decodeAll(m, fx.ivf);
      assert.equal(r.frames, fx.frames, `${fx.name}: frame count`);
      assert.equal(r.md5, fx.md5, `${fx.name}: MD5`);
      assert.deepEqual([r.first.w, r.first.h], [fx.w, fx.h], `${fx.name}: size`);
      assert.equal(r.first.layout, layoutOf[fx.pixFmt], `${fx.name}: layout`);
      assert.equal(r.first.bps, fx.pixFmt.endsWith('10le') ? 2 : 1, `${fx.name}: bytes/sample`);
      assert.equal(r.first.pts, 0, `${fx.name}: first pts`);
      assert.equal(r.stats.framesOut, fx.frames);
      assert.equal(r.stats.decodeErrors, 0);
      // Plane geometry is self-consistent: Y at 0, U after Y, V after U.
      const [y, u, v] = r.first.planes;
      assert.equal(y[0], 0);
      assert.equal(y[1], fx.w * r.first.bps);
      if (r.first.layout !== 0) {
        assert.equal(u[0], y[1] * y[3]);
        assert.equal(v[0], u[0] + u[1] * u[3]);
      }
    }
  });
}

test('SIMD and baseline RGBA output are byte-identical', { skip: !nodeHasSimd && 'node lacks wasm SIMD' }, async () => {
  const base = await load('baseline');
  const simd = await load('simd');
  // 177x99 has an odd width (SIMD tail path) and odd height (last chroma row);
  // 320x180 is the plain vectorised case; 10-bit and 4:4:4 take the scalar
  // path in both builds and must still agree.
  for (const fx of fixtures) {
    const a = decodeAll(base, fx.ivf, { rgba: true });
    const b = decodeAll(simd, fx.ivf, { rgba: true });
    assert.equal(a.md5, b.md5, `${fx.name}: planes`);
    assert.equal(a.rgbaMd5, b.rgbaMd5, `${fx.name}: RGBA`);
  }
});

test('push mode: temporal units fed one at a time decode identically', async () => {
  const m = await load('baseline');
  const fx = fixtures.find((f) => f.name.includes('320x180'));
  const reference = decodeAll(m, fx.ivf);

  // Split the IVF into its frames in JS (12-byte frame headers after the 32-byte file header).
  const buf = fx.ivf;
  const units = [];
  let pos = 32;
  while (pos + 12 <= buf.length) {
    const size = buf.readUInt32LE(pos);
    const pts = Number(buf.readBigUInt64LE(pos + 4));
    units.push({ data: buf.subarray(pos + 12, pos + 12 + size), pts });
    pos += 12 + size;
  }
  assert.equal(units.length, fx.frames);

  const dec = new m.mod.Av1Decoder(4);
  const md5 = createHash('md5');
  let frames = 0;
  const drain = () => {
    while (dec.nextFrame()) {
      md5.update(new Uint8Array(m.wasm.memory.buffer, dec.framePtr(), dec.frameLen()));
      frames++;
    }
  };
  for (const u of units) {
    dec.pushTemporalUnit(u.data, u.pts);
    // Keep the ring bounded, like a player would between segments.
    let r;
    do {
      r = dec.run();
      drain();
    } while (r === m.mod.RunResult.Consumed || r === m.mod.RunResult.Full);
  }
  assert.equal(dec.finished(), false);
  dec.endOfStream();
  while (!dec.finished()) {
    dec.run();
    drain();
  }
  assert.equal(frames, reference.frames);
  assert.equal(md5.digest('hex'), reference.md5);
  assert.equal(dec.width(), fx.w);
  dec.free();
});

test('errors: non-IVF input throws, decoder stays usable', async () => {
  const m = await load('baseline');
  const dec = new m.mod.Av1Decoder();
  assert.throws(() => dec.setSourceIvf(new Uint8Array([1, 2, 3])), /IVF/);
  assert.throws(() => dec.run(), /no source/);
  const fx = fixtures[0];
  dec.setSourceIvf(fx.ivf);
  const r = dec.runUntilFull();
  assert.ok(r === m.mod.RunResult.Full || r === m.mod.RunResult.EndOfStream);
  assert.ok(dec.framesBuffered() > 0);
  dec.free();
});

test('speed: decode + convert, ms/frame per variant (informational)', { skip: !nodeHasSimd && 'node lacks wasm SIMD' }, async () => {
  const fx = fixtures.find((f) => f.name.includes('320x180'));
  const rows = [];
  for (const variant of ['baseline', 'simd']) {
    const m = await load(variant);
    decodeAll(m, fx.ivf, { rgba: true }); // warm up the JIT
    let best = null;
    for (let i = 0; i < 5; i++) {
      const r = decodeAll(m, fx.ivf, { rgba: true });
      if (!best || r.decodeMs < best.decodeMs) best = r;
    }
    rows.push({ variant, decode: (best.decodeMs / best.frames).toFixed(3), convert: (best.convertMs / best.frames).toFixed(4) });
  }
  console.log(`\n  ${fx.name}: ms/frame (best of 5)`);
  for (const r of rows) console.log(`    ${r.variant.padEnd(9)} decode ${r.decode}  yuv->rgba ${r.convert}`);
});

test('container: MP4, fragmented MP4 and WebM decode to the IVF reference (rivet-container in wasm)', async () => {
  const m = await load('baseline');
  assert.equal(m.mod.containerSupport(), true, 'default build carries the container feature');
  const ref = fixtures.find((f) => f.name === 'testsrc-320x180-8bit');
  for (const [ext, timescale] of [['mp4', 12288], ['fmp4', 12288], ['webm', 1e9]]) {
    const bytes = readFileSync(path.join(testdata, `testsrc-320x180-8bit.${ext}`));
    const dec = new m.mod.Av1Decoder();
    dec.setSourceContainer(bytes);
    assert.equal(dec.width(), 320, ext);
    assert.equal(dec.timeBaseNum(), 1, ext);
    assert.equal(dec.timeBaseDen(), timescale, `${ext}: timescale`);
    // MP4 knows its sample count; Matroska has no such field (0 = unknown).
    assert.equal(dec.frameCountHint(), ext === 'webm' ? 0 : 48, `${ext}: frame count hint`);
    if (ext !== 'webm') assert.ok(Math.abs(dec.frameRateHint() - 24) < 0.05, `${ext}: fps ${dec.frameRateHint()}`);
    const md5 = createHash('md5');
    let frames = 0;
    let firstPts = null;
    while (!dec.finished()) {
      dec.run();
      while (dec.nextFrame()) {
        if (firstPts === null) firstPts = dec.framePts();
        md5.update(new Uint8Array(m.wasm.memory.buffer, dec.framePtr(), dec.frameLen()));
        frames++;
      }
    }
    assert.equal(frames, ref.frames, `${ext}: frames`);
    assert.equal(md5.digest('hex'), ref.md5, `${ext}: MD5`);
    assert.equal(firstPts, 0, `${ext}: first pts`);
    dec.free();
  }
  // Not a container, not AV1: clean errors, decoder survives.
  const dec = new m.mod.Av1Decoder();
  assert.throws(() => dec.setSourceContainer(new Uint8Array(100)), /container/);
  dec.setSourceIvf(ref.ivf);
  assert.ok(dec.runUntilFull() !== undefined);
  dec.free();
});
