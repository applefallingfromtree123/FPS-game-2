// Skinned, procedurally modelled soldiers (single draw call each) with a
// camouflage shader and procedural animation: walk/run/crouch/prone, aiming,
// recoil, freefall/parachute and death falls.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildGunTP } from './guns.js';
import { WEAPONS } from '/shared/weapons.js';

export const PALETTES = [
  { name: 'coalition', camo: ['#6f6a4b', '#8e8160', '#4a4835', '#a89a72'], base: 0x726b4e, gear: 0x8b7a58, helmet: 0x7a6e50, skin: 0xc79a7a },
  { name: 'pact', camo: ['#4f5746', '#3a4036', '#626b55', '#2b2f28'], base: 0x4a5142, gear: 0x2d302a, helmet: 0x3b4136, skin: 0xd2a88a },
  { name: 'urban', camo: ['#5c6066', '#7a7f86', '#3c3f44', '#9a9ea4'], base: 0x5f636a, gear: 0x26282b, helmet: 0x3a3d42, skin: 0xb88a6a },
  { name: 'desert', camo: ['#b59f78', '#8f7a56', '#cdb991', '#6f5d40'], base: 0xae9870, gear: 0x7a6744, helmet: 0x9c8762, skin: 0x8f6448 },
];

const BONES = [
  ['root', -1, [0, 0, 0]], ['hips', 0, [0, 0.98, 0]], ['spine', 1, [0, 1.1, 0]], ['chest', 2, [0, 1.3, 0]], ['neck', 3, [0, 1.52, 0]], ['head', 4, [0, 1.6, 0]],
  ['lUpper', 3, [-0.21, 1.45, 0]], ['lFore', 6, [-0.21, 1.17, 0]], ['lHand', 7, [-0.21, 0.93, 0]],
  ['rUpper', 3, [0.21, 1.45, 0]], ['rFore', 9, [0.21, 1.17, 0]], ['rHand', 10, [0.21, 0.93, 0]],
  ['lThigh', 1, [-0.1, 0.93, 0]], ['lShin', 12, [-0.1, 0.5, 0]], ['lFoot', 13, [-0.1, 0.08, 0]],
  ['rThigh', 1, [0.1, 0.93, 0]], ['rShin', 15, [0.1, 0.5, 0]], ['rFoot', 16, [0.1, 0.08, 0]],
];
const BI = Object.fromEntries(BONES.map((b, i) => [b[0], i]));

let TEMPLATE = null;

