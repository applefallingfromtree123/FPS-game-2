// Visual effects: GPU particle system (fire/smoke/dust/blood/sparks),
// tracers, muzzle flashes, explosions, bullet decals, projectiles, wrecks.
import * as THREE from 'three';
import * as TX from './textures.js';

class Particles {
  constructor(scene, max, texture, blending) {
    this.max = max; this.n = 0;
    this.pos = new Float32Array(max * 3); this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4); this.size = new Float32Array(max); this.life = new Float32Array(max); this.maxLife = new Float32Array(max);
    this.grow = new Float32Array(max); this.drag = new Float32Array(max); this.grav = new Float32Array(max); this.fade = new Float32Array(max); this.rot = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    this.aRot = new THREE.BufferAttribute(this.rot, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos); g.setAttribute('color', this.aCol); g.setAttribute('size', this.aSize); g.setAttribute('rot', this.aRot);
    g.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { map: { value: texture }, uScale: { value: 600 } }]),
      fog: true, transparent: true, depthWrite: false, blending,
      vertexShader: `
        #include <common>
        #include <fog_pars_vertex>
        #include <logdepthbuf_pars_vertex>
        attribute float size; attribute vec4 color; attribute float rot; uniform float uScale; varying vec4 vC; varying float vR;
        void main(){ vC = color; vR = rot; vec4 mvPosition = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mvPosition;
          gl_PointSize = size * uScale / max(0.1, -mvPosition.z);
          #include <logdepthbuf_vertex>
          #include <fog_vertex>
        }`,
      fragmentShader: `
        #include <common>
        #include <fog_pars_fragment>
        #include <logdepthbuf_pars_fragment>
        uniform sampler2D map; varying vec4 vC; varying float vR;
        void main(){
          #include <logdepthbuf_fragment>
          vec2 uv = gl_PointCoord - 0.5; float c = cos(vR), s = sin(vR); uv = vec2(c*uv.x - s*uv.y, s*uv.x + c*uv.y) + 0.5;
          vec4 t = texture2D(map, uv); gl_FragColor = t * vC; if (gl_FragColor.a < 0.01) discard;
          #include <fog_fragment>
        }`,
    });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
    this.mat = mat;
    scene.add(this.points);
  }

  emit(x, y, z, vx, vy, vz, size, r, g, b, a, life, { grow = 0, drag = 0, grav = 0, fade = 1 } = {}) {
    let i = this.n;
    if (i >= this.max) { i = Math.floor(Math.random() * this.max); } else this.n++;
    this.pos.set([x, y, z], i * 3); this.vel.set([vx, vy, vz], i * 3); this.col.set([r, g, b, a], i * 4);
    this.size[i] = size; this.life[i] = life; this.maxLife[i] = life; this.grow[i] = grow; this.drag[i] = drag; this.grav[i] = grav; this.fade[i] = a; this.rot[i] = Math.random() * 6.28;
  }

  update(dt, scale) {
    this.mat.uniforms.uScale.value = scale;
    let n = this.n;
    for (let i = 0; i < n; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        n--;
        if (i !== n) {
          this.pos.copyWithin(i * 3, n * 3, n * 3 + 3); this.vel.copyWithin(i * 3, n * 3, n * 3 + 3); this.col.copyWithin(i * 4, n * 4, n * 4 + 4);
          for (const arr of [this.size, this.life, this.maxLife, this.grow, this.drag, this.grav, this.fade, this.rot]) arr[i] = arr[n];
          i--;
        }
        continue;
      }
      const d = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i * 3] *= d; this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * d - this.grav[i] * dt; this.vel[i * 3 + 2] *= d;
      this.pos[i * 3] += this.vel[i * 3] * dt; this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt; this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] += this.grow[i] * dt;
      this.rot[i] += dt * 0.3;
      const k = this.life[i] / this.maxLife[i];
      this.col[i * 4 + 3] = this.fade[i] * Math.min(1, k * 2.5);
    }
    this.n = n;
    this.points.geometry.setDrawRange(0, n);
    this.aPos.needsUpdate = true; this.aCol.needsUpdate = true; this.aSize.needsUpdate = true; this.aRot.needsUpdate = true;
  }
}

