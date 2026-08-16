# Putting this in lewd-frontend (plan — not implemented yet)

The long-term goal: on a device whose browser cannot decode AV1 natively (no
hardware decoder, no software AV1 in the browser), lewd.net still plays its
AV1 renditions, using this decoder — with the SIMD build where the engine has
it, which on ARM phones becomes NEON.

## Where the frontend is today

`src/stores/globalPlayer.js` attaches **hls.js** to a `<video>` and plays
lewd.net's HLS/CMAF (fMP4) ladders; `cmaf_controller.rs` writes
`CODECS="av01.0.05M.08[,mp4a…]"` into the playlist. On a browser without AV1,
MSE rejects the variant (`MediaSource.isTypeSupported('video/mp4; codecs="av01.0.05M.08"')`
is false), hls.js reports an unsupported codec, and `VideoBlock.vue` shows
"This video uses a codec we don't support yet".

## The decision

```js
const av1 = 'video/mp4; codecs="av01.0.05M.08"';
const native = window.MediaSource?.isTypeSupported(av1)
  || document.createElement('video').canPlayType(av1) !== '';
// Better: navigator.mediaCapabilities.decodingInfo({type:'media-source', video:{contentType: av1, width, height, bitrate, framerate}})
//   → { supported, smooth, powerEfficient }: fall back when !supported, and consider it when !smooth.
if (!native && chooseVariant() /* from @safewords/wasm-av1 */) useWasmPlayer();
```

`chooseVariant()` is null on engines older than the baseline (Safari < 15,
Chrome < 96); nothing to do for those.

## The pipeline (per rendition)

```
m3u8 (variant + media playlist)      already parsed by hls.js, or fetch it: it is text
   │
   ├─ init.mp4  ─┐
   └─ seg-N.m4s ─┴─→ concat(init, seg) → decoder.setSourceContainer(bytes)   (rivet demux in wasm)
                                          decoder.run() … nextFrame() → frames with pts (track timescale)
   audio: a plain <audio> on the AAC media playlist (hls.js can drive it) — it is the clock:
          show the frame whose seconds ≤ audio.currentTime, drop late ones (Av1Player already does this
          against performance.now(); swap the clock source).
   render: WebGLRenderer on a <canvas> in PlayerSlot where the <video> would be (YUV in the shader,
           no CPU conversion); Canvas2DRenderer where WebGL is missing.
   thread: WorkerDecoder — decode + demux off the main thread, planes transferred per frame.
```

rivet's demuxer is whole-buffer and forward-only, so it is one
`setSourceContainer` per `init ‖ segment` (the init is a few KB; parsing it
again per segment is nothing). Segments are 2–6 s of frames, i.e. a bounded
amount of decode-ahead; the ring (`maxBuffered`) already limits memory.

## Which rung

Measure, do not guess: decode the first segment and compare ms/frame with the
frame duration; pick the highest rung whose measured decode ≤ ~60 % of the
frame time on that device. On this laptop the SIMD build does 720p at ~35 fps
and 1080p at ~23 fps single-threaded (docs/performance.md); an old phone is
3–8× slower, so expect 360p/480p there. That is still AV1 playing where today
nothing plays.

## Loading

`pkg/` is ~1.7 MB per variant (600 KB gzipped) — load lazily, only after the
decision above says so, from lewd.net's static assets (same origin, so no
CORS on the `.wasm` fetch), with long cache headers; the loader in `js/loader.js`
memoises per variant. Copy `js/` + `pkg/` into the frontend build (Vite:
serve `pkg/` as static assets and pass `baseUrl`), or publish
`@safewords/wasm-av1` to the org registry.

## Not in scope of the fallback

Seeking within a segment (flush + re-feed from the segment's keyframe — every
CMAF segment starts on one), captions, DRM (none on lewd.net), and audio
decoding (the browser does AAC natively everywhere).
