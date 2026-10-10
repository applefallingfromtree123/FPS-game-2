// World rendering: terrain, GPU grass, instanced trees with LOD, buildings,
// cover props, water, physically based sky, clouds, rain and lighting.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeNoise2D, fbm, Rng, smoothstep, clamp } from '/shared/rng.js';
import { distToSeg } from '/shared/world.js';
import * as TX from './textures.js';

export const QUALITY = [
  { name: 'low',    pixelRatio: 0.75, shadow: 1024, grass: 40000,  grassR: 40, treeNear: 160, treeFar: 700,  terrainStep: 2, bloom: false, msaa: 0, far: 1600 },
  { name: 'medium', pixelRatio: 1.0,  shadow: 2048, grass: 110000, grassR: 55, treeNear: 240, treeFar: 1100, terrainStep: 1, bloom: true,  msaa: 0, far: 2200 },
  { name: 'high',   pixelRatio: 1.0,  shadow: 2048, grass: 200000, grassR: 70, treeNear: 320, treeFar: 1500, terrainStep: 1, bloom: true,  msaa: 4, far: 2800 },
  { name: 'ultra',  pixelRatio: 1.5,  shadow: 4096, grass: 320000, grassR: 85, treeNear: 420, treeFar: 2000, terrainStep: 1, bloom: true,  msaa: 4, far: 3200 },
];

const col = (a) => new THREE.Color(a[0], a[1], a[2]);

export class Environment {
  constructor(scene, world, renderer, quality, progress = () => {}) {
    this.scene = scene; this.world = world; this.renderer = renderer; this.q = quality;
    this.biome = world.biome; this.time = world.time;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.uniforms = { uTime: { value: 0 }, uWind: { value: new THREE.Vector2(1, 0.4) } };
    progress(0.1, '하늘과 조명');
    this.buildSky();
    progress(0.25, '지형 생성');
    this.buildTerrain();
    progress(0.45, '잔디 생성');
    this.buildGrass();
    progress(0.6, '나무 생성');
    this.buildTrees();
    progress(0.75, '건물 생성');
    this.buildBuildings();
    progress(0.85, '물과 날씨');
    this.buildWater();
    this.buildClouds();
    if (this.time.rain) this.buildRain();
    this.buildObjectiveMarkers();
  }

