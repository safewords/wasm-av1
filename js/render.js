// Putting frames on a canvas.
//
// Upstream `draw-image.js` converted YUV→RGB on the CPU and uploaded an RGB
// texture — and rebuilt the shader program, buffers and texture on every
// frame. Its own comment asked for the conversion to move into a shader.
//
// * `WebGLRenderer` uploads the three planes as LUMINANCE textures and does
//   the matrix in the fragment shader (BT.601/709/2020, limited/full range,
//   from the frame's own metadata) — no CPU conversion, no RGBA buffer, and
//   everything GL is created once. 8-bit frames only; a 16-bit frame falls
//   back to an RGBA texture from the wasm converter.
// * `Canvas2DRenderer` uses the wasm RGBA conversion (SIMD in the SIMD build)
//   into a reused ImageData and `putImageData`. Works everywhere.
//
// Both accept either a live `Frame` (from decoder.js) or the plain object a
// Worker posts (`Frame.toTransferable()`), so the player can swap freely.

import { krKbFor } from './decoder.js';

const VS = `
attribute vec2 aPos;
attribute vec2 aTex;
varying vec2 vTex;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); vTex = aTex; }`;

// yuv → rgb with per-frame coefficients. Sample values arrive normalised
// (0..1); offsets and gains are for that scale.
const FS_YUV = `
precision mediump float;
uniform sampler2D uY; uniform sampler2D uU; uniform sampler2D uV;
uniform float uYOffset;      // 16/255 limited, 0 full
uniform float uYGain;        // 255/219 limited, 1 full
uniform vec4 uCoef;          // rv, gu, gv, bu (already × chroma gain)
uniform float uMono;         // 1.0 → ignore chroma
varying vec2 vTex;
void main() {
  float y = (texture2D(uY, vTex).r - uYOffset) * uYGain;
  float u = (texture2D(uU, vTex).r - 0.5) * (1.0 - uMono);
  float v = (texture2D(uV, vTex).r - 0.5) * (1.0 - uMono);
  gl_FragColor = vec4(y + uCoef.x * v, y + uCoef.y * u + uCoef.z * v, y + uCoef.w * u, 1.0);
}`;

const FS_RGBA = `
precision mediump float;
uniform sampler2D uTex;
varying vec2 vTex;
void main() { gl_FragColor = texture2D(uTex, vTex); }`;

function planeBytes(frame, i) {
  // Live Frame: transient view. Transferable: ArrayBuffer under .data.
  const p = frame.planes[i];
  const all = frame.data instanceof Uint8Array ? frame.data : new Uint8Array(frame.data);
  return all.subarray(p.offset, p.offset + p.stride * p.height);
}

function rgbaBytes(frame) {
  if (frame.rgba instanceof ArrayBuffer) return new Uint8Array(frame.rgba);
  if (typeof frame.rgba === 'function') return frame.rgba();
  throw new Error('wasm-av1: frame has no RGBA (worker frames need output: "rgba" for this renderer)');
}

