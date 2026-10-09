// Vehicle models (tank, IFV, jeep, attack helicopter, jet) and the local
// player's vehicle physics/controls.
import * as THREE from 'three';
import { VEHICLES } from '/shared/protocol.js';
import { trackTex } from './textures.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const TEAM_COLORS = [0x5f6644, 0x4b4f45, 0x7d7356];
let TRACK = null;

function mat(c, metal = 0.35, rough = 0.6) { return new THREE.MeshStandardMaterial({ color: c, metalness: metal, roughness: rough }); }
function bx(w, h, d, m, x = 0, y = 0, z = 0) { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); return o; }
function cy(r1, r2, l, m, seg = 12) { return new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, l, seg), m); }

export function buildVehicle(type, team) {
  const g = new THREE.Group();
  const paint = mat(TEAM_COLORS[team === 255 ? 2 : team % 2], 0.3, 0.65);
  const dark = mat(0x222426, 0.5, 0.5);
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x223344, metalness: 0.2, roughness: 0.05, transparent: true, opacity: 0.55 });
  const parts = { turret: null, barrel: null, rotor: null, tail: null, wheels: [] };
  if (!TRACK) TRACK = trackTex();
  if (type === 'tank' || type === 'ifv') {
    const tank = type === 'tank';
    const L = tank ? 7.8 : 6.8, W = tank ? 3.6 : 3.1, H = tank ? 1.3 : 1.6;
    const hull = bx(W, H, L, paint, 0, 1.0 + H / 2, 0);
    g.add(hull);
    const glacis = bx(W, 0.4, 1.6, paint, 0, 1.0 + H - 0.1, -L / 2 + 0.5); glacis.rotation.x = 0.35; g.add(glacis);
    const trackMat = new THREE.MeshStandardMaterial({ map: TRACK, roughness: 0.9, metalness: 0.2 });
    for (const s of [-1, 1]) {
      const tr = bx(0.7, 1.0, L + 0.3, trackMat, s * (W / 2 + 0.2), 0.55, 0);
      g.add(tr);
      for (let i = 0; i < (tank ? 7 : 6); i++) {
        const wh = cy(0.38, 0.38, 0.72, dark, 14); wh.rotation.z = Math.PI / 2; wh.position.set(s * (W / 2 + 0.2), 0.45, -L / 2 + 0.9 + i * (L - 1.8) / (tank ? 6 : 5));
        g.add(wh);
      }
      g.add(bx(0.6, 0.08, L + 0.4, paint, s * (W / 2 + 0.2), 1.08, 0)); // side skirts
    }
    const turret = new THREE.Group();
    turret.position.set(0, 1.0 + H, tank ? 0.4 : 0.8);
    const tb = bx(tank ? 2.8 : 1.6, tank ? 0.85 : 0.8, tank ? 3.4 : 1.9, paint, 0, 0.42, 0);
    turret.add(tb);
    if (tank) { const front = bx(2.6, 0.7, 0.8, paint, 0, 0.4, -1.9); front.rotation.x = -0.25; turret.add(front); turret.add(bx(2.2, 0.6, 0.8, paint, 0, 0.4, 1.9)); }
    turret.add(bx(0.5, 0.3, 0.5, dark, 0.6, tank ? 1.0 : 0.95, 0.4)); // commander hatch / sight
    const mgun = cy(0.04, 0.04, 1, dark); mgun.rotation.x = Math.PI / 2; mgun.position.set(0.6, tank ? 1.25 : 1.1, -0.2); turret.add(mgun);
    const barrel = new THREE.Group();
    barrel.position.set(0, 0.5, tank ? -1.7 : -0.9);
    const bl = tank ? 5.2 : 2.6;
    const tube = cy(tank ? 0.12 : 0.05, tank ? 0.14 : 0.06, bl, dark); tube.rotation.x = Math.PI / 2; tube.position.z = -bl / 2; barrel.add(tube);
    if (tank) { const ev = cy(0.2, 0.2, 0.7, paint); ev.rotation.x = Math.PI / 2; ev.position.z = -bl * 0.55; barrel.add(ev); }
    const muzzle = new THREE.Object3D(); muzzle.position.z = -bl; barrel.add(muzzle);
    turret.add(barrel);
    g.add(turret);
    parts.turret = turret; parts.barrel = barrel; parts.muzzle = muzzle;
    for (let i = 0; i < 6; i++) g.add(bx(0.5, 0.25, 0.5, mat(0x3a3a2e), (i % 2 ? 1 : -1) * 0.9, 1.0 + H + 0.12, L / 2 - 0.6 - Math.floor(i / 2) * 0.6)); // stowage
  } else if (type === 'jeep') {
    g.add(bx(2.1, 0.7, 4.6, paint, 0, 1.0, 0));
    g.add(bx(2.0, 0.5, 1.6, paint, 0, 1.5, -1.3)); // hood
    g.add(bx(2.05, 0.9, 2.2, paint, 0, 1.75, 0.6)); // cabin
    const ws = bx(1.9, 0.7, 0.05, glass, 0, 1.85, -0.52); ws.rotation.x = -0.3; g.add(ws);
    for (const s of [-1, 1]) g.add(bx(0.05, 0.5, 1.6, glass, s * 1.03, 1.85, 0.5));
    g.add(bx(2.2, 0.25, 0.25, dark, 0, 0.85, -2.35)); // bumper
    const mgMount = cy(0.04, 0.04, 1.2, dark); mgMount.rotation.x = Math.PI / 2; mgMount.position.set(0, 2.55, 0.4); g.add(mgMount);
    g.add(bx(0.15, 0.4, 0.15, dark, 0, 2.3, 0.6));
    for (const [x, z] of [[-1, -1.5], [1, -1.5], [-1, 1.5], [1, 1.5]]) {
      const w = cy(0.45, 0.45, 0.35, dark, 16); w.rotation.z = Math.PI / 2; w.position.set(x * 1.05, 0.45, z); g.add(w); parts.wheels.push(w);
    }
  } else if (type === 'heli') {
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.9, 3.2, 4, 12).rotateX(Math.PI / 2), paint);
    body.scale.set(1, 1.1, 1); body.position.y = 1.9; g.add(body);
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.75, 12, 8).scale(1, 0.9, 1.4), glass); nose.position.set(0, 2.05, -2.0); g.add(nose);
    const can2 = new THREE.Mesh(new THREE.SphereGeometry(0.6, 12, 8).scale(1, 0.8, 1.3), glass); can2.position.set(0, 2.5, -0.9); g.add(can2);
    const boom = cy(0.22, 0.45, 5.5, paint); boom.rotation.x = Math.PI / 2; boom.position.set(0, 2.1, 4.3); g.add(boom);
    g.add(bx(0.12, 1.6, 1.0, paint, 0, 2.7, 6.9)); // fin
    g.add(bx(2.2, 0.08, 0.6, paint, 0, 2.1, 6.2)); // stabilizer
    const tail = new THREE.Group(); tail.position.set(0.15, 2.9, 7.0);
    for (let i = 0; i < 2; i++) { const b = bx(0.04, 1.4, 0.12, dark); b.rotation.x = i * Math.PI / 2; tail.add(b); }
    g.add(tail); parts.tail = tail;
    g.add(bx(0.6, 0.6, 1.2, dark, 0, 3.0, 0.1)); // engine
    const rotor = new THREE.Group(); rotor.position.set(0, 3.45, 0);
    for (let i = 0; i < 4; i++) { const b = bx(0.35, 0.05, 6.6, dark); b.position.z = 3.3; const arm = new THREE.Group(); arm.rotation.y = (i * Math.PI) / 2; arm.add(b); b.position.set(0, 0, 3.3); rotor.add(arm); }
    rotor.add(cy(0.18, 0.18, 0.4, dark));
    const disc = new THREE.Mesh(new THREE.CircleGeometry(6.6, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.12, depthWrite: false }));
    rotor.add(disc);
    g.add(rotor); parts.rotor = rotor;
    for (const s of [-1, 1]) {
      g.add(bx(1.6, 0.12, 0.6, paint, s * 1.5, 1.8, -0.2)); // stub wing
      const pod = cy(0.22, 0.22, 1.4, dark); pod.rotation.x = Math.PI / 2; pod.position.set(s * 2.0, 1.6, -0.3); g.add(pod);
      const skid = cy(0.05, 0.05, 3.6, dark); skid.rotation.x = Math.PI / 2; skid.position.set(s * 0.9, 0.08, 0); g.add(skid);
      g.add(bx(0.06, 0.8, 0.06, dark, s * 0.85, 0.5, -0.8)); g.add(bx(0.06, 0.8, 0.06, dark, s * 0.85, 0.5, 0.9));
    }
    const gun = cy(0.05, 0.05, 1.0, dark); gun.rotation.x = Math.PI / 2; gun.position.set(0, 1.25, -2.4); g.add(gun);
  } else if (type === 'jet') {
    const grey = mat(team === 1 ? 0x5a6066 : 0x7a8088, 0.5, 0.45);
    const body = cy(0.75, 0.9, 11, grey, 16); body.rotation.x = Math.PI / 2; body.position.y = 1.8; g.add(body);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.75, 3, 16).rotateX(-Math.PI / 2), grey); nose.position.set(0, 1.8, -7); g.add(nose);
    const can = new THREE.Mesh(new THREE.SphereGeometry(0.6, 12, 8).scale(1, 0.8, 2.6), glass); can.position.set(0, 2.5, -3.6); g.add(can);
    const wing = new THREE.Shape([new THREE.Vector2(0, -2), new THREE.Vector2(5.5, 2.2), new THREE.Vector2(5.5, 3.2), new THREE.Vector2(0, 3.2)]);
    for (const s of [-1, 1]) {
      const wg = new THREE.Mesh(new THREE.ExtrudeGeometry(wing, { depth: 0.12, bevelEnabled: false }).rotateX(Math.PI / 2), grey);
      wg.scale.x = s; wg.position.set(0, 1.75, 0); g.add(wg);
      const fin = bx(0.1, 2.0, 1.8, grey, s * 0.9, 3.0, 4.6); fin.rotation.z = s * 0.35; g.add(fin);
      const hst = new THREE.Mesh(new THREE.ExtrudeGeometry(new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(2.4, 1.2), new THREE.Vector2(2.4, 1.8), new THREE.Vector2(0, 1.8)]), { depth: 0.08, bevelEnabled: false }).rotateX(Math.PI / 2), grey);
      hst.scale.x = s; hst.position.set(0, 1.8, 4.2); g.add(hst);
      const msl = cy(0.1, 0.1, 2.4, mat(0xdddddd)); msl.rotation.x = Math.PI / 2; msl.position.set(s * 3.2, 1.55, 1.2); g.add(msl);
      g.add(bx(0.08, 0.9, 0.08, dark, s * 1.2, 0.8, 0.5));
    }
    g.add(bx(0.08, 0.9, 0.08, dark, 0, 0.8, -4.5));
    const glow = new THREE.Mesh(new THREE.CircleGeometry(0.65, 16), new THREE.MeshBasicMaterial({ color: 0xff8a3a, transparent: true, opacity: 0.8 }));
    glow.position.set(0, 1.8, 5.52); g.add(glow); parts.glow = glow;
  }
  mergeStatic(g, new Set(parts.wheels));
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return { group: g, parts };
}

