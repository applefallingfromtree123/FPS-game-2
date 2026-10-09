// Procedural weapon models for 112 weapons (first-person and third-person),
// plus first-person arms.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const M = {};
function mats() {
  if (M.metal) return M;
  M.metal = new THREE.MeshStandardMaterial({ color: 0x141517, metalness: 0.55, roughness: 0.42, envMapIntensity: 0.6 });
  M.metal2 = new THREE.MeshStandardMaterial({ color: 0x232427, metalness: 0.45, roughness: 0.55, envMapIntensity: 0.6 });
  M.tones = [
    new THREE.MeshStandardMaterial({ color: 0x18191b, metalness: 0.1, roughness: 0.65 }),
    new THREE.MeshStandardMaterial({ color: 0xa08a64, metalness: 0.05, roughness: 0.7 }),
    new THREE.MeshStandardMaterial({ color: 0x4d5739, metalness: 0.05, roughness: 0.7 }),
    new THREE.MeshStandardMaterial({ color: 0x6a3f22, metalness: 0.0, roughness: 0.55 }),
  ];
  M.glass = new THREE.MeshPhysicalMaterial({ color: 0x6fa8c8, metalness: 0, roughness: 0.05, transparent: true, opacity: 0.35, transmission: 0 });
  M.dot = new THREE.MeshBasicMaterial({ color: 0xff2a1a });
  M.holo = new THREE.MeshBasicMaterial({ color: 0xff3a2a, transparent: true, opacity: 0.9 });
  M.launcher = new THREE.MeshStandardMaterial({ color: 0x4a5236, metalness: 0.2, roughness: 0.6 });
  M.warhead = new THREE.MeshStandardMaterial({ color: 0x3d4430, metalness: 0.3, roughness: 0.5 });
  M.brass = new THREE.MeshStandardMaterial({ color: 0xb08d3a, metalness: 0.9, roughness: 0.3 });
  return M;
}

function box(w, h, d, mat, x = 0, y = 0, z = 0) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); return m; }
function cyl(r1, r2, len, mat, x = 0, y = 0, z = 0, seg = 12) { const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, len, seg).rotateX(Math.PI / 2), mat); m.position.set(x, y, z); return m; }

