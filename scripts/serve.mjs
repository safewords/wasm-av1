// Zero-dependency static server for the demo: serves the repo root with the
// right MIME types (.wasm as application/wasm so instantiateStreaming works,
// .mjs/.js as JS modules). `npm run serve` then open http://localhost:8080/demo/
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.env.PORT || 8080);
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm', '.json': 'application/json', '.css': 'text/css', '.ivf': 'application/octet-stream',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.map': 'application/json',
};

createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let file = normalize(join(root, decodeURIComponent(url.pathname)));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  try {
    if (statSync(file).isDirectory()) file = join(file, 'index.html');
    const st = statSync(file);
    res.writeHead(200, {
      'Content-Type': types[extname(file)] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found: ' + url.pathname);
  }
}).listen(port, () => console.log(`serving ${root} at http://localhost:${port}/demo/`));
