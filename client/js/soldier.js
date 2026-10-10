// Skinned, procedurally modelled soldiers (single draw call each) with a camouflage
// shader, full character customization (skin, face, headgear, eyewear, camo, gear, pack)
// and procedural animation: walk/run/crouch/prone, aiming, recoil, freefall/parachute, death.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildGunTP } from './guns.js';
import { WEAPONS } from '/shared/weapons.js';
import { LOOK_OPTS, defaultLook } from '/shared/look.js';

// Factions (team uniforms). `variants` are the four camo patterns selectable in the customizer; they stay within
// the faction's colour family so friend and foe remain recognisable.
export const PALETTES = [
  { name: 'coalition', camo: ['#6f6a4b', '#8e8160', '#4a4835', '#a89a72'], base: 0x726b4e, gear: 0x8b7a58, helmet: 0x7a6e50,
    variants: [['#6f6a4b', '#8e8160', '#4a4835', '#a89a72'], ['#5d6c44', '#80905a', '#3b472b', '#9ca872'], ['#7b7050', '#a39373', '#56492f', '#bcae88'], ['#4f5c4c', '#6f7e68', '#323d33', '#8d9d85']] },
  { name: 'pact', camo: ['#4f5746', '#3a4036', '#626b55', '#2b2f28'], base: 0x4a5142, gear: 0x2d302a, helmet: 0x3b4136,
    variants: [['#4f5746', '#3a4036', '#626b55', '#2b2f28'], ['#4a5a4e', '#33403a', '#5f7164', '#272f2a'], ['#585a48', '#3f4132', '#6c6e58', '#2d2e24'], ['#454c52', '#30363b', '#59626a', '#24292d']] },
  { name: 'urban', camo: ['#5c6066', '#7a7f86', '#3c3f44', '#9a9ea4'], base: 0x5f636a, gear: 0x26282b, helmet: 0x3a3d42,
    variants: [['#5c6066', '#7a7f86', '#3c3f44', '#9a9ea4'], ['#55606c', '#76828e', '#37404a', '#97a3ae'], ['#666462', '#85827e', '#43413f', '#a4a19c'], ['#4c5058', '#6a6f78', '#30343a', '#8a8f98']] },
  { name: 'desert', camo: ['#b59f78', '#8f7a56', '#cdb991', '#6f5d40'], base: 0xae9870, gear: 0x7a6744, helmet: 0x9c8762,
    variants: [['#b59f78', '#8f7a56', '#cdb991', '#6f5d40'], ['#c2a778', '#9a8052', '#d8c598', '#75613f'], ['#a99879', '#85775a', '#c3b595', '#64563e'], ['#b8a083', '#917a5e', '#d0bba0', '#6d5a44']] },
];

const BONES = [
  ['root', -1, [0, 0, 0]], ['hips', 0, [0, 0.98, 0]], ['spine', 1, [0, 1.1, 0]], ['chest', 2, [0, 1.3, 0]], ['neck', 3, [0, 1.52, 0]], ['head', 4, [0, 1.6, 0]],
  ['lUpper', 3, [-0.21, 1.45, 0]], ['lFore', 6, [-0.21, 1.17, 0]], ['lHand', 7, [-0.21, 0.93, 0]],
  ['rUpper', 3, [0.21, 1.45, 0]], ['rFore', 9, [0.21, 1.17, 0]], ['rHand', 10, [0.21, 0.93, 0]],
  ['lThigh', 1, [-0.1, 0.93, 0]], ['lShin', 12, [-0.1, 0.5, 0]], ['lFoot', 13, [-0.1, 0.08, 0]],
  ['rThigh', 1, [0.1, 0.93, 0]], ['rShin', 15, [0.1, 0.5, 0]], ['rFoot', 16, [0.1, 0.08, 0]],
];
const BI = Object.fromEntries(BONES.map((b, i) => [b[0], i]));

// material kinds written into the aCamo attribute
const K = { PLAIN: 0, CAMO: 1, GEAR: 2, HELM: 3, SKIN: 4, METAL: 5, CLOTH: 6 };

const TEMPLATES = new Map();
function getTemplate(look) {
  const key = [look[1], look[2], look[3], look[6], look[0]].join('-'); // face, head, eyes, pack, skin (stubble tint)
  if (!TEMPLATES.has(key)) TEMPLATES.set(key, buildTemplate(look));
  return TEMPLATES.get(key);
}

