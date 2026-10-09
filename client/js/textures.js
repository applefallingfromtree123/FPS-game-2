// Procedurally generated textures (no external assets needed).
import * as THREE from 'three';
import { makeNoise2D, fbm } from '/shared/rng.js';

function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

function toTex(c, { repeat = true, srgb = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

// Periodic (tileable) value noise: lattice wraps every `scale` cells.
const LAT = new Float32Array(4096).map((_, i) => { const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); });
function pnoise(u, v, period, seed) {
  const x = u * period, y = v * period;
  const i = Math.floor(x), j = Math.floor(y);
  const fx = x - i, fy = y - j;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const h = (a, b) => LAT[(((a % period) + period) % period * 131 + (((b % period) + period) % period) * 17 + seed * 911) & 4095];
  const a = h(i, j), b = h(i + 1, j), c = h(i, j + 1), d = h(i + 1, j + 1);
  return (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy) * 2 - 1;
}
function tileNoise(noise, u, v, scale, oct = 4) {
  let s = 0, amp = 1, norm = 0, p = Math.max(1, Math.round(scale));
  for (let o = 0; o < oct; o++) { s += pnoise(u, v, p, o + 1) * amp; norm += amp; amp *= 0.5; p *= 2; }
  return s / norm;
}

// Ground detail: grayscale (~1.0 mean) multiplied with vertex colours
export function groundDetail() {
  const S = 256, c = canvas(S, S), g = c.getContext('2d');
  const img = g.createImageData(S, S);
  const n = makeNoise2D(42);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S;
    const big = tileNoise(n, u, v, 4, 3);
    const small = tileNoise(n, u, v, 24, 2);
    let val = 0.86 + big * 0.18 + small * 0.12;
    if (Math.random() < 0.04) val -= 0.12; // pebbles
    const i = (y * S + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.max(0, Math.min(255, val * 200));
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return toTex(c);
}

export function normalFromHeight(fn, S = 256, strength = 2) {
  const h = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) h[y * S + x] = fn(x / S, y / S);
  const c = canvas(S, S), g = c.getContext('2d');
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const l = h[y * S + ((x - 1 + S) % S)], r = h[y * S + ((x + 1) % S)];
    const u = h[((y - 1 + S) % S) * S + x], d = h[((y + 1) % S) * S + x];
    let nx = (l - r) * strength, ny = (u - d) * strength, nz = 1;
    const len = Math.hypot(nx, ny, nz);
    const i = (y * S + x) * 4;
    img.data[i] = ((nx / len) * 0.5 + 0.5) * 255;
    img.data[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
    img.data[i + 2] = ((nz / len) * 0.5 + 0.5) * 255;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return toTex(c, { srgb: false });
}

export function groundNormal() {
  const n = makeNoise2D(7);
  return normalFromHeight((u, v) => tileNoise(n, u, v, 16, 3) + tileNoise(n, u, v, 48, 2) * 0.4, 256, 6);
}

export function waterNormal() {
  const n = makeNoise2D(99);
  return normalFromHeight((u, v) => tileNoise(n, u, v, 6, 3) * 0.7 + tileNoise(n, u, v, 18, 2) * 0.3, 256, 10);
}

// Building facade: plaster with windows. One tile = 4m x 3.2m
export function facade(style = 0) {
  const W = 256, H = 205, c = canvas(W, H), g = c.getContext('2d');
  g.fillStyle = '#d8d4cc'; g.fillRect(0, 0, W, H);
  const n = makeNoise2D(5 + style);
  const img = g.getImageData(0, 0, W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const v = 0.88 + fbm(n, x / 40, y / 40, 3) * 0.1 + (Math.random() - 0.5) * 0.06 + (y > H - 10 ? -0.12 : 0);
    img.data[i] *= v; img.data[i + 1] *= v; img.data[i + 2] *= v;
  }
  g.putImageData(img, 0, 0);
  // window
  const wx = 72, wy = 50, ww = 112, wh = 96;
  g.fillStyle = '#6b6660'; g.fillRect(wx - 6, wy - 6, ww + 12, wh + 14);
  const grad = g.createLinearGradient(wx, wy, wx + ww, wy + wh);
  grad.addColorStop(0, style === 1 ? '#4a6a80' : '#2a3946'); grad.addColorStop(0.5, '#1a2229'); grad.addColorStop(1, '#3d5363');
  g.fillStyle = grad; g.fillRect(wx, wy, ww, wh);
  g.fillStyle = 'rgba(255,255,255,0.12)'; g.beginPath(); g.moveTo(wx, wy + wh); g.lineTo(wx + ww * 0.5, wy); g.lineTo(wx + ww * 0.65, wy); g.lineTo(wx + ww * 0.15, wy + wh); g.fill();
  g.fillStyle = '#d6d2ca'; g.fillRect(wx + ww / 2 - 3, wy, 6, wh); g.fillRect(wx, wy + wh / 2 - 3, ww, 6);
  g.fillStyle = '#9c968c'; g.fillRect(wx - 10, wy + wh + 6, ww + 20, 8);
  // stains
  g.fillStyle = 'rgba(60,50,40,0.12)';
  for (let k = 0; k < 6; k++) g.fillRect(wx + Math.random() * ww, wy + wh + 12, 3 + Math.random() * 6, 20 + Math.random() * 60);
  return toTex(c);
}

export function corrugated() {
  const W = 128, H = 128, c = canvas(W, H), g = c.getContext('2d');
  for (let x = 0; x < W; x++) {
    const v = 0.75 + 0.25 * Math.sin((x / W) * Math.PI * 16);
    g.fillStyle = `rgb(${200 * v},${200 * v},${200 * v})`; g.fillRect(x, 0, 1, H);
  }
  g.fillStyle = 'rgba(90,60,30,0.25)';
  for (let k = 0; k < 30; k++) g.fillRect(Math.random() * W, Math.random() * H, 2 + Math.random() * 4, 6 + Math.random() * 30);
  return toTex(c);
}

export function sandbagTex() {
  const W = 128, H = 128, c = canvas(W, H), g = c.getContext('2d');
  g.fillStyle = '#b8a27a'; g.fillRect(0, 0, W, H);
  for (let row = 0; row < 4; row++) {
    for (let col = -1; col < 3; col++) {
      const x = col * 64 + (row % 2) * 32, y = row * 32;
      const grd = g.createRadialGradient(x + 32, y + 16, 4, x + 32, y + 16, 34);
      grd.addColorStop(0, '#c9b48c'); grd.addColorStop(1, '#6d5c40');
      g.fillStyle = grd; g.beginPath(); g.ellipse(x + 32, y + 16, 31, 15, 0, 0, Math.PI * 2); g.fill();
    }
  }
  return toTex(c);
}

export function concreteTex() {
  const W = 128, c = canvas(W, W), g = c.getContext('2d');
  const n = makeNoise2D(3);
  const img = g.createImageData(W, W);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const v = 150 + tileNoise(n, x / W, y / W, 8, 3) * 40 + (Math.random() - 0.5) * 20;
    const i = (y * W + x) * 4; img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v * 0.97; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return toTex(c);
}

export function woodTex() {
  const W = 128, c = canvas(W, W), g = c.getContext('2d');
  g.fillStyle = '#8a6a44'; g.fillRect(0, 0, W, W);
  for (let y = 0; y < W; y += 32) {
    g.fillStyle = '#5a4128'; g.fillRect(0, y, W, 2);
    for (let k = 0; k < 20; k++) { g.fillStyle = `rgba(60,40,20,${Math.random() * 0.3})`; g.fillRect(0, y + Math.random() * 30, W, 1); }
  }
  return toTex(c);
}

export function roofTex() {
  const W = 128, c = canvas(W, W), g = c.getContext('2d');
  g.fillStyle = '#7a3a2a'; g.fillRect(0, 0, W, W);
  for (let y = 0; y < W; y += 16) for (let x = 0; x < W; x += 16) {
    const s = 0.8 + Math.random() * 0.3;
    g.fillStyle = `rgb(${130 * s},${60 * s},${44 * s})`; g.fillRect(x + ((y / 16) % 2) * 8, y, 15, 14);
    g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(x + ((y / 16) % 2) * 8, y + 13, 15, 2);
  }
  return toTex(c);
}

export function trackTex() {
  const W = 64, H = 128, c = canvas(W, H), g = c.getContext('2d');
  g.fillStyle = '#222'; g.fillRect(0, 0, W, H);
  for (let y = 0; y < H; y += 12) { g.fillStyle = '#3a3a3a'; g.fillRect(0, y, W, 7); g.fillStyle = '#4a4a4a'; g.fillRect(4, y + 2, W - 8, 2); }
  return toTex(c);
}

export function radialSprite(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)', size = 64) {
  const c = canvas(size, size), g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, inner); grd.addColorStop(1, outer);
  g.fillStyle = grd; g.fillRect(0, 0, size, size);
  return toTex(c, { repeat: false });
}