// Returns { group, muzzle, sightY, mag, length, eject }
export function buildGun(w, opts = {}) {
  const m = mats();
  const fp = !!opts.fp;
  const L = w.look;
  const g = new THREE.Group();
  const body = m.tones[L.tone];
  const sight = opts.sight || w.sight;
  const muzzleType = opts.muzzle || w.muzzleDefault;
  let recLen = 0.3, barLen = 0.32, recH = 0.085, recW = 0.058, barR = 0.011;
  const cat = w.cat;
  if (cat === 'smg') { recLen = 0.22; barLen = 0.12; }
  if (cat === 'carbine') { recLen = 0.28; barLen = 0.22; }
  if (cat === 'lmg') { recLen = 0.4; barLen = 0.42; recH = 0.1; recW = 0.07; barR = 0.014; }
  if (cat === 'dmr') { recLen = 0.34; barLen = 0.42; }
  if (cat === 'sniper') { recLen = 0.36; barLen = 0.58; barR = 0.013; }
  if (cat === 'shotgun') { recLen = 0.3; barLen = 0.42; barR = 0.016; }
  if (cat === 'pistol') { recLen = 0.19; barLen = 0.0; recH = 0.05; recW = 0.032; }
  recLen *= L.body; barLen *= L.barrel;
  let mag = null;
  let front = -recLen / 2;
  let muzzleZ;
  if (cat === 'launcher') return buildLauncher(w, g, m);
  if (cat === 'pistol') {
    g.add(box(recW, recH, recLen, m.metal, 0, 0, -recLen / 2 + 0.04));
    g.add(box(recW * 0.9, 0.03, recLen * 0.8, body, 0, -0.035, -recLen / 2 + 0.05));
    const grip = box(0.03, 0.11, 0.045, body, 0, -0.085, 0.02); grip.rotation.x = 0.25; g.add(grip);
    mag = box(0.024, 0.02, 0.035, m.metal2, 0, -0.14, 0.03); g.add(mag);
    g.add(box(0.006, 0.012, 0.006, m.metal, 0, 0.031, -recLen + 0.05)); // front sight
    g.add(box(0.02, 0.012, 0.006, m.metal, 0, 0.031, 0.02)); // rear sight
    muzzleZ = -recLen + 0.03;
    const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.0, muzzleZ); g.add(muzzle);
    if (muzzleType === 'suppressor') g.add(cyl(0.016, 0.016, 0.14, m.metal2, 0, 0, muzzleZ - 0.07));
    return finish(g, { muzzle, sightY: 0.037, mag, length: recLen, fp });
  }
  const bullpup = L.bullpup;
  // receiver
  const rec = box(recW, recH, recLen, bullpup ? body : m.metal, 0, 0.0, 0);
  g.add(rec);
  // upper rail
  if (L.rail || sight !== 'iron') {
    g.add(box(0.026, 0.012, recLen * 0.95, m.metal2, 0, recH / 2 + 0.006, 0));
    if (fp) for (let i = 0; i < 10; i++) g.add(box(0.03, 0.004, 0.006, m.metal2, 0, recH / 2 + 0.013, -recLen / 2 + 0.02 + i * recLen * 0.095));
  }
  // handguard + barrel
  const hgLen = cat === 'smg' ? 0.12 : cat === 'lmg' ? 0.28 : 0.24 * L.barrel;
  const hgZ = front - hgLen / 2 + 0.01;
  if (cat !== 'shotgun' || L.rail) {
    g.add(box(recW * 0.95, recH * 0.75, hgLen, cat === 'sniper' ? body : m.metal2, 0, -0.005, hgZ));
    if (L.rail && fp) { g.add(box(0.012, 0.008, hgLen * 0.9, m.metal, recW / 2, 0, hgZ)); g.add(box(0.012, 0.008, hgLen * 0.9, m.metal, -recW / 2, 0, hgZ)); }
  }
  const barStart = front - hgLen;
  const bLen = Math.max(0.05, barLen - hgLen * 0.3);
  g.add(cyl(barR, barR, bLen, m.metal, 0, 0, barStart - bLen / 2 + 0.02));
  muzzleZ = barStart - bLen + 0.02;
  if (cat === 'shotgun') {
    g.add(cyl(0.014, 0.014, bLen * 0.85, m.metal2, 0, -0.03, barStart - bLen * 0.42));
    g.add(box(0.05, 0.045, 0.14, body, 0, -0.035, barStart + 0.02)); // pump
  }
  // muzzle device
  if (muzzleType === 'suppressor') { g.add(cyl(0.02, 0.02, 0.17, m.metal2, 0, 0, muzzleZ - 0.085)); muzzleZ -= 0.17; }
  else if (muzzleType === 'comp') { g.add(box(0.03, 0.03, 0.05, m.metal, 0, 0, muzzleZ - 0.025)); muzzleZ -= 0.05; }
  else { g.add(cyl(barR * 1.4, barR * 1.4, 0.05, m.metal, 0, 0, muzzleZ - 0.025)); muzzleZ -= 0.05; }
  // front sight post / gas block
  g.add(box(0.016, 0.03, 0.02, m.metal, 0, 0.02, barStart + 0.03));
  if (sight === 'iron') g.add(box(0.004, 0.022, 0.004, m.metal, 0, 0.048, barStart + 0.03));
  // pistol grip
  const gripZ = bullpup ? -recLen * 0.15 : recLen * 0.18;
  const grip = box(0.03, 0.1, 0.045, body, 0, -recH / 2 - 0.045, gripZ); grip.rotation.x = 0.3; g.add(grip);
  // trigger guard
  g.add(box(0.008, 0.008, 0.06, m.metal, 0, -recH / 2 - 0.02, gripZ - 0.04));
  // magazine
  const magZ = bullpup ? recLen * 0.3 : -recLen * 0.18;
  if (cat === 'lmg' && w.mag >= 100) {
    mag = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.1, 0.11), m.launcher); mag.position.set(-0.02, -recH / 2 - 0.05, magZ);
  } else if (cat === 'sniper' || cat === 'shotgun') {
    mag = box(0.03, 0.04, 0.07, m.metal2, 0, -recH / 2 - 0.02, magZ);
  } else if (L.mag === 2 && cat !== 'smg') {
    mag = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.05, 16).rotateZ(Math.PI / 2), m.metal2); mag.position.set(0, -recH / 2 - 0.07, magZ);
  } else {
    const mh = cat === 'smg' ? 0.15 : 0.17;
    mag = box(0.026, mh, 0.06, L.tone === 3 ? m.metal2 : body, 0, -recH / 2 - mh / 2 + 0.01, magZ);
    if (L.mag === 1 || L.tone === 3) mag.rotation.x = -0.25;
  }
  g.add(mag);
  // stock
  const rear = recLen / 2;
  if (!bullpup && cat !== 'smg' || cat === 'smg' && L.stock !== 2) {
    if (L.stock === 0 || cat === 'sniper' || L.tone === 3) {
      const st = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.095, 0.2), body);
      st.position.set(0, -0.025, rear + 0.1); g.add(st);
      g.add(box(0.042, 0.115, 0.02, m.tones[0], 0, -0.03, rear + 0.205));
    } else {
      g.add(cyl(0.012, 0.012, 0.18, m.metal2, 0, 0.0, rear + 0.09));
      g.add(box(0.04, 0.11, 0.06, body, 0, -0.03, rear + 0.16));
      g.add(box(0.01, 0.07, 0.16, body, 0, -0.04, rear + 0.08));
    }
  }
  // foregrip / bipod
  if (L.grip && cat !== 'sniper' && cat !== 'shotgun') g.add(box(0.025, 0.07, 0.03, m.tones[0], 0, -recH / 2 - 0.04, hgZ - hgLen * 0.15));
  if (cat === 'lmg' || cat === 'sniper') {
    const leg1 = box(0.008, 0.008, 0.16, m.metal, 0.015, -0.03, barStart + 0.02 - 0.08); leg1.rotation.y = 0.1;
    const leg2 = box(0.008, 0.008, 0.16, m.metal, -0.015, -0.03, barStart + 0.02 - 0.08); leg2.rotation.y = -0.1;
    g.add(leg1, leg2);
  }
  if (cat === 'lmg') g.add(box(0.02, 0.04, 0.12, m.metal, 0, recH / 2 + 0.03, -0.05)); // carry handle
  // charging handle / ejection port detail
  if (fp) { g.add(box(0.004, 0.02, 0.05, m.metal2, recW / 2 + 0.002, 0.01, -0.02)); g.add(box(0.012, 0.01, 0.02, m.metal, recW / 2 + 0.004, 0.025, recLen / 2 - 0.03)); }
  // optics
  let sightY = recH / 2 + 0.02;
  const top = recH / 2 + 0.012;
  const sz = -0.02;
  if (sight === 'red') {
    g.add(box(0.03, 0.012, 0.04, m.metal, 0, top + 0.006, sz));
    g.add(cyl(0.017, 0.017, 0.055, m.metal, 0, top + 0.032, sz));
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.0012, 6, 6), m.dot); dot.position.set(0, top + 0.032, sz - 0.02); g.add(dot);
    g.add(new THREE.Mesh(new THREE.CircleGeometry(0.014, 16), m.glass).translateY(top + 0.032).translateZ(sz - 0.026));
    sightY = top + 0.032;
  } else if (sight === 'holo') {
    g.add(box(0.044, 0.014, 0.075, m.metal, 0, top + 0.007, sz));
    g.add(box(0.004, 0.036, 0.06, m.metal, 0.02, top + 0.03, sz)); g.add(box(0.004, 0.036, 0.06, m.metal, -0.02, top + 0.03, sz));
    g.add(box(0.044, 0.004, 0.06, m.metal, 0, top + 0.05, sz));
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.0035, 0.0045, 24), m.holo); ring.position.set(0, top + 0.03, sz - 0.03); g.add(ring);
    const d = new THREE.Mesh(new THREE.CircleGeometry(0.0007, 8), m.holo); d.position.set(0, top + 0.03, sz - 0.03); g.add(d);
    g.add(new THREE.Mesh(new THREE.PlaneGeometry(0.036, 0.03), m.glass).translateY(top + 0.03).translateZ(sz - 0.025));
    sightY = top + 0.03;
  } else if (sight === 'x2' || sight === 'acog') {
    g.add(box(0.03, 0.02, 0.05, m.metal, 0, top + 0.01, sz));
    g.add(cyl(0.02, 0.024, 0.14, m.metal, 0, top + 0.04, sz - 0.01));
    g.add(new THREE.Mesh(new THREE.CircleGeometry(0.02, 16), m.glass).translateY(top + 0.04).translateZ(sz - 0.081));
    sightY = top + 0.04;
  } else if (sight === 'scope') {
    g.add(box(0.025, 0.02, 0.03, m.metal, 0, top + 0.01, sz + 0.06)); g.add(box(0.025, 0.02, 0.03, m.metal, 0, top + 0.01, sz - 0.08));
    g.add(cyl(0.019, 0.019, 0.26, m.metal, 0, top + 0.042, sz - 0.01));
    g.add(cyl(0.031, 0.02, 0.08, m.metal, 0, top + 0.042, sz - 0.16));
    g.add(cyl(0.02, 0.026, 0.06, m.metal, 0, top + 0.042, sz + 0.13));
    g.add(new THREE.Mesh(new THREE.CircleGeometry(0.03, 16), m.glass).translateY(top + 0.042).translateZ(sz - 0.2));
    sightY = top + 0.042;
  } else {
    g.add(box(0.022, 0.018, 0.012, m.metal, 0, recH / 2 + 0.02, recLen / 2 - 0.03)); // rear aperture
    sightY = recH / 2 + 0.03;
  }
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0, muzzleZ); g.add(muzzle);
  return finish(g, { muzzle, sightY, mag, length: recLen + barLen, fp, eject: new THREE.Vector3(recW / 2, 0.02, -0.02) });
}

