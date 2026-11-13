// A threads build driven from Node, for test/decode.test.mjs.
//
//   node test/threads-node.mjs <threads|simd-threads> <thread count>
//
// Decodes every fixture in testdata/ and prints one line of JSON: the thread
// count the decoder applied, how many thread Workers the wasm asked for, and
// each fixture's MD5 — twice over, see below.
//
// In a browser a wasm thread is a Web Worker running pkg/thread-worker.js,
// and the decoder has to live in a Worker of its own because it blocks. Node
// lets its main thread block, so here the decoder runs on the main thread and
// each wasm thread is a `worker_threads` Worker running this same file: the
// Node stand-in for thread-worker.js (same module, same shared memory, same
// `__wasm_av1_thread_entry`). It is a process of its own because a decoder
// that waits for a thread forever cannot be timed out from inside; the test
// that spawns it can.

import { Worker, isMainThread, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

if (!isMainThread) {
  // One wasm thread. The body is a pool worker: it never returns.
  const { glue, module, memory, ptr, stackSize } = workerData;
  const mod = await import(glue);
  await mod.default({ module_or_path: module, memory, thread_stack_size: stackSize });
  mod.__wasm_av1_thread_entry(ptr);
} else {
  const [variant, threadsArg] = process.argv.slice(2);
  const threads = Number(threadsArg);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dir = path.join(root, 'pkg', variant);
  const glue = pathToFileURL(path.join(dir, 'wasm_av1.js')).href;
  const mod = await import(glue);
  const wasm = await mod.default({ module_or_path: readFileSync(path.join(dir, 'wasm_av1_bg.wasm')) });

  let spawned = 0;
  globalThis.__wasmAv1SpawnThread = (module, memory, ptr) => {
    spawned++;
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { glue, module, memory, ptr, stackSize: 2 * 1024 * 1024 } });
    w.on('error', (e) => {
      console.error('wasm thread died:', e);
      process.exit(3);
    });
  };

  const testdata = path.join(root, 'testdata');
  const fixtures = readdirSync(testdata).filter((f) => f.endsWith('.ivf')).sort();
  let applied = 0;
  const decodeAll = () => {
    const out = {};
    for (const f of fixtures) {
      const dec = new mod.Av1Decoder(4, true, threads);
      applied = dec.threads();
      dec.setSourceIvf(readFileSync(path.join(testdata, f)));
      const md5 = createHash('md5');
      let frames = 0;
      while (!dec.finished()) {
        dec.run();
        while (dec.nextFrame()) {
          // A copy: the memory is shared, and a hash may not read a SharedArrayBuffer.
          md5.update(new Uint8Array(wasm.memory.buffer, dec.framePtr(), dec.frameLen()).slice());
          frames++;
        }
      }
      dec.free();
      out[f.replace(/\.ivf$/, '')] = { frames, md5: md5.digest('hex') };
    }
    return out;
  };

  // First with the Workers only just asked for: the decoder must not wait
  // for a thread that is not up yet. Then again once they are waiting for
  // work, which is the pool doing the decoder's parallel jobs.
  const cold = decodeAll();
  await new Promise((r) => setTimeout(r, 500));
  const warm = decodeAll();
  console.log(JSON.stringify({ variant, simd: mod.simdEnabled(), threadsSupported: mod.threadsSupported(), applied, spawned, cold, warm }));
  // The pool's Workers wait for work for ever.
  process.exit(0);
}