export function smokeSprite() {
  const S = 128, c = canvas(S, S), g = c.getContext('2d');
  const n = makeNoise2D(11);
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = x / S - 0.5, dy = y / S - 0.5;
    const r = Math.hypot(dx, dy) * 2;
    const v = fbm(n, x / 24, y / 24, 4) * 0.5 + 0.5;
    const a = Math.max(0, 1 - r) ** 1.5 * (0.5 + v * 0.8);
    const i = (y * S + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = 255 * (0.75 + v * 0.25);
    img.data[i + 3] = Math.min(255, a * 255);
  }
  g.putImageData(img, 0, 0);
  return toTex(c, { repeat: false });
}

export function flashSprite() {
  const S = 128, c = canvas(S, S), g = c.getContext('2d');
  g.translate(S / 2, S / 2);
  const grd = g.createRadialGradient(0, 0, 0, 0, 0, S / 2);
  grd.addColorStop(0, 'rgba(255,255,230,1)'); grd.addColorStop(0.2, 'rgba(255,200,90,0.9)'); grd.addColorStop(1, 'rgba(255,120,20,0)');
  g.fillStyle = grd;
  for (let k = 0; k < 7; k++) {
    g.rotate((Math.PI * 2) / 7 + Math.random() * 0.3);
    g.beginPath(); g.moveTo(0, -6); g.lineTo(S * (0.3 + Math.random() * 0.2), 0); g.lineTo(0, 6); g.fill();
  }
  g.beginPath(); g.arc(0, 0, S * 0.18, 0, Math.PI * 2); g.fill();
  return toTex(c, { repeat: false });
}
