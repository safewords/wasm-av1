// Decode off the main thread.
//
// Upstream ran everything on the main thread and listed "offloading the
// decoding into a web worker" as future work. This is that worker: it owns a
// wasm runtime and a `Decoder`, decodes ahead, and posts frames to the page
// as transferable buffers, keeping at most `prefetch` frames in flight until
// the page acknowledges them. One copy per frame (wasm memory cannot be
// transferred), which is what an ImageBitmap path would cost anyway.
//
// Messages in:  init | ivf | container | source | initSegment | segment | switchStream | push | eos | flush | ack | close
// Messages out: ready | info | frame | finished | error | spawnThread | segment | switched
//
// `init.threads` > 1 asks for a threads runtime (loader.js picks one when the
// page is cross-origin isolated) and that many rav1d worker threads; `ready`
// reports how many there are. Each thread is a Worker the *page* creates:
// this Worker sends `spawnThread` up (WorkerDecoder answers) because it is
// about to block waiting for those threads, and a Worker created from a
// blocked Worker never starts in Chromium (see loader.js).
//
// Use `WorkerDecoder` in worker-client.js rather than talking to this directly.

import { loadWasmAv1 } from './loader.js';
import { Decoder, Run } from './decoder.js';

let rt = null;
let dec = null;
let output = 'planes'; // or 'rgba'
let prefetch = 6;
let inflight = 0;
let pumping = false;
let closed = false;

const wake = new MessageChannel();
wake.port1.onmessage = () => pump();
const schedule = () => wake.port2.postMessage(0);

function post(msg, transfer) {
  self.postMessage(msg, transfer || []);
}

function pump() {
  if (pumping || !dec || closed) return;
  pumping = true;
  try {
    // Fill the wasm ring and ship what the page has room for. One `run()`
    // per turn keeps the worker responsive to incoming messages.
    let progressed = false;
    if (inflight < prefetch) {
      let r;
      try {
        r = dec.run();
      } catch (e) {
        post({ type: 'error', message: String(e?.message ?? e), fatal: false });
        r = Run.CONSUMED;
      }
      progressed = r === Run.CONSUMED || r === Run.FULL;
      while (inflight < prefetch) {
        const f = dec.nextFrame();
        if (!f) break;
        const t = f.toTransferable({ rgba: output === 'rgba' });
        const transfer = [t.data];
        if (t.rgba) transfer.push(t.rgba);
        post({ type: 'frame', frame: t, stats: dec.stats() }, transfer);
        inflight++;
      }
      if (dec.finished && dec.framesBuffered === 0) {
        post({ type: 'finished', stats: dec.stats() });
      } else if (progressed && inflight < prefetch) {
        schedule();
      }
    }
  } finally {
    pumping = false;
  }
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    switch (m.type) {
      case 'init': {
        const threads = Math.max(1, m.threads ?? 1);
        rt = await loadWasmAv1({ variant: m.variant ?? 'auto', baseUrl: m.baseUrl, threads: threads > 1 });
        output = m.output ?? 'planes';
        prefetch = m.prefetch ?? 6;
        dec = new Decoder(rt, { maxBuffered: m.maxBuffered ?? 10, applyGrain: m.applyGrain ?? true, threads });
        post({ type: 'ready', variant: rt.variant, simd: rt.simd, threads: dec.threads, version: rt.version });
        break;
      }
      case 'ivf':
      case 'container':
      case 'source': {
        inflight = 0;
        const bytes = new Uint8Array(m.data);
        const info = m.type === 'ivf' ? dec.setSourceIvf(bytes)
          : m.type === 'container' ? dec.setSourceContainer(bytes)
          : dec.setSource(bytes);
        post({ type: 'info', info });
        schedule();
        break;
      }
      case 'push': {
        if (m.timeBase != null) dec.setTimeBase(m.timeBase);
        dec.pushTemporalUnit(new Uint8Array(m.data), m.pts ?? 0);
        schedule();
        break;
      }
      case 'initSegment':
        dec.setInitSegment(new Uint8Array(m.data));
        break;
      case 'segment': {
        let n = 0;
        let error = null;
        try {
          n = dec.pushSegment(new Uint8Array(m.data));
        } catch (e) {
          error = String(e?.message ?? e);
        }
        const range = dec.lastSegmentRange();
        post({ type: 'segment', tag: m.tag, samples: n, error, firstPts: range.firstPts, lastPts: range.lastPts, timeBase: dec.timeBase, info: dec.info() });
        schedule();
        break;
      }
      case 'switchStream': {
        // Seamless rendition switch — see Decoder.switchStream.
        let r;
        try {
          r = dec.switchStream({ boundaryPts: m.boundaryPts ?? null, init: new Uint8Array(m.init) });
        } catch (e) {
          r = { ok: false, dropped: 0, error: String(e?.message ?? e) };
        }
        post({ type: 'switched', tag: m.tag, ...r });
        schedule();
        break;
      }
      case 'eos':
        dec.endOfStream();
        schedule();
        break;
      case 'flush':
        dec.flush();
        inflight = 0;
        post({ type: 'flushed' });
        schedule();
        break;
      case 'ack':
        inflight = Math.max(0, inflight - (m.count ?? 1));
        schedule();
        break;
      case 'close':
        closed = true;
        dec?.free();
        dec = null;
        self.close();
        break;
      default:
        post({ type: 'error', message: `unknown message ${m.type}`, fatal: false });
    }
  } catch (e) {
    post({ type: 'error', message: String(e?.message ?? e), fatal: m.type === 'init' });
  }
};
