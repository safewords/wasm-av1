// tools/wasm-copy-guard: the post-link pass scripts/build.sh runs on the
// threads variants, so that JavaScriptCore's stale view of a shared memory
// grown by another Worker cannot trap their memory.copy / memory.fill
// (docs/features/variants-and-threading.md).
//
// The bug itself needs JavaScriptCore; test/browser.mjs runs the threads
// variants in WebKit and probes the engine for it. Here, in Node, the pass is
// run on a small module and the result is held to memmove/memset semantics:
// on its native path (what an engine without the bug always takes) and, with
// --always-slow, on the load/store loops WebKit takes, which no engine
// without the bug would ever run.
//
//   node --test test/copy-guard.test.mjs     (builds the tool with cargo if needed)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
execFileSync('cargo', ['build', '--release', '--locked', '--quiet', '--manifest-path', 'tools/wasm-copy-guard/Cargo.toml', '--target-dir', 'target/tools'], { cwd: root, stdio: 'inherit' });
const tool = join(root, 'target', 'tools', 'release', 'wasm-copy-guard');

// A module importing a shared memory of PAGES pages and exporting
// copy(dst, src, n) = memory.copy and fill(dst, val, n) = memory.fill.
const PAGES = 2;
const leb = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
const str = (s) => [s.length, ...[...s].map((c) => c.charCodeAt(0))];
const section = (id, body) => [id, ...leb(body.length), ...body];
const vec = (items) => [...leb(items.length), ...items.flat()];
function source({ shared = true } = {}) {
  const types = vec([[0x60, 3, 0x7f, 0x7f, 0x7f, 0]]);
  const imports = vec([[...str('env'), ...str('memory'), 2, shared ? 3 : 1, PAGES, PAGES]]);
  const funcs = vec([[0], [0]]);
  const exports = vec([[...str('copy'), 0, 0], [...str('fill'), 0, 1]]);
  const bodies = [
    [0x20, 0, 0x20, 1, 0x20, 2, 0xfc, 10, 0, 0],
    [0x20, 0, 0x20, 1, 0x20, 2, 0xfc, 11, 0],
  ].map((b) => { const f = [0, ...b, 0x0b]; return [...leb(f.length), ...f]; });
  return new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...section(1, types), ...section(2, imports), ...section(3, funcs), ...section(7, exports), ...section(10, vec(bodies))]);
}

const dir = mkdtempSync(join(tmpdir(), 'wasm-copy-guard-'));
writeFileSync(join(dir, 'in.wasm'), source());
const run = (out, ...flags) => {
  const log = execFileSync(tool, [join(dir, 'in.wasm'), join(dir, out), ...flags], { encoding: 'utf8' });
  return { bytes: readFileSync(join(dir, out)), log };
};
const guarded = run('guarded.wasm');
const slow = run('slow.wasm', '--always-slow');

/** Byte offsets of memory.copy (fc 0a 00 00) and memory.fill (fc 0b 00) in the code section. */
function bulkOps(bytes) {
  let p = 8;
  const u = () => { let r = 0, s = 0, b; do { b = bytes[p++]; r |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return r >>> 0; };
  while (p < bytes.length) {
    const id = bytes[p++], len = u(), end = p + len;
    if (id === 10) {
      const found = [];
      for (let i = p; i < end - 2; i++) {
        if (bytes[i] === 0xfc && bytes[i + 1] === 10 && bytes[i + 2] === 0 && bytes[i + 3] === 0) found.push('copy');
        if (bytes[i] === 0xfc && bytes[i + 1] === 11 && bytes[i + 2] === 0) found.push('fill');
      }
      return found;
    }
    p = end;
  }
  return [];
}

function instantiate(bytes) {
  const memory = new WebAssembly.Memory({ initial: PAGES, maximum: PAGES, shared: true });
  const { exports } = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory } });
  return { ...exports, mem: new Uint8Array(memory.buffer) };
}

// A deterministic stream of copies and fills: overlapping both ways and not,
// lengths around the 8-byte step of the loops, at both ends of memory.
function* operations() {
  let s = 0x9e3779b9;
  const rnd = (n) => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) % n; };
  const size = PAGES * 65536;
  const lengths = [0, 1, 7, 8, 9, 15, 16, 17, 63, 64, 65, 1000, 4096 + 3];
  for (let i = 0; i < 3000; i++) {
    const n = i % 3 === 0 ? rnd(300) : lengths[rnd(lengths.length)];
    const pick = () => (rnd(4) === 0 ? size - n - rnd(16) : rnd(size - n));
    const dst = pick();
    if (rnd(4) === 0) yield ['fill', dst, rnd(1000) - 300, n];
    else {
      const near = rnd(3);
      const src = near === 0 ? Math.min(size - n, Math.max(0, dst + rnd(33) - 16)) : pick();
      yield ['copy', dst, src, n];
    }
  }
}

test('wasm-copy-guard routes memory.copy and memory.fill through its helpers', () => {
  assert.match(guarded.log, /1 memory\.copy and 1 memory\.fill routed/);
  assert.deepEqual(bulkOps(source()), ['copy', 'fill']);
  // The native instructions survive only inside the helpers' fast paths.
  assert.deepEqual(bulkOps(guarded.bytes), ['copy', 'fill']);
  // --always-slow leaves none, so the loops are all that runs below.
  assert.deepEqual(bulkOps(slow.bytes), []);
});

for (const [name, bytes] of [['native path', guarded.bytes], ['slow path (--always-slow)', slow.bytes]]) {
  test(`wasm-copy-guard, ${name}: memmove and memset semantics, and out of bounds still traps`, () => {
    const m = instantiate(bytes);
    const ref = new Uint8Array(m.mem.length);
    for (let i = 0; i < ref.length; i++) ref[i] = m.mem[i] = (i * 131 + (i >> 8)) & 0xff;
    let ops = 0;
    for (const [op, dst, a, n] of operations()) {
      if (op === 'copy') { m.copy(dst, a, n); ref.copyWithin(dst, a, a + n); }
      else { m.fill(dst, a, n); ref.fill(a & 0xff, dst, dst + n); }
      ops++;
      if (ops % 250 === 0) assert.ok(Buffer.compare(m.mem, ref) === 0, `memory differs after ${ops} operations (${op} ${dst} ${a} ${n})`);
    }
    assert.ok(Buffer.compare(m.mem, ref) === 0, 'memory differs at the end');
    const size = ref.length;
    assert.throws(() => m.copy(size - 4, 0, 8), WebAssembly.RuntimeError);
    assert.throws(() => m.copy(0, size - 4, 8), WebAssembly.RuntimeError);
    assert.throws(() => m.fill(size - 4, 1, 8), WebAssembly.RuntimeError);
    assert.throws(() => m.copy(0xfffffff0, 0, 32), WebAssembly.RuntimeError);
  });
}

test('wasm-copy-guard refuses a module whose memory is not shared', () => {
  writeFileSync(join(dir, 'unshared.wasm'), source({ shared: false }));
  assert.throws(() => execFileSync(tool, [join(dir, 'unshared.wasm'), join(dir, 'x.wasm')], { stdio: 'pipe' }), /not shared/);
});