export class WebGLRenderer {
  /** @param {HTMLCanvasElement|OffscreenCanvas} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl', { preserveDrawingBuffer: false, antialias: false, alpha: false, premultipliedAlpha: false })
      || canvas.getContext('experimental-webgl');
    if (!gl) throw new Error('wasm-av1: WebGL not available');
    this.gl = gl;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    this.progYuv = this._program(VS, FS_YUV);
    this.progRgba = this._program(VS, FS_RGBA);
    // One quad, one texcoord set, shared by both programs.
    this.quad = this._buffer(new Float32Array([-1, 1, -1, -1, 1, -1, 1, 1]));
    // Texture rows go top-down and GL's origin is bottom-left; flip via texcoords.
    this.tex = this._buffer(new Float32Array([0, 0, 0, 1, 1, 1, 1, 0]));
    this.textures = [0, 1, 2, 3].map(() => this._texture());
    this._texSize = new Map();
    this._last = { w: 0, h: 0 };
  }

  _program(vs, fs) {
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('wasm-av1: shader: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('wasm-av1: link: ' + gl.getProgramInfoLog(p));
    const u = {};
    for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) {
      const name = gl.getActiveUniform(p, i).name;
      u[name] = gl.getUniformLocation(p, name);
    }
    return { p, u, aPos: gl.getAttribLocation(p, 'aPos'), aTex: gl.getAttribLocation(p, 'aTex') };
  }

  _buffer(data) {
    const gl = this.gl;
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return b;
  }

  _texture() {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  }

  _upload(unit, format, w, h, bytes) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.textures[unit]);
    const key = `${format}:${w}x${h}`;
    if (this._texSize.get(unit) === key) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, format, gl.UNSIGNED_BYTE, bytes);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, format, w, h, 0, format, gl.UNSIGNED_BYTE, bytes);
      this._texSize.set(unit, key);
    }
  }

  _use(prog) {
    const gl = this.gl;
    gl.useProgram(prog.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(prog.aPos);
    gl.vertexAttribPointer(prog.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.tex);
    gl.enableVertexAttribArray(prog.aTex);
    gl.vertexAttribPointer(prog.aTex, 2, gl.FLOAT, false, 0, 0);
  }

  _fit(w, h) {
    if (this._last.w !== w || this._last.h !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this._last = { w, h };
    }
    this.gl.viewport(0, 0, w, h);
  }

  /** Draw a frame (live Frame or transferable). Returns 'yuv' or 'rgba' for the path taken. */
  draw(frame) {
    const gl = this.gl;
    this._fit(frame.width, frame.height);
    if (frame.bytesPerSample !== 1 || (frame.matrix === 0 && frame.layout === 3)) {
      // 16-bit samples (or planar GBR): let wasm convert, upload RGBA.
      this._use(this.progRgba);
      this._upload(3, gl.RGBA, frame.width, frame.height, rgbaBytes(frame));
      gl.uniform1i(this.progRgba.u.uTex, 3);
      gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
      return 'rgba';
    }
    this._use(this.progYuv);
    const mono = frame.layout === 0;
    const [py, pu, pv] = frame.planes;
    this._upload(0, gl.LUMINANCE, py.width, py.height, planeBytes(frame, 0));
    if (!mono) {
      this._upload(1, gl.LUMINANCE, pu.width, pu.height, planeBytes(frame, 1));
      this._upload(2, gl.LUMINANCE, pv.width, pv.height, planeBytes(frame, 2));
    }
    const u = this.progYuv.u;
    gl.uniform1i(u.uY, 0);
    gl.uniform1i(u.uU, mono ? 0 : 1);
    gl.uniform1i(u.uV, mono ? 0 : 2);
    const [kr, kb] = krKbFor(frame.matrix, frame.height);
    const kg = 1 - kr - kb;
    const cs = frame.fullRange ? 1 : 255 / 224;
    gl.uniform1f(u.uYOffset, frame.fullRange ? 0 : 16 / 255);
    gl.uniform1f(u.uYGain, frame.fullRange ? 1 : 255 / 219);
    gl.uniform4f(u.uCoef, 2 * (1 - kr) * cs, (-2 * kb * (1 - kb) / kg) * cs, (-2 * kr * (1 - kr) / kg) * cs, 2 * (1 - kb) * cs);
    gl.uniform1f(u.uMono, mono ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
    return 'yuv';
  }

  /**
   * Release GL resources. Deliberately does NOT lose the context: a canvas
   * that is reused for the next stream (a page's singleton player) gets the
   * same context back from `getContext('webgl')`, and a lost one cannot be
   * revived nor replaced by a 2D context on that canvas.
   */
  destroy() {
    const gl = this.gl;
    this.textures.forEach((t) => gl.deleteTexture(t));
    gl.deleteBuffer(this.quad);
    gl.deleteBuffer(this.tex);
    gl.deleteProgram(this.progYuv.p);
    gl.deleteProgram(this.progRgba.p);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
}

export class Canvas2DRenderer {
  /** @param {HTMLCanvasElement|OffscreenCanvas} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!this.ctx) throw new Error('wasm-av1: 2D canvas not available');
    this._img = null;
  }

  draw(frame) {
    if (this.canvas.width !== frame.width || this.canvas.height !== frame.height) {
      this.canvas.width = frame.width;
      this.canvas.height = frame.height;
      this._img = null;
    }
    if (!this._img) this._img = this.ctx.createImageData(frame.width, frame.height);
    this._img.data.set(rgbaBytes(frame));
    this.ctx.putImageData(this._img, 0, 0);
    return 'rgba';
  }

  destroy() {}
}

/**
 * Pick a renderer: WebGL if it initialises, else 2D.
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas
 * @param {'auto'|'webgl'|'2d'} [prefer='auto']
 */
export function createRenderer(canvas, prefer = 'auto') {
  if (prefer !== '2d') {
    try {
      return new WebGLRenderer(canvas);
    } catch (e) {
      if (prefer === 'webgl') throw e;
    }
  }
  return new Canvas2DRenderer(canvas);
}
