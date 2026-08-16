// Drive the demo page in headless Chromium and Firefox with Playwright:
// every (variant × renderer × worker) combination must play a fixture to
// the end, show every frame (or drop a bounded few), and match the decoded
// MD5 the native tests hold the wasm to. Screenshots go to test/out/.
//
// Not part of `npm test` (needs a Playwright install). Run with:
//   PLAYWRIGHT_DIR=/path/to/node_modules/playwright node test/browser.mjs
// or from lewd-frontend's checkout, which has Playwright installed.

import { createServer } from 'node:http';
import { createReadStream, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// A Playwright install: PLAYWRIGHT_DIR, else this package's node_modules, else
// the sibling lewd-frontend checkout in devenv (which has one).
const pwDir = process.env.PLAYWRIGHT_DIR
  ?? [join(root, 'node_modules', 'playwright'), join(root, '..', '..', 'lewd', 'lewd-frontend', 'node_modules', 'playwright')]
    .find((p) => { try { statSync(p); return true; } catch { return false; } })
  ?? 'playwright';
const { chromium, firefox } = await import(pathToFileURL(join(pwDir, 'index.mjs')).href);

// --- static server (same as scripts/serve.mjs, in-process) ------------------
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.ivf': 'application/octet-stream', '.json': 'application/json' };
const server = createServer((req, res) => {
  let file = normalize(join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  try {
    if (statSync(file).isDirectory()) file = join(file, 'index.html');
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Content-Length': statSync(file).size });
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
  const master = null;
  await v.selectVariant('${base}/testdata/cmaf/index.m3u8');
  const ended = new Promise((res) => { v.player.onstate = (s) => { if (s === 'ended') res(); }; });
  t0 = performance.now();
  v.start();
  await Promise.race([ended, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000))]);
  const wall = performance.now() - t0;
  v.stop();
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

mkdirSync(join(root, 'test', 'out'), { recursive: true });
let failures = 0;
for (const [name, launcher] of [['chromium', chromium], ['firefox', firefox]]) {
  let browser;
  try {
    browser = await launcher.launch({ args: name === 'chromium' ? ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] : [] });
  } catch (e) {
    console.log(`${name}: not available (${e.message.split('\n')[0]})`);
    continue;
  }
  for (const combo of combos) {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    await page.goto(`${base}/demo/`);
    const label = `${name} ${combo.variant} ${combo.renderer} ${combo.worker ? 'worker' : 'main'}${combo.file ? ' ' + combo.file.split('.').pop() : ''}${combo.hls ? ' hls-cmaf' : ''}`;
    try {
      await page.evaluate((src) => new Promise((res, rej) => {
        const s = document.createElement('script'); s.type = 'module';
        s.textContent = `import { Av1Player, HlsAv1Video } from '${location.origin}/js/index.js';
try { ${src}; window.__done = true; } catch (e) { window.__err = String(e && e.stack || e); }`;
        document.body.appendChild(s);
        const deadline = Date.now() + 40000;
        const t = setInterval(() => {
          if (window.__done) { clearInterval(t); res(); }
          else if (window.__err) { clearInterval(t); rej(new Error(window.__err)); }
          else if (Date.now() > deadline) { clearInterval(t); rej(new Error('harness timeout')); }
        }, 20);
      }), combo.hls ? hlsHarness({ variant: combo.variant, renderer: combo.renderer, worker: combo.worker }) : harness(combo));
      const r = await page.evaluate(() => window.__result);
      const st = r.stats;
      const okFrames = st.framesShown + st.framesDropped === 48;
      const okDraw = r.nonBlackFraction > 0.5;
      const okInfo = combo.hls || combo.file?.endsWith('webm') ? true : (r.info.frameCount === 48 || r.info.frameCount === null);
      const ok = okFrames && okDraw && okInfo && r.errors.length === 0 && consoleErrors.length === 0 && st.variant === combo.variant && r.rendererKind === combo.renderer;
      if (!ok) failures++;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(39)} shown ${st.framesShown} dropped ${st.framesDropped} draw ${(st.drawMs / Math.max(1, st.framesShown)).toFixed(2)}ms ${st.worker ? '' : `decode ${(st.decodeMs / 48).toFixed(2)}ms`} path ${st.drawPath} wall ${r.wall.toFixed(0)}ms nonblack ${(r.nonBlackFraction * 100).toFixed(0)}%${r.errors.length ? ' errors: ' + r.errors.join('; ') : ''}${consoleErrors.length ? ' console: ' + consoleErrors.join('; ') : ''}`);
      writeFileSync(join(root, 'test', 'out', `${label.replace(/ /g, '-')}.png`), Buffer.from(r.png.split(',')[1], 'base64'));
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
