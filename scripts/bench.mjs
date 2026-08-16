// Benchmark the built .wasm variants under Node's V8 — the same engine as
// Chrome, so the numbers transfer (modulo the device).
//
//   node scripts/bench.mjs [file.ivf] [--frames N] [--variants baseline,simd] [--rgba]
//
// With --frames 100000 (i.e. the whole clip) and a FILE.ivf.md5 next to it
// (scripts/fetch-samples.sh writes one), the decoded MD5 is checked against
// libdav1d's as well.
//
// Defaults to the first upstream sample under testdata/samples/ (run
// scripts/fetch-samples.sh), 600 frames, both variants. Reports decode
// ms/frame, the slowest single temporal unit, and — with --rgba — the RGBA
// conversion cost, plus the MD5 of the decoded planes so the two variants can
// be seen to agree.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const flag = (name) => args.includes(name);
let file = args.find((a) => a.endsWith('.ivf'));
if (!file) {
  const dir = path.join(root, 'testdata', 'samples');
  const f = existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith('.ivf')).sort()[0] : null;
  if (!f) { console.error('no .ivf given and testdata/samples/ is empty — run scripts/fetch-samples.sh'); process.exit(2); }
  file = path.join(dir, f);
}
const maxFrames = Number(opt('--frames', 600));
const variants = opt('--variants', 'baseline,simd').split(',');
const doRgba = flag('--rgba');
const ivf = readFileSync(file);

async function load(variant) {
  const dir = path.join(root, 'pkg', variant);
  const mod = await import(pathToFileURL(path.join(dir, 'wasm_av1.js')).href);
  const wasm = await mod.default({ module_or_path: readFileSync(path.join(dir, 'wasm_av1_bg.wasm')) });
  return { mod, wasm };
}

function bench({ mod, wasm }) {
  const dec = new mod.Av1Decoder(4);
  dec.setSourceIvf(ivf);
  const md5 = createHash('md5');
  let frames = 0, decodeMs = 0, worst = 0, convertMs = 0, runs = 0, errors = 0;
  const per = [];
  while (!dec.finished() && frames < maxFrames) {
    const t0 = performance.now();
    try { dec.run(); } catch (e) { errors++; }   // a damaged temporal unit is reported, not fatal
    const dt = performance.now() - t0;
    decodeMs += dt; runs++;
    if (dt > worst) worst = dt;
    while (dec.nextFrame() && frames < maxFrames) {
      md5.update(new Uint8Array(wasm.memory.buffer, dec.framePtr(), dec.frameLen()));
      if (doRgba) {
        const t1 = performance.now();
        dec.convertToRgba();
        convertMs += performance.now() - t1;
      }
      frames++;
      per.push(dt);
    }
  }
  const w = dec.width(), h = dec.height();
  dec.free();
  per.sort((a, b) => a - b);
  return { frames, w, h, decodeMs, worst, convertMs, errors, md5: md5.digest('hex'), p50: per[Math.floor(per.length * 0.5)], p95: per[Math.floor(per.length * 0.95)] };
}

console.log(`${path.basename(file)} — first ${maxFrames} frames, ${variants.join(' vs ')}${doRgba ? ', with RGBA conversion' : ''}`);
const results = {};
for (const v of variants) {
  const rt = await load(v);
  bench(rt); // warm-up: JIT tiers up on the first pass
  const r = bench(rt);
  results[v] = r;
  const fps = r.frames / (r.decodeMs / 1000);
  console.log(
    `  ${v.padEnd(9)} ${r.w}x${r.h}  ${r.frames} frames  decode ${(r.decodeMs / r.frames).toFixed(2)} ms/frame (${fps.toFixed(0)} fps)  p50 ${r.p50.toFixed(2)}  p95 ${r.p95.toFixed(2)}  worst TU ${r.worst.toFixed(1)} ms` +
      (doRgba ? `  rgba ${(r.convertMs / r.frames).toFixed(3)} ms/frame` : '') +
      (r.errors ? `  errors ${r.errors}` : '') + `  md5 ${r.md5.slice(0, 8)}`,
  );
}
const refFile = file + '.md5';
if (existsSync(refFile) && maxFrames >= 100000) {
  const ref = readFileSync(refFile, 'utf8').trim();
  for (const [v, r] of Object.entries(results)) console.log(`  ${v.padEnd(9)} ${r.md5 === ref ? 'matches' : 'DOES NOT MATCH'} libdav1d reference ${ref.slice(0, 8)}`);
}
if (results.baseline && results.simd) {
  const s = results.baseline.decodeMs / results.simd.decodeMs;
  console.log(`  simd decode speed-up: ${s.toFixed(2)}x` + (doRgba ? `, rgba: ${(results.baseline.convertMs / results.simd.convertMs).toFixed(2)}x` : '') + (results.baseline.md5 === results.simd.md5 ? '  (identical output)' : '  OUTPUT DIFFERS'));
}
