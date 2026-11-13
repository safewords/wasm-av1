# wasm-av1: feature docs

> **Last verified against code:** 2026-11-12 @ `162385f`

wasm-av1 is AV1 decoding for browsers that have no AV1 decoder of their own:
rivet-av1 (rivet's own AV1 decoder, written from the specification) compiled
to WebAssembly in four variants, with containers demuxed inside the same wasm
by rivet's `rivet-container`, behind a small pull-style API ported from
GoogleChromeLabs/wasm-av1. On top of the wasm sits an ESM JavaScript layer:
loader and feature detection, a `Decoder` wrapper, a decode Worker, WebGL and
2D renderers, `Av1Player` and `HlsAv1Video`. It is a library, not a service:
nothing deploys. A `v*` tag builds and publishes `@safewords/wasm-av1` to npm
and to a GitHub Release; lewd-frontend consumes the 0.2.2 release tarball by
URL. Pushing `main` only runs CI.

Since 0.3.0 (2026-11-12) rivet-av1 is the only decoder; rav1d, which 0.1.0
to 0.2.2 were built on, is gone. **That made the package slower:** in wasm
rivet-av1 decodes 8-bit video at a third to two thirds of rav1d's
single-thread rate and scales poorly with threads on the one-tile streams
most encoders make. It is bit-exact on every fixture in every variant. The
performance work is under way in rivet-av1;
[`../rivet-av1.md`](../rivet-av1.md) is the account, with the measurements
and rav1d as their baseline. lewd-frontend's 0.2.2 tarball is still the
rav1d build.

```mermaid
flowchart TB
  subgraph page[Page / main thread]
    hls[HlsAv1Video<br/>js/hls.js]
    player[Av1Player<br/>js/player.js]
    render[WebGL / 2D renderers<br/>js/render.js]
    wclient[WorkerDecoder<br/>js/worker-client.js]
    jsdec[Decoder + Frame<br/>js/decoder.js]
    loader[loader + detect<br/>js/loader.js, js/detect.js]
  end
  subgraph worker[Decode Worker  js/worker.js]
    wdec[Decoder + Frame]
  end
  subgraph wasm[wasm module  pkg/variant]
    bind[wasm-bindgen surface<br/>src/wasm.rs]
    core[Decoder core: ring, run, sources<br/>src/decoder.rs]
    adapter[core adapter<br/>src/core.rs]
    ivf[IVF reader<br/>src/ivf.rs]
    frame[Frame + YUV to RGBA<br/>src/frame.rs, src/convert.rs]
    threads[thread pool<br/>src/threads.rs]
    rivetav1[(rivet-av1<br/>rivet main)]
    rivet[(rivet-container<br/>rivet main)]
  end
  tw[thread Workers<br/>pkg/thread-worker.js]

  hls --> player --> render
  player --> jsdec
  player --> wclient -- postMessage --> worker
  jsdec --> loader --> bind
  wdec --> bind
  bind --> core
  core --> ivf
  core --> rivet
  core --> adapter
  adapter --> rivetav1
  core --> frame
  rivetav1 -- parallel jobs --> threads -. spawnThread .-> wclient --> tw
  tw -. shared memory .-> threads
  hls -. fetch playlists + segments .-> cdn[(HLS / CMAF origin)]
  hls -. clock .-> video[video element<br/>audio rendition]
```

## Index

| Component | Status | Doc |
|---|---|---|
| Decoder core (ring, `run`, `finished`, flush) | PARTIAL (slow next to rav1d; a truncated IVF frame loops) | [decoder-core.md](./decoder-core.md) |
| Input sources (IVF, containers via rivet, push, CMAF segments, rendition switch) | STABLE | [input-sources.md](./input-sources.md) |
| Frames, colour conversion and rendering | STABLE | [frames-and-rendering.md](./frames-and-rendering.md) |
| wasm variants, detection and threading | PARTIAL (threads buy little on one-tile streams) | [variants-and-threading.md](./variants-and-threading.md) |
| JS decoder API and the decode Worker | PARTIAL (stale frames after flush; `load` can hang) | [js-api-and-worker.md](./js-api-and-worker.md) |
| Av1Player and HlsAv1Video | STABLE | [player-and-hls.md](./player-and-hls.md) |
| Build, tests and release | PARTIAL (committed `pkg/` is still the rav1d build of 0.2.2) | [build-and-release.md](./build-and-release.md) |

Deeper material that stays authoritative for its subject:
[`../rivet-av1.md`](../rivet-av1.md) (the decoder: what it is, what it
replaced, what was measured, what would close the gap),
[`../rivet.md`](../rivet.md) (the demuxer), [`../performance.md`](../performance.md)
(where 0.3.0 stands, and the rav1d measurements of 0.2.x as the baseline),
[`../integration.md`](../integration.md) (how a player should
adopt the fallback).

## Known defects

| Component | Defect | Severity |
|---|---|---|
| Decoder core | **Speed.** Since 0.3.0 the decoder is rivet-av1, which in wasm decodes 8-bit video at 0.33 to 0.63 times the single-thread rate of the rav1d build it replaced (measured 2026-11-12; 0.83 to 0.97 for 10-bit in the SIMD variant). A rung a device played with 0.2.x may stutter with 0.3.0. The work is in rivet-av1: [`../rivet-av1.md`](../rivet-av1.md). | High |
| Variants & threading | **Thread scaling.** rivet-av1 threads tiles and post-filter bands inside one frame, not frames: 1.2 to 1.3 times on 8 threads for a stream with one tile per frame, 3.3 with eight tiles; rav1d reached 2.8 to 3.6 and 6.3. On eight threads a one-tile 720p or 1080p stream decodes at a sixth to a fifth of rav1d's rate. | High |
| Decoder core | A truncated IVF frame makes `IvfReader::next_frame` fail without advancing (`src/ivf.rs:191-196`), so every later `run()` returns the same error and `finished` never becomes true. `Av1Player` and `worker.js` both treat a throw as `CONSUMED` and keep calling: a hot loop of `onerror` / `error` messages on a partly downloaded file. | Medium |
| JS API & Worker | `WorkerDecoder.flush()` / `setSource()` clear the page-side queue, but frames the Worker posted before it saw the message still arrive and are queued: a few frames of the old position or file are shown after a seek or reload. Messages carry no generation. | Medium |
| JS API & Worker | `Av1Player.load()` in Worker mode polls `src.info` (`js/player.js:129-133`); if the Worker rejects the source (not AV1, bad file) `info` never arrives and `load()` never settles. | Medium |
| Variants & threading | A thread Worker that fails to start or traps leaves the decoder waiting forever (`js/thread-worker.js:19-32`); the page sees only a console error. | Low |
| Build & release | The committed `pkg/` is replaced only from CI's build, by hand, after the source commit that changes it. Between the two a `github:safewords/wasm-av1#main` consumer gets the previous wasm with the new JS (on 2026-11-13: the threads variants without `tools/wasm-copy-guard`, until CI's build of that commit is committed). | Low |
| Variants & threading | `test/browser.mjs` is not in CI (Playwright is not installed there). It was last run on 2026-11-13, on a local unoptimised build of 0.3.0 with `tools/wasm-copy-guard`: every combination passed in Chromium, Firefox and WebKit (Playwright 1.56's macOS WebKit and 1.62's). A regression in a browser shows up only when somebody runs it. | Medium |
| Build & release | `scripts/build.sh` does not run on a stock macOS: GNU-only sed expressions (`:48`, `:50`), empty arrays under `set -u` on bash 3.2 (`:75`), GNU `stat -c %s` (`:129`). | Low |
| Player & HLS | `_switchAtBoundary` locates the decoding segment by comparing cumulative pushed samples with `stats.temporalUnitsIn`, which is never reset by a flush and counts past the 64-entry `_pushed` window (`js/hls.js:332-338`, `438`). After a seek or 64 segments, a boundary switch lands after everything already pushed: correct, but up to `prefetchSeconds` late. | Low |
