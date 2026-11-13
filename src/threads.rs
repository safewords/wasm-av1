//! Threads for the wasm build: the decoder core's worker threads as Web
//! Workers.
//!
//! Only compiled with the `atomics` target feature (the `threads` variants
//! in `pkg/`). A wasm thread is another instance of the same module on the
//! same shared memory, running in a Worker; Rust cannot create one, so the
//! core asks the embedder and this module is that embedder: it boxes the
//! thread body, hands its address to
//! `globalThis.__wasmAv1SpawnThread(module, memory, ptr)` — installed by
//! `js/loader.js` in whichever context instantiated the module — and the
//! Worker that JS ends up creating (`pkg/thread-worker.js`, created by the
//! page at the decode Worker's request: a Worker created by a Worker that
//! then blocks never starts in Chromium) instantiates the module on the
//! shared memory and calls [`thread_entry`] with the address, which runs the
//! body to completion.
//!
//! What asks, by core:
//!
//! * **rav1d** creates its worker threads when a decoder opens, through the
//!   spawner registered with `rav1d::wasm_thread::set_thread_spawner`; they
//!   live as long as that decoder.
//! * **rivet-av1** starts scoped threads for every parallel job, which a
//!   Worker is far too slow for, so the `pool` here keeps threads for the
//!   life of the instance and is the `av1::parallel::Runner` rivet-av1 hands
//!   each job to (feature `rivet-av1-pending`: that hook is not in rivet
//!   `develop` yet, and without it a `rivet-av1` build has no threads on
//!   wasm and this module is not compiled).
//!
//! The spawner returns as soon as the Worker is *requested*; the thread starts
//! when its script has loaded. Neither core blocks on the start: rav1d's
//! worker threads wait for the decoder context on a condvar, and the pool
//! gives a job only to the threads that are already waiting for one.
//!
//! Requirements on the page: `crossOriginIsolated` (COOP + COEP headers), or
//! there is no `SharedArrayBuffer` and the threads variant cannot even be
//! instantiated — `js/detect.js` checks before choosing it. And the decoder
//! must itself run in a Worker: with more than one thread the core blocks
//! the calling thread on condvars (`memory.atomic.wait`), which browsers
//! forbid on the main thread.

use std::sync::Once;

use wasm_bindgen::prelude::*;

/// What a thread runs. Double-boxed on its way through JS: a `Box<dyn …>` is
/// a fat pointer, the address handed to JS must be thin.
type ThreadBody = Box<dyn FnOnce() + Send + 'static>;

#[wasm_bindgen]
extern "C" {
    /// `globalThis.__wasmAv1SpawnThread(module, memory, ptr)` — see js/loader.js.
    #[wasm_bindgen(js_namespace = globalThis, js_name = "__wasmAv1SpawnThread", catch)]
    fn js_spawn_thread(module: JsValue, memory: JsValue, ptr: usize) -> Result<JsValue, JsValue>;
}

fn spawn(body: ThreadBody) -> Result<(), ()> {
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

/// Entry point of a thread Worker: run the body whose address `spawn` gave
/// JS. Called exactly once per address, from `pkg/thread-worker.js`.
#[wasm_bindgen(js_name = "__wasm_av1_thread_entry")]
pub fn thread_entry(ptr: usize) {
    // SAFETY: `ptr` came from `Box::into_raw` in `spawn` and is consumed
    // here, once.
    let body: Box<ThreadBody> = unsafe { Box::from_raw(ptr as *mut ThreadBody) };
    body();
}

/// Register the spawner with rav1d (once per instance).
#[cfg(not(feature = "rivet-av1"))]
pub fn install() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        rav1d::wasm_thread::set_thread_spawner(spawn);
    });
}

#[cfg(feature = "rivet-av1-pending")]
pub use pool::install;

/// rivet-av1's threads: a pool of Workers that outlives every decoder.
///
/// rivet-av1 starts scoped threads for each parallel job (the tiles of a
/// frame, the bands of a post-filter) and joins them after it. A Worker
/// takes milliseconds to start and cannot be started from a thread that is
/// about to block, so here the threads are started once, kept, and handed
/// each job: the pool is rivet-av1's [`av1::parallel::Runner`]. The thread
/// that decodes takes part in every job, and a job is a loop over a shared
/// queue, so a Worker that is not up yet is simply not waited for.
#[cfg(feature = "rivet-av1-pending")]
mod pool {
    use super::*;
    use std::sync::{Condvar, Mutex};

