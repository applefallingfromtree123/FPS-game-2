// Realistic foliage: alpha-tested leaf/needle card textures, card-cluster tree crowns with outward-facing
// (volumetric) normals, shrubs and rocks. Everything is generated procedurally (no external assets).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Rng } from '/shared/rng.js';

function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function tex(c, srgb = true) { const t = new THREE.CanvasTexture(c); t.anisotropy = 8; if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; return t; }

// Greyscale leaf cluster; the vertex colour tints it per biome.
export function leafTexture() {
  const S = 256, c = canvas(S, S), g = c.getContext('2d');
  const r = new Rng(31);
  g.clearRect(0, 0, S, S);
  const leaf = (x, y, len, ang, shade) => {
    g.save(); g.translate(x, y); g.rotate(ang);
    const grd = g.createLinearGradient(0, -len / 2, 0, len / 2);
    grd.addColorStop(0, `rgb(${shade + 30},${shade + 30},${shade + 30})`); grd.addColorStop(1, `rgb(${shade - 35},${shade - 35},${shade - 35})`);
    g.fillStyle = grd;
    g.beginPath(); g.moveTo(0, -len / 2); g.bezierCurveTo(len * 0.42, -len * 0.18, len * 0.38, len * 0.25, 0, len / 2); g.bezierCurveTo(-len * 0.38, len * 0.25, -len * 0.42, -len * 0.18, 0, -len / 2); g.fill();
    g.strokeStyle = `rgba(0,0,0,0.28)`; g.lineWidth = 1; g.beginPath(); g.moveTo(0, -len / 2); g.lineTo(0, len / 2); g.stroke();
    g.restore();
  };
  // dense scatter: darker leaves behind, lighter in front
  for (let i = 0; i < 190; i++) leaf(r.float(8, S - 8), r.float(8, S - 8), r.float(22, 44), r.float(0, 6.28), r.int(120, 175));
  for (let i = 0; i < 150; i++) leaf(r.float(8, S - 8), r.float(8, S - 8), r.float(20, 38), r.float(0, 6.28), r.int(170, 235));
  // soften edges slightly to avoid aliasing with alphaTest
  return tex(c);
}

// A fir/pine branch: central stem with fine needles.
export function needleTexture() {
  const W = 128, H = 256, c = canvas(W, H), g = c.getContext('2d');
  const r = new Rng(77);
  g.clearRect(0, 0, W, H);
  g.strokeStyle = 'rgb(110,100,90)'; g.lineWidth = 3; g.beginPath(); g.moveTo(W / 2, H - 2); g.lineTo(W / 2, 4); g.stroke();
  for (let y = H - 10; y > 6; y -= 1.3) {
    const t = y / H, len = 14 + (W / 2 - 18) * Math.min(1, (1 - t) * 1.6 + 0.2) * (0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, (1 - t) * 1.1)));
    for (const s of [-1, 1]) {
      const shade = r.int(120, 235);
      g.strokeStyle = `rgb(${shade},${shade},${shade})`; g.lineWidth = r.float(1.0, 1.7);
      g.beginPath(); g.moveTo(W / 2, y); g.lineTo(W / 2 + s * len * r.float(0.8, 1.05), y - len * 0.45 * r.float(0.7, 1.2)); g.stroke();
    }
  }
  return tex(c);
}

