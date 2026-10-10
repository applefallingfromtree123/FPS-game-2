// WARFIELD client game: rendering pipeline, local soldier controller,
// weapons, vehicles, entity interpolation and server event handling.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { Lensflare, LensflareElement } from 'three/addons/objects/Lensflare.js';
import { World, rayCapsule, raySphere } from '/shared/world.js';
import { MAPS } from '/shared/maps.js';
import { MODES } from '/shared/modes.js';
import { WEAPONS, zoomFor, MUZZLES, GRENADE } from '/shared/weapons.js';
import { decodeSnapshot, PF, VF, VEHICLES, EYE, hitboxes } from '/shared/protocol.js';
import { Environment, QUALITY } from './env.js';
import { Soldier, PALETTES } from './soldier.js';
import { buildGun, buildArms } from './guns.js';
import { buildVehicle, VehicleController } from './vehicles.js';
import { FX } from './fx.js';
import { HUD } from './hud.js';
import * as TX from './textures.js';
import { drawCollimator, drawScope } from './sights.js';

const $ = (id) => document.getElementById(id);
const V3 = THREE.Vector3;
const lerpAngle = (a, b, t) => { let d = b - a; d = Math.atan2(Math.sin(d), Math.cos(d)); return a + d * t; };

const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uVig: { value: 0.35 }, uDamage: { value: 0 }, uSat: { value: 1.04 }, uTime: { value: 0 }, uGrain: { value: 0.025 }, uCA: { value: 0.0005 }, uCool: { value: 0.0 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uVig, uDamage, uSat, uTime, uGrain, uCA, uCool; varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)) + uTime) * 43758.5453); }
    void main(){
      vec2 d = vUv - 0.5; float r2 = dot(d, d);
      vec2 o = d * r2 * uCA * 8.0;                       // chromatic aberration grows toward the edges
      vec3 col = vec3(texture2D(tDiffuse, vUv + o).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - o).b);
      float l = dot(col, vec3(0.299,0.587,0.114));
      col = mix(vec3(l), col, uSat * (1.0 - uDamage * 0.7));
      col *= mix(vec3(1.0), vec3(0.93, 1.0, 1.08), uCool * (1.0 - smoothstep(0.0, 1.2, l))); // cool shadows
      float v = 1.0 - r2 * uVig * 2.2;
      col *= v; col.r += uDamage * 0.15 * (1.0 - v);
      col += (hash(vUv * 1000.0) - 0.5) * uGrain * (1.0 - clamp(l, 0.0, 0.8));   // film grain, mostly in shadows
      gl_FragColor = vec4(col, 1.0); }`,
};

// radial blur of the bright sky toward the sun: light shafts through trees and buildings
const SunShaftShader = {
  uniforms: { tDiffuse: { value: null }, uSun: { value: new THREE.Vector2(0.5, 0.5) }, uInt: { value: 0 }, uColor: { value: new THREE.Color(1, 0.9, 0.75) } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform vec2 uSun; uniform float uInt; uniform vec3 uColor; varying vec2 vUv;
    void main(){
      vec4 base = texture2D(tDiffuse, vUv);
      if (uInt < 0.002) { gl_FragColor = base; return; }
      vec2 dir = (uSun - vUv); float dist = length(dir);
      vec2 stepv = dir * 0.9 / 30.0;
      vec2 uv = vUv; float decay = 1.0; vec3 acc = vec3(0.0);
      for (int i = 0; i < 30; i++) {
        uv += stepv;
        vec3 s = texture2D(tDiffuse, uv).rgb;
        float b = smoothstep(1.0, 2.2, dot(s, vec3(0.333)));
        acc += s * b * decay; decay *= 0.93;
      }
      float falloff = smoothstep(1.0, 0.0, dist);
      gl_FragColor = vec4(base.rgb + acc / 30.0 * uColor * uInt * falloff * 0.45, base.a); }`,
};

export class Game {
  constructor({ net, audio, settings, match, ui }) {
    this.net = net; this.audio = audio; this.settings = settings; this.ui = ui;
    this.modeId = match.mode; this.mode = MODES[match.mode];
    this.map = MAPS[match.map];
    this.world = new World(this.map);
    this.roster = new Map();
    for (const [id, name, team, squad, bot, cls] of match.roster) this.roster.set(id, { id, name, team, squad, bot: !!bot, cls });
    this.me = { id: match.you, team: match.team, squad: match.squad, alive: false, hp: 100, loadout: null };
    this.soldiers = new Map();
    this.vehiclesR = new Map();
    this.vehInit = match.vehicles;
    this.board = new Map();
    this.state = null;
    this.timeOffset = match.time - performance.now();
    this.clockInit = false;
    this.keys = {}; this.mouse = { dx: 0, dy: 0, left: false, right: false, leftPressed: false, rightPressed: false };
    this.pos = new V3(); this.vel = new V3(); this.cam = { yaw: 0, pitch: 0 };
    this.stance = 0; this.onGround = true; this.para = 0; this.adsT = 0; this.sprinting = false;
    this.sway = { x: 0, y: 0 }; this.breath = 1; this.sightDirty = true;
    this.tmpV = new V3();
    this.loudShooters = new Set();
    this.ammo = new Map(); this.slot = 0; this.reloadUntil = 0; this.nextFire = 0; this.burstLeft = 0; this.bloom = 0;
    this.fireModeIdx = 0; this.switchUntil = 0; this.grenades = 2; this.c4Count = 3; this.boxReady = 0; this.spotReady = 0;
    this.vehicle = null; this.thirdPerson = true;
    this.lastSend = 0; this.frame = 0; this.running = false;
    this.deathAt = 0; this.killerId = -1;
    this.brWeapon = -1;
    this.lootMeshes = null;
    this.ended = false;
  }