    /// A job as rivet-av1 hands it over, its borrow of the caller's stack
    /// erased so that the pool's threads can hold it. Sound because
    /// [`Pool::run`] does not return while a thread is inside it.
    #[derive(Clone, Copy)]
    struct Job(*const (dyn Fn(usize) + Sync));
    // SAFETY: the pointee is `Sync`; see `Job`.
    unsafe impl Send for Job {}

    #[derive(Default)]
    struct State {
        /// Workers asked for so far (each is running, or about to).
        spawned: usize,
        /// The job in progress, and the indices `next..limit` nobody has
        /// taken yet.
        job: Option<Job>,
        next: usize,
        limit: usize,
        /// Workers inside the job.
        running: usize,
    }

    struct Pool {
        state: Mutex<State>,
        /// Workers wait here for a job.
        work: Condvar,
        /// `run` waits here for the workers to leave the job.
        idle: Condvar,
    }

    static POOL: Pool = Pool {
        state: Mutex::new(State {
            spawned: 0,
            job: None,
            next: 0,
            limit: 0,
            running: 0,
        }),
        work: Condvar::new(),
        idle: Condvar::new(),
    };

    impl Pool {
        /// The body of one worker thread: take an index of the job in
        /// progress, run it, wait for the next. Never returns.
        fn worker(&'static self) {
            let mut st = self.state.lock().unwrap();
            loop {
                match st.job {
                    Some(job) if st.next < st.limit => {
                        let k = st.next;
                        st.next += 1;
                        st.running += 1;
                        drop(st);
                        // SAFETY: `run` holds the job alive until `running`
                        // is back to zero.
                        (unsafe { &*job.0 })(k);
                        st = self.state.lock().unwrap();
                        st.running -= 1;
                        if st.running == 0 {
                            self.idle.notify_all();
                        }
                    }
                    _ => st = self.work.wait(st).unwrap(),
                }
            }
        }
    }

    impl av1::parallel::Runner for Pool {
        fn run(&self, n: usize, job: &(dyn Fn(usize) + Sync)) {
            {
                let mut st = self.state.lock().unwrap();
                if st.job.is_some() {
                    // Another decoder's job has the pool (two decoders on
                    // two threads of one instance): do this one alone.
                    drop(st);
                    return job(0);
                }
                // SAFETY: only the lifetime changes; the job is not used
                // after this function returns (see below).
                st.job = Some(Job(unsafe {
                    std::mem::transmute::<
                        *const (dyn Fn(usize) + Sync + '_),
                        *const (dyn Fn(usize) + Sync + 'static),
                    >(job)
                }));
                st.next = 1;
                st.limit = n;
            }
            self.work.notify_all();
            // The caller is worker 0. The job is a loop over a shared queue,
            // so when this returns nothing is left to start: a Worker that
            // has not come up yet, or wakes late, is not waited for.
            job(0);
            let mut st = self.state.lock().unwrap();
            st.limit = 0;
            while st.running > 0 {
                st = self.idle.wait(st).unwrap();
            }
            st.job = None;
        }
    }

    /// Make sure the pool has the `threads - 1` workers a decoder with
    /// `threads` threads uses (the decoding thread is the other one), and
    /// that rivet-av1 runs its parallel work on it.
    pub fn install(threads: usize) {
        static ONCE: Once = Once::new();
        ONCE.call_once(|| {
            av1::parallel::set_runner(&POOL);
        });
        let want = threads.saturating_sub(1);
        loop {
            {
                let mut st = POOL.state.lock().unwrap();
                if st.spawned >= want {
                    return;
                }
                st.spawned += 1;
            }
            if spawn(Box::new(|| POOL.worker())).is_err() {
                // No Worker: decode with the threads there are.
                POOL.state.lock().unwrap().spawned -= 1;
                return;
            }
        }
    }
}