function buildTemplate(look) {
  const [skinI, faceI, headI, eyesI, , , packI] = look;
  const skinCol = new THREE.Color(LOOK_OPTS.skin.values[skinI]);
  const parts = [];
  // geo is scaled, rotated (x,y,z), then translated, and rigidly bound to one bone
  const add = (geo, bone, color, kind = K.PLAIN, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => {
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    if (sx !== 1 || sy !== 1 || sz !== 1) g.scale(sx, sy, sz);
    g.rotateX(rx); g.rotateY(ry); g.rotateZ(rz);
    g.translate(x, y, z);
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    g.computeVertexNormals();
    const n = g.attributes.position.count;
    const c = new THREE.Color(color);
    const colors = new Float32Array(n * 3), cam = new Float32Array(n), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
    const pos = g.attributes.position;
    for (let i = 0; i < n; i++) {
      // baked ambient occlusion: darker low on the body and in the lower half of every part
      const ao = 0.82 + 0.18 * Math.min(1, Math.max(0, pos.getY(i) / 1.6));
      colors[i * 3] = c.r * ao; colors[i * 3 + 1] = c.g * ao; colors[i * 3 + 2] = c.b * ao; cam[i] = kind;
      si[i * 4] = bone; sw[i * 4] = 1;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.setAttribute('aCamo', new THREE.BufferAttribute(cam, 1));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
    parts.push(g);
  };
  const cap = (r, len, seg = 10) => new THREE.CapsuleGeometry(r, len, 4, seg);
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  const cyl = (rt, rb, h, seg = 12) => new THREE.CylinderGeometry(rt, rb, h, seg);
  const sph = (r, ws = 14, hs = 10, ps = 0, pl = Math.PI * 2, ts = 0, tl = Math.PI) => new THREE.SphereGeometry(r, ws, hs, ps, pl, ts, tl);
  const W = 0xffffff, BOOT = 0x17140f, LACE = 0x6b6558, GLOVE = 0x22201c, DARK = 0x16171a, STRAP = 0x2a2a28, METAL = 0x8a8f94;

  // ---- legs ----
  for (const s of [-1, 1]) {
    const th = s < 0 ? BI.lThigh : BI.rThigh, sh = s < 0 ? BI.lShin : BI.rShin, ft = s < 0 ? BI.lFoot : BI.rFoot;
    add(cap(0.092, 0.3), th, W, K.CAMO, s * 0.1, 0.72, 0, 0, 0, 0, 1, 1, 1.02);
    add(box(0.075, 0.13, 0.06), th, W, K.CAMO, s * 0.19, 0.7, -0.01);                      // cargo pocket
    add(box(0.078, 0.025, 0.066), th, W, K.GEAR, s * 0.19, 0.775, -0.012);                  // pocket flap
    add(cap(0.068, 0.32), sh, W, K.CAMO, s * 0.1, 0.3, 0.005);
    add(box(0.115, 0.1, 0.05), sh, DARK, K.PLAIN, s * 0.1, 0.5, -0.075);                    // knee pad
    add(box(0.12, 0.02, 0.012), sh, STRAP, K.PLAIN, s * 0.1, 0.5, -0.045);
    add(cyl(0.07, 0.066, 0.15, 12), ft, BOOT, K.PLAIN, s * 0.1, 0.165, 0.005);              // boot shaft
    add(box(0.1, 0.075, 0.27), ft, BOOT, K.PLAIN, s * 0.1, 0.082, -0.06);                   // boot body
    add(box(0.108, 0.028, 0.285), ft, 0x0b0a08, K.PLAIN, s * 0.1, 0.018, -0.055);           // sole
    add(box(0.096, 0.045, 0.07), ft, 0x0b0a08, K.PLAIN, s * 0.1, 0.04, 0.07);               // heel
    add(box(0.05, 0.006, 0.11), ft, LACE, K.PLAIN, s * 0.1, 0.12, -0.12);                   // laces
  }
  // ---- pelvis, belt, holster ----
  add(box(0.34, 0.18, 0.22), BI.hips, W, K.CAMO, 0, 0.95, 0, 0, 0, 0, 1, 1, 1);
  add(box(0.375, 0.05, 0.255), BI.hips, 0x1c1d1f, K.GEAR, 0, 1.03, 0);
  add(box(0.04, 0.035, 0.01), BI.hips, METAL, K.METAL, 0, 1.03, -0.13);                    // buckle
  add(box(0.055, 0.15, 0.1), BI.rThigh, DARK, K.GEAR, 0.215, 0.82, 0.02);                   // holster
  add(box(0.03, 0.04, 0.05), BI.rThigh, STRAP, K.PLAIN, 0.215, 0.9, 0.04);
  add(box(0.09, 0.1, 0.08), BI.hips, W, K.GEAR, -0.2, 0.98, 0.07);                         // dump pouch
  // ---- torso ----
  add(box(0.33, 0.28, 0.21), BI.spine, W, K.CAMO, 0, 1.2, 0);
  add(cyl(0.205, 0.175, 0.3, 14), BI.chest, W, K.CAMO, 0, 1.38, 0, 0, 0, 0, 1, 1, 0.74);
  add(cyl(0.09, 0.15, 0.06, 12), BI.chest, W, K.CAMO, 0, 1.52, 0, 0, 0, 0, 1.4, 1, 0.8);   // trapezius slope
  // plate carrier
  add(box(0.3, 0.33, 0.07), BI.chest, W, K.GEAR, 0, 1.34, -0.12);
  add(box(0.3, 0.33, 0.06), BI.chest, W, K.GEAR, 0, 1.34, 0.12);
  for (const s of [-1, 1]) {
    add(box(0.07, 0.24, 0.24), BI.chest, W, K.GEAR, s * 0.185, 1.28, 0);                   // cummerbund
    add(box(0.065, 0.045, 0.27), BI.chest, W, K.GEAR, s * 0.115, 1.5, 0, 0, 0, s * 0.18);  // shoulder straps
    add(sph(0.078, 12, 8), BI.chest, W, K.GEAR, s * 0.215, 1.47, 0.0, 0, 0, 0, 1, 0.8, 1.1); // shoulder armour
  }
  for (let i = 0; i < 4; i++) add(box(0.27, 0.012, 0.012), BI.chest, STRAP, K.PLAIN, 0, 1.4 - i * 0.045, -0.158); // MOLLE rows
  for (const x of [-0.095, 0, 0.095]) {
    add(box(0.078, 0.11, 0.05), BI.chest, 0x24262a, K.GEAR, x, 1.22, -0.17);               // magazine pouches
    add(box(0.08, 0.03, 0.054), BI.chest, 0x1b1d20, K.GEAR, x, 1.285, -0.172);
    add(box(0.04, 0.012, 0.012), BI.chest, METAL, K.METAL, x, 1.285, -0.2);
  }
  add(box(0.14, 0.085, 0.045), BI.chest, 0x24262a, K.GEAR, 0.0, 1.43, -0.168);              // admin pouch
  add(box(0.06, 0.1, 0.05), BI.chest, 0x24262a, K.GEAR, -0.14, 1.4, -0.168);                // radio pouch
  add(box(0.05, 0.03, 0.01), BI.chest, 0x8b2a22, K.PLAIN, 0.1, 1.47, -0.158);               // patch
  // back equipment
  if (packI === 0) { // assault pack
    add(box(0.28, 0.32, 0.13), BI.chest, W, K.GEAR, 0, 1.31, 0.2);
    add(box(0.26, 0.05, 0.12), BI.chest, 0x1b1d20, K.GEAR, 0, 1.48, 0.2);
    for (const s of [-1, 1]) add(box(0.04, 0.2, 0.08), BI.chest, 0x1b1d20, K.GEAR, s * 0.15, 1.28, 0.2);
  } else if (packI === 1) { // radio
    add(box(0.13, 0.22, 0.075), BI.chest, 0x202225, K.GEAR, 0.07, 1.32, 0.19);
    add(cyl(0.006, 0.008, 0.55, 5), BI.chest, 0x111111, K.PLAIN, 0.11, 1.62, 0.2);
    add(box(0.03, 0.12, 0.03), BI.chest, 0x2d2f33, K.PLAIN, -0.04, 1.28, 0.2);
    add(cyl(0.04, 0.04, 0.17, 10), BI.chest, W, K.GEAR, -0.09, 1.27, 0.19, 0, 0, Math.PI / 2);   // hydration roll
  } else if (packI === 3) { // large rucksack with bedroll
    add(box(0.34, 0.44, 0.2), BI.chest, W, K.GEAR, 0, 1.32, 0.25);
    add(cyl(0.065, 0.065, 0.34, 12), BI.chest, W, K.CAMO, 0, 1.56, 0.26, 0, 0, Math.PI / 2);
    for (const s of [-1, 1]) add(box(0.07, 0.2, 0.12), BI.chest, W, K.GEAR, s * 0.2, 1.22, 0.24);
  }
  // ---- neck & head ----
  add(cyl(0.056, 0.066, 0.12, 10), BI.neck, W, K.SKIN, 0, 1.56, 0);
  add(sph(0.1, 18, 14), BI.head, W, K.SKIN, 0, 1.69, -0.004, 0, 0, 0, 0.93, 1.1, 1.0);   // cranium
  add(sph(0.08, 14, 10), BI.head, W, K.SKIN, 0, 1.635, -0.022, 0, 0, 0, 1.0, 0.72, 0.92); // jaw
  for (const s of [-1, 1]) add(sph(0.024, 8, 6), BI.head, W, K.SKIN, s * 0.097, 1.69, 0.0, 0, 0, 0, 0.5, 1, 0.85); // ears
  if (eyesI !== 3) add(new THREE.ConeGeometry(0.017, 0.042, 7), BI.head, W, K.SKIN, 0, 1.672, -0.108, -Math.PI / 2 - 0.35, 0, 0);       // nose
  for (const s of [-1, 1]) {
    add(sph(0.0145, 8, 6), BI.head, 0xeeebe4, K.PLAIN, s * 0.036, 1.7, -0.088);              // eyeball
    add(sph(0.0085, 8, 6), BI.head, 0x2a1d14, K.PLAIN, s * 0.036, 1.7, -0.1);                // iris
    add(box(0.042, 0.008, 0.012), BI.head, 0x2a2018, K.PLAIN, s * 0.036, 1.724, -0.092, 0, 0, s * -0.12); // brow
  }
  add(box(0.04, 0.006, 0.01), BI.head, 0x7a4a42, K.PLAIN, 0, 1.642, -0.097);                 // mouth
  // facial hair
  const stub = skinCol.clone().multiplyScalar(0.55);
  if (faceI === 1) add(sph(0.083, 14, 10), BI.head, stub, K.PLAIN, 0, 1.628, -0.02, 0, 0, 0, 1.02, 0.7, 0.93);
  if (faceI === 2) { add(sph(0.088, 14, 10), BI.head, 0x2b2119, K.PLAIN, 0, 1.62, -0.018, 0, 0, 0, 1.04, 0.85, 0.96); add(box(0.07, 0.07, 0.05), BI.head, 0x2b2119, K.PLAIN, 0, 1.58, -0.07); }
  if (faceI === 3) add(box(0.07, 0.014, 0.022), BI.head, 0x2b2119, K.PLAIN, 0, 1.655, -0.099);
  if (faceI === 4) for (const s of [-1, 1]) add(box(0.016, 0.07, 0.035), BI.head, 0x2b2119, K.PLAIN, s * 0.088, 1.665, -0.03);
  // eyewear
  if (eyesI === 1) { for (const s of [-1, 1]) add(box(0.048, 0.03, 0.006), BI.head, 0x1a2c36, K.PLAIN, s * 0.037, 1.7, -0.106); add(box(0.2, 0.006, 0.006), BI.head, 0x111111, K.PLAIN, 0, 1.715, -0.105); for (const s of [-1, 1]) add(box(0.006, 0.006, 0.09), BI.head, 0x111111, K.PLAIN, s * 0.093, 1.715, -0.06); }
  if (eyesI === 2) { for (const s of [-1, 1]) add(box(0.056, 0.036, 0.007), BI.head, 0x0b0e12, K.PLAIN, s * 0.038, 1.7, -0.108); add(box(0.2, 0.008, 0.008), BI.head, 0x2a2a2a, K.PLAIN, 0, 1.718, -0.106); for (const s of [-1, 1]) add(box(0.007, 0.007, 0.09), BI.head, 0x2a2a2a, K.PLAIN, s * 0.094, 1.718, -0.06); }
  if (eyesI === 3) { add(sph(0.109, 18, 10, 0, Math.PI * 2, Math.PI * 0.53, Math.PI * 0.47), BI.head, 0x15171a, K.CLOTH, 0, 1.69, -0.003, 0, 0, 0, 0.95, 1.02, 1.02); add(cyl(0.07, 0.074, 0.1, 12), BI.neck, 0x15171a, K.CLOTH, 0, 1.57, 0); }
  if (eyesI === 4) { add(box(0.125, 0.05, 0.045), BI.head, 0x181a1c, K.PLAIN, 0, 1.7, -0.108); for (const s of [-1, 1]) add(box(0.048, 0.034, 0.012), BI.head, 0x7a5a24, K.PLAIN, s * 0.036, 1.7, -0.133); add(new THREE.TorusGeometry(0.105, 0.012, 6, 24), BI.head, 0x181a1c, K.PLAIN, 0, 1.7, 0, Math.PI / 2, 0, 0); }
  // headgear
  if (headI === 0 || headI === 1) {
    add(sph(0.127, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.56), BI.head, W, K.CAMO, 0, 1.715, 0.004, 0, 0, 0, 1, 0.98, 1.06);
    add(new THREE.TorusGeometry(0.126, 0.011, 6, 24), BI.head, 0x2a2a28, K.PLAIN, 0, 1.722, 0.004, Math.PI / 2, 0, 0);
    for (const s of [-1, 1]) { add(box(0.012, 0.03, 0.09), BI.head, METAL, K.METAL, s * 0.126, 1.72, 0); add(box(0.008, 0.07, 0.008), BI.head, 0x1b1b1a, K.PLAIN, s * 0.098, 1.645, -0.015); }
    add(box(0.05, 0.035, 0.022), BI.head, METAL, K.METAL, 0, 1.775, -0.128);                  // NVG shroud
    if (headI === 1) { add(box(0.05, 0.03, 0.02), BI.head, 0x1b1d20, K.PLAIN, 0, 1.805, -0.136); for (const s of [-1, 1]) add(cyl(0.02, 0.02, 0.055, 10), BI.head, 0x0f1012, K.PLAIN, s * 0.027, 1.825, -0.15, Math.PI / 2 - 0.7); }
  } else if (headI === 2) { // boonie
    add(cyl(0.1, 0.116, 0.1, 18), BI.head, W, K.CAMO, 0, 1.765, 0.004);
    add(sph(0.1, 14, 6, 0, Math.PI * 2, 0, Math.PI * 0.5), BI.head, W, K.CAMO, 0, 1.815, 0.004);
    add(cyl(0.215, 0.22, 0.012, 24), BI.head, W, K.CAMO, 0, 1.72, 0.004, 0, 0, 0, 1, 1, 1);
    add(new THREE.TorusGeometry(0.113, 0.008, 6, 24), BI.head, 0x2b2b26, K.PLAIN, 0, 1.742, 0.004, Math.PI / 2, 0, 0);
  } else if (headI === 3) { // beanie
    add(sph(0.114, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.6), BI.head, W, K.GEAR, 0, 1.72, 0.004, 0, 0, 0, 1, 1, 1.04);
    add(cyl(0.116, 0.116, 0.045, 18), BI.head, W, K.GEAR, 0, 1.675, 0.004, 0, 0, 0, 1, 1, 1.04);
  } else if (headI === 4) { // bandana
    add(cyl(0.109, 0.109, 0.055, 18), BI.head, W, K.GEAR, 0, 1.727, 0.004, 0, 0, 0, 1, 1, 1.04);
    add(sph(0.108, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.45), BI.head, W, K.GEAR, 0, 1.742, 0.004, 0, 0, 0, 1, 1, 1.04);
    add(box(0.05, 0.05, 0.03), BI.head, W, K.GEAR, 0, 1.72, 0.125, 0.3, 0, 0.5);
    add(box(0.022, 0.09, 0.012), BI.head, W, K.GEAR, 0.02, 1.66, 0.14, 0.2, 0, 0.2); add(box(0.022, 0.08, 0.012), BI.head, W, K.GEAR, -0.02, 1.665, 0.14, 0.2, 0, -0.25);
  } else if (headI === 5) { // cap
    add(sph(0.112, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.52), BI.head, W, K.CAMO, 0, 1.72, 0.004, 0, 0, 0, 1, 1, 1.04);
    add(box(0.15, 0.01, 0.1), BI.head, W, K.CAMO, 0, 1.718, -0.14, 0.15);
  }
  // ---- arms ----
  for (const s of [-1, 1]) {
    const up = s < 0 ? BI.lUpper : BI.rUpper, fo = s < 0 ? BI.lFore : BI.rFore, ha = s < 0 ? BI.lHand : BI.rHand;
    add(cap(0.06, 0.2), up, W, K.CAMO, s * 0.21, 1.31, 0);
    add(cap(0.053, 0.2), fo, W, K.CAMO, s * 0.21, 1.05, 0);
    add(box(0.075, 0.07, 0.065), fo, DARK, K.PLAIN, s * 0.21, 1.17, 0.045);                  // elbow pad
    add(cyl(0.057, 0.055, 0.035, 10), fo, 0x1e1f21, K.GEAR, s * 0.21, 0.94, 0);               // glove cuff
    add(box(0.062, 0.028, 0.085), ha, GLOVE, K.PLAIN, s * 0.21, 0.885, -0.02);               // palm
    add(box(0.064, 0.012, 0.03), ha, 0x131211, K.PLAIN, s * 0.21, 0.9, -0.05);               // knuckle guard
    for (let f = 0; f < 4; f++) add(box(0.014, 0.016, 0.05), ha, GLOVE, K.PLAIN, s * 0.21 + (f - 1.5) * 0.0155, 0.882, -0.09);
    add(box(0.016, 0.016, 0.04), ha, GLOVE, K.PLAIN, s * 0.21 - s * 0.04, 0.89, -0.045, 0, s * 0.5, 0);   // thumb
  }
  const geo = mergeGeometries(parts);
  geo.computeBoundingSphere();
  geo.boundingSphere.radius = 2.2;
  geo.boundingSphere.center.set(0, 1, 0);
  return geo;
}

const matCache = new Map();
function materialFor(pi, camoVar = 0, skinI = 1, gearI = 0) {
  const key = [pi, camoVar, skinI, gearI].join('-');
  if (matCache.has(key)) return matCache.get(key);
  const P = PALETTES[pi % PALETTES.length];
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.0 });
  const camo = P.variants[camoVar % 4].map((c) => new THREE.Color(c));
  const gear = new THREE.Color(LOOK_OPTS.gear.values[gearI % 4]);
  const skin = new THREE.Color(LOOK_OPTS.skin.values[skinI % 6]);
  const helm = camo[0].clone().multiplyScalar(0.8);
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uCamo = { value: camo };
    sh.uniforms.uGear = { value: gear };
    sh.uniforms.uHelm = { value: helm };
    sh.uniforms.uSkin = { value: skin };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aCamo; varying float vCamo; varying vec3 vObj;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCamo = aCamo; vObj = position;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
      varying float vCamo; varying vec3 vObj; uniform vec3 uCamo[4]; uniform vec3 uGear, uHelm, uSkin;
      float hh(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
      float vn(vec3 p){ vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(mix(hh(i), hh(i+vec3(1,0,0)), f.x), mix(hh(i+vec3(0,1,0)), hh(i+vec3(1,1,0)), f.x), f.y),
                   mix(mix(hh(i+vec3(0,0,1)), hh(i+vec3(1,0,1)), f.x), mix(hh(i+vec3(0,1,1)), hh(i+vec3(1,1,1)), f.x), f.y), f.z); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float kind = vCamo;
        if (kind > 1.5 && kind < 2.5) diffuseColor.rgb *= uGear * 2.2 * (0.92 + vn(vObj * 60.0) * 0.16);
        else if (kind > 3.5 && kind < 4.5) {
          // skin: subtle pores + warmer cheeks/lips area
          float pores = vn(vObj * 140.0);
          diffuseColor.rgb = uSkin * (0.93 + pores * 0.1) * mix(vec3(1.0), vec3(1.06, 0.97, 0.95), smoothstep(1.6, 1.72, vObj.y));
        } else if (kind > 5.5) diffuseColor.rgb *= 0.95 + vn(vObj * 90.0) * 0.1;
        if (kind > 0.5 && kind < 1.5) {
          float n1 = vn(vObj * 9.0) * 0.65 + vn(vObj * 23.0) * 0.35;
          float n2 = vn(vObj * 13.0 + 7.3);
          vec3 c = uCamo[0];
          c = mix(c, uCamo[1], step(0.52, n1));
          c = mix(c, uCamo[2], step(0.6, n2));
          c = mix(c, uCamo[3], step(0.7, n1 * 0.6 + n2 * 0.5));
          float weave = 0.9 + vn(vObj * 260.0) * 0.18;   // fabric weave
          diffuseColor.rgb = c * weave;
          if (vObj.y > 1.68) diffuseColor.rgb = mix(c, uHelm, 0.45);
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        if (kind > 3.5 && kind < 4.5) roughnessFactor = 0.52; else if (kind > 4.5 && kind < 5.5) roughnessFactor = 0.35; else if (kind > 1.5 && kind < 2.5) roughnessFactor = 0.68;`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        if (kind > 4.5 && kind < 5.5) metalnessFactor = 0.85;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        if (kind < 3.5 || kind > 5.5) { vec3 nn = vec3(vn(vObj * 170.0), vn(vObj * 170.0 + 3.1), vn(vObj * 170.0 + 7.7)) - 0.5; normal = normalize(normal + nn * 0.22); }`);
  };
  matCache.set(key, mat);
  return mat;
}