function buildLauncher(w, g, m) {
  let muzzle = new THREE.Object3D();
  let sightY = 0.08;
  if (w.name === 'M32 MGL') {
    g.add(cyl(0.05, 0.05, 0.12, m.metal2, 0, -0.02, -0.05, 6));
    g.add(cyl(0.022, 0.022, 0.3, m.metal, 0, 0.0, -0.25));
    g.add(box(0.03, 0.1, 0.045, m.tones[0], 0, -0.08, 0.05));
    g.add(box(0.035, 0.08, 0.2, m.tones[0], 0, -0.02, 0.2));
    g.add(box(0.01, 0.04, 0.02, m.metal, 0, 0.05, -0.05));
    muzzle.position.set(0, 0, -0.4); sightY = 0.06;
  } else {
    const len = w.name === 'Carl Gustaf' ? 1.1 : w.name === 'Javelin' ? 1.2 : w.name === 'Stinger' ? 1.5 : 1.0;
    const r = w.name === 'Javelin' ? 0.07 : w.name === 'Carl Gustaf' ? 0.055 : 0.045;
    g.add(cyl(r, r, len, m.launcher, 0, 0, -len / 2 + 0.35, 16));
    if (w.name === 'RPG-7') {
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.3, 12).rotateX(-Math.PI / 2), m.warhead); head.position.set(0, 0, -len + 0.35 - 0.2); g.add(head);
      g.add(cyl(0.045, 0.045, 0.1, m.warhead, 0, 0, -len + 0.35 - 0.03));
      g.add(cyl(0.06, 0.06, 0.2, m.tones[3], 0, 0, -0.1));
    }
    if (w.name === 'Javelin') g.add(box(0.14, 0.12, 0.2, m.launcher, -0.1, 0.05, -0.05));
    g.add(box(0.03, 0.1, 0.045, m.tones[0], 0, -r - 0.05, 0.05));
    g.add(box(0.03, 0.09, 0.04, m.tones[0], 0, -r - 0.04, -0.25));
    g.add(box(0.03, 0.05, 0.08, m.metal, -0.035, r + 0.03, -0.1));
    muzzle.position.set(0, 0, -len + 0.3);
    sightY = r + 0.05;
  }
  g.add(muzzle);
  return finish(g, { muzzle, sightY, mag: null, length: 1, fp: true });
}