  // ------------------------------------------------------------ setup
  async load(progress) {
    const q = QUALITY[this.settings.quality];
    this.q = q;
    const canvas = $('gl');
    const r = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', logarithmicDepthBuffer: true });
    r.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatio * (window.devicePixelRatio > 1 ? 1.3 : 1)));
    r.setSize(innerWidth, innerHeight);
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = this.world.time.exposure * 1.25;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer = r;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(this.settings.fov, innerWidth / innerHeight, 0.05, q.far * 3);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);
    await tick();
    this.env = new Environment(this.scene, this.world, r, q, (p, msg) => progress(p * 0.8, msg));
    await tick();
    progress(0.85, '병력 및 장비');
    this.fx = new FX(this.scene, this.camera);
    this.fx.groundAt = (x, z) => this.world.heightAt(x, z);
    if (q.name !== 'low' && this.world.time.sunElev > 3) {
      // sun lens flare (occluded by terrain/buildings automatically)
      const sunLight = new THREE.PointLight(0xffffff, 0, 0);
      const flare = new Lensflare();
      const tc = this.env.sun.color.clone();
      flare.addElement(new LensflareElement(TX.radialSprite('rgba(255,255,255,0.55)', 'rgba(255,255,255,0)', 128), 240, 0, tc));
      flare.addElement(new LensflareElement(TX.radialSprite('rgba(255,220,170,0.28)', 'rgba(255,200,150,0)', 64), 120, 0.35, new THREE.Color(1, 0.8, 0.6)));
      flare.addElement(new LensflareElement(TX.radialSprite('rgba(150,200,255,0.25)', 'rgba(150,200,255,0)', 64), 80, 0.62, new THREE.Color(0.7, 0.85, 1)));
      flare.addElement(new LensflareElement(TX.radialSprite('rgba(255,255,255,0.18)', 'rgba(255,255,255,0)', 64), 170, 0.9, new THREE.Color(0.9, 0.95, 1)));
      sunLight.add(flare);
      this.scene.add(sunLight);
      this.sunFlare = sunLight;
    }
    // first-person viewmodel scene
    this.vmScene = new THREE.Scene();
    this.vmCamera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.01, 10);
    this.vmScene.add(this.vmCamera);
    this.vmScene.environment = this.env.envMap;
    this.vmScene.environmentIntensity = 0.6;
    const vSun = new THREE.DirectionalLight(this.env.sun.color, this.env.sun.intensity * 0.8);
    this.vmScene.add(vSun); this.vmSun = vSun;
    this.vmScene.add(new THREE.HemisphereLight(this.env.hemi.color, this.env.hemi.groundColor, this.env.hemi.intensity));
    this.vm = new THREE.Group(); this.vmCamera.add(this.vm);
    this.vmFlash = new THREE.Sprite(new THREE.SpriteMaterial({ map: TX.flashSprite(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    this.vmFlash.visible = false;
    // post processing
    const rt = new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, samples: q.msaa });
    const comp = new EffectComposer(r, rt);
    comp.addPass(new RenderPass(this.scene, this.camera));
    if (q.name !== 'low') { this.shafts = new ShaderPass(SunShaftShader); this.shafts.uniforms.uColor.value.copy(this.env.sun.color); comp.addPass(this.shafts); }
    const vmPass = new RenderPass(this.vmScene, this.vmCamera);
    vmPass.clear = false; vmPass.clearDepth = true;
    comp.addPass(vmPass);
    if (q.bloom) comp.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), 0.22, 0.6, 0.92));
    this.grade = new ShaderPass(GradeShader);
    this.grade.uniforms.uCool.value = this.world.time.sunElev < 12 ? 0.25 : 0.55;
    comp.addPass(this.grade);
    comp.addPass(new OutputPass());
    if (q.msaa === 0 && q.name !== 'low') { this.smaa = new SMAAPass(innerWidth * r.getPixelRatio(), innerHeight * r.getPixelRatio()); comp.addPass(this.smaa); }
    this.composer = comp;
    // vehicles
    for (const [id, type, team] of this.vehInit) this._ensureVehicle(id, type, team);
    // battle royale crates & zone
    if (this.mode.br) {
      this.lootMeshes = new Map();
      this.world.loot.forEach((L, i) => this._addLoot(i, L.x, L.y, L.z));
      const zm = new THREE.ShaderMaterial({
        transparent: true, side: THREE.DoubleSide, depthWrite: false,
        uniforms: { uTime: this.env.uniforms.uTime },
        vertexShader: 'varying vec2 vUv; varying vec3 vW; void main(){ vUv = uv; vec4 w = modelMatrix*vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }',
        fragmentShader: 'varying vec2 vUv; varying vec3 vW; uniform float uTime; void main(){ float s = 0.5+0.5*sin(vW.y*0.15 - uTime*2.0 + vUv.x*200.0); gl_FragColor = vec4(1.0, 0.35+0.2*s, 0.1, (0.18 + 0.12*s) * (1.0 - vUv.y*0.6)); }',
      });
      this.zoneMesh = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 96, 1, true), zm);
      this.zoneMesh.scale.set(1, 900, 1); this.zoneMesh.position.y = 300; this.zoneMesh.frustumCulled = false;
      this.scene.add(this.zoneMesh);
    }
    this.boxes = new Map();
    this.hud = new HUD(this);
    this.audio.setRain(!!this.world.time.rain);
    progress(0.95, '셰이더 컴파일');
    // compile shaders once with a representative frame
    this.camera.position.set(0, this.world.heightAt(0, 0) + 2, 0);
    r.compile(this.scene, this.camera);
    await tick();
    progress(1, '완료');
    window.addEventListener('resize', (this._onResize = () => this.resize()));
    this.bindInput();
  }

  resize() {
    this.renderer.setSize(innerWidth, innerHeight);
    this.composer.setSize(innerWidth, innerHeight);
    if (this.smaa) this.smaa.setSize(innerWidth * this.renderer.getPixelRatio(), innerHeight * this.renderer.getPixelRatio());
    this.camera.aspect = this.vmCamera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix(); this.vmCamera.updateProjectionMatrix();
  }

  _ensureVehicle(id, type, team) {
    let v = this.vehiclesR.get(id);
    if (v) return v;
    const { group, parts } = buildVehicle(type, team);
    this.scene.add(group);
    v = { id, type, team, group, parts, buf: [], x: 0, y: -1000, z: 0, yaw: 0, pitch: 0, roll: 0, turret: 0, destroyed: false, occupied: false, driver: -1, hp: VEHICLES[type].hp, rotor: 0 };
    group.visible = false;
    this.vehiclesR.set(id, v);
    return v;
  }

  _addLoot(i, x, y, z) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.55, 0.6), new THREE.MeshStandardMaterial({ color: 0x4d5a37, roughness: 0.7 }));
    const lid = new THREE.Mesh(new THREE.BoxGeometry(1.14, 0.06, 0.64), new THREE.MeshStandardMaterial({ color: 0xffb030, emissive: 0x553300, roughness: 0.5 }));
    lid.position.y = 0.3; m.add(lid);
    m.position.set(x, y + 0.28, z); m.castShadow = true;
    this.scene.add(m);
    this.lootMeshes.set(i, m);
  }

  // ------------------------------------------------------------ input
  bindInput() {
    const c = $('gl');
    this._kd = (e) => {
      if (e.code === 'Tab') { e.preventDefault(); $('scoreboard').style.display = 'block'; this.hud.renderScoreboard(); }
      if (!this.hasPointerLock && e.code === 'Escape' && this.engaged) { this.unlock(); return; }
      if (!this.locked()) return;
      if (e.code === 'Space' || e.code.startsWith('Arrow') || e.code === 'Tab') e.preventDefault();
      this.keys[e.code] = true;
      if (e.repeat) return;
      this.onKey(e.code);
    };
    this._ku = (e) => {
      this.keys[e.code] = false;
      if (e.code === 'Tab') $('scoreboard').style.display = 'none';
      if (e.code === 'KeyM') $('bigmap').style.display = 'none';
    };
    this._mm = (e) => {
      // Chrome can report a huge bogus delta right after the pointer gets locked
      let mx = e.movementX, my = e.movementY;
      if (mx === undefined) { mx = this._lx === undefined ? 0 : e.clientX - this._lx; my = this._ly === undefined ? 0 : e.clientY - this._ly; }
      this._lx = e.clientX; this._ly = e.clientY;
      if (!this.locked() || performance.now() < this.ignoreMouseUntil) return;
      if (Math.abs(mx) > 350 || Math.abs(my) > 350) return;
      this.mouse.dx += mx; this.mouse.dy += my;
    };
    this._md = (e) => {
      this.audio.init();
      if (!this.locked()) { if (this.me.alive && !this.ended && $('deploy').style.display !== 'flex' && $('pause').style.display !== 'flex') this.lock(); return; }
      if (e.button === 0) { this.mouse.left = true; this.mouse.leftPressed = true; }
      if (e.button === 2) { this.mouse.right = true; this.mouse.rightPressed = true; }
    };
    this._mu = (e) => { if (e.button === 0) this.mouse.left = false; if (e.button === 2) this.mouse.right = false; };
    window.addEventListener('blur', () => { if (!this.hasPointerLock) this.unlock(); });
    this._plc = () => {
      if (!this.locked() && this.me.alive && !this.ended && $('deploy').style.display !== 'flex') { $('pause').style.display = 'flex'; }
      else if (this.locked()) { $('pause').style.display = 'none'; this.ignoreMouseUntil = performance.now() + 120; }
      this.keys = {}; this.mouse.left = this.mouse.right = false;
    };
    window.addEventListener('keydown', this._kd); window.addEventListener('keyup', this._ku);
    window.addEventListener('mousemove', this._mm); window.addEventListener('mousedown', this._md); window.addEventListener('mouseup', this._mu);
    document.addEventListener('pointerlockchange', this._plc);
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('contextmenu', this._cm = (e) => { if (this.running) e.preventDefault(); });
  }

  unbindInput() {
    window.removeEventListener('keydown', this._kd); window.removeEventListener('keyup', this._ku);
    window.removeEventListener('mousemove', this._mm); window.removeEventListener('mousedown', this._md); window.removeEventListener('mouseup', this._mu);
    document.removeEventListener('pointerlockchange', this._plc);
    window.removeEventListener('contextmenu', this._cm);
    window.removeEventListener('resize', this._onResize);
  }

  // Pointer Lock is missing on iPad/iPhone Safari: fall back to an "engaged" flag so keyboard and mouse still work.
  get hasPointerLock() {
    // iPadOS reports a Mac user agent but has touch points; pointer lock is unreliable there
    const ipad = navigator.maxTouchPoints > 1 && /iPad|iPhone|Macintosh/.test(navigator.userAgent);
    return 'requestPointerLock' in Element.prototype && !ipad;
  }
  locked() { return this.hasPointerLock ? document.pointerLockElement === $('gl') : !!this.engaged; }
  lock() {
    if (!this.hasPointerLock) { this.engaged = true; $('pause').style.display = 'none'; this.ignoreMouseUntil = performance.now() + 120; return; }
    try { const p = $('gl').requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch {}
  }
  unlock() {
    if (this.hasPointerLock) { if (document.pointerLockElement) document.exitPointerLock(); return; }
    this.engaged = false; this.keys = {}; this.mouse.left = this.mouse.right = false;
    if (this.me.alive && !this.ended && $('deploy').style.display !== 'flex') $('pause').style.display = 'flex';
  }

  onKey(code) {
    if (!this.me.alive) return;
    if (code === 'KeyE') return this.interact();
    if (code === 'KeyV' && this.vehicle) { this.thirdPerson = !this.thirdPerson; return; }
    if (code === 'KeyM') { $('bigmap').style.display = 'flex'; this.hud.drawBigMap(); }
    if (this.vehicle) return;
    if (code === 'KeyC') this.stance = this.stance === 1 ? 0 : 1;
    if (code === 'KeyZ') this.stance = this.stance === 2 ? 0 : 2;
    if (code === 'KeyR') this.startReload();
    if (code === 'KeyB') { const w = this.weapon(); if (w && w.modes.length > 1) { this.fireModeIdx = (this.fireModeIdx + 1) % w.modes.length; this.audio.click(); } }
    if (code === 'Digit1') this.switchSlot(0);
    if (code === 'Digit2') this.switchSlot(1);
    if (code === 'Digit3' || code === 'Digit4') this.switchSlot(2);
    if (code === 'KeyG') this.throwGrenade();
    if (code === 'KeyQ') this.spot();
    if (code === 'Space') {
      if (this.para === 1) this.para = 2;
      else if (this.onGround && this.stance === 0) { this.vel.y = 6.2; this.onGround = false; }
      else if (this.stance !== 0) this.stance = 0;
    }
  }

  // ------------------------------------------------------------ helpers
  serverNow() { return performance.now() + this.timeOffset; }
  renderTime() { return this.serverNow() - 110; }
  isFriend(team) { return this.mode.teams === 0 ? false : team === this.me.team; }
  paletteFor(team) {
    if (this.mode.teams === 2) return team % 2;
    return team === this.me.team ? 0 : 1 + (team % 3);
  }
  myPos() { return this.vehicle ? new V3(this.vehicle.x, this.vehicle.y, this.vehicle.z) : this.pos; }
  altitude() { return this.pos.y - this.world.heightAt(this.pos.x, this.pos.z); }

  slotWeaponId(slot) {
    const l = this.me.loadout;
    if (!l) return -1;
    if (this.mode.br) return slot === 0 ? this.brWeapon : slot === 1 ? l.secondary : -1;
    if (slot === 0) return l.primary;
    if (slot === 1) return l.secondary;
    if (slot === 2) return l.gadget;
    return -1;
  }
  weapon() { const id = this.slotWeaponId(this.slot); return id >= 0 ? WEAPONS[id] : null; }
  ammoOf(w) { if (!this.ammo.has(w.id)) this.ammo.set(w.id, { mag: w.mag, res: w.reserve }); return this.ammo.get(w.id); }
  gadgetKind() {
    if (this.mode.br) return null;
    const cls = this.me.loadout && this.me.loadout.cls;
    if (cls === 'support') return 'box';
    if (cls === 'recon') return 'c4';
    return this.me.loadout && this.me.loadout.gadget >= 0 ? 'weapon' : null;
  }

  // ------------------------------------------------------------ viewmodel
  buildViewmodel() {
    while (this.vm.children.length) this.vm.remove(this.vm.children[0]);
    this.vmGun = null;
    const w = this.weapon();
    const pal = PALETTES[this.paletteFor(this.me.team)];
    const arms = buildArms(pal);
    let gunInfo;
    if (w) {
      const isPrim = w.id === this.me.loadout.primary || (this.mode.br && w.id === this.brWeapon);
      gunInfo = buildGun(w, { fp: true, sight: isPrim && !this.mode.br ? this.me.loadout.sight : w.sight, muzzle: isPrim && !this.mode.br ? this.me.loadout.muzzle : w.muzzleDefault });
    } else {
      // gadget: C4 brick or ammo box in hand
      const g = new THREE.Group();
      const kind = this.gadgetKind();
      const m = new THREE.Mesh(kind === 'box' ? new THREE.BoxGeometry(0.22, 0.14, 0.12) : new THREE.BoxGeometry(0.12, 0.05, 0.08), new THREE.MeshStandardMaterial({ color: kind === 'box' ? 0x4d5a37 : 0xb8a77a, roughness: 0.7 }));
      m.position.set(0, -0.02, -0.08); g.add(m);
      gunInfo = { group: g, muzzle: new THREE.Object3D(), sightY: 0.05, mag: null };
    }
    const grp = new THREE.Group();
    grp.add(gunInfo.group);
    const cat = w ? w.cat : 'pistol';
    const rh = cat === 'launcher' ? new V3(0, -0.11, 0.05) : cat === 'pistol' ? new V3(0, -0.09, 0.03) : new V3(0, -0.085, 0.07);
    const lh = cat === 'pistol' ? new V3(-0.01, -0.1, 0.02) : cat === 'launcher' ? new V3(0, -0.12, -0.25) : new V3(0, -0.045, -0.22 - (cat === 'lmg' ? 0.06 : 0));
    arms.userData.build(rh, lh);
    grp.add(arms);
    gunInfo.muzzle.add(this.vmFlash);
    this.vm.add(grp);
    this.vmGun = { grp, info: gunInfo, w, magRest: gunInfo.mag ? gunInfo.mag.position.clone() : null };
    const sight = w && (w.id === this.me.loadout.primary && !this.mode.br) ? this.me.loadout.sight : w ? w.sight : 'iron';
    this.sightKind = sight;
    this.zoom = w ? zoomFor(w, sight) : 1;
    this.sightDirty = true;
    this.fireModeIdx = 0;
  }

  switchSlot(s) {
    if (s === this.slot) return;
    if (s === 2 && !this.gadgetKind()) return;
    if (s === 0 && this.slotWeaponId(0) < 0) return;
    this.slot = s; this.reloadUntil = 0; this.switchUntil = performance.now() + 450; this.burstLeft = 0;
    this.buildViewmodel();
  }

  startReload() {
    const w = this.weapon();
    if (!w) return;
    const a = this.ammoOf(w);
    if (a.mag >= w.mag || a.res <= 0 || performance.now() < this.reloadUntil) return;
    this.reloadStart = performance.now();
    this.reloadUntil = this.reloadStart + w.reload * 1000;
    this.audio.reload();
  }

  // ------------------------------------------------------------ actions
  interact() {
    if (this.vehicle) {
      const v = this.vehicle;
      this.net.send({ t: 'exit', p: [v.x + Math.cos(v.yaw) * (VEHICLES[v.type].radius + 1.2), v.y + 0.5, v.z - Math.sin(v.yaw) * (VEHICLES[v.type].radius + 1.2)] });
      return;
    }
    const near = this.nearestVehicle();
    if (near) { this.net.send({ t: 'enter', id: near.id }); return; }
    if (this.lootMeshes) {
      for (const [i, m] of this.lootMeshes) if (Math.hypot(m.position.x - this.pos.x, m.position.z - this.pos.z) < 3) { this.net.send({ t: 'loot', i }); return; }
    }
  }

  nearestVehicle() {
    let best = null, bd = Infinity;
    for (const v of this.vehiclesR.values()) {
      if (v.destroyed || !v.group.visible) continue;
      if (v.team !== 255 && v.team !== this.me.team) continue;
      const d = Math.hypot(v.x - this.pos.x, v.z - this.pos.z);
      if (d < VEHICLES[v.type].radius + 3 && d < bd && Math.abs(v.y - this.pos.y) < 5) { bd = d; best = v; }
    }
    return best;
  }

  throwGrenade() {
    if (this.grenades <= 0 || this.mode.br && false) return;
    this.grenades--;
    const d = this.aimDir();
    const o = this.eyePos().addScaledVector(d, 0.5);
    const v = d.clone().multiplyScalar(GRENADE.vel).add(new V3(0, 3.5, 0)).add(new V3(this.vel.x, 0, this.vel.z));
    this.net.send({ t: 'throw', k: 'frag', o: o.toArray(), v: v.toArray() });
  }

  spot() {
    if (performance.now() < this.spotReady) return;
    this.spotReady = performance.now() + 1500;
    this.net.send({ t: 'spot', o: this.eyePos().toArray(), d: this.aimDir().toArray() });
  }

  eyePos() { return new V3(this.pos.x, this.pos.y + this.eyeH, this.pos.z); }
  aimDir() { const y = this.cam.yaw + this.sway.x, p = this.cam.pitch + this.sway.y; return new V3(-Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p)); }

  currentSpread() {
    const w = this.weapon();
    if (!w) return 0;
    const hspeed = Math.hypot(this.vel.x, this.vel.z);
    let s = this.adsT > 0.7 ? w.ads : w.hip * (1 + Math.min(1.5, hspeed / 5) * 0.7);
    if (this.stance === 1) s *= 0.8; else if (this.stance === 2) s *= 0.6;
    if (!this.onGround) s *= 2;
    return s + this.bloom;
  }
  currentSpreadPx() {
    const s = this.currentSpread();
    return Math.tan(THREE.MathUtils.degToRad(s / 2)) / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * innerHeight / 2;
  }

  tryFire(now) {
    const w = this.weapon();
    const kind = this.slot === 2 ? this.gadgetKind() : 'weapon';
    if (kind === 'box') {
      if (this.mouse.leftPressed && now > this.boxReady) { this.boxReady = now + 20000; this.net.send({ t: 'box' }); this.hud.notice('보급 상자 배치', '', '#7cff8a'); }
      return;
    }
    if (kind === 'c4') {
      if (this.mouse.leftPressed && this.c4Count > 0) {
        this.c4Count--;
        const d = this.aimDir();
        this.net.send({ t: 'throw', k: 'c4', o: this.eyePos().addScaledVector(d, 0.4).toArray(), v: d.multiplyScalar(C4VEL).add(new V3(0, 2, 0)).toArray() });
      }
      if (this.mouse.rightPressed) this.net.send({ t: 'det' });
      return;
    }
    if (!w || now < this.switchUntil || now < this.reloadUntil || this.sprinting && this.adsT < 0.1 && false) return;
    const mode = w.modes[this.fireModeIdx % w.modes.length];
    const auto = mode === 'auto';
    const wantShot = auto ? this.mouse.left : (mode === 'burst' ? (this.mouse.leftPressed || this.burstLeft > 0) : this.mouse.leftPressed);
    if (!wantShot || now < this.nextFire) return;
    const a = this.ammoOf(w);
    if (a.mag <= 0) { if (this.mouse.leftPressed) this.audio.click(); this.startReload(); this.burstLeft = 0; return; }
    if (mode === 'burst' && this.burstLeft <= 0) this.burstLeft = 3;
    if (this.burstLeft > 0) this.burstLeft--;
    a.mag--;
    this.nextFire = now + w.fireInterval * 1000 + (mode === 'bolt' ? 900 : 0);
    if (this.sprinting) { this.sprinting = false; }
    const eye = this.eyePos();
    const dirs = [];
    const spread = THREE.MathUtils.degToRad(this.currentSpread());
    for (let i = 0; i < w.pellets; i++) {
      const ang = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * spread * 0.5;
      const yaw = this.cam.yaw + this.sway.x + Math.cos(ang) * r, pitch = this.cam.pitch + this.sway.y + Math.sin(ang) * r;
      dirs.push([-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)]);
    }
    const isPrim = w.id === this.me.loadout.primary && !this.mode.br;
    const muzzle = isPrim ? this.me.loadout.muzzle : w.muzzleDefault;
    this.net.send({ t: 'fire', w: w.id, o: eye.toArray().map((x) => +x.toFixed(3)), d: dirs.map((d) => d.map((x) => +x.toFixed(5))), vt: Math.round(this.renderTime()) });
    // local effects
    const suppressed = !MUZZLES[muzzle].loud;
    this.audio.gunshot(w.cat, 0, 0, 0, suppressed, true);
    this.vmFlash.visible = !suppressed && w.cat !== 'launcher'; this.vmFlash.scale.setScalar(w.cat === 'launcher' ? 0.6 : 0.18); this.vmFlash.material.rotation = Math.random() * 6;
    this.flashT = 0.05;
    const muzzleWorld = this.muzzleWorld();
    if (w.cat !== 'launcher' && w.cat !== 'shotgun') { const rt = new V3(Math.cos(this.cam.yaw), 0, -Math.sin(this.cam.yaw)); this.fx.casing(this.eyePos().addScaledVector(this.aimDir(), 0.35).addScaledVector(rt, 0.1).add(new V3(0, -0.07, 0)), rt, new V3(0, 1, 0)); }
    if (!suppressed) { this.fx.light.position.copy(muzzleWorld); this.fx.light.intensity = 25; this.fx.lightLife = 0.05; }
    if (w.cat === 'launcher') {
      for (let i = 0; i < 12; i++) this.fx.smoke.emit(eye.x, eye.y, eye.z, (Math.random() - 0.5) * 2 - dirs[0][0] * 6, Math.random(), (Math.random() - 0.5) * 2 - dirs[0][2] * 6, 0.8, 0.8, 0.8, 0.8, 0.5, 1.5, { grow: 2, drag: 2 });
    } else {
      for (const d of dirs.slice(0, 3)) {
        const dv = new V3(...d);
        const hit = this.world.raycast(eye.x, eye.y, eye.z, dv.x, dv.y, dv.z, 900);
        let end = eye.clone().addScaledVector(dv, hit.dist);
        let kind = hit.type ? 2 : 0;
        const ph = this.localHitTest(eye, dv, hit.dist);
        if (ph) { end = eye.clone().addScaledVector(dv, ph); kind = 1; }
        if (Math.random() < (w.cat === 'smg' || w.cat === 'lmg' || w.cat === 'ar' || w.cat === 'carbine' ? 0.5 : 1)) this.fx.tracer(muzzleWorld, end, Math.min(900, w.vel));
        if (kind) this.fx.impact(end, hit.type === 'terrain' ? new V3(...this.world.normalAt(end.x, end.z)) : dv.clone().negate(), kind);
      }
    }
    // recoil
    const rm = MUZZLES[muzzle].recoil * (this.adsT > 0.5 ? 0.75 : 1) * (this.stance === 1 ? 0.85 : this.stance === 2 ? 0.65 : 1);
    this.cam.pitch += THREE.MathUtils.degToRad(w.recoilV * 0.55 * rm);
    this.cam.yaw += THREE.MathUtils.degToRad((Math.random() - 0.45) * w.recoilH * 0.7 * rm);
    this.vmKick = Math.min(1.5, (this.vmKick || 0) + 0.5 + w.recoilV * 0.15);
    this.bloom = Math.min(w.cat === 'sniper' ? 0 : 2.5, this.bloom + 0.08 * w.recoilV);
    if (a.mag === 0) this.startReload();
  }

  muzzleWorld() {
    const d = this.aimDir();
    const right = new V3(Math.cos(this.cam.yaw), 0, -Math.sin(this.cam.yaw));
    const k = 1 - this.adsT;
    return this.eyePos().addScaledVector(d, 0.7).addScaledVector(right, 0.12 * k).add(new V3(0, -0.12 * k - 0.04, 0));
  }

  localHitTest(o, d, maxD) {
    let best = null;
    for (const e of this.soldiers.values()) {
      if (!e.visible || !e.alive || this.isFriend(e.team) || e.veh >= 0) continue;
      const hb = hitboxes(e.stance);
      const t = rayCapsule(o.x, o.y, o.z, d.x, d.y, d.z, e.x, e.z, e.y + hb.body.y0, e.y + hb.body.y1, hb.body.r);
      const th = raySphere(o.x, o.y, o.z, d.x, d.y, d.z, e.x, e.y + hb.head.y, e.z, hb.head.r);
      for (const tt of [t, th]) if (tt >= 0 && tt < maxD && (best === null || tt < best)) best = tt;
    }
    return best;
  }

  // ------------------------------------------------------------ main loop
  start() {
    this.running = true;
    this.last = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      try { this.update(dt, now); } catch (e) { reportError('update', e); }
      try { this.render(); } catch (e) { reportError('render', e); }
    };
    requestAnimationFrame(loop);
    this.pingTimer = setInterval(() => this.net.send({ t: 'pi', c: performance.now() }), 2000);
  }

  stop() {
    this.running = false;
    clearInterval(this.pingTimer);
    this.unbindInput();
    this.audio.setEngine(null);
    this.unlock();
    this.renderer.dispose();
  }

  update(dt, now) {
    this.frame++;
    const sens = this.settings.sens * 0.0022 * (this.camera.fov / this.settings.fov);
    const mdx = this.mouse.dx, mdy = this.mouse.dy * (this.settings.invert ? -1 : 1);
    this.mouse.dx = this.mouse.dy = 0;
    const safe = (name, fn) => { try { fn(); } catch (e) { reportError(name, e); } };
    safe('input', () => {
      if (this.me.alive) {
        if (this.vehicle) this.updateVehicle(dt, now, mdx, mdy, sens);
        else this.updatePlayer(dt, now, mdx, mdy, sens);
      } else this.updateDeathCam(dt, now);
    });
    this.mouse.leftPressed = this.mouse.rightPressed = false;
    safe('remote', () => this.updateRemote(dt));
    safe('env', () => this.env.update(dt, this.camera.position, this.camera));
    safe('fx', () => this.fx.update(dt));
    if (this.fx.shake > 0) { this.camera.rotation.x += (Math.random() - 0.5) * this.fx.shake * 0.05; this.camera.rotation.y += (Math.random() - 0.5) * this.fx.shake * 0.05; }
    safe('hud', () => { this.hud.update(dt); this.updateHudPanels(now); });
    this.grade.uniforms.uDamage.value = this.me.alive ? Math.max(0, (60 - this.me.hp) / 60) : 0.8;
    this.grade.uniforms.uTime.value = (now * 0.001) % 100;
    this.updateSun();
    const L = this.audio.listener; const cp = this.camera.position; L.x = cp.x; L.y = cp.y; L.z = cp.z; L.yaw = this.cam.yaw;
    // network state 20Hz
    if (now - this.lastSend > 50 && this.me.alive) {
      this.lastSend = now;
      const msg = { t: 'st', p: [+this.pos.x.toFixed(2), +this.pos.y.toFixed(2), +this.pos.z.toFixed(2)], r: [+this.cam.yaw.toFixed(3), +this.cam.pitch.toFixed(3)], s: this.stance, a: this.adsT > 0.5 ? 1 : 0, w: this.slot, pa: this.para };
      if (this.vehicle) { msg.v = this.vehicle.state().map((x) => +x.toFixed(3)); msg.vs = +this.vehicle.speed.toFixed(1); msg.p = [msg.v[0], msg.v[1], msg.v[2]]; }
      this.net.send(msg);
    }
    if (this.state && this.state.zone) {
      const z = this.state.zone;
      this.zoneMesh.position.set(z[0], 300, z[1]); this.zoneMesh.scale.set(Math.max(1, z[2]), 900, Math.max(1, z[2]));
      const p = this.myPos();
      this.zoneWarning = this.me.alive && this.para !== 1 && Math.hypot(p.x - z[0], p.z - z[1]) > z[2];
    }
    if (this.state && this.state.area && this.me.alive) {
      const a = this.state.area; const p = this.myPos();
      this.outOfBounds = Math.hypot(p.x - a[0], p.z - a[1]) > a[2];
    } else this.outOfBounds = false;
    if (this.frame % 30 === 0) $('fps').textContent = `${Math.round(1 / Math.max(dt, 0.001))} fps · ${this.ping || 0}ms` + (document.body.classList.contains('touch') ? ` · 터치 ${window.__tc || 0}` : '');
  }

  updateSun() {
    const cp = this.camera.position, sd = this.env.sunDir;
    if (this.sunFlare) { this.sunFlare.position.set(cp.x + sd.x * 900, cp.y + sd.y * 900, cp.z + sd.z * 900); this.sunFlare.visible = !(this.adsT > 0.9 && (this.sightKind === 'scope' || this.sightKind === 'acog')); }
    if (this.shafts) {
      const v = new THREE.Vector3(cp.x + sd.x * 1000, cp.y + sd.y * 1000, cp.z + sd.z * 1000).project(this.camera);
      const fwd = new THREE.Vector3(); this.camera.getWorldDirection(fwd);
      const facing = Math.max(0, fwd.dot(sd));
      this.shafts.uniforms.uSun.value.set(v.x * 0.5 + 0.5, v.y * 0.5 + 0.5);
      const strong = this.world.time.clouds ? 0.15 : 1;
      this.shafts.uniforms.uInt.value = facing * facing * strong * (this.vehicle ? 0.8 : 1);
    }
  }

  updatePlayer(dt, now, mdx, mdy, sens) {
    const w = this.world, k = this.keys;
    this.cam.yaw -= mdx * sens;
    this.cam.pitch = Math.max(-1.5, Math.min(1.5, this.cam.pitch - mdy * sens));
    const wpn = this.weapon();
    // parachute / freefall
    if (this.para) {
      const g = w.heightAt(this.pos.x, this.pos.z);
      const fwd = (k.KeyW ? 1 : 0) - (k.KeyS ? 1 : 0), side = (k.KeyD ? 1 : 0) - (k.KeyA ? 1 : 0);
      const hs = this.para === 1 ? 40 : 10, vs = this.para === 1 ? 52 : 5.5;
      const dx = -Math.sin(this.cam.yaw) * fwd + Math.cos(this.cam.yaw) * side, dz = -Math.cos(this.cam.yaw) * fwd - Math.sin(this.cam.yaw) * side;
      this.vel.x += (dx * hs - this.vel.x) * Math.min(1, dt * 1.5); this.vel.z += (dz * hs - this.vel.z) * Math.min(1, dt * 1.5);
      this.pos.x += this.vel.x * dt; this.pos.z += this.vel.z * dt; this.pos.y -= vs * dt;
      if (this.para === 1 && this.pos.y - g < 130) this.para = 2;
      const gl = w.groundAt(this.pos.x, this.pos.z, this.pos.y + 1);
      if (this.pos.y <= gl) { this.pos.y = gl; this.para = 0; this.vel.set(0, 0, 0); }
      const lim = w.half - 3; this.pos.x = Math.max(-lim, Math.min(lim, this.pos.x)); this.pos.z = Math.max(-lim, Math.min(lim, this.pos.z));
      this.eyeH = 1.62;
      this.setCamera(dt, 0, now);
      this.vm.visible = false;
      return;
    }
    this.vm.visible = !!this.vmGun;
    const fwd = (k.KeyW ? 1 : 0) - (k.KeyS ? 1 : 0), side = (k.KeyD ? 1 : 0) - (k.KeyA ? 1 : 0);
    const ads = this.mouse.right && now > this.switchUntil && !(this.slot === 2 && this.gadgetKind() !== 'weapon');
    this.sprinting = !!k.ShiftLeft && fwd > 0 && !ads && this.stance !== 2 && now > this.reloadUntil - (wpn ? wpn.reload * 1000 : 0) + 0;
    if (this.sprinting && this.stance === 1) this.stance = 0;
    const adsTime = wpn ? wpn.adsTime : 0.2;
    this.adsT = Math.max(0, Math.min(1, this.adsT + (ads ? dt / adsTime : -dt / (adsTime * 0.8))));
    let speed = this.stance === 2 ? 1.1 : this.stance === 1 ? 2.3 : this.sprinting ? 6.8 : 4.3;
    if (this.adsT > 0.5) speed *= 0.6;
    if (wpn && wpn.weight > 6) speed *= 0.93;
    let wx = -Math.sin(this.cam.yaw) * fwd + Math.cos(this.cam.yaw) * side, wz = -Math.cos(this.cam.yaw) * fwd - Math.sin(this.cam.yaw) * side;
    const wl = Math.hypot(wx, wz); if (wl > 0) { wx /= wl; wz /= wl; }
    const ground = w.heightAt(this.pos.x, this.pos.z);
    const swimming = ground < w.waterLevel - 1.4 && this.pos.y <= w.waterLevel - 1.3;
    if (swimming) speed = 2.6;
    const accel = this.onGround || swimming ? 14 : 2.5;
    this.vel.x += (wx * speed - this.vel.x) * Math.min(1, dt * accel);
    this.vel.z += (wz * speed - this.vel.z) * Math.min(1, dt * accel);
    this.vel.y -= 21 * dt;
    const p = { x: this.pos.x + this.vel.x * dt, y: this.pos.y + this.vel.y * dt, z: this.pos.z + this.vel.z * dt };
    const height = this.stance === 2 ? 0.5 : this.stance === 1 ? 1.2 : 1.8;
    w.collide(p, 0.38, height);
    // slope limit
    const gNew = w.groundAt(p.x, p.z, this.pos.y + 0.35);
    if (this.onGround && gNew - this.pos.y > 0.6 && gNew > w.heightAt(p.x, p.z) + 0.1) { p.x = this.pos.x; p.z = this.pos.z; }
    let g = w.groundAt(p.x, p.z, this.pos.y + 0.35);
    if (swimming || (g < w.waterLevel - 1.4 && p.y < w.waterLevel - 1.3)) { p.y = Math.max(p.y, w.waterLevel - 1.3); this.vel.y = Math.max(0, this.vel.y); this.onGround = false; if (k.Space) p.y += dt; }
    if (p.y <= g) { p.y = g; if (this.vel.y < -16) this.hud.notice(''); this.vel.y = 0; this.onGround = true; }
    else if (this.onGround && p.y - g < 0.45 && this.vel.y <= 0) { p.y = g; this.vel.y = 0; }
    else this.onGround = false;
    this.pos.set(p.x, p.y, p.z);
    // footsteps
    const hs = Math.hypot(this.vel.x, this.vel.z);
    if (this.onGround && hs > 1) { this.stepAcc = (this.stepAcc || 0) + hs * dt; if (this.stepAcc > (this.sprinting ? 2.4 : 1.8)) { this.stepAcc = 0; this.audio.step(this.sprinting); } }
    // weapons
    this.bloom = Math.max(0, this.bloom - dt * 3);
    if (this.reloadUntil && now >= this.reloadUntil) {
      const w2 = this.weapon();
      if (w2) { const a = this.ammoOf(w2); const need = w2.mag - a.mag; const take = Math.min(need, a.res); a.mag += take; a.res -= take; }
      this.reloadUntil = 0;
    }
    if (!this.sprinting || this.mouse.left) this.tryFire(now);
    // stance eye height
    const targetEye = EYE[this.stance];
    this.eyeH = this.eyeH === undefined ? targetEye : this.eyeH + (targetEye - this.eyeH) * Math.min(1, dt * 10);
    this.setCamera(dt, hs, now);
    this.updateViewmodel(dt, now, mdx, mdy, hs);
    // lock-on for homing launchers
    this.lockTarget = null;
    if (wpn && wpn.homing && this.adsT > 0.8) {
      const d = this.aimDir();
      let bd = 0.94;
      for (const v of this.vehiclesR.values()) {
        if (v.destroyed || this.isFriend(v.team) || ((wpn.homing === 'air') !== VEHICLES[v.type].air)) continue;
        const to = new V3(v.x - this.pos.x, v.y - this.pos.y, v.z - this.pos.z);
        const L = to.length(); if (L > 900) continue;
        const c = to.dot(d) / L; if (c > bd) { bd = c; this.lockTarget = v; }
      }
    }
    // interaction prompt
    let prompt = '';
    const nv = this.nearestVehicle();
    if (nv) prompt = `[E] 탑승 — ${VEHICLES[nv.type].label}`;
    else if (this.lootMeshes) for (const [, m] of this.lootMeshes) if (Math.hypot(m.position.x - this.pos.x, m.position.z - this.pos.z) < 3) { prompt = '[E] 보급 상자 열기'; break; }
    $('interact').style.display = prompt ? 'block' : 'none';
    $('interact').textContent = prompt;
  }

  setCamera(dt, hs, now) {
    const bob = this.onGround ? Math.sin(now * 0.0105 * (this.sprinting ? 1.4 : 1)) * Math.min(1, hs / 5) * 0.035 * (1 - this.adsT * 0.8) : 0;
    // weapon sway when aiming through magnified optics; hold Shift to steady your breath
    const holding = !!this.keys.ShiftLeft && this.adsT > 0.8 && this.zoom >= 3 && this.breath > 0;
    this.breath = Math.max(0, Math.min(1, this.breath + (holding ? -dt / 4 : dt / 6)));
    const amp = (this.adsT > 0.5 && this.zoom >= 2 ? 0.0006 * Math.min(this.zoom, 8) : 0.00015) * this.adsT * (holding ? 0.1 : 1) * (this.stance === 2 ? 0.4 : this.stance === 1 ? 0.7 : 1) * (hs > 0.5 ? 2.2 : 1) * (this.breath <= 0 ? 1.8 : 1);
    this.sway.x = (Math.sin(now * 0.0013) + Math.sin(now * 0.0031 + 1.7) * 0.5) * amp;
    this.sway.y = (Math.cos(now * 0.0011 + 0.5) + Math.sin(now * 0.0027) * 0.5) * amp;
    this.camera.position.set(this.pos.x, this.pos.y + this.eyeH + bob, this.pos.z);
    this.camera.rotation.set(this.cam.pitch + this.sway.y, this.cam.yaw + this.sway.x, 0);
    const z = this.vmGun && this.adsT > 0 ? 1 + (this.zoom - 1) * this.adsT : 1;
    const base = THREE.MathUtils.degToRad(this.settings.fov);
    const fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(base / 2) / z)) * (this.sprinting ? 1.06 : 1);
    if (Math.abs(fov - this.camera.fov) > 0.01) { this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 20); this.camera.updateProjectionMatrix(); }
    const kind = this.sightKind;
    const magnified = kind === 'scope' || kind === 'acog';
    const scoped = this.adsT > 0.92 && magnified && !this.vehicle;
    const collim = this.adsT > 0.85 && (kind === 'red' || kind === 'holo' || kind === 'x2') && !this.vehicle;
    const size = innerWidth + 'x' + innerHeight;
    if (this.sightDirty || this._sightSize !== size) {
      this.sightDirty = false; this._sightSize = size;
      const sc = $('scopeCv'), cc = $('sightCv');
      if (magnified) { drawScope(sc, kind, this.zoom); cc.getContext('2d').clearRect(0, 0, cc.width, cc.height); }
      else { drawCollimator(cc, kind); sc.getContext('2d').clearRect(0, 0, sc.width, sc.height); }
    }
    $('scope').style.display = scoped ? 'block' : 'none';
    $('sightCv').style.opacity = collim ? 1 : 0;
    if (scoped && this.frame % 6 === 0) $('scopeInfo').textContent = `${this.zoom}X${this.zoom >= 3 ? '  ·  호흡 정지 [Shift] ' + Math.round(this.breath * 100) + '%' : ''}`;
    if (this.vmGun) this.vmGun.grp.visible = !scoped;
  }

  updateViewmodel(dt, now, mdx, mdy, hs) {
    if (!this.vmGun) return;
    const g = this.vmGun.grp, info = this.vmGun.info;
    const ads = this.adsT;
    const e = ads * ads * (3 - 2 * ads);
    const hip = new V3(0.15, -0.16, -0.4);
    const adsPos = new V3(0, -info.sightY, info.w && info.w.cat === 'pistol' ? -0.34 : -0.24);
    const pos = hip.clone().lerp(adsPos, e);
    // sway & bob
    this.swayX = (this.swayX || 0) * Math.exp(-dt * 8) + mdx * 0.00025;
    this.swayY = (this.swayY || 0) * Math.exp(-dt * 8) + mdy * 0.00025;
    const bobK = this.onGround ? Math.min(1, hs / 5) * (1 - e * 0.85) : 0;
    const t = now * 0.0105 * (this.sprinting ? 1.4 : 1);
    pos.x += Math.sin(t * 0.5) * 0.012 * bobK - this.swayX * (1 - e * 0.7);
    pos.y += Math.abs(Math.cos(t * 0.5)) * 0.014 * bobK + this.swayY * (1 - e * 0.7);
    const breath = Math.sin(now * 0.0016) * 0.002 * (1 - e * 0.7);
    pos.y += breath;
    this.vmKick = Math.max(0, (this.vmKick || 0) - dt * 9);
    pos.z += this.vmKick * 0.035;
    let rx = this.vmKick * 0.04 + this.swayY * 2, ry = this.swayX * 2, rz = 0;
    // sprint pose
    const sp = this.sprintBlend = (this.sprintBlend || 0) + ((this.sprinting ? 1 : 0) - (this.sprintBlend || 0)) * Math.min(1, dt * 8);
    pos.x += sp * 0.04; pos.y -= sp * 0.06; rx -= sp * 0.35; ry += sp * 0.6;
    // reload anim
    if (this.reloadUntil && now < this.reloadUntil) {
      const T = (now - this.reloadStart) / (this.reloadUntil - this.reloadStart);
      const s = Math.sin(Math.min(1, T) * Math.PI);
      rz += s * 0.5; rx += s * 0.25; pos.y -= s * 0.05;
      const mag = info.mag;
      if (mag && this.vmGun.magRest) {
        const m = T < 0.25 ? 0 : T < 0.5 ? (T - 0.25) / 0.25 : T < 0.7 ? 1 : T < 0.9 ? 1 - (T - 0.7) / 0.2 : 0;
        mag.position.copy(this.vmGun.magRest).add(new V3(0, -0.25 * m, 0.05 * m));
        mag.visible = !(T > 0.45 && T < 0.62);
      }
    } else if (info.mag && this.vmGun.magRest) { info.mag.position.copy(this.vmGun.magRest); info.mag.visible = true; }
    // weapon switch
    if (now < this.switchUntil) { const s = (this.switchUntil - now) / 450; pos.y -= s * 0.25; rx -= s * 0.6; }
    g.position.lerp(pos, Math.min(1, dt * 25));
    g.rotation.set(rx, ry, rz);
    if (this.flashT > 0) { this.flashT -= dt; if (this.flashT <= 0) this.vmFlash.visible = false; }
    this.vmSun.position.copy(this.env.sunDir).applyAxisAngle(new V3(0, 1, 0), -this.cam.yaw);
  }

  // ------------------------------------------------------------ vehicles (local)
  updateVehicle(dt, now, mdx, mdy, sens) {
    const v = this.vehicle;
    const res = v.update(dt, { mdx, mdy, sens, keys: this.keys });
    if (res === 'crash') { this.net.send({ t: 'vcrash' }); }
    this.pos.set(v.x, v.y, v.z);
    this.cam.yaw = v.aimYaw; this.cam.pitch = v.aimPitch;
    const spec = VEHICLES[v.type];
    // weapons
    if (this.mouse.left || this.mouse.right) {
      const kind = this.mouse.left ? (spec.weapon ? 'main' : 'mg') : 'mg';
      this.vehicleFire(kind, now);
      if (this.mouse.left && this.mouse.right && spec.weapon) this.vehicleFire('mg', now);
    }
    // camera
    const target = new V3(v.x, v.y + spec.height + 1, v.z);
    const d = this.aimDirFrom(v.aimYaw, v.aimPitch);
    if (this.thirdPerson) {
      const dist = { tank: 13, ifv: 12, jeep: 9, heli: 17, jet: 24 }[v.type];
      const cp = target.clone().addScaledVector(d, -dist).add(new V3(0, 2, 0));
      const gy = this.world.heightAt(cp.x, cp.z) + 1;
      if (cp.y < gy) cp.y = gy;
      this.camera.position.lerp(cp, Math.min(1, dt * 12));
      this.camera.lookAt(target.clone().addScaledVector(d, 30));
    } else {
      const fp = new V3(v.x, v.y + spec.height * (v.type === 'jet' ? 0.85 : 0.9), v.z);
      if (v.type === 'jet' || v.type === 'heli') fp.add(new V3(-Math.sin(v.yaw) * (v.type === 'jet' ? 3.6 : 2.0), 0.4, -Math.cos(v.yaw) * (v.type === 'jet' ? 3.6 : 2.0)));
      this.camera.position.copy(fp);
      this.camera.rotation.set(v.aimPitch, v.aimYaw, v.type === 'jet' || v.type === 'heli' ? v.roll * 0.5 : 0);
    }
    if (Math.abs(this.camera.fov - this.settings.fov) > 0.1) { this.camera.fov = this.settings.fov; this.camera.updateProjectionMatrix(); }
    this.vm.visible = false;
    $('scope').style.display = 'none';
    this.audio.setEngine(v.type, Math.min(1, Math.abs(v.speed) / spec.speed));
    $('interact').style.display = 'none';
    // lock-on for jet missiles
    this.lockTarget = null;
    if (v.type === 'jet' || v.type === 'heli') {
      const fd = v.type === 'jet' ? this.aimDirFrom(v.yaw, v.pitch) : d;
      let bd = 0.96;
      for (const o of this.vehiclesR.values()) {
        if (o.destroyed || o.id === v.id || this.isFriend(o.team) || !o.occupied) continue;
        const to = new V3(o.x - v.x, o.y - v.y, o.z - v.z); const L = to.length(); if (L > 900) continue;
        const c = to.dot(fd) / L; if (c > bd) { bd = c; this.lockTarget = o; }
      }
    }
  }

  aimDirFrom(yaw, pitch) { return new V3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)); }

  vehicleWeaponRay(kind) {
    const v = this.vehicle, spec = VEHICLES[v.type];
    let d, o;
    if (v.type === 'tank' || v.type === 'ifv') {
      const yaw = v.yaw + v.turret;
      const pitch = Math.max(-0.15, Math.min(0.4, v.aimPitch + 0.05));
      d = this.aimDirFrom(yaw, pitch);
      o = new V3(v.x, v.y + spec.height + 0.5, v.z).addScaledVector(d, v.type === 'tank' ? 6.5 : 3.5);
      if (kind === 'mg') { d = this.aimDirFrom(v.aimYaw, v.aimPitch); o = new V3(v.x, v.y + spec.height + 1.2, v.z).addScaledVector(d, 2); }
    } else if (v.type === 'jet') {
      d = this.aimDirFrom(v.yaw, v.pitch);
      o = new V3(v.x, v.y + 1.8, v.z).addScaledVector(d, 9);
    } else {
      // aim through the crosshair: find what the camera looks at
      const cd = this.aimDirFrom(v.aimYaw, v.aimPitch);
      const cp = this.camera.position;
      const hit = this.world.raycast(cp.x, cp.y, cp.z, cd.x, cd.y, cd.z, 1200);
      const aimPt = cp.clone().addScaledVector(cd, hit.dist);
      o = new V3(v.x, v.y + (v.type === 'jeep' ? 2.5 : 1.3), v.z).addScaledVector(this.aimDirFrom(v.yaw, 0), v.type === 'heli' ? 3 : 0.5);
      d = aimPt.sub(o).normalize();
    }
    return { o, d };
  }

  vehicleAimPoint() {
    if (!this.vehicle) return null;
    const { o, d } = this.vehicleWeaponRay(VEHICLES[this.vehicle.type].weapon ? 'main' : 'mg');
    const hit = this.world.raycast(o.x, o.y, o.z, d.x, d.y, d.z, 1500);
    return o.addScaledVector(d, Math.min(hit.dist, 600));
  }

  vehicleFire(kind, now) {
    const v = this.vehicle, spec = VEHICLES[v.type];
    if (kind === 'main') {
      const w = spec.weapon;
      if (!w) return;
      if (w.clip) { if (v.clip <= 0) { if (now - v.lastMain > w.clipReload * 1000) v.clip = w.clip; else return; } }
      if (now - v.lastMain < w.reload * 1000) return;
      v.lastMain = now;
      if (w.clip) v.clip--;
      const { o, d } = this.vehicleWeaponRay('main');
      this.net.send({ t: 'vfire', k: 'main', o: o.toArray(), d: d.toArray(), vt: Math.round(this.renderTime()) });
      this.fx.muzzleFlash(o, v.type === 'tank' ? 3 : 1.2, true);
      this.audio.gunshot(v.type === 'tank' ? 'veh' : 'launcher', o.x, o.y, o.z, false, true);
      if (v.type === 'tank') { this.fx.shake = 0.3; for (let i = 0; i < 20; i++) this.fx.smoke.emit(o.x, o.y, o.z, (Math.random() - 0.5) * 6, Math.random() * 2, (Math.random() - 0.5) * 6, 1.5, 0.75, 0.73, 0.7, 0.6, 2, { grow: 2, drag: 2 }); }
    } else {
      if (!spec.mg) return;
      if (now - v.lastMg < 60000 / spec.mg.rpm) return;
      v.lastMg = now;
      const { o, d } = this.vehicleWeaponRay('mg');
      const sp = 0.012;
      d.x += (Math.random() - 0.5) * sp; d.y += (Math.random() - 0.5) * sp; d.z += (Math.random() - 0.5) * sp; d.normalize();
      this.net.send({ t: 'vfire', k: 'mg', o: o.toArray(), d: d.toArray(), vt: Math.round(this.renderTime()) });
      const hit = this.world.raycast(o.x, o.y, o.z, d.x, d.y, d.z, 900);
      const end = o.clone().addScaledVector(d, hit.dist);
      this.fx.tracer(o, end, 800);
      this.fx.muzzleFlash(o, 0.6, false);
      if (hit.type) this.fx.impact(end, new V3(0, 1, 0), 2);
      this.audio.gunshot('mg', o.x, o.y, o.z, false, true);
    }
  }

  // ------------------------------------------------------------ death cam
  updateDeathCam(dt, now) {
    this.vm.visible = false;
    $('scope').style.display = 'none';
    $('interact').style.display = 'none';
    const k = this.soldiers.get(this.killerId);
    const t = (now - this.deathAt) / 1000;
    const center = this.pos.clone().add(new V3(0, 1, 0));
    const ang = this.cam.yaw + t * 0.15;
    const camPos = center.clone().add(new V3(Math.sin(ang) * 6, 3 + t * 0.4, Math.cos(ang) * 6));
    this.camera.position.lerp(camPos, Math.min(1, dt * 3));
    const look = k && k.visible && t > 1.2 ? new V3(k.x, k.y + 1.4, k.z) : center;
    this.camera.lookAt(look);
    if (Math.abs(this.camera.fov - this.settings.fov) > 0.1) { this.camera.fov = this.settings.fov; this.camera.updateProjectionMatrix(); }
    if (this.mode.respawn && !this.ended && t > 4.5 && !this.deployShown) { this.deployShown = true; this.ui.showDeploy(this); }
  }

  // ------------------------------------------------------------ remote entities
  updateClock(serverTime) {
    const off = serverTime - performance.now();
    if (!this.clockInit) { this.timeOffset = off; this.clockInit = true; return; }
    if (off > this.timeOffset) this.timeOffset += (off - this.timeOffset) * 0.2;
    else this.timeOffset += (off - this.timeOffset) * 0.02;
  }

  onSnapshot(buf) {
    const s = decodeSnapshot(buf);
    this.updateClock(s.time);
    const seen = new Set();
    for (const p of s.players) {
      seen.add(p.id);
      if (p.id === this.me.id) {
        if (this.me.alive && (p.flags & PF.ALIVE)) this.me.hp = p.hp;
        continue;
      }
      let e = this.soldiers.get(p.id);
      if (!e) { e = { id: p.id, buf: [], visible: false, soldier: null, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: 0, alive: true, flags: 0, team: p.team, veh: -1, stance: 0, speed: 0 }; this.soldiers.set(p.id, e); }
      e.team = p.team;
      e.buf.push({ t: s.time, ...p });
      if (e.buf.length > 30) e.buf.shift();
      e.lastSnap = s.time;
      if ((p.flags & PF.FIRING) && !(p.flags & PF.BOT)) this.loudShooters.add(p.id);
    }
    for (const e of this.soldiers.values()) if (!seen.has(e.id)) e.gone = true; else e.gone = false;
    for (const v of s.vehicles) {
      const r = this._ensureVehicle(v.id, v.type, v.team);
      r.buf.push({ t: s.time, ...v });
      if (r.buf.length > 30) r.buf.shift();
      const destroyed = !!(v.flags & VF.DESTROYED);
      if (destroyed && !r.destroyed) { r.group.visible = false; }
      r.destroyed = destroyed; r.occupied = !!(v.flags & VF.OCCUPIED); r.driver = v.driver; r.hp = v.hp;
    }
  }

  sample(buf, rt) {
    if (!buf.length) return null;
    if (rt <= buf[0].t) return buf[0];
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].t <= rt) {
        const a = buf[i], b = buf[i + 1];
        if (!b) return a;
        const k = (rt - a.t) / Math.max(1, b.t - a.t);
        return { ...b, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k, yaw: lerpAngle(a.yaw, b.yaw, k), pitch: a.pitch + (b.pitch - a.pitch) * k, roll: a.roll !== undefined ? lerpAngle(a.roll, b.roll, k) : 0, turret: a.turret !== undefined ? lerpAngle(a.turret, b.turret, k) : 0 };
      }
    }
    return buf[0];
  }

  updateRemote(dt) {
    const rt = this.renderTime();
    const cam = this.camera.position;
    for (const e of this.soldiers.values()) {
      const s = this.sample(e.buf, rt);
      if (!s || e.gone) { e.visible = false; if (e.soldier) e.soldier.root.visible = false; continue; }
      const px = e.x, pz = e.z;
      e.x = s.x; e.y = s.y; e.z = s.z; e.yaw = s.yaw; e.pitch = s.pitch; e.flags = s.flags; e.veh = s.veh; e.weapon = s.weapon; e.hp = s.hp;
      e.alive = !!(s.flags & PF.ALIVE);
      e.stance = s.flags & PF.PRONE ? 2 : s.flags & PF.CROUCH ? 1 : 0;
      const sp = Math.hypot(e.x - px, e.z - pz) / Math.max(dt, 1e-3);
      e.speed = e.speed + (Math.min(sp, 9) - e.speed) * Math.min(1, dt * 8);
      const dist = Math.hypot(e.x - cam.x, e.z - cam.z);
      e.visible = e.veh < 0;
      const show = e.visible && dist < 1100;
      if (show && !e.soldier) {
        e.soldier = new Soldier(this.paletteFor(e.team));
        this.scene.add(e.soldier.root);
      }
      if (!e.soldier) continue;
      e.soldier.root.visible = show;
      if (!show) continue;
      e.soldier.root.position.set(e.x, e.y, e.z);
      e.soldier.root.rotation.y = e.yaw;
      e.soldier.mesh.castShadow = dist < 70;
      e.soldier.setWeapon(e.weapon);
      if (dist < 90 || (this.frame + e.id) % (dist < 300 ? 2 : 4) === 0) {
        e.soldier.animate({ dt: dist < 90 ? dt : dt * (dist < 300 ? 2 : 4), speed: e.speed, stance: e.stance, pitch: e.pitch, alive: e.alive, para: e.flags & PF.PARACHUTE ? (e.y - this.world.heightAt(e.x, e.z) > 140 ? 1 : 2) : 0, firing: !!(e.flags & PF.FIRING), ads: !!(e.flags & PF.ADS) });
      }
    }
    for (const v of this.vehiclesR.values()) {
      if (this.vehicle && this.vehicle.id === v.id) {
        const c = this.vehicle;
        Object.assign(v, { x: c.x, y: c.y, z: c.z, yaw: c.yaw, pitch: c.pitch, roll: c.roll, turret: c.turret });
        v.speed = c.speed;
      } else {
        const s = this.sample(v.buf, rt);
        if (!s) continue;
        const px = v.x, pz = v.z;
        Object.assign(v, { x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch, roll: s.roll, turret: s.turret });
        v.speed = Math.hypot(v.x - px, v.z - pz) / Math.max(dt, 1e-3);
      }
      v.group.visible = !v.destroyed;
      if (v.destroyed) continue;
      v.group.position.set(v.x, v.y, v.z);
      v.group.rotation.set(v.pitch, v.yaw, v.roll, 'YXZ');
      const P = v.parts;
      if (P.turret) { P.turret.rotation.y = v.turret; if (P.barrel) P.barrel.rotation.x = this.vehicle && this.vehicle.id === v.id ? Math.max(-0.15, Math.min(0.4, this.vehicle.aimPitch + 0.05)) : 0.03; }
      if (P.rotor) { v.rotor += dt * (v.occupied || v.y - this.world.heightAt(v.x, v.z) > 1 ? 28 : 2); P.rotor.rotation.y = v.rotor; P.tail.rotation.x = v.rotor * 1.5; }
      if (P.wheels) for (const w of P.wheels) w.rotation.x += (v.speed || 0) * dt / 0.45;
      if (P.glow) P.glow.material.opacity = v.occupied ? 0.5 + Math.random() * 0.4 : 0;
      // damaged vehicles smoke
      if (v.hp < VEHICLES[v.type].hp * 0.35 && Math.random() < dt * 8) this.fx.smoke.emit(v.x, v.y + 2, v.z, 0, 2, 0, 1.2, 0.15, 0.15, 0.15, 0.6, 3, { grow: 1.5, drag: 0.5 });
      // rotor wash dust
      if (v.type === 'heli' && v.occupied && v.y - this.world.heightAt(v.x, v.z) < 25 && Math.random() < dt * 15) {
        const a = Math.random() * 6.28; const gy = this.world.heightAt(v.x, v.z);
        this.fx.smoke.emit(v.x + Math.cos(a) * 4, gy + 0.5, v.z + Math.sin(a) * 4, Math.cos(a) * 8, 0.5, Math.sin(a) * 8, 1.5, 0.6, 0.55, 0.45, 0.35, 1.5, { grow: 2, drag: 1.5 });
      }
    }
  }

  // ------------------------------------------------------------ server events
  onEvents(msg) {
    for (const e of msg.e || []) this.onEvent(e);
    for (const e of msg.pe || []) this.onPrivate(e);
  }

  onEvent(e) {
    const fx = this.fx;
    switch (e[0]) {
      case 'j': this.roster.set(e[1], { id: e[1], name: e[2], team: e[3], squad: e[4], bot: !!e[5], cls: e[6] }); break;
      case 'l': { this.roster.delete(e[1]); const s = this.soldiers.get(e[1]); if (s) { if (s.soldier) this.scene.remove(s.soldier.root); this.soldiers.delete(e[1]); } break; }
      case 's': {
        const [, id, ex, ey, ez, hit, wid, sup] = e;
        if (id === this.me.id) break;
        const sh = this.soldiers.get(id);
        const end = new V3(ex, ey, ez);
        let from;
        if (sh && sh.veh < 0) {
          from = new V3(sh.x - Math.sin(sh.yaw) * 0.7, sh.y + (sh.stance === 1 ? 1.05 : sh.stance === 2 ? 0.35 : 1.45), sh.z - Math.cos(sh.yaw) * 0.7);
        } else if (sh && sh.veh >= 0) {
          const v = this.vehiclesR.get(sh.veh); if (!v) break;
          from = new V3(v.x, v.y + VEHICLES[v.type].height, v.z).addScaledVector(end.clone().sub(new V3(v.x, v.y, v.z)).normalize(), 3);
        } else break;
        const d = from.distanceTo(this.camera.position);
        const w = WEAPONS[wid];
        const cat = wid === 240 ? 'mg' : w ? w.cat : 'ar';
        this.audio.gunshot(cat, from.x, from.y, from.z, !!sup);
        if (d < 600) {
          if (!sup) fx.muzzleFlash(from, cat === 'mg' ? 0.8 : 0.45, d < 40);
          if (Math.random() < 0.6) fx.tracer(from, end, w ? Math.min(900, w.vel) : 800);
          if (hit && end.distanceTo(this.camera.position) < 250) fx.impact(end, hit === 2 ? new V3(...this.world.normalAt(ex, ez)) : from.clone().sub(end).normalize(), hit);
        }
        // near miss
        if (this.me.alive && !this.isFriend(sh ? sh.team : -1)) {
          const cp = this.camera.position, dir = end.clone().sub(from); const L = dir.length(); dir.normalize();
          const t = Math.max(0, Math.min(L, cp.clone().sub(from).dot(dir)));
          const closest = from.clone().addScaledVector(dir, t);
          if (closest.distanceTo(cp) < 2.5 && t > 5) { this.audio.whiz(from.x, from.z); this.grade.uniforms.uVig.value = 0.9; setTimeout(() => (this.grade.uniforms.uVig.value = 0.35), 400); }
        }
        break;
      }
      case 'k': {
        const [, killer, victim, wid, head] = e;
        this.hud.killfeed(killer, victim, wid, head);
        if (victim === this.me.id) this.onDeath(killer);
        else if (killer === this.me.id) { this.audio.kill(); const r = this.roster.get(victim); this.hud.notice(`+${100 + (head ? 25 : 0)}`, `${r ? r.name : ''} 처치${head ? ' · 헤드샷' : ''}`, '#cfefff'); }
        const s = this.soldiers.get(victim); if (s) s.alive = false;
        break;
      }
      case 'p': {
        const [, id, kind, x, y, z, vx, vy, vz] = e;
        fx.spawnProjectile(id, kind, new V3(x, y, z), new V3(vx, vy, vz));
        if (kind === 'rocket' && e[9] !== this.me.id) this.audio.gunshot('launcher', x, y, z);
        if (kind === 'shell' && e[9] !== this.me.id) { this.audio.gunshot('veh', x, y, z); fx.muzzleFlash(new V3(x, y, z), 2.5, true); }
        break;
      }
      case 'pu': fx.updateProjectile(e[1], new V3(e[2], e[3], e[4]), new V3(e[5], e[6], e[7])); break;
      case 'x': {
        fx.removeProjectile(e[1]);
        if (e[5] === 0) break;
        const p = new V3(e[2], e[3], e[4]);
        fx.explosion(p, e[5]);
        this.audio.explosion(p.x, p.y, p.z, e[5]);
        break;
      }
      case 'vd': {
        const v = this.vehiclesR.get(e[1]);
        const p = new V3(e[2], e[3], e[4]);
        fx.explosion(p, 2); fx.explosion(p.clone().add(new V3(0, 2, 0)), 1); fx.addWreck(p);
        this.audio.explosion(p.x, p.y, p.z, 2);
        if (v) { v.destroyed = true; v.group.visible = false; }
        if (this.vehicle && this.vehicle.id === e[1]) this.leaveVehicleLocal();
        break;
      }
      case 'vr': { const v = this.vehiclesR.get(e[1]); if (v) { v.destroyed = false; v.buf = []; } break; }
      case 'cap': {
        const mine = e[2] === this.me.team;
        this.hud.notice(`거점 ${e[1]} ${mine ? '점령' : '상실'}`, '', mine ? '#42b8ff' : '#ff4b3a');
        break;
      }
      case 'hill': this.hud.notice('거점 이동', '새 하드포인트 위치를 확인하세요', '#9fd8ff'); break;
      case 'sec': this.hud.notice(this.state && this.state.att === this.me.team ? '구역 돌파! 전진하라' : '구역 상실! 후퇴하라', `섹터 ${e[1] + 1}`, '#bfe9ff'); break;
      case 'bx': {
        const m = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.35, 0.4), new THREE.MeshStandardMaterial({ color: 0x4d5a37, roughness: 0.7 }));
        m.position.set(e[2], e[3] + 0.18, e[4]); m.castShadow = true; this.scene.add(m); this.boxes.set(e[1], m);
        break;
      }
      case 'bxr': { const m = this.boxes.get(e[1]); if (m) { this.scene.remove(m); this.boxes.delete(e[1]); } break; }
      case 'lo': { if (this.lootMeshes) { const m = this.lootMeshes.get(e[1]); if (m) { this.scene.remove(m); this.lootMeshes.delete(e[1]); } } break; }
      case 'ld': if (this.lootMeshes) this._addLoot(e[1], e[2], e[3], e[4]); break;
    }
  }

  onPrivate(e) {
    switch (e[0]) {
      case 'h': this.hud.hit(!!e[2], !!e[3]); this.audio.hit(!!e[2]); break;
      case 'd': {
        this.me.hp = e[3];
        this.hud.damaged(e[1], e[2]);
        this.audio.hurt();
        break;
      }
      case 'sp': this.onSpawn(e); break;
      case 've': {
        const [, vid, type, x, y, z, yaw, pitch, roll, , clip] = e;
        this.vehicle = new VehicleController(this, vid, type, [x, y, z, yaw, pitch, roll, 0, 0, 0, 0, clip]);
        this.vehicle.aimYaw = yaw; this.vehicle.aimPitch = 0;
        this.thirdPerson = true;
        this.stance = 0;
        $('vehHud').style.display = 'block';
        this.hud.notice(VEHICLES[type].label, '[E] 하차 · [V] 시점 전환', '#9fd8ff');
        break;
      }
      case 'vx': {
        this.leaveVehicleLocal();
        this.pos.set(e[1], e[2], e[3]); this.vel.set(0, 0, 0);
        if (e[4]) this.para = 2;
        break;
      }
      case 'rs': {
        for (const [id, a] of this.ammo) { const w = WEAPONS[id]; a.res = Math.min(w.reserve * 2, a.res + w.mag); }
        this.grenades = Math.min(2, this.grenades + 1);
        if (this.me.loadout && this.me.loadout.cls === 'recon') this.c4Count = Math.min(3, this.c4Count + 1);
        break;
      }
      case 'gm': {
        // gun master: the server promoted our weapon
        const w = WEAPONS[e[1]];
        this.me.loadout.primary = w.id; this.me.loadout.sight = w.sight; this.me.loadout.muzzle = w.muzzleDefault;
        this.ammo.set(w.id, { mag: w.mag, res: w.reserve });
        this.slot = -1; this.switchSlot(0);
        this.hud.notice(w.name, `무기 ${e[2] + 1} / ${this.mode.scoreLimit}`, '#9fd8ff');
        break;
      }
      case 'lw': {
        this.brWeapon = e[1];
        this.ammo.set(e[1], { mag: WEAPONS[e[1]].mag, res: WEAPONS[e[1]].reserve });
        this.slot = -1; this.switchSlot(0);
        this.hud.notice(WEAPONS[e[1]].name, '무기 획득', '#bfe9ff');
        break;
      }
    }
  }

  leaveVehicleLocal() {
    this.vehicle = null;
    this.audio.setEngine(null);
    $('vehHud').style.display = 'none';
    if (this.camera.fov !== this.settings.fov) { this.camera.fov = this.settings.fov; this.camera.updateProjectionMatrix(); }
  }

  onSpawn(e) {
    const [, x, y, z, yaw, veh, loadout, para] = e;
    this.me.alive = true; this.me.hp = 100;
    this.me.loadout = loadout;
    this.pos.set(x, y, z); this.vel.set(0, 0, 0);
    this.cam.yaw = yaw; this.cam.pitch = 0;
    this.stance = 0; this.para = para ? 1 : 0; this.adsT = 0;
    this.ammo.clear();
    this.grenades = 2; this.c4Count = 3;
    this.slot = -1;
    if (this.mode.br) this.brWeapon = -1;
    this.switchSlot(this.mode.br ? 1 : 0);
    this.deployShown = false;
    this.ui.hideDeploy();
    $('deathCam').style.display = 'none';
    if (veh < 0) this.leaveVehicleLocal();
    this.lock();
  }

  onDeath(killerId) {
    this.me.alive = false;
    this.deathAt = performance.now();
    this.killerId = killerId;
    this.adsT = 0;
    if (this.vehicle) this.leaveVehicleLocal();
    const r = this.roster.get(killerId);
    const dc = $('deathCam');
    dc.style.display = 'block';
    dc.innerHTML = killerId >= 0 && killerId !== this.me.id && r ? `<div style="color:#ff6a5a">사망</div><div style="font-size:16px">${r.name}${r.bot ? ' (AI)' : ''}에게 처치당했습니다</div>` : '<div style="color:#ff6a5a">사망</div>';
    if (!this.mode.respawn) dc.innerHTML += '<div style="font-size:15px;margin-top:8px">탈락했습니다 — 분대가 계속 싸우고 있습니다. [Esc] 메뉴</div>';
    if (document.pointerLockElement && this.mode.respawn) setTimeout(() => { if (!this.me.alive && document.pointerLockElement) document.exitPointerLock(); }, 4400);
  }

  onState(s) {
    this.state = s;
    this.hud.updateObjectives();
    if (s.obj) this.env.setObjectives(s.obj.map(([id, owner, prog, contested, x, z, radius]) => ({ id, owner, prog, contested, x, z, radius })), this.me.team);
  }

  onBoard(b) { for (const row of b) this.board.set(row[0], row); if ($('scoreboard').style.display === 'block') this.hud.renderScoreboard(); }

  // ------------------------------------------------------------ deploy helpers
  spawnOptions() {
    const opts = [];
    if (this.mode.br) return opts;
    if (this.state && this.state.area) return [{ id: 'area', label: '전투 구역' }];
    opts.push({ id: 'hq', label: '본부 (HQ)', x: this.world.bases[this.me.team]?.x, z: this.world.bases[this.me.team]?.z });
    if (this.state && this.state.obj) for (const [id, owner, , contested, x, z] of this.state.obj) if (owner === this.me.team && !contested) opts.push({ id: 'flag:' + id, label: '거점 ' + id, x, z });
    for (const e of this.soldiers.values()) {
      const r = this.roster.get(e.id);
      if (r && e.alive && e.visible && r.team === this.me.team && r.squad === this.me.squad) opts.push({ id: 'squad:' + e.id, label: '분대원 ' + r.name, x: e.x, z: e.z });
    }
    for (const v of this.vehiclesR.values()) {
      const b = this.world.bases[this.me.team];
      if (!v.destroyed && v.team === this.me.team && v.driver < 0 && b && Math.hypot(v.x - b.x, v.z - b.z) < 140) opts.push({ id: 'veh:' + v.id, label: VEHICLES[v.type].label, x: v.x, z: v.z });
    }
    return opts;
  }

  // ------------------------------------------------------------ HUD panels
  updateHudPanels(now) {
    if (this.frame % 3) return;
    const w = this.weapon();
    if (this.vehicle) {
      const v = this.vehicle, spec = VEHICLES[v.type];
      const r = this.vehiclesR.get(v.id);
      const hp = r ? Math.round((r.hp / spec.hp) * 100) : 100;
      let wpn = '';
      if (spec.weapon) { const ready = now - v.lastMain > spec.weapon.reload * 1000; wpn = `${spec.weapon.name}: ${spec.weapon.clip ? v.clip + '/' + spec.weapon.clip : ready ? '준비' : '재장전'}`; }
      const alt = v.type === 'heli' || v.type === 'jet' ? ` · 고도 ${Math.round(v.y - this.world.heightAt(v.x, v.z))}m` : '';
      $('vehHud').innerHTML = `<b>${spec.label}</b> · 내구도 <span style="color:${hp < 35 ? '#ff5a3a' : '#7cff8a'}">${hp}%</span> · ${Math.round(Math.abs(v.speed) * 3.6)} km/h${alt}<br><small>${wpn}${v.type === 'jet' ? ' · 스로틀 ' + Math.round(v.throttle * 100) + '%' : ''}</small>`;
    }
    $('wName').textContent = this.vehicle ? '' : w ? w.name : this.gadgetKind() === 'box' ? '보급 상자' : this.gadgetKind() === 'c4' ? 'C4 폭약' : '';
    if (w && !this.vehicle) {
      const a = this.ammoOf(w);
      $('wMag').textContent = this.reloadUntil ? '··' : a.mag; $('wRes').textContent = a.res;
      $('wMode').textContent = (w.modes[this.fireModeIdx % w.modes.length] || '').toUpperCase();
    } else {
      $('wMag').textContent = this.gadgetKind() === 'c4' && this.slot === 2 ? this.c4Count : '-'; $('wRes').textContent = ''; $('wMode').textContent = '';
    }
    $('gGren').textContent = `수류탄 ${this.grenades}`;
    const gk = this.gadgetKind();
    $('gGadget').textContent = gk === 'box' ? (now > this.boxReady ? '보급상자 준비' : `보급상자 ${Math.ceil((this.boxReady - now) / 1000)}s`) : gk === 'c4' ? `C4 ${this.c4Count}` : gk === 'weapon' ? WEAPONS[this.me.loadout.gadget].name : '';
    const hp = Math.max(0, Math.round(this.me.hp));
    $('hpBar').style.width = hp + '%';
    $('hpBar').style.background = hp < 35 ? '#ff4b3a' : '';
    $('hpText').textContent = hp;
  }

  render() {
    this.composer.render();
  }

  showEnd(msg) {
    this.ended = true;
    const g = this;
    const won = msg.winner === this.me.team;
    const rows = msg.board.map(([id, k, d, s]) => ({ id, k, d, s, r: this.roster.get(id) })).filter((x) => x.r).sort((a, b) => b.s - a.s).slice(0, 12);
    const title = this.mode.teams === 2 || this.mode.br ? (won ? '승리' : '패배') : (msg.winner === this.me.team ? '1위!' : '경기 종료');
    $('endScreen').innerHTML = `<div class="win ${won ? 'victory' : 'defeat'}">${title}</div>
      <div>${this.mode.name} · ${this.map.name}</div>
      <table><tr><th>#</th><th style="text-align:left">이름</th><th>K</th><th>D</th><th>점수</th></tr>
      ${rows.map((x, i) => `<tr style="${x.id === g.me.id ? 'color:#ffffff' : ''}"><td>${i + 1}</td><td style="text-align:left">${x.r.name}${x.r.bot ? ' <small style="opacity:.5">BOT</small>' : ''}</td><td>${x.k}</td><td>${x.d}</td><td>${x.s}</td></tr>`).join('')}</table>
      <button class="primary" id="btnEndMenu">메뉴로</button>`;
    $('endScreen').style.display = 'block';
    $('btnEndMenu').onclick = () => this.ui.exitMatch();
    this.engaged = false; if (document.pointerLockElement) document.exitPointerLock();
  }
}

const C4VEL = 10;
function tick() { return new Promise((r) => setTimeout(r, 0)); }

// Show runtime errors on screen so they can be reported (the loop keeps running either way).
const seenErrors = new Set();
export function reportError(where, e) {
  const msg = `${where}: ${e && e.message ? e.message : e}`;
  if (seenErrors.has(msg)) return;
  seenErrors.add(msg);
  console.error(msg, e);
  let box = document.getElementById('errbox');
  if (!box) { box = document.createElement('div'); box.id = 'errbox'; document.body.appendChild(box); }
  const stack = e && e.stack ? String(e.stack).split('\n').slice(0, 3).join(' | ') : '';
  box.textContent = `오류 ${seenErrors.size}개 — ` + [...seenErrors].slice(-3).join(' // ') + (stack ? '\n' + stack.slice(0, 300) : '');
}