// Two-bone IK for arms. Target is in chest space; upper/fore bones hang along -Y at rest.
const L1 = 0.28, L2 = 0.29;
const POLE_R = new THREE.Vector3(1, -1, 0.4).normalize(), POLE_L = new THREE.Vector3(-0.7, -1, 0.2).normalize();
const _d = new THREE.Vector3(), _p = new THREE.Vector3(), _e = new THREE.Vector3(), _q = new THREE.Quaternion(), DOWN = new THREE.Vector3(0, -1, 0);
function solveArm(upper, fore, target, pole) {
  const S = upper.position;
  _d.subVectors(target, S);
  let d = _d.length();
  d = Math.min(d, L1 + L2 - 0.005);
  _d.normalize();
  const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
  _p.copy(pole).addScaledVector(_d, -pole.dot(_d)).normalize();
  _e.copy(_d).multiplyScalar(a).addScaledVector(_p, h); // elbow, relative to shoulder
  upper.quaternion.setFromUnitVectors(DOWN, _e.clone().normalize());
  // forearm direction in the upper arm's local frame
  const toHand = _d.clone().multiplyScalar(d).sub(_e).normalize();
  _q.copy(upper.quaternion).invert();
  fore.quaternion.setFromUnitVectors(DOWN, toHand.applyQuaternion(_q));
}