export function barkTexture() {
  const W = 64, H = 128, c = canvas(W, H), g = c.getContext('2d');
  const r = new Rng(5);
  g.fillStyle = '#7a6a58'; g.fillRect(0, 0, W, H);
  for (let i = 0; i < 90; i++) { const x = r.float(0, W), w = r.float(1, 4), v = r.int(40, 120); g.fillStyle = `rgba(${v},${v * 0.85},${v * 0.7},${r.float(0.25, 0.6)})`; g.fillRect(x, 0, w, H); }
  for (let i = 0; i < 40; i++) { g.fillStyle = `rgba(20,14,8,${r.float(0.1, 0.35)})`; g.fillRect(r.float(0, W), r.float(0, H), r.float(1, 3), r.float(8, 30)); }
  const t = tex(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
}

const col = (a) => new THREE.Color(a[0], a[1], a[2]);

// plane card (w x h) placed at pos with quaternion q; vertex normals point from `center` (volumetric shading)
function card(w, h, pos, q, tint, center, nBlend = 0.8, up = false) {
  const g = new THREE.PlaneGeometry(w, h);
  g.applyQuaternion(q); g.translate(pos.x, pos.y, pos.z);
  const p = g.attributes.position, n = new Float32Array(p.count * 3), c = new Float32Array(p.count * 3);
  const flat = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  const v = new THREE.Vector3(), o = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.set(p.getX(i), p.getY(i), p.getZ(i));
    o.copy(v).sub(center).normalize();
    if (up) o.y = Math.abs(o.y) * 0.6 + 0.6;
    o.lerp(flat, 1 - nBlend).normalize();
    n[i * 3] = o.x; n[i * 3 + 1] = o.y; n[i * 3 + 2] = o.z;
    // inner parts of the crown are darker (cheap ambient occlusion)
    const d = Math.min(1, v.distanceTo(center) / 3.2);
    const ao = 0.72 + 0.28 * d;
    c[i * 3] = tint.r * ao; c[i * 3 + 1] = tint.g * ao; c[i * 3 + 2] = tint.b * ao;
  }
  g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

function colorize(g, color, jitter = 0, r = null) {
  g = g.index ? g.toNonIndexed() : g;
  const p = g.attributes.position, c = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    const ao = 0.6 + 0.4 * Math.min(1, y / 1.8); // darker at the ground
    const v = (r ? 0.85 + r.next() * 0.3 : 1) * ao;
    c[i * 3] = color.r * v; c[i * 3 + 1] = color.g * v; c[i * 3 + 2] = color.b * v;
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) g.deleteAttribute(k);
  void jitter;
  return g;
}

const rq = (r) => new THREE.Quaternion().setFromEuler(new THREE.Euler(r.float(-1.2, 1.2), r.float(0, 6.28), r.float(-1.2, 1.2)));