// Merge the vehicle's static meshes (direct children) per material to cut draw calls.
function mergeStatic(g, keep) {
  const byMat = new Map();
  for (const o of [...g.children]) {
    if (!o.isMesh || keep.has(o) || o.material.transparent) continue;
    o.updateMatrix();
    const geo = o.geometry.clone().applyMatrix4(o.matrix);
    const ng = geo.index ? geo.toNonIndexed() : geo;
    for (const k of Object.keys(ng.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') ng.deleteAttribute(k);
    if (!ng.attributes.uv) ng.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(ng.attributes.position.count * 2), 2));
    if (!byMat.has(o.material)) byMat.set(o.material, []);
    byMat.get(o.material).push(ng);
    g.remove(o);
  }
  for (const [mat, list] of byMat) g.add(new THREE.Mesh(mergeGeometries(list), mat));
}

// ---------------------------------------------------------------- local control
export class VehicleController {
  constructor(game, id, type, state) {
    this.game = game; this.id = id; this.type = type; this.spec = VEHICLES[type];
    [this.x, this.y, this.z, this.yaw, this.pitch, this.roll] = state;
    this.turret = 0; this.speed = 0; this.vy = 0; this.vx = 0; this.vz = 0;
    this.throttle = type === 'jet' ? 0.6 : 0;
    this.aimYaw = this.yaw; this.aimPitch = 0;
    this.lastMain = 0; this.lastMg = 0;
    this.clip = state[10] || 0;
    this.thirdPerson = true;
    this.engineOn = type !== 'jet' || this.y - game.world.heightAt(this.x, this.z) > 10;
  }