let BIND_INVERSES = null;
function makeBones() {
  const bones = BONES.map(([name, , p]) => { const b = new THREE.Bone(); b.name = name; b.userData.rest = new THREE.Vector3(...p); return b; });
  BONES.forEach(([, parent, p], i) => {
    if (parent >= 0) {
      const pp = BONES[parent][2];
      bones[i].position.set(p[0] - pp[0], p[1] - pp[1], p[2] - pp[2]);
      bones[parent].add(bones[i]);
    } else bones[i].position.set(...p);
  });
  return bones;
}

export class Soldier {
  constructor(paletteIndex, look = defaultLook()) {
    this.look = look;
    this.bones = makeBones();
    this.b = Object.fromEntries(this.bones.map((b) => [b.name, b]));
    const mesh = new THREE.SkinnedMesh(getTemplate(look), materialFor(paletteIndex, look[4], look[0], look[5]));
    mesh.add(this.bones[0]);
    mesh.updateMatrixWorld(true);
    if (!BIND_INVERSES) {
      const sk = new THREE.Skeleton(this.bones);
      BIND_INVERSES = sk.boneInverses.map((m) => m.clone());
      mesh.bind(sk);
    } else mesh.bind(new THREE.Skeleton(this.bones, BIND_INVERSES.map((m) => m.clone())));
    mesh.castShadow = true;
    mesh.frustumCulled = true;
    this.mesh = mesh;
    this.root = new THREE.Group();
    this.root.add(mesh);
    this.phase = Math.random() * 10;
    this.weaponId = -1;
    this.gun = null;
    this.deathT = -1;
    this.deathDir = Math.random() < 0.5 ? 1 : -1;
    this.chute = null;
    this.recoil = 0;
  }

