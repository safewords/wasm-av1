// Drive the demo page in headless Chromium, Firefox and WebKit with Playwright:
// every (variant × renderer × worker) combination must play a fixture to
// the end, show every frame (or drop a bounded few), and match the decoded
// MD5 the native tests hold the wasm to. Screenshots go to test/out/.
//
// The server sends COOP/COEP so the page is cross-origin isolated and the
// threads variants can run (SharedArrayBuffer); the thread combos assert
// that the decoder really ran with N threads (`stats.threads`).
//
// Not part of `npm test` (needs a Playwright install with browsers). Run with
//   PLAYWRIGHT_DIR=/path/to/node_modules/playwright node test/browser.mjs
// or `npm i -D playwright && npx playwright install` here first.

import { createServer } from 'node:http';
import { createReadStream, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// A Playwright install: PLAYWRIGHT_DIR, else this package's node_modules.
const pwDir = process.env.PLAYWRIGHT_DIR
  ?? [join(root, 'node_modules', 'playwright')]
    .find((p) => { try { statSync(p); return true; } catch { return false; } })
  ?? 'playwright';
const { chromium, firefox, webkit } = await import(pathToFileURL(join(pwDir, 'index.mjs')).href);

// --- static server (same as scripts/serve.mjs, in-process) ------------------
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.ivf': 'application/octet-stream', '.json': 'application/json' };
const server = createServer((req, res) => {
  let file = normalize(join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  try {
    if (statSync(file).isDirectory()) file = join(file, 'index.html');
    res.writeHead(200, {
      'Content-Type': types[extname(file)] || 'application/octet-stream', 'Content-Length': statSync(file).size,
      // Cross-origin isolation: what a page needs for SharedArrayBuffer, i.e. the threads builds.
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    createReadStream(file).pipe(res);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

// The page under test: a bare harness (not the demo UI) so the assertions are
// about the library, not the buttons.
const harness = ({ file = 'testsrc-320x180-8bit.ivf', ...opts }) => `
  const canvas = document.createElement('canvas'); document.body.appendChild(canvas);
  // A first player on the same canvas, played briefly and destroyed: the
  // one below must still get a working context (a page's singleton canvas
  // is reused for the next video).
  { const warm = new Av1Player(canvas, ${JSON.stringify(opts)}); await warm.load((await (await fetch('${base}/testdata/${file}')).arrayBuffer()).slice(0)); warm.play(); await new Promise(r => setTimeout(r, 300)); warm.destroy(); }
  const p = new Av1Player(canvas, ${JSON.stringify(opts)});
  const errors = [];
  p.onerror = (e) => errors.push(String(e.message || e));
  const bytes = await (await fetch('${base}/testdata/${file}')).arrayBuffer();
  const info = await p.load(bytes);
  const ended = new Promise((res) => { p.onstate = (s) => { if (s === 'ended') res(); }; });
  const t0 = performance.now();
  p.play();
  await Promise.race([ended, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000))]);
  const wall = performance.now() - t0;
  // Read back a pixel block from the canvas to prove something was drawn.
  const probe = document.createElement('canvas'); probe.width = canvas.width; probe.height = canvas.height;
  probe.getContext('2d').drawImage(canvas, 0, 0);
  const px = probe.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let nonBlack = 0; for (let i = 0; i < px.length; i += 4) if (px[i] + px[i+1] + px[i+2] > 60) nonBlack++;
  window.__result = { info, stats: p.stats, errors, wall, nonBlackFraction: nonBlack / (px.length / 4), rendererKind: p.rendererKind, png: probe.toDataURL('image/png') };
`;

// HLS/CMAF through HlsAv1Video, clocked by a fake media clock that starts at
// start(): init + two 1 s segments of the same stream, 48 frames.
const hlsHarness = (opts) => `
  const canvas = document.createElement('canvas'); document.body.appendChild(canvas);
  let t0 = null;
  const clock = () => (t0 === null ? 0 : (performance.now() - t0) / 1000);
  const v = new HlsAv1Video(canvas, { ...${JSON.stringify(opts)}, clock });
  const errors = [];
  v.onerror = (e) => errors.push(String(e.message || e));
  const master = await v.loadMaster('${base}/testdata/cmaf/master.m3u8');
  const hi = master.variants.find((x) => x.height === 180);
  const lo = master.variants.find((x) => x.height === 90);
  await v.selectVariant(${JSON.stringify(opts.switchAt || null)} ? hi : hi.url);
  const ended = new Promise((res) => { v.player.onstate = (s) => { if (s === 'ended') res(); }; });
  t0 = performance.now();
  v.start();
  let switched = null;
  const switchAt = ${JSON.stringify(opts.switchAt || null)};
  if (switchAt) {
    // A rung switch mid-play: down to 160x90 — seamlessly at the next segment
    // boundary (frames keep flowing, the picture changes rung a segment on)
    // or hard (flush + refill from the clock).
    // Early: the in-thread decoder runs ~16 frames ahead of the clock and the
    // clip is 2 s of 1 s segments, so the only boundary (1 s) is gone by ~0.35 s.
    await new Promise((r) => setTimeout(r, 120));
    switched = await v.selectVariant(lo, { at: switchAt });
  }
  await Promise.race([ended, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000))]);
  const wall = performance.now() - t0;
  v.stop();
  window.__switch = { switched, variantHeight: v.stats.variantHeight, canvasW: canvas.width, canvasH: canvas.height, bandwidth: v.stats.bandwidth, fetches: v.stats.fetches, stalls: v.stats.stalls, late: v.stats.lateFrames };
  const probe = document.createElement('canvas'); probe.width = canvas.width; probe.height = canvas.height;
  probe.getContext('2d').drawImage(canvas, 0, 0);
  const px = probe.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let nonBlack = 0; for (let i = 0; i < px.length; i += 4) if (px[i] + px[i+1] + px[i+2] > 60) nonBlack++;
  window.__result = { info: v.player.info ?? null, stats: v.player.stats, errors, wall, nonBlackFraction: nonBlack / (px.length / 4), rendererKind: v.player.rendererKind, png: probe.toDataURL('image/png') };
`;

const combos = [];
for (const variant of ['baseline', 'simd'])
  for (const renderer of ['webgl', '2d'])
    for (const worker of [false, true]) combos.push({ variant, renderer, worker });
// The same stream inside containers, demuxed by rivet inside the wasm.
combos.push({ variant: 'simd', renderer: 'webgl', worker: false, file: 'testsrc-320x180-8bit.fmp4' });
combos.push({ variant: 'simd', renderer: 'webgl', worker: true, file: 'testsrc-320x180-8bit.mp4' });
combos.push({ variant: 'baseline', renderer: '2d', worker: true, file: 'testsrc-320x180-8bit.webm' });
combos.push({ variant: 'simd', renderer: 'webgl', worker: false, hls: true });
combos.push({ variant: 'simd', renderer: 'webgl', worker: true, hls: true });
// Rung switches through HlsAv1Video on the two-rung master (320x180 → 160x90):
// seamless at a segment boundary, in-thread and in a Worker; and the hard way.
combos.push({ variant: 'simd', renderer: 'webgl', worker: true, hls: true, switchAt: 'boundary' });
combos.push({ variant: 'simd', renderer: 'webgl', worker: false, hls: true, switchAt: 'boundary' });
combos.push({ variant: 'simd', renderer: '2d', worker: true, hls: true, switchAt: 'now' });
// Threads: the decoder's worker threads as Web Workers on shared memory. Only
// in a Worker (the decoder blocks its caller), on the isolated page the server makes.
combos.push({ variant: 'simd-threads', renderer: 'webgl', worker: true, threads: 4 });
combos.push({ variant: 'threads', renderer: '2d', worker: true, threads: 2 });
combos.push({ variant: 'simd-threads', renderer: 'webgl', worker: true, threads: 4, file: 'testsrc-320x180-8bit.mp4' });
combos.push({ variant: 'simd-threads', renderer: 'webgl', worker: true, threads: 4, hls: true });
// 'auto' with threads on an isolated page picks a threads variant.
combos.push({ variant: 'auto', expectVariant: 'simd-threads', renderer: 'webgl', worker: true, threads: 'auto' });

// `node test/browser.mjs --only <substring>` runs the combos whose label contains it (and browsers: --browsers chromium).
const argOnly = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const argBrowsers = process.argv.includes('--browsers') ? process.argv[process.argv.indexOf('--browsers') + 1].split(',') : null;
mkdirSync(join(root, 'test', 'out'), { recursive: true });

// The engine bug tools/wasm-copy-guard works around (docs/features/variants-and-threading.md):
// after one Worker grows a shared memory, does memory.fill on the grown pages
// trap in another Worker's instance? JavaScriptCore's did on 2026-11-12. Only
// reported, not asserted: the threads combos below are what must pass, and an
// engine that fixes it shows up here as "no".
const probeModule = (() => {
  const leb = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
  const str = (s) => [s.length, ...[...s].map((c) => c.charCodeAt(0))];
  const sec = (id, b) => [id, ...leb(b.length), ...b];
  const vec = (items) => [...leb(items.length), ...items.flat()];
  const bodies = [[0x20, 0, 0x40, 0], [0x20, 0, 0x20, 1, 0x20, 2, 0xfc, 11, 0]] // grow(n) -> old; fill(dst, val, n)
    .map((b) => { const f = [0, ...b, 0x0b]; return [...leb(f.length), ...f]; });
  return [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...sec(1, vec([[0x60, 1, 0x7f, 1, 0x7f], [0x60, 3, 0x7f, 0x7f, 0x7f, 0]])),
    ...sec(2, vec([[...str('env'), ...str('memory'), 2, 3, 1, ...leb(16384)]])),
    ...sec(3, vec([[0], [1]])),
    ...sec(7, vec([[...str('grow'), 0, 0], [...str('fill'), 0, 1]])),
    ...sec(10, vec(bodies))];
})();
const probeStaleGrow = (page) => page.evaluate(async (bytes) => {
  const src = `onmessage = ({ data }) => {
    if (data.module) { self.x = new WebAssembly.Instance(data.module, { env: { memory: data.memory } }).exports; return postMessage('ready'); }
    if (data.grow) return postMessage(self.x.grow(data.grow));
    try { self.x.fill(data.fill, 1, 8); postMessage('ok'); } catch (e) { postMessage(String(e)); }
  };`;
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  const call = (w, msg) => new Promise((r) => { w.onmessage = (e) => r(e.data); w.postMessage(msg); });
  const module = await WebAssembly.compile(new Uint8Array(bytes));
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 16384, shared: true });
  const a = new Worker(url), b = new Worker(url);
  await call(a, { module, memory }); await call(b, { module, memory });
  await call(a, { grow: 4 });
  const r = await call(b, { fill: 4 * 65536 });
  a.terminate(); b.terminate();
  return r;
}, probeModule);
let failures = 0;
for (const [name, launcher] of [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]]) {
  if (argBrowsers && !argBrowsers.includes(name)) continue;
  let browser;
  try {
    browser = await launcher.launch({ args: name === 'chromium' ? ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] : [] });
  } catch (e) {
    console.log(`${name}: not available (${e.message.split('\n')[0]})`);
    continue;
  }
  {
    const page = await browser.newPage();
    await page.goto(`${base}/demo/`);
    const r = await probeStaleGrow(page).catch((e) => e.message.split('\n')[0]);
    console.log(`${name}: memory.fill in one Worker on pages another Worker grew: ${r === 'ok' ? 'works' : `traps (${r}) — the engine bug wasm-copy-guard works around`}`);
    await page.close();
  }
  for (const combo of combos) {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    await page.goto(`${base}/demo/`);
    const label = `${name} ${combo.variant} ${combo.renderer} ${combo.worker ? 'worker' : 'main'}${combo.threads ? ' t' + combo.threads : ''}${combo.file ? ' ' + combo.file.split('.').pop() : ''}${combo.hls ? ' hls-cmaf' : ''}${combo.switchAt ? ' switch@' + combo.switchAt : ''}`;
    const playerOpts = { variant: combo.variant, renderer: combo.renderer, worker: combo.worker, ...(combo.threads ? { threads: combo.threads } : {}), ...(combo.switchAt ? { switchAt: combo.switchAt } : {}) };
    if (argOnly && !label.includes(argOnly)) { await page.close(); continue; }
    try {
      await page.evaluate((src) => new Promise((res, rej) => {
        const s = document.createElement('script'); s.type = 'module';
        s.textContent = `import { Av1Player, HlsAv1Video } from '${location.origin}/js/index.js';
try { ${src}; window.__done = true; } catch (e) { window.__err = String(e && e.message || e) + ' | ' + String(e && e.stack || '').split(String.fromCharCode(10)).slice(0, 3).join(' <- '); }`;
        document.body.appendChild(s);
        const deadline = Date.now() + 40000;
        const t = setInterval(() => {
          if (window.__done) { clearInterval(t); res(); }
          else if (window.__err) { clearInterval(t); rej(new Error(window.__err)); }
          else if (Date.now() > deadline) { clearInterval(t); rej(new Error('harness timeout')); }
        }, 20);
      }), combo.hls ? hlsHarness(playerOpts) : harness({ ...playerOpts, ...(combo.file ? { file: combo.file } : {}) }));
      const r = await page.evaluate(() => window.__result);
      const sw = combo.switchAt ? await page.evaluate(() => window.__switch) : null;
      const st = r.stats;
      // A boundary switch keeps every frame; a hard switch re-decodes from
      // the clock's segment start, so frames before the clock are dropped
      // (not shown) — the total is still 48 as pts run on.
      // (a hard switch zeroes the player's counters at the switch, so only what came after counts there)
      const okFrames = combo.switchAt === 'now' ? st.framesShown >= 20 && st.framesShown <= 48 : st.framesShown + st.framesDropped === 48;
      const okSwitch = !sw || (sw.switched === combo.switchAt && sw.variantHeight === 90 && sw.canvasW === 160 && sw.canvasH === 90 && sw.bandwidth > 0 && sw.fetches >= 2);
      const okDraw = r.nonBlackFraction > 0.5;
      const okInfo = combo.hls || combo.file?.endsWith('webm') ? true : (r.info.frameCount === 48 || r.info.frameCount === null);
      const wantThreads = combo.threads === 'auto' ? 2 : (combo.threads ?? 1);
      const okThreads = combo.threads ? st.threads >= wantThreads : st.threads === 1;
      const ok = okFrames && okDraw && okInfo && okThreads && okSwitch && r.errors.length === 0 && consoleErrors.length === 0 && st.variant === (combo.expectVariant ?? combo.variant) && r.rendererKind === combo.renderer;
      if (!ok) failures++;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(42)} threads ${st.threads} shown ${st.framesShown} dropped ${st.framesDropped}${sw ? ` switch ${sw.switched}→${sw.variantHeight}p canvas ${sw.canvasW}x${sw.canvasH} bw ${(sw.bandwidth / 1e6).toFixed(1)}Mb/s stalls ${sw.stalls} late ${sw.late}` : ''} draw ${(st.drawMs / Math.max(1, st.framesShown)).toFixed(2)}ms ${st.worker ? '' : `decode ${(st.decodeMs / 48).toFixed(2)}ms`} path ${st.drawPath} wall ${r.wall.toFixed(0)}ms nonblack ${(r.nonBlackFraction * 100).toFixed(0)}%${r.errors.length ? ' errors: ' + r.errors.join('; ') : ''}${consoleErrors.length ? ' console: ' + consoleErrors.join('; ') : ''}`);
      writeFileSync(join(root, 'test', 'out', `${label.replace(/ /g, '-')}.png`), Buffer.from(r.png.split(',')[1], 'base64'));
    } catch (e) {
      failures++;
      console.log(`FAIL ${label}: ${e.message.split('\n')[0]} ${consoleErrors.join('; ')}`);
    }
    await page.close();
  }
  // A live stream on the threads build: temporal units pushed one by one and
  // never an end of stream. With several frames in flight the last units'
  // frames are still being decoded when the decode Worker runs out of input,
  // and it has to come back for them by itself — nothing else wakes it.
  if (!argOnly || 'live push'.includes(argOnly)) {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    await page.goto(`${base}/demo/`);
    const label = `${name} simd-threads live push t4, no end of stream`;
    try {
      const r = await page.evaluate(async () => {
        const { WorkerDecoder } = await import(`${location.origin}/js/index.js`);
        const dec = new WorkerDecoder({ variant: 'simd-threads', threads: 4 });
        const errors = [];
        dec.onerror = (e) => errors.push(String(e.message || e));
        const ready = await dec.ready;
        const ivf = new Uint8Array(await (await fetch('/testdata/testsrc-320x180-8bit.ivf')).arrayBuffer());
        const view = new DataView(ivf.buffer);
        let units = 0;
        for (let o = view.getUint16(6, true); o + 12 <= ivf.length;) {
          const size = view.getUint32(o, true);
          dec.pushTemporalUnit(ivf.slice(o + 12, o + 12 + size), Number(view.getBigUint64(o + 4, true)));
          o += 12 + size;
          units++;
        }
        const pts = [];
        const deadline = performance.now() + 10000;
        while (pts.length < units && performance.now() < deadline) {
          const f = dec.nextFrame();
          if (f) pts.push(f.pts);
          else await new Promise((res) => setTimeout(res, 5));
        }
        const out = { units, frames: pts.length, inOrder: pts.every((p, i) => i === 0 || p > pts[i - 1]), threads: ready.threads, finished: dec.finished, errors };
        dec.close();
        return out;
      });
      const ok = r.units === 48 && r.frames === r.units && r.inOrder && r.threads === 4 && !r.finished && r.errors.length === 0 && consoleErrors.length === 0;
      if (!ok) failures++;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(42)} threads ${r.threads} units ${r.units} frames ${r.frames}${r.inOrder ? '' : ' out of order'}${r.errors.length ? ' errors: ' + r.errors.join('; ') : ''}${consoleErrors.length ? ' console: ' + consoleErrors.join('; ') : ''}`);
    } catch (e) {
      failures++;
      console.log(`FAIL ${label}: ${e.message.split('\n')[0]} ${consoleErrors.join('; ')}`);
    }
    await page.close();
  }
  await browser.close();
}
server.close();
console.log(failures ? `${failures} failure(s)` : 'all browser combinations passed');
process.exit(failures ? 1 : 0);