export class FX {
  constructor(scene, camera) {
    this.scene = scene; this.camera = camera;
    this.smoke = new Particles(scene, 3000, TX.smokeSprite(), THREE.NormalBlending);
    this.fire = new Particles(scene, 2500, TX.radialSprite('rgba(255,240,200,1)', 'rgba(255,120,20,0)'), THREE.AdditiveBlending);
    this.flashTex = TX.flashSprite();
    // tracers
    this.tracers = [];
    const tg = new THREE.BoxGeometry(0.035, 0.035, 1);
    this.tracerMat = new THREE.MeshBasicMaterial({ color: 0xffd28a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
    for (let i = 0; i < 150; i++) {
      const m = new THREE.Mesh(tg, this.tracerMat); m.visible = false; m.frustumCulled = false; scene.add(m);
      this.tracers.push({ mesh: m, life: 0 });
    }
    // muzzle flash sprites
    this.flashes = [];
    for (let i = 0; i < 40; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.flashTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      s.visible = false; scene.add(s); this.flashes.push({ s, life: 0 });
    }
    this.light = new THREE.PointLight(0xffb060, 0, 18, 2); scene.add(this.light); this.lightLife = 0;
    this.boomLight = new THREE.PointLight(0xff9040, 0, 120, 1.6); scene.add(this.boomLight); this.boomLife = 0;
    // bullet decals
    const dTex = TX.radialSprite('rgba(20,18,15,0.95)', 'rgba(20,18,15,0)', 32);
    this.decalMat = new THREE.MeshBasicMaterial({ map: dTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
    this.decals = []; this.decalIdx = 0;
    const dg = new THREE.PlaneGeometry(0.12, 0.12);
    for (let i = 0; i < 160; i++) { const m = new THREE.Mesh(dg, this.decalMat); m.visible = false; scene.add(m); this.decals.push(m); }
    this.projectiles = new Map();
    this.wrecks = [];
    this.shake = 0;
  }

  tracer(from, to, speed = 700, color = null) {
    const t = this.tracers.find((q) => q.life <= 0) || this.tracers[Math.floor(Math.random() * this.tracers.length)];
    const dir = new THREE.Vector3().subVectors(to, from);
    const dist = dir.length();
    if (dist < 1) return;
    dir.normalize();
    t.from = from.clone(); t.dir = dir; t.dist = dist; t.speed = speed; t.t = 0; t.life = dist / speed + 0.02;
    t.len = Math.min(dist, Math.max(2, speed * 0.012));
    t.mesh.scale.set(1, 1, t.len);
    t.mesh.lookAt(t.mesh.position.clone().add(dir));
    t.mesh.visible = true;
    if (color) t.mesh.material = new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    else t.mesh.material = this.tracerMat;
  }

  muzzleFlash(pos, size = 0.5, light = false) {
    const f = this.flashes.find((q) => q.life <= 0) || this.flashes[0];
    f.s.position.copy(pos); f.s.scale.setScalar(size * (0.7 + Math.random() * 0.6)); f.s.material.rotation = Math.random() * 6.28;
    f.s.visible = true; f.life = 0.045;
    if (light) { this.light.position.copy(pos); this.light.intensity = 30; this.lightLife = 0.05; }
    this.smoke.emit(pos.x, pos.y, pos.z, (Math.random() - 0.5) * 0.4, 0.4, (Math.random() - 0.5) * 0.4, 0.25, 0.8, 0.8, 0.8, 0.15, 0.6, { grow: 0.8, drag: 1 });
  }

  impact(pos, normal, kind) {
    // kind: 1 flesh, 2 terrain/building, 3 vehicle
    if (kind === 1) {
      for (let i = 0; i < 6; i++) this.smoke.emit(pos.x, pos.y, pos.z, (Math.random() - 0.5) * 1.5, Math.random() * 1.2, (Math.random() - 0.5) * 1.5, 0.18, 0.45, 0.02, 0.02, 0.8, 0.35, { grow: 0.6, drag: 3, grav: 2 });
      return;
    }
    if (kind === 3) {
      for (let i = 0; i < 6; i++) this.fire.emit(pos.x, pos.y, pos.z, (Math.random() - 0.5) * 8, Math.random() * 6, (Math.random() - 0.5) * 8, 0.06, 1, 0.8, 0.4, 1, 0.25, { grav: 12, drag: 1 });
      return;
    }
    const n = normal || new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < 4; i++) this.smoke.emit(pos.x, pos.y, pos.z, n.x * 1.5 + (Math.random() - 0.5), n.y * 1.5 + Math.random() * 0.8, n.z * 1.5 + (Math.random() - 0.5), 0.25, 0.55, 0.5, 0.42, 0.6, 0.9, { grow: 1.2, drag: 2, grav: 0.5 });
    if (Math.random() < 0.5) this.fire.emit(pos.x, pos.y, pos.z, n.x * 3 + (Math.random() - 0.5) * 3, n.y * 3 + Math.random() * 2, n.z * 3 + (Math.random() - 0.5) * 3, 0.04, 1, 0.85, 0.5, 1, 0.15, { grav: 9 });
    const d = this.decals[this.decalIdx++ % this.decals.length];
    d.position.copy(pos).addScaledVector(n, 0.02);
    d.lookAt(d.position.clone().add(n));
    d.visible = true;
  }

  explosion(pos, big = 1) {
    const s = big >= 2 ? 1.8 : 1;
    for (let i = 0; i < 26 * s; i++) {
      const a = Math.random() * Math.PI * 2, u = Math.random() * 2 - 1, sp = (4 + Math.random() * 10) * s;
      const vx = Math.cos(a) * Math.sqrt(1 - u * u) * sp, vz = Math.sin(a) * Math.sqrt(1 - u * u) * sp, vy = Math.abs(u) * sp;
      this.fire.emit(pos.x, pos.y + 0.5, pos.z, vx, vy, vz, (1.2 + Math.random() * 1.5) * s, 1, 0.55 + Math.random() * 0.3, 0.2, 1, 0.35 + Math.random() * 0.4, { grow: 3 * s, drag: 3 });
    }
    for (let i = 0; i < 24 * s; i++) {
      const vx = (Math.random() - 0.5) * 6 * s, vz = (Math.random() - 0.5) * 6 * s, vy = Math.random() * 6 * s;
      const g = 0.18 + Math.random() * 0.12;
      this.smoke.emit(pos.x + vx * 0.2, pos.y + 0.5, pos.z + vz * 0.2, vx, vy, vz, (2 + Math.random() * 2) * s, g, g * 0.95, g * 0.9, 0.85, 3 + Math.random() * 3, { grow: 2.2 * s, drag: 1.2, grav: -0.6 });
    }
    for (let i = 0; i < 30; i++) this.fire.emit(pos.x, pos.y + 0.3, pos.z, (Math.random() - 0.5) * 30, Math.random() * 20, (Math.random() - 0.5) * 30, 0.08, 1, 0.8, 0.4, 1, 0.6 + Math.random() * 0.6, { grav: 15, drag: 0.5 });
    // dirt column
    for (let i = 0; i < 12 * s; i++) this.smoke.emit(pos.x, pos.y, pos.z, (Math.random() - 0.5) * 3, 8 + Math.random() * 10, (Math.random() - 0.5) * 3, 0.8, 0.32, 0.27, 0.2, 0.9, 1.6, { grow: 1.5, drag: 1, grav: 9 });
    this.boomLight.position.copy(pos).y += 2; this.boomLight.intensity = 400 * s; this.boomLife = 0.25;
    const d = this.camera.position.distanceTo(pos);
    this.shake = Math.max(this.shake, Math.max(0, 1 - d / (40 * s)) * 0.6);
  }

  spawnProjectile(id, kind, pos, vel) {
    const g = new THREE.Group();
    let mesh;
    if (kind === 'frag' || kind === 'c4') {
      mesh = new THREE.Mesh(kind === 'c4' ? new THREE.BoxGeometry(0.2, 0.06, 0.12) : new THREE.SphereGeometry(0.05, 8, 6), new THREE.MeshStandardMaterial({ color: kind === 'c4' ? 0xb8a77a : 0x3d4430, roughness: 0.6 }));
    } else {
      mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.6, 6).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x555a50, emissive: kind === 'shell' ? 0xffaa55 : 0x000000, emissiveIntensity: 2 }));
    }
    g.add(mesh);
    g.position.copy(pos);
    this.scene.add(g);
    this.projectiles.set(id, { g, kind, vel: vel.clone(), grav: kind === 'grenade' || kind === 'frag' || kind === 'c4' ? 9.8 : kind === 'shell' ? 1.5 : 0, trail: kind === 'rocket' || kind === 'grenade' });
  }

  updateProjectile(id, pos, vel) {
    const p = this.projectiles.get(id);
    if (!p) return;
    p.g.position.copy(pos); p.vel.copy(vel);
  }

  removeProjectile(id) {
    const p = this.projectiles.get(id);
    if (!p) return;
    this.scene.remove(p.g);
    this.projectiles.delete(id);
  }

  addWreck(pos) { this.wrecks.push({ pos: pos.clone(), life: 40 }); }

  update(dt) {
    const cam = this.camera;
    const scale = (window.innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)));
    this.smoke.update(dt, scale); this.fire.update(dt, scale);
    for (const t of this.tracers) {
      if (t.life <= 0) { t.mesh.visible = false; continue; }
      t.life -= dt; t.t += t.speed * dt;
      const head = Math.min(t.t, t.dist);
      t.mesh.position.copy(t.from).addScaledVector(t.dir, Math.max(t.len / 2, head - t.len / 2));
      if (t.life <= 0) t.mesh.visible = false;
    }
    for (const f of this.flashes) { if (f.life > 0) { f.life -= dt; if (f.life <= 0) f.s.visible = false; } }
    if (this.lightLife > 0) { this.lightLife -= dt; if (this.lightLife <= 0) this.light.intensity = 0; }
    if (this.boomLife > 0) { this.boomLife -= dt; this.boomLight.intensity *= 0.85; if (this.boomLife <= 0) this.boomLight.intensity = 0; }
    for (const p of this.projectiles.values()) {
      if (p.kind === 'c4' && p.vel.lengthSq() === 0) continue;
      p.vel.y -= p.grav * dt;
      p.g.position.addScaledVector(p.vel, dt);
      if (p.vel.lengthSq() > 1) p.g.lookAt(p.g.position.clone().add(p.vel));
      if (p.trail) {
        const q = p.g.position;
        this.smoke.emit(q.x, q.y, q.z, (Math.random() - 0.5) * 0.5, 0.3, (Math.random() - 0.5) * 0.5, 0.4, 0.75, 0.75, 0.75, 0.5, 1.4, { grow: 1.4, drag: 1 });
        this.fire.emit(q.x, q.y, q.z, 0, 0, 0, 0.5, 1, 0.7, 0.3, 1, 0.06);
      }
    }
    for (const w of this.wrecks) {
      w.life -= dt;
      if (Math.random() < dt * 12) {
        const g = 0.1 + Math.random() * 0.08;
        this.smoke.emit(w.pos.x + (Math.random() - 0.5) * 2, w.pos.y + 1.5, w.pos.z + (Math.random() - 0.5) * 2, (Math.random() - 0.5), 2 + Math.random() * 2, (Math.random() - 0.5), 1.5, g, g, g, 0.7, 5, { grow: 1.5, drag: 0.3, grav: -0.2 });
        if (Math.random() < 0.5) this.fire.emit(w.pos.x + (Math.random() - 0.5) * 2, w.pos.y + 1, w.pos.z + (Math.random() - 0.5) * 2, 0, 2, 0, 0.9, 1, 0.5, 0.15, 0.9, 0.5, { grow: -0.5 });
      }
    }
    this.wrecks = this.wrecks.filter((w) => w.life > 0);
    this.shake = Math.max(0, this.shake - dt * 1.5);
  }
}
