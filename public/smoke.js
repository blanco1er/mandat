// Real smoke for the voice conversation: domain-warped fractal noise on the GPU (WebGL), rising from the
// bottom of the screen. The level (0 to 1) of the voice you hear or speak lifts it, thickens it and makes it
// swirl faster; the phase sets its colours. Rendered at half resolution: smoke is soft anyway, phones stay cool.

const FRAG = `
precision mediump float;
uniform vec2 res;
uniform float time, lvl, light;
uniform vec3 c1, c2, c3;
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = m * p; a *= 0.5; }
  return v;
}
void main() {
  vec2 uv = gl_FragCoord.xy / res;
  vec2 p = vec2(uv.x * res.x / res.y, uv.y) * 1.9;
  float t = time * (0.10 + lvl * 0.32);
  p.y -= t * 1.4;                                   // it rises
  vec2 q = vec2(fbm(p + vec2(0.0, t)), fbm(p + vec2(5.2, 1.3) - t * 0.5));
  vec2 r = vec2(fbm(p + 4.0 * q + vec2(1.7, 9.2) + t * 0.6), fbm(p + 4.0 * q + vec2(8.3, 2.8) - t * 0.4));
  float f = fbm(p + 3.5 * r);                       // wisps that curl into each other
  float top = 0.30 + lvl * 0.55;                    // the louder the voice, the higher it climbs
  float fade = 1.0 - smoothstep(0.0, top + 0.2, uv.y);
  float dens = smoothstep(0.22, 0.85, f + lvl * 0.14) * fade * (0.7 + lvl * 0.8);
  vec3 col = mix(c1, c2, smoothstep(0.25, 0.75, q.x));
  col = mix(col, c3, smoothstep(0.45, 0.9, r.y));
  col *= 0.85 + f * (1.25 + light * 0.35) + lvl * 0.35; // light glowing inside the smoke
  dens = clamp(dens, 0.0, 0.95);
  gl_FragColor = vec4(col * dens, dens);            // premultiplied alpha
}`;
const VERT = 'attribute vec2 pos; void main() { gl_Position = vec4(pos, 0.0, 1.0); }';

// Colours per phase: listening (cool blues), speaking (warm gold and rose in blue), thinking (quiet violet).
const PALETTE = {
  listening: [[0.04, 0.52, 1.0], [0.35, 0.85, 1.0], [0.85, 0.95, 1.0]],
  speaking: [[0.20, 0.45, 1.0], [1.0, 0.72, 0.20], [1.0, 0.45, 0.58]],
  thinking: [[0.32, 0.30, 0.85], [0.45, 0.55, 0.95], [0.75, 0.70, 1.0]],
  paused: [[0.30, 0.34, 0.45], [0.40, 0.45, 0.58], [0.55, 0.60, 0.70]],
};

export function createSmoke(canvas, read) {
  const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false });
  if (!gl) return null;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null; };
  const vs = sh(gl.VERTEX_SHADER, VERT);
  const fs = sh(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'pos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const u = Object.fromEntries(['res', 'time', 'lvl', 'light', 'c1', 'c2', 'c3'].map((n) => [n, gl.getUniformLocation(prog, n)]));
  const cur = PALETTE.listening.map((c) => c.slice());
  let raf = 0, start = performance.now(), level = 0;

  function size() {
    const scale = 0.5; // soft by nature: half resolution is invisible and twice as light
    const w = Math.max(1, Math.round(canvas.clientWidth * scale));
    const h = Math.max(1, Math.round(canvas.clientHeight * scale));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
  }
  function frame(now) {
    const { lvl, phase, dark } = read();
    level += (lvl - level) * 0.12;
    const target = PALETTE[phase] || PALETTE.listening;
    for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) cur[i][k] += (target[i][k] - cur[i][k]) * 0.04; // colours drift, never jump
    size();
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(u.res, canvas.width, canvas.height);
    gl.uniform1f(u.time, (now - start) / 1000);
    gl.uniform1f(u.lvl, Math.min(1, level));
    gl.uniform1f(u.light, dark ? 1 : 0);
    gl.uniform3fv(u.c1, cur[0]);
    gl.uniform3fv(u.c2, cur[1]);
    gl.uniform3fv(u.c3, cur[2]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    raf = requestAnimationFrame(frame);
  }
  return {
    start() { if (!raf) { start = performance.now(); raf = requestAnimationFrame(frame); } },
    stop() { cancelAnimationFrame(raf); raf = 0; gl.clear(gl.COLOR_BUFFER_BIT); },
  };
}