  // ------------------------------------------------------------ sky & light
  buildSky() {
    const t = this.time;
    const sky = new Sky();
    sky.scale.setScalar(20000);
    const u = sky.material.uniforms;
    u.turbidity.value = t.turbidity; u.rayleigh.value = t.rayleigh; u.mieCoefficient.value = 0.005; u.mieDirectionalG.value = 0.8;
    const phi = THREE.MathUtils.degToRad(90 - t.sunElev), theta = THREE.MathUtils.degToRad(t.sunAz);
    this.sunDir = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
    u.sunPosition.value.copy(this.sunDir);
    this.sky = sky;
    this.scene.add(sky);
    // environment map from sky for PBR reflections / ambient
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    const sky2 = new Sky(); sky2.scale.setScalar(1000);
    Object.assign(sky2.material.uniforms.sunPosition.value, this.sunDir);
    for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG']) sky2.material.uniforms[k].value = u[k].value;
    envScene.add(sky2);
    this.envMap = pmrem.fromScene(envScene, 0, 0.1, 2000).texture;
    this.scene.environment = this.envMap;
    this.scene.environmentIntensity = 0.4 * (t.clouds ? 0.8 : 1);
    pmrem.dispose();
    // lights
    const sun = new THREE.DirectionalLight(col(t.sunColor), t.sunIntensity);
    sun.position.copy(this.sunDir).multiplyScalar(400);
    sun.castShadow = true;
    sun.shadow.mapSize.set(this.q.shadow, this.q.shadow);
    const S = 90;
    Object.assign(sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S, near: 1, far: 1200 });
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.6;
    this.sun = sun;
    this.scene.add(sun, sun.target);
    const fogC = col(this.biome.fog).lerp(new THREE.Color(1, 1, 1), 0.1);
    if (t.sunElev < 10) fogC.lerp(new THREE.Color(1.0, 0.6, 0.4), 0.35);
    if (t.clouds) fogC.lerp(new THREE.Color(0.55, 0.58, 0.62), 0.5);
    this.hemi = new THREE.HemisphereLight(fogC.clone().lerp(new THREE.Color(0.6, 0.75, 1), 0.4), col(this.biome.grass).multiplyScalar(0.5), t.hemi * 0.6);
    this.scene.add(this.hemi);
    this.scene.fog = new THREE.FogExp2(fogC, t.fogDensity);
    this.fogColor = fogC;
  }

  // ------------------------------------------------------------ terrain
  buildTerrain() {
    const w = this.world, b = this.biome;
    const step = this.q.terrainStep;
    const n = Math.floor((w.res - 1) / step);
    const geo = new THREE.PlaneGeometry(w.size, w.size, n, n);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const noise = makeNoise2D(w.map.seed ^ 77);
    const cG = col(b.grass), cD = col(b.dirt), cR = col(b.rock), cS = col(b.sand);
    const cRoad = new THREE.Color(0.32, 0.3, 0.28), cTown = cD.clone().lerp(new THREE.Color(0.45, 0.43, 0.4), 0.5);
    const tmp = new THREE.Color();
    // grass mask texture (used by GPU grass)
    const res = w.res;
    const mask = new Uint8Array(res * res * 4);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const y = w.heightAt(x, z);
      pos.setY(i, y);
    }
    geo.computeVertexNormals();
    const nrm = geo.attributes.normal;
    const roadD = (x, z) => { let d = 1e9; for (const r of w.roads) d = Math.min(d, distToSeg(x, z, r.ax, r.az, r.bx, r.bz) - r.w * 0.5); return d; };
    const townD = (x, z) => { let d = 1e9; for (const s of w.sites) d = Math.min(d, Math.hypot(x - s.x, z - s.z) - s.radius * 1.4); for (const s of w.bases) d = Math.min(d, Math.hypot(x - s.x, z - s.z) - 45); return d; };
    const classify = (x, z, y, ny, out) => {
      const slope = 1 - ny;
      const v = fbm(noise, x / 90, z / 90, 4);
      const v2 = fbm(noise, x / 14 + 50, z / 14, 2);
      out.copy(cG).multiplyScalar(0.9 + v * 0.25 + v2 * 0.06);
      // dry / lush variation
      out.lerp(cD, clamp(0.15 + v * 0.5, 0, 0.55) * (b.snow ? 0 : 1) * 0.5);
      let grass = clamp(1 - slope * 3.5, 0, 1) * clamp(0.7 + v * 0.8, 0, 1);
      const rock = smoothstep(0.22, 0.42, slope);
      out.lerp(cR.clone().multiplyScalar(0.85 + v2 * 0.2), rock);
      if (y < w.waterLevel + 1.6) { const k = 1 - smoothstep(w.waterLevel + 0.2, w.waterLevel + 1.6, y); out.lerp(cS, k); grass *= 1 - k; }
      if (b.snow) { const k = smoothstep(0.35, 0.2, slope); out.lerp(col(b.grass), k * 0.9); }
      else if (w.map.biome === 'mountains' && y > 140) { const k = smoothstep(140, 190, y) * smoothstep(0.5, 0.3, slope); out.lerp(new THREE.Color(0.9, 0.92, 0.95), k); grass *= 1 - k; }
      const rd = roadD(x, z);
      if (rd < 2) { const k = 1 - smoothstep(-1, 2, rd); out.lerp(cRoad.clone().multiplyScalar(0.9 + v2 * 0.2), k * 0.92); grass *= smoothstep(0, 2.5, rd); }
      const td = townD(x, z);
      if (td < 10) { const k = 1 - smoothstep(-15, 10, td); out.lerp(cTown, k * 0.55); grass *= 1 - k * 0.75; }
      grass *= 1 - rock;
      return clamp(grass, 0, 1);
    };
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i), y = pos.getY(i);
      classify(x, z, y, nrm.getY(i), tmp);
      colors[i * 3] = tmp.r; colors[i * 3 + 1] = tmp.g; colors[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    // full-resolution grass mask (+ tint) for the grass shader
    for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
      const x = i * w.cell - w.half, z = j * w.cell - w.half;
      const nn = w.normalAt(x, z);
      const g = classify(x, z, w.heightAt(x, z), nn[1], tmp) * b.grassDensity;
      const k = (j * res + i) * 4;
      mask[k] = clamp(g, 0, 1) * 255;
      mask[k + 1] = clamp(tmp.r, 0, 1) * 255; mask[k + 2] = clamp(tmp.g, 0, 1) * 255; mask[k + 3] = clamp(tmp.b, 0, 1) * 255;
    }
    for (const bd of w.buildings) {
      const i0 = Math.floor((bd.x - bd.w / 2 + w.half) / w.cell), i1 = Math.ceil((bd.x + bd.w / 2 + w.half) / w.cell);
      const j0 = Math.floor((bd.z - bd.d / 2 + w.half) / w.cell), j1 = Math.ceil((bd.z + bd.d / 2 + w.half) / w.cell);
      for (let j = Math.max(0, j0); j <= Math.min(res - 1, j1); j++) for (let i = Math.max(0, i0); i <= Math.min(res - 1, i1); i++) mask[(j * res + i) * 4] = 0;
    }
    this.grassMask = new THREE.DataTexture(mask, res, res, THREE.RGBAFormat);
    this.grassMask.magFilter = THREE.LinearFilter; this.grassMask.minFilter = THREE.LinearFilter; this.grassMask.needsUpdate = true;
    const hdata = new Float32Array(w.heights);
    this.heightTex = new THREE.DataTexture(hdata, res, res, THREE.RedFormat, THREE.FloatType);
    this.heightTex.magFilter = THREE.NearestFilter; this.heightTex.minFilter = THREE.NearestFilter; this.heightTex.needsUpdate = true;

    const detail = TX.groundDetail();
    const normal = TX.groundNormal();
    const rep = w.size / 6;
    detail.repeat.set(rep, rep); normal.repeat.set(rep, rep);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: detail, normalMap: normal, normalScale: new THREE.Vector2(0.35, 0.35), roughness: 0.95, metalness: 0 });
    // second, larger-scale detail layer breaks up tiling
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uDetail = { value: detail };
      sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `
        #ifdef USE_MAP
          vec4 texelColor = texture2D( map, vMapUv );
          vec4 texel2 = texture2D( map, vMapUv * 0.137 + 0.31 );
          diffuseColor *= mix(vec4(0.8), mix(texelColor, texel2, 0.5), 0.6) * 1.25;
        #endif`);
    };
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    this.terrain = mesh;
    this.group.add(mesh);
    // skirt ground plane beyond the map so the horizon isn't empty
    const outer = new THREE.Mesh(new THREE.PlaneGeometry(w.size * 6, w.size * 6).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: cG.clone().lerp(this.fogColor, 0.3), roughness: 1 }));
    outer.position.y = Math.min(...[w.heightAt(w.half, 0), w.heightAt(-w.half, 0), w.heightAt(0, w.half), w.heightAt(0, -w.half)]) - 6;
    if (w.waterLevel > -100) outer.position.y = w.waterLevel - 6;
    this.group.add(outer);
  }

  // ------------------------------------------------------------ grass
  buildGrass() {
    const w = this.world, b = this.biome;
    if (b.grassDensity <= 0.01) return;
    const COUNT = Math.floor(this.q.grass * Math.min(1.2, b.grassDensity + 0.2));
    const R = this.q.grassR;
    const SEG = 3;
    const vertsPerBlade = SEG * 2 + 1;
    const idxPerBlade = SEG * 6 + 3;
    const pos = new Float32Array(COUNT * vertsPerBlade * 3);
    const off = new Float32Array(COUNT * vertsPerBlade * 4);
    const index = new Uint32Array(COUNT * idxPerBlade);
    const r = new Rng(1234);
    let vi = 0, ii = 0;
    for (let k = 0; k < COUNT; k++) {
      // denser close to the camera: sample radius with a bias
      if (k % 8 === 0) { const ang = r.float(0, Math.PI * 2); const rad = Math.pow(r.next(), 0.7) * R; this._cx = Math.cos(ang) * rad; this._cz = Math.sin(ang) * rad; }
      const px = this._cx + r.float(-0.3, 0.3), pz = this._cz + r.float(-0.3, 0.3);
      const h = r.float(0.3, 0.85) * b.grassHeight;
      const wdt = r.float(0.018, 0.032);
      const rot = r.float(0, Math.PI * 2);
      const rnd = r.next();
      const base = vi;
      for (let s = 0; s <= SEG; s++) {
        const t = s / SEG;
        const ww = wdt * (1 - t * 0.85);
        if (s < SEG) {
          for (const side of [-1, 1]) {
            pos[vi * 3] = side * ww; pos[vi * 3 + 1] = t * h; pos[vi * 3 + 2] = t;
            off[vi * 4] = px; off[vi * 4 + 1] = pz; off[vi * 4 + 2] = rot; off[vi * 4 + 3] = rnd;
            vi++;
          }
        } else {
          pos[vi * 3] = 0; pos[vi * 3 + 1] = h; pos[vi * 3 + 2] = 1;
          off[vi * 4] = px; off[vi * 4 + 1] = pz; off[vi * 4 + 2] = rot; off[vi * 4 + 3] = rnd;
          vi++;
        }
      }
      for (let s = 0; s < SEG; s++) {
        const a = base + s * 2;
        if (s < SEG - 1) { index[ii++] = a; index[ii++] = a + 1; index[ii++] = a + 2; index[ii++] = a + 1; index[ii++] = a + 3; index[ii++] = a + 2; }
        else { index[ii++] = a; index[ii++] = a + 1; index[ii++] = a + 2; }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, vi * 3), 3));
    geo.setAttribute('aOff', new THREE.BufferAttribute(off.subarray(0, vi * 4), 4));
    geo.setIndex(new THREE.BufferAttribute(index.subarray(0, ii), 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uHeight: { value: this.heightTex }, uMask: { value: this.grassMask }, uRes: { value: w.res }, uCell: { value: w.cell }, uHalf: { value: w.half },
      uCam: { value: new THREE.Vector3() }, uR: { value: R }, uTime: this.uniforms.uTime, uWind: this.uniforms.uWind,
      uSunDir: { value: this.sunDir.clone() }, uSunCol: { value: col(this.time.sunColor).multiplyScalar(this.time.sunIntensity * 0.32) },
      uAmb: { value: this.hemi.color.clone().multiplyScalar(this.time.hemi * 0.34) }, uDry: { value: col(b.dirt).lerp(col(b.grass), 0.3) }, uGrass: { value: col(b.grass).multiplyScalar(1.05) },
    }]);
    const mat = new THREE.ShaderMaterial({
      uniforms, fog: true, side: THREE.DoubleSide,
      vertexShader: `
        #include <common>
        #include <fog_pars_vertex>
        #include <logdepthbuf_pars_vertex>
        attribute vec4 aOff;
        uniform sampler2D uHeight; uniform sampler2D uMask;
        uniform float uRes, uCell, uHalf, uR, uTime; uniform vec3 uCam; uniform vec2 uWind; uniform vec3 uGrass, uDry;
        varying vec3 vCol; varying float vT; varying vec3 vN;
        float hAt(vec2 p) {
          vec2 g = clamp((p + uHalf) / uCell, vec2(0.0), vec2(uRes - 1.001));
          ivec2 i = ivec2(floor(g)); vec2 f = fract(g);
          float a = texelFetch(uHeight, i, 0).r, b = texelFetch(uHeight, i + ivec2(1,0), 0).r;
          float c = texelFetch(uHeight, i + ivec2(0,1), 0).r, d = texelFetch(uHeight, i + ivec2(1,1), 0).r;
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }
        void main() {
          vec2 local = aOff.xy;
          vec2 world = uCam.xz + mod(local - uCam.xz + uR, 2.0 * uR) - uR;
          float dist = length(world - uCam.xz);
          vec4 m = texture2D(uMask, (world + uHalf) / (uRes * uCell) + 0.5 / uRes);
          float dens = m.r;
          float keep = step(aOff.w, dens * 1.15);
          float fade = 1.0 - smoothstep(uR * 0.65, uR, dist);
          float scale = keep * fade * (0.6 + dens * 0.5);
          float t = position.z;
          vec3 p = vec3(position.x, position.y * scale, 0.0);
          p.x *= scale > 0.0 ? 1.0 : 0.0;
          float c = cos(aOff.z), s = sin(aOff.z);
          float lean = (0.25 + aOff.w * 0.5) * t * t * position.y;
          p = vec3(p.x * c - lean * s, p.y - lean * 0.3, p.x * s + lean * c);
          // wind: large gust waves + small flutter
          float gust = sin(dot(world, uWind) * 0.08 + uTime * 1.7) * 0.5 + 0.5;
          float flutter = sin(uTime * 4.0 + aOff.w * 30.0 + world.x * 0.5) * 0.15;
          vec2 bend = normalize(uWind) * (gust * 0.35 + flutter) * t * t;
          p.xz += bend; p.y -= length(bend) * 0.3;
          vec3 wp = vec3(world.x, hAt(world), world.y) + p;
          vT = t;
          vec3 grassCol = mix(uGrass, m.gba, 0.35) * (0.8 + aOff.w * 0.4);
          grassCol = mix(grassCol, uDry, step(0.82, fract(aOff.w * 7.13)) * 0.6);
          vCol = mix(grassCol * 0.45, grassCol * 1.35, t);
          vN = normalize(vec3(-s, 1.6, c));
          vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <logdepthbuf_vertex>
          #include <fog_vertex>
        }`,
      fragmentShader: `
        #include <common>
        #include <fog_pars_fragment>
        #include <logdepthbuf_pars_fragment>
        uniform vec3 uSunDir; uniform vec3 uSunCol; uniform vec3 uAmb;
        varying vec3 vCol; varying float vT; varying vec3 vN;
        void main() {
          #include <logdepthbuf_fragment>
          float ndl = abs(dot(normalize(vN), uSunDir)) * 0.6 + 0.4;
          vec3 c = vCol * (uAmb + uSunCol * ndl);
          c += vCol * uSunCol * pow(vT, 3.0) * 0.25; // translucency at tips
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    this.grass = new THREE.Mesh(geo, mat);
    this.grass.frustumCulled = false;
    this.grassU = uniforms;
    this.group.add(this.grass);
  }

  // ------------------------------------------------------------ trees
  makeTreeGeos(type) {
    const r = new Rng(type.length * 97);
    const parts = [];
    const add = (g, color, jitter = 0) => {
      g = g.toNonIndexed();
      const p = g.attributes.position;
      if (jitter) for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) + r.float(-jitter, jitter), p.getY(i) + r.float(-jitter, jitter), p.getZ(i) + r.float(-jitter, jitter));
      const c = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) { const v = 0.85 + r.next() * 0.3; c[i * 3] = color.r * v; c[i * 3 + 1] = color.g * v; c[i * 3 + 2] = color.b * v; }
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
      g.deleteAttribute('uv');
      g.computeVertexNormals();
      parts.push(g);
    };
    const bark = new THREE.Color(0.25, 0.18, 0.12);
    const leaf = col(this.biome.foliage);
    const lo = [];
    if (type === 'pine' || type === 'snowpine') {
      add(new THREE.CylinderGeometry(0.12, 0.3, 9, 6).translate(0, 4.5, 0), bark);
      for (let k = 0; k < 5; k++) {
        const y = 2.5 + k * 1.6, rad = 2.6 - k * 0.45;
        add(new THREE.ConeGeometry(rad, 2.8, 8, 1).translate(0, y + 1.2, 0), leaf.clone().multiplyScalar(0.8 + k * 0.06), 0.18);
        if (type === 'snowpine') add(new THREE.ConeGeometry(rad * 0.85, 1.0, 8, 1).translate(0, y + 2.2, 0), new THREE.Color(0.92, 0.94, 0.97), 0.1);
      }
      lo.push(new THREE.ConeGeometry(2.6, 10, 6).translate(0, 6, 0));
    } else if (type === 'oak' || type === 'jungle' || type === 'birch') {
      const bc = type === 'birch' ? new THREE.Color(0.8, 0.78, 0.72) : bark;
      add(new THREE.CylinderGeometry(0.22, 0.38, 5, 7).translate(0, 2.5, 0), bc);
      add(new THREE.CylinderGeometry(0.08, 0.15, 2.5, 5).rotateZ(0.7).translate(0.8, 4.2, 0), bc);
      add(new THREE.CylinderGeometry(0.08, 0.15, 2.5, 5).rotateZ(-0.6).translate(-0.7, 4.4, 0.2), bc);
      const blobs = type === 'jungle' ? 7 : 6;
      for (let k = 0; k < blobs; k++) {
        const g = new THREE.IcosahedronGeometry(r.float(1.4, 2.2), 1);
        g.translate(r.float(-1.6, 1.6), r.float(5, 7.5) + (type === 'jungle' ? 2 : 0), r.float(-1.6, 1.6));
        add(g, leaf.clone().multiplyScalar(r.float(0.75, 1.1)), 0.25);
      }
      lo.push(new THREE.IcosahedronGeometry(3.2, 0).translate(0, 6.5, 0));
    } else if (type === 'palm') {
      let x = 0, y = 0;
      for (let k = 0; k < 6; k++) { const g = new THREE.CylinderGeometry(0.18, 0.24, 1.6, 6); g.rotateZ(-0.06 * k).translate(x, y + 0.8, 0); add(g, new THREE.Color(0.42, 0.33, 0.22)); x += 0.08 * k; y += 1.55; }
      for (let k = 0; k < 8; k++) {
        const g = new THREE.PlaneGeometry(0.9, 4.2, 1, 4);
        const p = g.attributes.position;
        for (let i = 0; i < p.count; i++) { const t = (p.getY(i) + 2.1) / 4.2; p.setZ(i, -t * t * 1.6); }
        g.translate(0, 2.1, 0).rotateX(-1.1).rotateY((k / 8) * Math.PI * 2).translate(x, y, 0);
        add(g, leaf.clone().multiplyScalar(1.1));
      }
      lo.push(new THREE.ConeGeometry(2.5, 3, 5).translate(0.5, 9, 0));
    } else if (type === 'acacia') {
      add(new THREE.CylinderGeometry(0.15, 0.3, 4.5, 6).rotateZ(0.15).translate(0, 2.2, 0), bark);
      for (let k = 0; k < 4; k++) add(new THREE.SphereGeometry(r.float(2, 2.8), 8, 4).scale(1, 0.32, 1).translate(r.float(-1.5, 1.5), 4.8 + r.float(0, 0.5), r.float(-1.5, 1.5)), leaf, 0.15);
      lo.push(new THREE.SphereGeometry(3.6, 6, 3).scale(1, 0.35, 1).translate(0, 5, 0));
    } else {
      add(new THREE.CylinderGeometry(0.12, 0.32, 6, 6).translate(0, 3, 0), new THREE.Color(0.2, 0.17, 0.15));
      for (let k = 0; k < 5; k++) add(new THREE.CylinderGeometry(0.03, 0.09, 2.4, 4).rotateZ(r.float(0.5, 1.1) * (k % 2 ? 1 : -1)).rotateY(r.float(0, 6)).translate(0, r.float(2.5, 5.5), 0), new THREE.Color(0.2, 0.17, 0.15));
      lo.push(new THREE.CylinderGeometry(0.1, 0.3, 6, 4).translate(0, 3, 0));
    }
    const hi = mergeGeometries(parts);
    const loG = lo[0].toNonIndexed();
    const lc = new Float32Array(loG.attributes.position.count * 3);
    const lcCol = type === 'dead' ? new THREE.Color(0.2, 0.17, 0.15) : type === 'snowpine' ? leaf.clone().lerp(new THREE.Color(0.9, 0.92, 0.95), 0.35) : leaf;
    for (let i = 0; i < lc.length; i += 3) { lc[i] = lcCol.r; lc[i + 1] = lcCol.g; lc[i + 2] = lcCol.b; }
    loG.setAttribute('color', new THREE.BufferAttribute(lc, 3));
    loG.deleteAttribute('uv'); loG.computeVertexNormals();
    return { hi, lo: loG };
  }

  buildTrees() {
    const w = this.world;
    const types = [...new Set(w.trees.map((t) => t.type))];
    this.treeSets = [];
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this.uniforms.uTime;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          #ifdef USE_INSTANCING
            vec3 ip = vec3(instanceMatrix[3][0], 0.0, instanceMatrix[3][2]);
          #else
            vec3 ip = vec3(0.0);
          #endif
          float sway = max(0.0, position.y - 2.0) * 0.012 * sin(uTime * 1.3 + ip.x * 0.05 + ip.z * 0.07);
          transformed.x += sway; transformed.z += sway * 0.6;`);
    };
    this.treeMat = mat;
    for (const type of types) {
      const list = w.trees.filter((t) => t.type === type);
      const g = this.makeTreeGeos(type);
      const hi = new THREE.InstancedMesh(g.hi, mat, Math.min(list.length, 6000));
      const lo = new THREE.InstancedMesh(g.lo, mat, list.length);
      hi.castShadow = true; hi.receiveShadow = true;
      hi.count = 0; lo.count = 0;
      hi.frustumCulled = false; lo.frustumCulled = false;
      this.group.add(hi, lo);
      const mats = list.map((t) => new THREE.Matrix4().compose(new THREE.Vector3(t.x, t.y - 0.2, t.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.rot), new THREE.Vector3(t.s, t.s * (0.9 + (t.rot % 0.3)), t.s)));
      this.treeSets.push({ list, hi, lo, mats });
    }
    this.lastTreeUpdate = new THREE.Vector3(1e9, 0, 1e9);
  }

  updateTrees(cam) {
    if (cam.distanceTo(this.lastTreeUpdate) < 15) return;
    this.lastTreeUpdate.copy(cam);
    const near2 = this.q.treeNear ** 2, far2 = this.q.treeFar ** 2;
    for (const s of this.treeSets) {
      let h = 0, l = 0;
      const maxHi = s.hi.instanceMatrix.count;
      for (let i = 0; i < s.list.length; i++) {
        const t = s.list[i];
        const d2 = (t.x - cam.x) ** 2 + (t.z - cam.z) ** 2;
        if (d2 < near2 && h < maxHi) s.hi.setMatrixAt(h++, s.mats[i]);
        else if (d2 < far2) s.lo.setMatrixAt(l++, s.mats[i]);
      }
      s.hi.count = h; s.lo.count = l;
      s.hi.instanceMatrix.needsUpdate = true; s.lo.instanceMatrix.needsUpdate = true;
    }
  }

  // ------------------------------------------------------------ buildings
  buildBuildings() {
    const w = this.world;
    const groups = { wall: [], wall2: [], roof: [], flatroof: [], metal: [], sandbag: [], concrete: [], crate: [], container: [] };
    const tint = (g, c) => {
      const p = g.attributes.position.count;
      const a = new Float32Array(p * 3);
      for (let i = 0; i < p; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
      g.setAttribute('color', new THREE.BufferAttribute(a, 3));
      return g;
    };
    const boxUV = (W, H, D, tileW, tileH) => {
      const g = new THREE.BoxGeometry(W, H, D);
      const uv = g.attributes.uv, n = g.attributes.normal;
      for (let i = 0; i < uv.count; i++) {
        const nx = Math.abs(n.getX(i)), ny = Math.abs(n.getY(i));
        const sx = nx > 0.5 ? D : W;
        const sy = ny > 0.5 ? D : H;
        uv.setXY(i, uv.getX(i) * sx / tileW, uv.getY(i) * sy / tileH);
      }
      return g;
    };
    for (const b of w.buildings) {
      const c = new THREE.Color(b.color);
      if (b.cover) {
        const g = boxUV(b.w, b.h, b.d, b.type === 'container' ? 2.4 : 1.5, b.type === 'container' ? 2.6 : 1.1);
        if (b.type === 'container') g.rotateY(0);
        g.translate(b.x, b.y + b.h / 2, b.z);
        groups[b.type === 'sandbag' ? 'sandbag' : b.type === 'container' ? 'container' : b.type === 'crate' ? 'crate' : 'concrete'].push(tint(g, b.type === 'container' ? c : new THREE.Color(1, 1, 1)));
        continue;
      }
      const H = b.h;
      const g = boxUV(b.w, H, b.d, 4, 3.2);
      // roof/floor faces should not show windows: squash their UVs
      const uv = g.attributes.uv, n = g.attributes.normal;
      for (let i = 0; i < uv.count; i++) if (Math.abs(n.getY(i)) > 0.5) uv.setXY(i, 0.02, 0.02);
      g.translate(b.x, b.y + H / 2, b.z);
      const target = b.type === 'warehouse' || b.type === 'bunker' ? 'metal' : (b.type === 'apartment' ? 'wall2' : 'wall');
      groups[target].push(tint(g, c));
      // base/plinth
      const plinth = new THREE.BoxGeometry(b.w + 0.3, 0.8, b.d + 0.3).translate(b.x, b.y + 0.2, b.z);
      groups.concrete.push(tint(plinth, new THREE.Color(0.75, 0.75, 0.75)));
      if (b.roof === 'pitched') {
        const rh = Math.min(b.w, b.d) * 0.35;
        const along = b.w > b.d;
        const L = along ? b.w : b.d, S = along ? b.d : b.w;
        const shape = new THREE.Shape([new THREE.Vector2(-S / 2 - 0.4, 0), new THREE.Vector2(S / 2 + 0.4, 0), new THREE.Vector2(0, rh)]);
        const rg = new THREE.ExtrudeGeometry(shape, { depth: L + 0.6, bevelEnabled: false });
        rg.translate(0, 0, -(L + 0.6) / 2);
        if (along) rg.rotateY(Math.PI / 2);
        rg.translate(b.x, b.y + H, b.z);
        const ruv = rg.attributes.uv; for (let i = 0; i < ruv.count; i++) ruv.setXY(i, ruv.getX(i) * 0.3, ruv.getY(i) * 0.3);
        groups.roof.push(tint(rg, new THREE.Color(1, 1, 1)));
      } else {
        const rg = new THREE.BoxGeometry(b.w + 0.2, 0.5, b.d + 0.2).translate(b.x, b.y + H + 0.25, b.z);
        groups.flatroof.push(tint(rg, new THREE.Color(0.55, 0.55, 0.55)));
        if (b.type === 'apartment' && b.w > 12) {
          const ac = new THREE.BoxGeometry(2, 1.4, 2).translate(b.x + b.w * 0.2, b.y + H + 1.2, b.z - b.d * 0.15);
          groups.flatroof.push(tint(ac, new THREE.Color(0.6, 0.62, 0.64)));
        }
      }
      b.renderH = H;
    }
    const mats = {
      wall: new THREE.MeshStandardMaterial({ map: TX.facade(0), vertexColors: true, roughness: 0.85 }),
      wall2: new THREE.MeshStandardMaterial({ map: TX.facade(1), vertexColors: true, roughness: 0.75 }),
      metal: new THREE.MeshStandardMaterial({ map: TX.corrugated(), vertexColors: true, roughness: 0.6, metalness: 0.3 }),
      roof: new THREE.MeshStandardMaterial({ map: TX.roofTex(), vertexColors: true, roughness: 0.8 }),
      flatroof: new THREE.MeshStandardMaterial({ map: TX.concreteTex(), vertexColors: true, roughness: 0.95 }),
      concrete: new THREE.MeshStandardMaterial({ map: TX.concreteTex(), vertexColors: true, roughness: 0.95 }),
      sandbag: new THREE.MeshStandardMaterial({ map: TX.sandbagTex(), vertexColors: true, roughness: 1 }),
      crate: new THREE.MeshStandardMaterial({ map: TX.woodTex(), vertexColors: true, roughness: 0.9 }),
      container: new THREE.MeshStandardMaterial({ map: TX.corrugated(), vertexColors: true, roughness: 0.55, metalness: 0.4 }),
    };
    for (const [k, list] of Object.entries(groups)) {
      if (!list.length) continue;
      const geo = mergeGeometries(list.map((g) => (g.index ? g.toNonIndexed() : g)));
      const mesh = new THREE.Mesh(geo, mats[k]);
      mesh.castShadow = true; mesh.receiveShadow = true;
      this.group.add(mesh);
    }
    // flag poles / HQ markers
  }

  // ------------------------------------------------------------ water
  buildWater() {
    const w = this.world;
    if (w.waterLevel < -100) return;
    const nrm = TX.waterNormal();
    nrm.repeat.set(w.size / 25, w.size / 25);
    const mat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(0.04, 0.16, 0.2), roughness: 0.06, metalness: 0.1, normalMap: nrm, normalScale: new THREE.Vector2(0.6, 0.6), transparent: true, opacity: 0.88, envMapIntensity: 1.2, clearcoat: 1 });
    const geo = new THREE.PlaneGeometry(w.size * 6, w.size * 6).rotateX(-Math.PI / 2);
    const water = new THREE.Mesh(geo, mat);
    water.position.y = w.waterLevel;
    water.receiveShadow = true;
    this.water = water; this.waterNormal = nrm;
    this.group.add(water);
  }

  // ------------------------------------------------------------ clouds
  buildClouds() {
    const cover = this.time.clouds || 0.45;
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uTime: this.uniforms.uTime, uCover: { value: cover }, uSun: { value: col(this.time.sunColor) }, uDark: { value: this.time.rain ? 0.45 : 0.85 } },
      vertexShader: `varying vec2 vUv; varying vec3 vW; void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `
        varying vec2 vUv; varying vec3 vW; uniform float uTime, uCover, uDark; uniform vec3 uSun;
        float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
        float n(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f); return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x), f.y); }
        float fbm(vec2 p){ float s=0.0, a=0.5; for(int i=0;i<6;i++){ s+=a*n(p); p*=2.03; a*=0.5; } return s; }
        void main(){
          vec2 p = vW.xz * 0.0009 + vec2(uTime * 0.004, uTime * 0.002);
          float d = fbm(p);
          float c = smoothstep(1.0 - uCover * 0.9 - 0.15, 1.0 - uCover * 0.9 + 0.25, d);
          float edge = 1.0 - smoothstep(4000.0, 9000.0, length(vW.xz));
          vec3 col = mix(vec3(uDark), uSun, 0.35) * (0.75 + d * 0.4);
          gl_FragColor = vec4(col, c * 0.85 * edge);
        }`,
    });
    const clouds = new THREE.Mesh(new THREE.PlaneGeometry(20000, 20000).rotateX(-Math.PI / 2), mat);
    clouds.position.y = 900;
    clouds.renderOrder = -1;
    this.clouds = clouds;
    this.scene.add(clouds);
  }

  buildRain() {
    const N = 6000;
    const pos = new Float32Array(N * 6);
    const r = new Rng(5);
    for (let i = 0; i < N; i++) {
      const x = r.float(-40, 40), y = r.float(0, 40), z = r.float(-40, 40);
      pos.set([x, y, z, x + 0.05, y - 0.9, z + 0.02], i * 6);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const m = new THREE.LineBasicMaterial({ color: 0x9aa8b8, transparent: true, opacity: 0.35 });
    this.rain = new THREE.LineSegments(g, m);
    this.rain.frustumCulled = false;
    this.scene.add(this.rain);
    this.lightningAt = 5;
  }

  buildObjectiveMarkers() {
    this.flagMeshes = new Map();
  }

  setObjectives(objs, myTeam) {
    for (const o of objs) {
      let f = this.flagMeshes.get(o.id);
      if (!f) {
        const g = new THREE.Group();
        const y = this.world.heightAt(o.x, o.z);
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 9, 8), new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.8, roughness: 0.3 }));
        pole.position.y = 4.5; pole.castShadow = true;
        const cloth = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.3, 8, 4), new THREE.MeshStandardMaterial({ color: 0xffffff, side: THREE.DoubleSide, roughness: 0.9 }));
        cloth.position.set(1.15, 8.2, 0);
        const ring = new THREE.Mesh(new THREE.RingGeometry(o.radius - 0.4, o.radius, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25, depthWrite: false }));
        ring.position.y = 0.3;
        g.add(pole, cloth, ring);
        g.position.set(o.x, y, o.z);
        this.group.add(g);
        f = { g, cloth, ring, base: cloth.geometry.attributes.position.array.slice() };
        this.flagMeshes.set(o.id, f);
      }
      f.g.position.set(o.x, this.world.heightAt(o.x, o.z), o.z); // hardpoint hills relocate
      const color = o.owner < 0 ? 0xdddddd : o.owner === myTeam ? 0x42b8ff : 0xff4b3a;
      f.cloth.material.color.setHex(color);
      f.ring.material.color.setHex(color);
      f.cloth.position.y = 2 + Math.abs(o.prog) / 100 * 6.2;
    }
  }

  update(dt, camPos, camera) {
    this.uniforms.uTime.value += dt;
    const t = this.uniforms.uTime.value;
    if (this.grassU) this.grassU.uCam.value.copy(camPos);
    this.updateTrees(camPos);
    // shadow camera follows the viewer, snapped to texels to avoid shimmering
    const S = this.q.shadow;
    const texel = 180 / S;
    const cx = Math.round(camPos.x / texel) * texel, cz = Math.round(camPos.z / texel) * texel;
    this.sun.target.position.set(cx, camPos.y, cz);
    this.sun.position.set(cx, camPos.y, cz).addScaledVector(this.sunDir, 400);
    if (this.waterNormal) { this.waterNormal.offset.x = t * 0.01; this.waterNormal.offset.y = t * 0.006; }
    if (this.clouds) { this.clouds.position.x = camPos.x; this.clouds.position.z = camPos.z; }
    for (const f of this.flagMeshes.values()) {
      const p = f.cloth.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) { const x = f.base[i * 3]; p.setZ(i, Math.sin(t * 6 + x * 2.5) * 0.15 * (x + 1.1)); }
      p.needsUpdate = true;
    }
    if (this.rain) {
      this.rain.position.set(camPos.x, camPos.y - 10, camPos.z);
      const p = this.rain.geometry.attributes.position;
      const a = p.array;
      for (let i = 0; i < a.length; i += 6) {
        a[i + 1] -= dt * 28; a[i + 4] -= dt * 28;
        if (a[i + 1] < 0) { a[i + 1] += 40; a[i + 4] += 40; }
      }
      p.needsUpdate = true;
      this.lightningAt -= dt;
      if (this.lightningAt < 0) {
        this.lightningAt = 8 + Math.random() * 20;
        this.flash = 0.35;
      }
      if (this.flash > 0) { this.flash -= dt; this.hemi.intensity = this.time.hemi * 0.6 + (this.flash > 0.2 || (this.flash > 0.05 && this.flash < 0.12) ? 3 : 0); }
    }
    void camera;
  }
}
