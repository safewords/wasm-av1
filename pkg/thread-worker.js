// One rav1d worker thread: another instance of the same wasm module on the
// same shared memory, in a Worker.
//
// Created by worker-client.js on the page at the decode Worker's request (or
// by loader.js directly when a decoder runs on the page — which threads
// cannot, but the path exists). It receives the compiled module, the shared memory and
// the address of the thread body that rav1d handed to the spawner, runs the
// body to completion (`__wasm_av1_thread_entry`), frees the thread's TLS and
// stack, and closes. Copied into pkg/ by scripts/build.sh so it sits next to
// the variants it instantiates.

self.onmessage = async ({ data }) => {
  const { glue, module, memory, ptr, stackSize } = data;
  let mod;
  try {
    mod = await import(/* @vite-ignore */ /* webpackIgnore: true */ glue);
    await mod.default({ module_or_path: module, memory, thread_stack_size: stackSize });
  } catch (e) {
    // The decoder side would wait forever for a thread that never came;
    // there is nothing to do here but say so loudly.
    console.error('wasm-av1: thread could not start:', e);
    self.close();
    return;
  }
  try {
    mod.__wasm_av1_thread_entry(ptr);
  } catch (e) {
    // A trap here is a rav1d worker thread dying (a panic aborts); the other
    // threads and the decoder will wait forever, so at least say where.
    console.error('wasm-av1: thread died:', e?.stack ?? e);
    throw e;
  } finally {
    try {
      mod.__wbindgen_thread_destroy?.();
    } catch {
      /* already gone */
    }
    self.close();
  }
};