// returns { bark, leaf, lo, needles } geometries for one tree type
export function buildTree(type, foliage) {
  const r = new Rng(type.split('').reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7));
  const leafCol = col(foliage);
  const barkCol = type === 'birch' ? new THREE.Color(0.82, 0.8, 0.74) : new THREE.Color(0.55, 0.45, 0.36);
  const bark = [], leaf = [];
  const trunk = (r1, r2, len, y, x = 0, z = 0, tiltX = 0, tiltZ = 0, c = barkCol) => {
    const g = new THREE.CylinderGeometry(r1, r2, len, 8, 3, true); g.rotateZ(tiltZ); g.rotateX(tiltX); g.translate(x, y, z);
    // bark UVs repeat along the trunk
    const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2, uv.getY(i) * len * 0.5);
    const gg = colorize(g, c, 0, r);
    bark.push(gg);
  };
  let needles = false;
  let lo;
  const loCol = (g, c) => { const n = g.attributes.position.count, a = new Float32Array(n * 3); for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; } g.setAttribute('color', new THREE.BufferAttribute(a, 3)); g.deleteAttribute('uv'); return g; };

  if (type === 'pine' || type === 'snowpine') {
    needles = true;
    trunk(0.1, 0.32, 9.5, 4.75);
    const tiers = 8;
    for (let k = 0; k < tiers; k++) {
      const y = 1.8 + k * 1.05, rad = 2.7 - k * 0.3, n = Math.max(6, 11 - k);
      for (let j = 0; j < n; j++) {
        const a = (j / n) * Math.PI * 2 + k * 0.5 + r.float(-0.15, 0.15);
        const droop = 0.55 - k * 0.025 + r.float(-0.1, 0.1);
        const len = rad * r.float(0.85, 1.15);
        const dir = new THREE.Vector3(Math.cos(a), -Math.sin(droop), Math.sin(a)).normalize();
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        const pos = new THREE.Vector3(Math.cos(a) * len * 0.5 * Math.cos(droop), y - Math.sin(droop) * len * 0.5 + r.float(-0.08, 0.08), Math.sin(a) * len * 0.5 * Math.cos(droop));
        const tint = leafCol.clone().multiplyScalar(1.25 + r.next() * 0.35);
        if (type === 'snowpine' && k > 1) tint.lerp(new THREE.Color(0.92, 0.95, 1), 0.38 + k * 0.03);
        leaf.push(card(1.5, len * 1.15, pos, q, tint, new THREE.Vector3(0, y - 0.2, 0), 0.45, true));
        // cross card for volume
        const q2 = q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2));
        if (k % 2 === 0) leaf.push(card(1.2, len * 1.0, pos, q2, tint, new THREE.Vector3(0, y - 0.2, 0), 0.45, true));
      }
    }
    lo = new THREE.ConeGeometry(2.5, 10, 6).translate(0, 6, 0);
  } else if (type === 'oak' || type === 'jungle' || type === 'birch') {
    trunk(0.2, 0.4, 5.2, 2.6);
    trunk(0.07, 0.17, 3.0, 4.6, 0.9, 0, 0, 0.7); trunk(0.07, 0.16, 3.0, 4.7, -0.8, 0.2, 0, -0.65); trunk(0.06, 0.14, 2.6, 5.0, 0.1, -0.8, 0.6, 0);
    const cards = type === 'jungle' ? 60 : type === 'birch' ? 38 : 48;
    const cy = type === 'jungle' ? 8.2 : 6.6, rx = type === 'birch' ? 1.7 : 2.4, ry = type === 'birch' ? 2.4 : 1.9;
    const center = new THREE.Vector3(0, cy, 0);
    for (let i = 0; i < cards; i++) {
      const u = r.float(-1, 1), a = r.float(0, 6.28), s = Math.sqrt(1 - u * u), rr = Math.cbrt(r.next());
      const pos = new THREE.Vector3(Math.cos(a) * s * rx * rr, cy + u * ry * rr, Math.sin(a) * s * rx * rr);
      const size = r.float(1.7, 2.7);
      const tint = leafCol.clone().multiplyScalar(1.1 + r.next() * 0.4);
      leaf.push(card(size, size, pos, rq(r), tint, center, 0.85));
    }
    lo = new THREE.IcosahedronGeometry(3.2, 0).translate(0, cy, 0);
  } else if (type === 'palm') {
    let x = 0, y = 0;
    for (let k = 0; k < 6; k++) { trunk(0.17, 0.23, 1.6, y + 0.8, x, 0, 0, -0.06 * k, new THREE.Color(0.5, 0.4, 0.3)); x += 0.08 * k; y += 1.55; }
    needles = true;
    for (let k = 0; k < 9; k++) {
      const a = (k / 9) * Math.PI * 2 + r.float(-0.2, 0.2);
      const dir = new THREE.Vector3(Math.cos(a), r.float(0.1, 0.55), Math.sin(a)).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().add(new THREE.Vector3(0, 0.3, 0)).normalize());
      const len = r.float(3.4, 4.4);
      const pos = new THREE.Vector3(x + dir.x * len * 0.45, y + dir.y * len * 0.4 - 0.1 * len * 0.3, dir.z * len * 0.45);
      leaf.push(card(2.1, len, pos, q, leafCol.clone().multiplyScalar(0.9 + r.next() * 0.35), new THREE.Vector3(x, y - 0.5, 0), 0.4, true));
    }
    lo = new THREE.ConeGeometry(2.5, 3, 5).translate(0.5, 9, 0);
  } else if (type === 'acacia') {
    trunk(0.14, 0.3, 4.6, 2.3, 0, 0, 0, 0.12);
    trunk(0.07, 0.14, 2.4, 4.8, 0.9, 0, 0, 0.8); trunk(0.07, 0.14, 2.4, 4.8, -0.9, 0, 0, -0.8);
    const center = new THREE.Vector3(0, 5.4, 0);
    for (let i = 0; i < 34; i++) {
      const a = r.float(0, 6.28), rr = Math.sqrt(r.next()) * 3.4;
      const pos = new THREE.Vector3(Math.cos(a) * rr, 5.4 + r.float(-0.35, 0.5) * (1 - rr / 3.8), Math.sin(a) * rr);
      const size = r.float(1.6, 2.4);
      leaf.push(card(size, size, pos, new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2 + r.float(-0.35, 0.35), r.float(0, 6.28), r.float(-0.3, 0.3))), leafCol.clone().multiplyScalar(0.8 + r.next() * 0.4), center, 0.5, true));
    }
    lo = new THREE.SphereGeometry(3.6, 6, 3).scale(1, 0.35, 1).translate(0, 5.3, 0);
  } else { // dead
    trunk(0.1, 0.32, 6.5, 3.25, 0, 0, 0, 0, new THREE.Color(0.28, 0.24, 0.21));
    for (let k = 0; k < 7; k++) { const a = r.float(0, 6.28), t = r.float(0.5, 1.1); trunk(0.03, 0.09, 2.6, r.float(2.8, 5.8), Math.cos(a) * 0.6, Math.sin(a) * 0.6, Math.sin(a) * t, -Math.cos(a) * t, new THREE.Color(0.28, 0.24, 0.21)); }
    lo = new THREE.CylinderGeometry(0.1, 0.3, 6, 4).translate(0, 3, 0);
  }
  const loC = type === 'dead' ? new THREE.Color(0.25, 0.21, 0.19) : type === 'snowpine' ? leafCol.clone().lerp(new THREE.Color(0.9, 0.92, 0.95), 0.4) : leafCol.clone().multiplyScalar(0.8);
  const loG = loCol(lo.index ? lo.toNonIndexed() : lo, loC); loG.computeVertexNormals();
  return { bark: bark.length ? mergeGeometries(bark) : null, leaf: leaf.length ? mergeGeometries(leaf) : null, lo: loG, needles };
}

