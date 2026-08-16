// Benchmark the variants in real browsers (Playwright), including the threads
// builds, which need a cross-origin-isolated page — the in-process server
// here sends COOP/COEP — and rav1d's worker threads as Web Workers, which
// Node has no way to run.
//
//   node scripts/bench-browser.mjs [--files bbb-720p.ivf,bbb-1080p.ivf] [--frames 300]
//                                  [--threads 1,2,4,8] [--browsers chromium,firefox]
//
// Decodes inside a Worker (scripts/bench-worker.js) with the frames consumed
// there, so the ms/frame is decode alone. Clips from scripts/fetch-samples.sh
// under testdata/samples/. Prints a table per browser and checks that every
// configuration produced the same frame hash.

import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const files = opt('--files', 'bbb-720p.ivf,bbb-1080p.ivf').split(',');
const maxFrames = Number(opt('--frames', 300));
const threadCounts = opt('--threads', '1,2,4,8').split(',').map(Number);
const browsers = opt('--browsers', 'chromium,firefox').split(',');

// A Playwright install: PLAYWRIGHT_DIR, else this package's node_modules.
const pwDir = process.env.PLAYWRIGHT_DIR
  ?? [join(root, 'node_modules', 'playwright')]
    .find((p) => { try { statSync(p); return true; } catch { return false; } })
  ?? 'playwright';
const pw = await import(pathToFileURL(join(pwDir, 'index.mjs')).href);

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.ivf': 'application/octet-stream', '.json': 'application/json' };
const server = createServer((req, res) => {
  let file = normalize(join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  try {
    if (statSync(file).isDirectory()) file = join(file, 'index.html');
    res.writeHead(200, {
      'Content-Type': types[extname(file)] || 'application/octet-stream', 'Content-Length': statSync(file).size,
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    createReadStream(file).pipe(res);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

// (variant, threads) configurations: single-threaded simd is the reference.
const configs = [{ variant: 'simd', threads: 1 }];
for (const t of threadCounts) if (t > 1) configs.push({ variant: 'simd-threads', threads: t });

for (const name of browsers) {
  let browser;
  try {
    browser = await pw[name].launch();
  } catch (e) {
    console.log(`${name}: not available (${e.message.split('\n')[0]})`);
    continue;
  }
  const page = await browser.newPage();
  await page.goto(`${base}/demo/`);
  const hc = await page.evaluate(() => navigator.hardwareConcurrency);
  console.log(`\n${name} (hardwareConcurrency ${hc}, crossOriginIsolated ${await page.evaluate(() => crossOriginIsolated)})`);
  console.log('clip'.padEnd(16) + 'variant'.padEnd(14) + 'threads  ms/frame   fps   worst run  hash');
  for (const file of files) {
    let refHash = null;
    for (const cfg of configs) {
      const r = await page.evaluate(async ({ base, file, cfg, maxFrames }) => {
        const { spawnThreadWorker } = await import(`${base}/js/loader.js`);
        const ivf = await (await fetch(`${base}/testdata/samples/${file}`)).arrayBuffer();
        return new Promise((resolve) => {
          const w = new Worker(`${base}/scripts/bench-worker.js`, { type: 'module' });
          const timer = setTimeout(() => resolve({ type: 'error', message: 'timeout' }), 120000);
          w.onmessage = ({ data }) => {
            if (data.type === 'spawnThread') { spawnThreadWorker(data); return; }
            clearTimeout(timer);
            w.terminate();
            resolve(data);
          };
          w.onerror = (e) => { clearTimeout(timer); resolve({ type: 'error', message: e.message }); };
          w.postMessage({ variant: cfg.variant, baseUrl: `${base}/pkg/`, threads: cfg.threads, ivf, maxFrames }, [ivf]);
        });
      }, { base, file, cfg, maxFrames });
      if (r.type === 'error') {
        console.log(`${file.padEnd(16)}${cfg.variant.padEnd(14)}${String(cfg.threads).padStart(7)}  ERROR ${r.message.split('\n')[0]}`);
        continue;
      }
      if (refHash === null) refHash = r.hash;
      const same = r.hash === refHash ? 'same' : 'DIFFERENT';
      console.log(`${file.padEnd(16)}${r.variant.padEnd(14)}${String(r.threads).padStart(7)}  ${r.msPerFrame.toFixed(2).padStart(8)}  ${(1000 / r.msPerFrame).toFixed(0).padStart(4)}  ${r.worstRunMs.toFixed(1).padStart(8)}ms  ${same}${r.stats.decodeErrors ? `  errors ${r.stats.decodeErrors}` : ''}`);
    }
  }
  await browser.close();
}
server.close();