  update(dt, input) {
    const w = this.game.world;
    const t = this.type;
    // camera aim (mouse)
    this.aimYaw -= input.mdx * input.sens;
    this.aimPitch = Math.max(-1.2, Math.min(1.0, this.aimPitch - input.mdy * input.sens));
    if (t === 'tank' || t === 'ifv' || t === 'jeep') {
      const fwd = (input.keys.KeyW ? 1 : 0) - (input.keys.KeyS ? 1 : 0);
      const turn = (input.keys.KeyA ? 1 : 0) - (input.keys.KeyD ? 1 : 0);
      const max = this.spec.speed * (input.keys.ShiftLeft ? 1.15 : 1);
      const target = fwd > 0 ? max : fwd < 0 ? -max * 0.4 : 0;
      this.speed += (target - this.speed) * Math.min(1, dt * (fwd ? 0.9 : 1.6));
      const tr = t === 'jeep' ? 1.4 : 0.85;
      this.yaw += turn * tr * dt * (t === 'jeep' ? Math.min(1, Math.abs(this.speed) / 6) * Math.sign(this.speed || 1) : 1);
      const nx = this.x - Math.sin(this.yaw) * this.speed * dt, nz = this.z - Math.cos(this.yaw) * this.speed * dt;
      const slope = (w.heightAt(nx, nz) - w.heightAt(this.x, this.z)) / Math.max(0.01, Math.abs(this.speed * dt));
      if (w.heightAt(nx, nz) < w.waterLevel - 0.8 || slope > 1.1) this.speed *= -0.2;
      else {
        const p = { x: nx, y: this.y, z: nz };
        w.collide(p, this.spec.radius * 0.75, 2);
        if (Math.hypot(p.x - nx, p.z - nz) > 0.01) this.speed *= 0.6;
        this.x = p.x; this.z = p.z;
      }
      this.y = w.heightAt(this.x, this.z);
      const n = w.normalAt(this.x, this.z);
      const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
      const tp = Math.asin(Math.max(-1, Math.min(1, -(n[0] * fx + n[2] * fz))));
      const tr2 = -Math.asin(Math.max(-1, Math.min(1, n[0] * Math.cos(this.yaw) - n[2] * Math.sin(this.yaw))));
      this.pitch += (tp - this.pitch) * Math.min(1, dt * 8); this.roll += (tr2 - this.roll) * Math.min(1, dt * 8);
      // turret follows camera
      let rel = this.aimYaw - this.yaw;
      rel = Math.atan2(Math.sin(rel), Math.cos(rel));
      let d = rel - this.turret; d = Math.atan2(Math.sin(d), Math.cos(d));
      const ts = t === 'tank' ? 1.1 : 2.0;
      this.turret += Math.max(-ts * dt, Math.min(ts * dt, d));
      if (t === 'jeep') this.turret = rel;
    } else if (t === 'heli') {
      const g = w.heightAt(this.x, this.z);
      const up = (input.keys.Space ? 1 : 0) - (input.keys.KeyC || input.keys.ControlLeft ? 1 : 0) + (input.keys.KeyW && this.y - g < 2 ? 0.5 : 0);
      const fwd = (input.keys.KeyW ? 1 : 0) - (input.keys.KeyS ? 1 : 0);
      const side = (input.keys.KeyD ? 1 : 0) - (input.keys.KeyA ? 1 : 0);
      // nose follows mouse yaw with a rate limit
      let d = this.aimYaw - this.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
      this.yaw += Math.max(-1.6 * dt, Math.min(1.6 * dt, d));
      const ax = (-Math.sin(this.yaw) * fwd + Math.cos(this.yaw) * side) * 22, az = (-Math.cos(this.yaw) * fwd - Math.sin(this.yaw) * side) * 22;
      this.vx += (ax - this.vx * 0.45) * dt; this.vz += (az - this.vz * 0.45) * dt;
      const sp = Math.hypot(this.vx, this.vz);
      if (sp > this.spec.speed) { this.vx *= this.spec.speed / sp; this.vz *= this.spec.speed / sp; }
      this.vy += (up * 12 - this.vy) * Math.min(1, dt * 2);
      this.x += this.vx * dt; this.z += this.vz * dt; this.y += this.vy * dt;
      if (this.y > g + 600) this.y = g + 600;
      const gl = w.groundAt(this.x, this.z, this.y + 1);
      if (this.y < gl) {
        if (this.vy < -9 || sp > 25) return 'crash';
        this.y = gl; this.vy = Math.max(0, this.vy); this.vx *= 0.9; this.vz *= 0.9;
      }
      const lp = this.vx * -Math.sin(this.yaw) + this.vz * -Math.cos(this.yaw);
      const ls = this.vx * Math.cos(this.yaw) - this.vz * Math.sin(this.yaw);
      this.pitch += (-lp / 160 - this.pitch) * Math.min(1, dt * 3);
      this.roll += (-ls / 120 - d * 0.3 - this.roll) * Math.min(1, dt * 3);
      this.speed = sp;
      this.turret = 0;
    } else if (t === 'jet') {
      const thr = (input.keys.KeyW ? 1 : 0) - (input.keys.KeyS ? 1 : 0);
      this.throttle = Math.max(0, Math.min(1, this.throttle + thr * dt * 0.5));
      const g = w.heightAt(this.x, this.z);
      const onGround = this.y - g < 1.5;
      const target = 25 + this.throttle * (this.spec.speed - 25);
      this.speed += (target - this.speed) * dt * 0.35;
      // mouse-aim style: nose chases the camera direction
      let dy = this.aimYaw - this.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      const yawIn = (input.keys.KeyA ? 1 : 0) - (input.keys.KeyD ? 1 : 0);
      const turnRate = 0.9 * Math.min(1, this.speed / 60);
      this.yaw += Math.max(-turnRate * dt, Math.min(turnRate * dt, dy)) + yawIn * 0.3 * dt;
      const dp = this.aimPitch - this.pitch;
      if (!onGround || this.speed > 55) this.pitch += Math.max(-turnRate * dt, Math.min(turnRate * dt, dp));
      if (onGround && this.pitch < 0) this.pitch = 0;
      this.roll += (Math.max(-1.3, Math.min(1.3, -dy * 2.2)) - this.roll) * Math.min(1, dt * 3);
      const lift = Math.min(1, this.speed / 70);
      const cp = Math.cos(this.pitch);
      this.x += -Math.sin(this.yaw) * cp * this.speed * dt;
      this.z += -Math.cos(this.yaw) * cp * this.speed * dt;
      this.y += Math.sin(this.pitch) * this.speed * dt - (1 - lift) * 9.8 * dt;
      const lim = w.half + 300;
      if (Math.abs(this.x) > lim || Math.abs(this.z) > lim) { this.aimYaw = Math.atan2(this.x, this.z); }
      if (this.y < g) {
        if (this.speed > 80 || this.pitch < -0.15 || Math.abs(this.roll) > 0.5) return 'crash';
        this.y = g;
      }
      if (w.groundAt(this.x, this.z, this.y + 2) > this.y + 1) return 'crash';
      this.turret = 0;
    }
    return null;
  }

  state() { return [this.x, this.y, this.z, this.yaw, this.pitch, this.roll, this.turret]; }
}