// Low shrub: a squat cluster of leaf cards.
export function buildBush(foliage) {
  const r = new Rng(909), leaf = [];
  const center = new THREE.Vector3(0, 0.55, 0), c = col(foliage);
  for (let i = 0; i < 16; i++) {
    const a = r.float(0, 6.28), rr = Math.sqrt(r.next()) * 0.7;
    const pos = new THREE.Vector3(Math.cos(a) * rr, 0.35 + r.float(0, 0.7), Math.sin(a) * rr);
    leaf.push(card(r.float(0.7, 1.1), r.float(0.7, 1.1), pos, rq(r), c.clone().multiplyScalar(0.8 + r.next() * 0.4), center, 0.8));
  }
  return mergeGeometries(leaf);
}

// Small boulder: noisy, flattened icosahedron with grey-brown vertex colours.
export function buildRock(rockColor) {
  const r = new Rng(404);
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.attributes.position;
  const c = new Float32Array(p.count * 3), base = col(rockColor);
  const seen = new Map();
  for (let i = 0; i < p.count; i++) {
    const key = p.getX(i).toFixed(3) + p.getY(i).toFixed(3) + p.getZ(i).toFixed(3);
    if (!seen.has(key)) seen.set(key, 0.72 + r.next() * 0.5);
    const k = seen.get(key);
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 0.65, p.getZ(i) * k);
    const sh = 0.7 + r.next() * 0.35 + Math.max(0, p.getY(i)) * 0.15;
    c[i * 3] = base.r * sh; c[i * 3 + 1] = base.g * sh; c[i * 3 + 2] = base.b * sh;
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  g.deleteAttribute('uv');
  const out = g.toNonIndexed(); out.computeVertexNormals();
  return out;
}