function finish(g, info) {
  g.traverse((o) => { if (o.isMesh) { o.castShadow = !info.fp; o.receiveShadow = false; } });
  return { group: g, ...info };
}

// Third-person low-cost version: one merged mesh with baked vertex colours (1 draw call)
const tpCache = new Map();
let TP_MAT = null;
export function buildGunTP(w) {
  if (!TP_MAT) TP_MAT = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.35 });
  if (!tpCache.has(w.id)) {
    const full = buildGun(w, { fp: false });
    const list = [];
    full.group.updateMatrixWorld(true);
    full.group.traverse((o) => {
      if (!o.isMesh || o.material.transparent || o.material.isMeshBasicMaterial) return;
      const geo = o.geometry.clone().applyMatrix4(o.matrixWorld);
      const g2 = geo.index ? geo.toNonIndexed() : geo;
      for (const k of Object.keys(g2.attributes)) if (k !== 'position' && k !== 'normal') g2.deleteAttribute(k);
      const c = o.material.color;
      const n = g2.attributes.position.count;
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
      g2.setAttribute('color', new THREE.BufferAttribute(col, 3));
      list.push(g2);
    });
    tpCache.set(w.id, mergeGeometries(list));
  }
  const mesh = new THREE.Mesh(tpCache.get(w.id), TP_MAT);
  mesh.castShadow = true;
  return mesh;
}

