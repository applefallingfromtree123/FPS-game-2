// Small standalone 3D viewer: shows the player's soldier holding their primary weapon.
// Used by the character customization tab and the matchmaking lobby.
import * as THREE from 'three';
import { Soldier } from './soldier.js';
import { sanitizeLook } from '/shared/look.js';

export class CharPreview {
  constructor(canvas, { spin = true, weaponCheck = false } = {}) {
    this.canvas = canvas; this.spin = spin; this.weaponCheck = weaponCheck;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
    this.camera.position.set(0.15, 1.35, 3.6); this.camera.lookAt(0, 1.0, 0);
    this.scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x2a2f36, 1.1));
    const key = new THREE.DirectionalLight(0xfff1dc, 2.4); key.position.set(2.5, 3.5, 3); this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x6fc8ff, 1.8); rim.position.set(-3, 2.5, -3); this.scene.add(rim);
    const fill = new THREE.DirectionalLight(0x88a0c0, 0.6); fill.position.set(-2, 1, 3); this.scene.add(fill);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(1.1, 48), new THREE.MeshStandardMaterial({ color: 0x1a2028, roughness: 0.8, metalness: 0.3 }));
    disc.rotation.x = -Math.PI / 2; this.scene.add(disc);
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.1, 1.16, 64), new THREE.MeshBasicMaterial({ color: 0x5fc7ff, transparent: true, opacity: 0.7 }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.002; this.scene.add(ring);
    this.pivot = new THREE.Group(); this.scene.add(this.pivot);
    this.soldier = null; this.look = null; this.weapon = -1; this.yaw = Math.PI - 0.4; this.t = 0; this.running = false;
    this.drag = null; this.auto = true;
    canvas.addEventListener('pointerdown', (e) => { this.drag = e.clientX; this.auto = false; try { canvas.setPointerCapture(e.pointerId); } catch {} });
    canvas.addEventListener('pointermove', (e) => { if (this.drag !== null) { this.yaw += (e.clientX - this.drag) * 0.01; this.drag = e.clientX; } });
    const up = () => { this.drag = null; clearTimeout(this._rs); this._rs = setTimeout(() => { this.auto = true; }, 2500); };
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
  }

  set(look, weaponId, pal = 0) {
    look = sanitizeLook(look);
    if (!this.soldier || JSON.stringify(look) !== JSON.stringify(this.look)) {
      if (this.soldier) { this.pivot.remove(this.soldier.root); this.soldier.dispose(); this.soldier = null; }
      this.soldier = new Soldier(pal, look); this.look = look;
      this.pivot.add(this.soldier.root); this.weapon = -1;
    }
    if (weaponId !== this.weapon && this.soldier) { this.soldier.setWeapon(weaponId); this.weapon = weaponId; }
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(2, Math.round(r.width)), h = Math.max(2, Math.round(r.height));
    if (this._w !== w || this._h !== h) { this._w = w; this._h = h; this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }
  }

  start() {
    if (this.running) return;
    this.running = true; this._last = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      this._raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - this._last) / 1000); this._last = now; this.t += dt;
      this.resize();
      if (this.soldier) {
        if (this.auto && this.spin) this.yaw += dt * 0.35;
        this.pivot.rotation.y = this.yaw;
        this.soldier.animate({ dt, speed: 0, stance: 0, pitch: Math.sin(this.t * 0.6) * 0.04, alive: true, para: 0, firing: false, ads: false });
        // breathing
        this.soldier.root.position.y = Math.sin(this.t * 1.7) * 0.004;
      }
      this.renderer.render(this.scene, this.camera);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() { this.running = false; cancelAnimationFrame(this._raf); }
}
