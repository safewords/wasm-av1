//! Threads for the wasm build: rav1d's worker threads as Web Workers.
//!
//! Only compiled with the `atomics` target feature (the `threads` variants
//! in `pkg/`). A wasm thread is another instance of the same module on the
//! same shared memory, running in a Worker; Rust cannot create one, so rav1d
//! asks the embedder ([`rav1d::wasm_thread::set_thread_spawner`]) and this
//! module is that embedder: it boxes the thread body, hands its address to
//! `globalThis.__wasmAv1SpawnThread(module, memory, ptr)` — installed by
//! `js/loader.js` in whichever context instantiated the module — and the
//! Worker that JS ends up creating (`pkg/thread-worker.js`, created by the
//! page at the decode Worker's request: a Worker created by a Worker that
//! then blocks never starts in Chromium) instantiates the module on the
//! shared memory and calls [`__wasm_av1_thread_entry`] with the address,
//! which runs the body to completion.
//!
//! The spawner returns as soon as the Worker is *requested*; the thread starts
//! when its script has loaded. rav1d's worker threads wait for the decoder
//! context on a condvar, so nothing blocks on the start.
//!
//! Requirements on the page: `crossOriginIsolated` (COOP + COEP headers), or
//! there is no `SharedArrayBuffer` and the threads variant cannot even be
//! instantiated — `js/detect.js` checks before choosing it. And the decoder
//! must itself run in a Worker: with more than one thread rav1d blocks the
//! calling thread on condvars (`memory.atomic.wait`), which browsers forbid
//! on the main thread.

use std::sync::Once;

use rav1d::wasm_thread::ThreadBody;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    /// `globalThis.__wasmAv1SpawnThread(module, memory, ptr)` — see js/loader.js.
    #[wasm_bindgen(js_namespace = globalThis, js_name = "__wasmAv1SpawnThread", catch)]
    fn js_spawn_thread(module: JsValue, memory: JsValue, ptr: usize) -> Result<JsValue, JsValue>;
}

fn spawn(body: ThreadBody) -> Result<(), ()> {
    // Double-boxed: `ThreadBody` is a fat pointer, the address handed to JS
    // must be thin.
    let ptr = Box::into_raw(Box::new(body)) as usize;
    match js_spawn_thread(wasm_bindgen::module(), wasm_bindgen::memory(), ptr) {
        Ok(_) => Ok(()),
        Err(_) => {
            // SAFETY: the Worker was not created, nobody else has `ptr`.
            drop(unsafe { Box::from_raw(ptr as *mut ThreadBody) });
            Err(())
        }
    }
}

/// Register the spawner with rav1d (once per instance).
pub fn install() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        rav1d::wasm_thread::set_thread_spawner(spawn);
    });
}

/// Entry point of a thread Worker: run the body whose address `spawn` gave
/// JS. Called exactly once per address, from `pkg/thread-worker.js`.
#[wasm_bindgen(js_name = "__wasm_av1_thread_entry")]
pub fn thread_entry(ptr: usize) {
    // SAFETY: `ptr` came from `Box::into_raw` in `spawn` and is consumed
    // here, once.
    let body: Box<ThreadBody> = unsafe { Box::from_raw(ptr as *mut ThreadBody) };
    body();
}