function buildTemplate() {
  const parts = [];
  const add = (geo, bone, color, camo = 0, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    g.rotateX(rx); g.rotateY(ry); g.rotateZ(rz);
    g.translate(x, y, z);
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    const n = g.attributes.position.count;
    const c = new THREE.Color(color);
    const colors = new Float32Array(n * 3), cam = new Float32Array(n), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b; cam[i] = camo;
      si[i * 4] = bone; sw[i * 4] = 1;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.setAttribute('aCamo', new THREE.BufferAttribute(cam, 1));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
    parts.push(g);
  };
  const cap = (r, len, seg = 8) => new THREE.CapsuleGeometry(r, len, 3, seg);
  // material kinds: 0 = vertex colour, 1 = camo, 2 = gear (team colour), 3 = helmet, 4 = skin
  const BOOT = 0x2a2219, GLOVE = 0x24211c, DARK = 0x1a1a1a, STRAP = 0x3a3428;
  // legs
  for (const s of [-1, 1]) {
    const th = s < 0 ? BI.lThigh : BI.rThigh, sh = s < 0 ? BI.lShin : BI.rShin, ft = s < 0 ? BI.lFoot : BI.rFoot;
    add(cap(0.088, 0.3), th, 0xffffff, 1, s * 0.1, 0.72, 0);
    add(cap(0.07, 0.32), sh, 0xffffff, 1, s * 0.1, 0.3, 0.005);
    add(new THREE.BoxGeometry(0.11, 0.1, 0.07), sh, DARK, 0, s * 0.1, 0.5, -0.06); // knee pad
    add(new THREE.BoxGeometry(0.075, 0.11, 0.12), th, 0xffffff, 2, s * 0.18, 0.72, 0.0); // thigh pouch
    add(new THREE.BoxGeometry(0.11, 0.1, 0.27), ft, BOOT, 0, s * 0.1, 0.05, -0.05);
    add(new THREE.CylinderGeometry(0.07, 0.065, 0.12, 8), ft, BOOT, 0, s * 0.1, 0.13, 0);
  }
  // pelvis & torso
  add(new THREE.BoxGeometry(0.34, 0.2, 0.22), BI.hips, 0xffffff, 1, 0, 0.95, 0);
  add(new THREE.BoxGeometry(0.36, 0.05, 0.24), BI.hips, STRAP, 0, 0, 1.03, 0); // belt
  add(new THREE.BoxGeometry(0.33, 0.28, 0.21), BI.spine, 0xffffff, 1, 0, 1.2, 0);
  add(new THREE.BoxGeometry(0.4, 0.28, 0.24), BI.chest, 0xffffff, 1, 0, 1.38, 0);
  // plate carrier
  add(new THREE.BoxGeometry(0.35, 0.33, 0.29), BI.chest, 0xffffff, 2, 0, 1.33, 0.0);
  for (let i = -1; i <= 1; i++) add(new THREE.BoxGeometry(0.09, 0.12, 0.06), BI.chest, 0xffffff, 2, i * 0.1, 1.24, -0.18); // mag pouches
  add(new THREE.BoxGeometry(0.14, 0.08, 0.05), BI.chest, 0xffffff, 2, 0.0, 1.42, -0.175); // admin pouch
  add(new THREE.BoxGeometry(0.26, 0.3, 0.12), BI.chest, 0xffffff, 2, 0, 1.31, 0.2); // backpack
  add(new THREE.CylinderGeometry(0.006, 0.006, 0.4, 4), BI.chest, DARK, 0, 0.1, 1.6, 0.25); // antenna
  add(new THREE.BoxGeometry(0.1, 0.06, 0.18), BI.chest, 0xffffff, 2, 0.21, 1.47, 0); // shoulder pads
  add(new THREE.BoxGeometry(0.1, 0.06, 0.18), BI.chest, 0xffffff, 2, -0.21, 1.47, 0);
  // neck & head
  add(new THREE.CylinderGeometry(0.055, 0.065, 0.12, 8), BI.neck, 0xffffff, 4, 0, 1.56, 0);
  add(new THREE.SphereGeometry(0.105, 14, 12).scale(0.92, 1.12, 1.0), BI.head, 0xffffff, 4, 0, 1.69, -0.005);
  add(new THREE.ConeGeometry(0.016, 0.04, 6).rotateX(-Math.PI / 2 - 0.3), BI.head, 0xffffff, 4, 0, 1.675, -0.112); // nose
  for (const s of [-1, 1]) add(new THREE.SphereGeometry(0.012, 8, 6), BI.head, 0x1b1712, 0, s * 0.036, 1.705, -0.093); // eyes
  add(new THREE.BoxGeometry(0.08, 0.012, 0.02), BI.head, 0x2a211a, 0, 0, 1.728, -0.095); // brow shadow
  add(new THREE.BoxGeometry(0.13, 0.035, 0.03).translate(0, 0, 0), BI.head, 0x15181b, 0, 0, 1.79, -0.11); // goggles on helmet
  add(new THREE.SphereGeometry(0.135, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), BI.head, 0xffffff, 1, 0, 1.72, 0.0);
  add(new THREE.TorusGeometry(0.128, 0.012, 6, 20).rotateX(Math.PI / 2), BI.head, 0xffffff, 3, 0, 1.735, 0);
  add(new THREE.BoxGeometry(0.05, 0.05, 0.03), BI.head, DARK, 0, 0, 1.8, -0.125); // NVG mount
  for (const s of [-1, 1]) add(new THREE.CylinderGeometry(0.04, 0.04, 0.035, 10).rotateZ(Math.PI / 2), BI.head, DARK, 0, s * 0.105, 1.69, 0.0); // headset
  // arms
  for (const s of [-1, 1]) {
    const up = s < 0 ? BI.lUpper : BI.rUpper, fo = s < 0 ? BI.lFore : BI.rFore, ha = s < 0 ? BI.lHand : BI.rHand;
    add(cap(0.06, 0.2), up, 0xffffff, 1, s * 0.21, 1.31, 0);
    add(cap(0.052, 0.2), fo, 0xffffff, 1, s * 0.21, 1.05, 0);
    add(new THREE.BoxGeometry(0.055, 0.09, 0.08), ha, GLOVE, 0, s * 0.21, 0.885, -0.01);
  }
  const geo = mergeGeometries(parts);
  geo.computeBoundingSphere();
  geo.boundingSphere.radius = 2.2;
  geo.boundingSphere.center.set(0, 1, 0);
  TEMPLATE = geo;
}

