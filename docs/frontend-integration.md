# Putting this in lewd-frontend

The concrete, file-by-file plan lives with the frontend:
`lewd/lewd-frontend/WASM_AV1_FALLBACK.md`. This page is the package-side
summary of what it relies on. The library-side pieces it needs all exist and
are tested: `HlsAv1Video` (`js/hls.js`: master/media playlist parsing, init +
segment fetching with a credentials hook, prefetch, seek, variant switch,
external clock), the segment-fed decoder API (`setInitSegment` /
`pushSegment`, rivet demux in wasm, no reset between segments), the Worker,
the WebGL renderer, and the feature detection.

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
master.m3u8 ──parseMaster──▶ variants (av01, sorted by bandwidth) + audio group
   audio rendition ──▶ hls.js on the <video>  (the clock and the transport; controls untouched)
   video rendition ──parseMediaPlaylist──▶ init.mp4 + seg-N.m4s
        init  ──▶ decoder.setInitSegment(init)
        seg-N ──▶ decoder.pushSegment(seg)      rivet demuxes init‖seg in wasm, samples queued as temporal units
                  decoder.run() … nextFrame()   frames with pts in the track timescale
   HlsAv1Video: prefetch `prefetchSeconds` ahead of `clock()`, show the frame due at video.currentTime,
                drop late ones, seek() = flush + refill from the segment holding the target
   render: WebGLRenderer on a <canvas> beside the <video> (YUV in the shader); Canvas2DRenderer fallback
   thread: WorkerDecoder — decode + demux off the main thread, planes transferred per frame
```

## Which rung

Measure, do not guess: decode the first segment and compare ms/frame with the
frame duration; pick the highest rung whose measured decode ≤ ~60 % of the
frame time on that device. On this laptop the SIMD build does 720p at ~110 fps
and 1080p at ~60 fps single-threaded (docs/performance.md); an old phone is
3–8× slower, so expect 480p/720p there. That is still AV1 playing where today
nothing plays. With the threads builds (`threads: 'auto'`, needs the page
cross-origin isolated — `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` on the document, which on
Cloudflare Pages is a `_headers` file) 1080p decodes 3–5× faster on 4–8
cores, and the worst-frame time — what shows as a stutter — comes down with
it. Without the headers nothing breaks: `detectThreads()` is false and the
single-thread build loads.

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