// First-person arms (sleeves + gloves) attached to the gun
export function buildArms(palette) {
  const g = new THREE.Group();
  const sleeve = new THREE.MeshStandardMaterial({ color: palette.base, roughness: 0.85 });
  const glove = new THREE.MeshStandardMaterial({ color: 0x2a2620, roughness: 0.7 });
  const cuff = new THREE.MeshStandardMaterial({ color: palette.gear, roughness: 0.8 });
  const limb = (from, to, r1, r2, mat) => {
    const dir = new THREE.Vector3().subVectors(to, from);
    const len = dir.length();
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r2, r1, len, 10), mat);
    m.position.copy(from).addScaledVector(dir, 0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    return m;
  };
  const hand = (pos, mat) => {
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.09, 0.095), mat);
    h.position.copy(pos);
    return h;
  };
  g.userData.build = (rightHand, leftHand) => {
    while (g.children.length) g.remove(g.children[0]);
    const rElbow = new THREE.Vector3(rightHand.x + 0.11, rightHand.y - 0.14, rightHand.z + 0.2);
    const rShoulder = new THREE.Vector3(rightHand.x + 0.2, rightHand.y - 0.3, rightHand.z + 0.5);
    const lElbow = new THREE.Vector3(leftHand.x - 0.1, leftHand.y - 0.16, leftHand.z + 0.22);
    const lShoulder = new THREE.Vector3(leftHand.x - 0.2, leftHand.y - 0.32, leftHand.z + 0.55);
    g.add(limb(rElbow, rightHand, 0.042, 0.036, sleeve), limb(rShoulder, rElbow, 0.05, 0.045, sleeve));
    g.add(limb(lElbow, leftHand, 0.042, 0.036, sleeve), limb(lShoulder, lElbow, 0.05, 0.045, sleeve));
    g.add(limb(rightHand.clone().add(new THREE.Vector3(0.0, -0.03, 0.06)), rightHand.clone().add(new THREE.Vector3(0, -0.02, 0.1)), 0.04, 0.04, cuff));
    g.add(hand(rightHand, glove), hand(leftHand, glove));
    g.traverse((o) => { if (o.isMesh) o.castShadow = false; });
  };
  return g;
}