const matCache = new Map();
function materialFor(pi) {
  if (matCache.has(pi)) return matCache.get(pi);
  const P = PALETTES[pi % PALETTES.length];
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.0 });
  const camo = P.camo.map((c) => new THREE.Color(c));
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uCamo = { value: camo };
    sh.uniforms.uGear = { value: new THREE.Color(P.gear) };
    sh.uniforms.uHelm = { value: new THREE.Color(P.helmet) };
    sh.uniforms.uSkin = { value: new THREE.Color(P.skin) };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aCamo; varying float vCamo; varying vec3 vObj;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCamo = aCamo; vObj = position;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
      varying float vCamo; varying vec3 vObj; uniform vec3 uCamo[4]; uniform vec3 uGear, uHelm, uSkin;
      float hh(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
      float vn(vec3 p){ vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(mix(hh(i), hh(i+vec3(1,0,0)), f.x), mix(hh(i+vec3(0,1,0)), hh(i+vec3(1,1,0)), f.x), f.y),
                   mix(mix(hh(i+vec3(0,0,1)), hh(i+vec3(1,0,1)), f.x), mix(hh(i+vec3(0,1,1)), hh(i+vec3(1,1,1)), f.x), f.y), f.z); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        if (vCamo > 1.5 && vCamo < 2.5) diffuseColor.rgb = uGear * (0.9 + vn(vObj * 40.0) * 0.2);
        else if (vCamo > 2.5 && vCamo < 3.5) diffuseColor.rgb = uHelm;
        else if (vCamo > 3.5) diffuseColor.rgb = uSkin * (0.92 + vn(vObj * 60.0) * 0.12);
        if (vCamo > 0.5 && vCamo < 1.5) {
          float n1 = vn(vObj * 9.0) * 0.65 + vn(vObj * 23.0) * 0.35;
          float n2 = vn(vObj * 13.0 + 7.3);
          vec3 c = uCamo[0];
          c = mix(c, uCamo[1], step(0.52, n1));
          c = mix(c, uCamo[2], step(0.6, n2));
          c = mix(c, uCamo[3], step(0.7, n1 * 0.6 + n2 * 0.5));
          float fabric = 0.9 + vn(vObj * 220.0) * 0.18;
          diffuseColor.rgb = mix(diffuseColor.rgb, c, 1.0) * fabric;
          if (vObj.y > 1.68) diffuseColor.rgb = mix(c, uHelm, 0.5);
        }`);
  };
  matCache.set(pi, mat);
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
  constructor(paletteIndex) {
    if (!TEMPLATE) buildTemplate();
    this.bones = makeBones();
    this.b = Object.fromEntries(this.bones.map((b) => [b.name, b]));
    const mesh = new THREE.SkinnedMesh(TEMPLATE, materialFor(paletteIndex));
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