  setWeapon(id) {
    if (id === this.weaponId) return;
    this.weaponId = id;
    if (this.gun) this.b.chest.remove(this.gun);
    const w = WEAPONS[id];
    if (!w) { this.gun = null; return; }
    this.gun = buildGunTP(w);
    this.gunCat = w.cat;
    if (w.cat === 'launcher') { this.gunRest = new THREE.Vector3(0.14, 0.3, -0.12); this.hands = [new THREE.Vector3(0, -0.1, 0.05), new THREE.Vector3(0, -0.09, -0.22)]; }
    else if (w.cat === 'pistol') { this.gunRest = new THREE.Vector3(0.04, 0.17, -0.46); this.hands = [new THREE.Vector3(0, -0.085, 0.03), new THREE.Vector3(-0.015, -0.095, 0.03)]; }
    else { this.gunRest = new THREE.Vector3(0.1, 0.16, -0.31); this.hands = [new THREE.Vector3(0, -0.085, 0.07), new THREE.Vector3(0, -0.04, -0.17)]; }
    this.gun.position.copy(this.gunRest);
    this.b.chest.add(this.gun);
  }

  // state: { speed, stance, pitch, alive, para, firing, dt, moveAngle }
  animate(s) {
    const b = this.b, dt = s.dt;
    const R = (bone) => bone.rotation;
    for (const bone of this.bones) bone.rotation.set(0, 0, 0);
    b.hips.position.set(0, 0.98, 0);
    b.root.position.set(0, 0, 0);
    this.recoil = Math.max(0, this.recoil - dt * 8);
    if (s.firing && Math.random() < 0.4) this.recoil = 1;
    // arms: rifle-holding pose (relative to chest)
    const holdPose = (low = 0) => {
      if (!this.gun) { R(b.rUpper).set(0.3, 0, 0.1); R(b.lUpper).set(0.3, 0, -0.1); return; }
      this.gun.position.copy(this.gunRest);
      this.gun.position.z += this.recoil * 0.04;
      this.gun.position.y -= low * 0.18; this.gun.position.x += low * 0.04;
      this.gun.rotation.set(-low * 0.7, low * 0.5, 0);
      this.gun.updateMatrix();
      const rT = this.hands[0].clone().applyMatrix4(this.gun.matrix), lT = this.hands[1].clone().applyMatrix4(this.gun.matrix);
      solveArm(b.rUpper, b.rFore, rT, POLE_R);
      solveArm(b.lUpper, b.lFore, lT, POLE_L);
    };
    if (s.alive === false) {
      if (this.deathT < 0) this.deathT = 0;
      this.deathT = Math.min(1, this.deathT + dt * 2.2);
      const k = 1 - (1 - this.deathT) ** 3;
      R(b.root).x = this.deathDir * 1.5 * k;
      b.root.position.y = 0.15 * k;
      R(b.lThigh).x = 0.4 * k; R(b.rThigh).x = 0.9 * k; R(b.lShin).x = -0.8 * k; R(b.rShin).x = -0.4 * k;
      R(b.lUpper).set(0.3 + 1.5 * k, 0, -0.6 * k); R(b.rUpper).set(0.4, 0, 1.2 * k);
      R(b.head).y = 0.6 * k;
      if (this.gun) this.gun.visible = this.deathT < 0.4;
      return;
    }
    this.deathT = -1;
    if (this.gun) this.gun.visible = true;
    if (s.para === 1) {
      R(b.root).x = -1.35; b.root.position.y = 0.9;
      R(b.lUpper).set(0.3, 0, -1.3); R(b.rUpper).set(0.3, 0, 1.3);
      R(b.lThigh).set(-0.2, 0, -0.25); R(b.rThigh).set(-0.2, 0, 0.25); R(b.lShin).x = -0.5; R(b.rShin).x = -0.5;
      R(b.head).x = 1.0;
      if (this.gun) this.gun.visible = false;
      this.showChute(false);
      return;
    }
    if (s.para === 2) {
      R(b.lUpper).set(0, 0, -2.6); R(b.rUpper).set(0, 0, 2.6);
      R(b.lThigh).x = 0.2 + Math.sin(this.phase) * 0.1; R(b.rThigh).x = 0.1; R(b.lShin).x = -0.3; R(b.rShin).x = -0.2;
      this.phase += dt;
      if (this.gun) this.gun.visible = false;
      this.showChute(true);
      return;
    }
    this.showChute(false);
    const spd = s.speed;
    const pitch = s.pitch || 0;
    if (s.stance === 2) {
      // prone
      R(b.root).x = -1.42; b.root.position.set(0, 0.12, 0.85);
      R(b.chest).x = 0.5; R(b.neck).x = 0.4; R(b.head).x = 0.5 + pitch * 0.5;
      holdPose();
      this.phase += spd * dt * 2;
      R(b.lThigh).set(Math.sin(this.phase) * 0.2 * Math.min(1, spd), 0, -0.15); R(b.rThigh).set(-Math.sin(this.phase) * 0.2 * Math.min(1, spd), 0, 0.15);
      R(b.lFoot).x = 0.9; R(b.rFoot).x = 0.9;
      return;
    }
    const crouch = s.stance === 1;
    const run = spd > 5.2;
    const amp = Math.min(1, spd / 4) * (run ? 0.85 : 0.55) * (crouch ? 0.6 : 1);
    this.phase += dt * (spd > 0.2 ? (run ? 9.5 : 7.5) * Math.max(0.6, spd / (run ? 6.5 : 4.2)) : 0);
    const ph = this.phase;
    const sw = Math.sin(ph);
    if (crouch) {
      b.hips.position.y = 0.66;
      R(b.lThigh).x = 1.2 + sw * amp * 0.5; R(b.rThigh).x = 0.7 - sw * amp * 0.5;
      R(b.lShin).x = -1.9 + Math.max(0, -sw) * amp; R(b.rShin).x = -1.1 + Math.max(0, sw) * amp;
      R(b.lFoot).x = 0.6; R(b.rFoot).x = 0.35;
      R(b.spine).x = -0.25;
    } else {
      R(b.lThigh).x = sw * amp; R(b.rThigh).x = -sw * amp;
      R(b.lShin).x = -Math.max(0, Math.sin(ph - 1.4)) * amp * 1.6 - 0.05;
      R(b.rShin).x = -Math.max(0, Math.sin(ph + Math.PI - 1.4)) * amp * 1.6 - 0.05;
      R(b.lFoot).x = Math.max(0, -sw) * amp * 0.4; R(b.rFoot).x = Math.max(0, sw) * amp * 0.4;
      b.hips.position.y = 0.98 - Math.abs(Math.cos(ph)) * 0.035 * amp * 2;
      R(b.spine).x = run ? -0.2 : -0.05;
      R(b.hips).y = sw * 0.08 * amp;
      R(b.spine).y = -sw * 0.1 * amp;
    }
    if (run && !crouch && !s.ads) holdPose(1); // sprinting: weapon at low ready
    // aim: chest/head follow camera pitch
    R(b.chest).x += pitch * 0.55;
    R(b.neck).x = pitch * 0.2;
    R(b.head).x = pitch * 0.25;
    if (!(run && !crouch && !s.ads)) holdPose();
  }

  showChute(on) {
    if (on && !this.chute) {
      const g = new THREE.Group();
      const canopy = new THREE.Mesh(new THREE.SphereGeometry(3.2, 16, 6, 0, Math.PI * 2, 0, Math.PI * 0.35).scale(1.3, 0.6, 1),
        new THREE.MeshStandardMaterial({ color: 0x5d6b45, side: THREE.DoubleSide, roughness: 0.9 }));
      canopy.position.y = 5.5;
      g.add(canopy);
      const lineMat = new THREE.LineBasicMaterial({ color: 0x222222 });
      const pts = [];
      for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; pts.push(new THREE.Vector3(0, 1.6, 0), new THREE.Vector3(Math.cos(a) * 3.3, 6.3, Math.sin(a) * 2.6)); }
      g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), lineMat));
      this.chute = g;
      this.root.add(g);
    }
    if (this.chute) this.chute.visible = on;
  }

  dispose() {
    this.mesh.skeleton.dispose();
  }
}
