// Deterministic world generation shared by server and client: heightmap,
// towns/buildings, cover, trees, objectives, team bases, vehicle spawns,
// and collision / line-of-sight queries.
import { Rng, makeNoise2D, fbm, ridged, clamp, lerp, smoothstep } from './rng.js';
import { BIOMES, TIMES } from './maps.js';

const CELL = 4; // heightmap resolution in meters
const GRID = 64; // spatial hash cell size

export class World {
  constructor(map) {
    this.map = map;
    this.biome = BIOMES[map.biome];
    this.time = TIMES[map.time];
    this.size = map.size;
    this.half = map.size / 2;
    this.res = Math.floor(map.size / CELL) + 1;
    this.cell = CELL;
    this.rng = new Rng(map.seed);
    this.waterLevel = -1000;
    this.sites = [];
    this.buildings = [];
    this.trees = [];
    this.roads = [];
    this.loot = [];
    this._genLayout();
    this._genHeights();
    this._genTowns();
    this._genTrees();
    this._genVehicles();
    this._buildIndex();
  }

  // ---------- generation ----------
  _genLayout() {
    const r = this.rng;
    this.axisAngle = r.float(0, Math.PI * 2);
    const ax = Math.cos(this.axisAngle), az = Math.sin(this.axisAngle);
    const px = -az, pz = ax;
    const len = this.size * 0.36;
    this.bases = [
      { x: -ax * len, z: -az * len },
      { x: ax * len, z: az * len },
    ];
    // objective sites along the axis, zig-zagging sideways
    const n = r.int(5, 7);
    const names = 'ABCDEFG';
    for (let i = 0; i < n; i++) {
      const t = -0.62 + (1.24 * i) / (n - 1) + r.float(-0.04, 0.04);
      const side = (i % 2 === 0 ? 1 : -1) * r.float(0.05, 0.28) * this.size * 0.5;
      this.sites.push({ id: names[i], x: ax * t * len + px * side, z: az * t * len + pz * side,
        radius: r.float(22, 32), t, kind: r.pick(['town', 'town', 'compound', 'village', 'industrial']) });
    }
    // centre site for small infantry modes: the one closest to the middle
    this.centerSite = this.sites.reduce((b, s) => (Math.hypot(s.x, s.z) < Math.hypot(b.x, b.z) ? s : b), this.sites[0]);
    // roads connecting sites and bases
    const chain = [this.bases[0], ...this.sites, this.bases[1]];
    for (let i = 0; i < chain.length - 1; i++) this.roads.push({ ax: chain[i].x, az: chain[i].z, bx: chain[i + 1].x, bz: chain[i + 1].z, w: 6 });
    if (this.sites.length > 3) this.roads.push({ ax: this.sites[0].x, az: this.sites[0].z, bx: this.sites[2].x, bz: this.sites[2].z, w: 5 });
    if (this.sites.length > 4) this.roads.push({ ax: this.sites[2].x, az: this.sites[2].z, bx: this.sites[4].x, bz: this.sites[4].z, w: 5 });
  }

  _genHeights() {
    const m = this.map, b = this.biome;
    const n1 = makeNoise2D(m.seed ^ 0x1234);
    const n2 = makeNoise2D(m.seed ^ 0xbeef);
    const n3 = makeNoise2D(m.seed ^ 0x51ed);
    const res = this.res;
    const H = new Float32Array(res * res);
    const relief = b.relief;
    const flatPts = [...this.sites.map((s) => ({ x: s.x, z: s.z, r: s.radius * 3.2 })), ...this.bases.map((s) => ({ x: s.x, z: s.z, r: 90 }))];
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const x = i * CELL - this.half, z = j * CELL - this.half;
        const u = x / 900, v = z / 900;
        let hgt = fbm(n1, u, v, 6) * relief;
        if (this.map.biome === 'mountains' || m.canyon) hgt += ridged(n2, u * 0.8, v * 0.8, 5) * relief * 1.2 - relief * 0.25;
        if (b.dunes) hgt += Math.abs(fbm(n3, u * 4, v * 1.5, 3)) * 14;
        hgt += fbm(n3, u * 12, v * 12, 3) * 1.4; // micro relief
        // edge falloff: coasts/islands sink into sea, others rise into hills (natural boundary)
        const ed = Math.max(Math.abs(x), Math.abs(z)) / this.half;
        if (m.island) {
          const rr = Math.hypot(x, z) / this.half;
          hgt = hgt * 0.6 + 18 - smoothstep(0.55, 0.98, rr) * 45;
        } else if (m.coast) {
          const side = (x * Math.cos(this.axisAngle + 1.57) + z * Math.sin(this.axisAngle + 1.57)) / this.half;
          hgt += 8 - smoothstep(0.35, 0.9, side) * 40;
        } else {
          hgt += smoothstep(0.82, 1.0, ed) * relief * 1.5;
        }
        if (m.lakes) {
          const l = fbm(n2, u * 1.6 + 7, v * 1.6 - 3, 3);
          if (l > 0.28) hgt -= (l - 0.28) * 90;
        }
        // flatten building areas and bases
        for (const f of flatPts) {
          const d = Math.hypot(x - f.x, z - f.z);
          if (d < f.r * 1.6) {
            const k = 1 - smoothstep(f.r * 0.7, f.r * 1.6, d);
            hgt = lerp(hgt, f.base ?? (f.base = this._rawBase(n1, n2, n3, f.x, f.z)), k);
          }
        }
        H[j * res + i] = hgt;
      }
    }
    this.heights = H;
    // roads: gently flatten across the road profile
    for (const rd of this.roads) this._flattenRoad(rd);
    if (m.island || m.coast || m.lakes) this.waterLevel = m.island || m.coast ? 0 : this._lakeLevel();
    // make sure sites/bases are above water
    for (const s of [...this.sites, ...this.bases]) {
      const g = this.heightAt(s.x, s.z);
      if (g < this.waterLevel + 1.5) this._raise(s.x, s.z, 140, this.waterLevel + 2 - g);
    }
  }

  _rawBase(n1, n2, n3, x, z) {
    // approximate base height at a point (cheap version of the formula above)
    const u = x / 900, v = z / 900;
    let h = fbm(n1, u, v, 6) * this.biome.relief;
    if (this.map.biome === 'mountains' || this.map.canyon) h += ridged(n2, u * 0.8, v * 0.8, 5) * this.biome.relief * 1.2 - this.biome.relief * 0.25;
    if (this.map.island) h = h * 0.6 + 18;
    if (this.map.coast) h += 4;
    return h;
  }

  _lakeLevel() {
    // pick a level so that only the lake depressions are flooded
    const s = [...this.heights].sort((a, b) => a - b);
    return s[Math.floor(s.length * 0.06)] + 1.0;
  }

  _raise(cx, cz, r, dh) {
    const res = this.res;
    for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
      const x = i * CELL - this.half, z = j * CELL - this.half;
      const d = Math.hypot(x - cx, z - cz);
      if (d < r) this.heights[j * res + i] += dh * (1 - smoothstep(r * 0.5, r, d));
    }
  }

  _flattenRoad(rd) {
    const res = this.res;
    const minX = Math.min(rd.ax, rd.bx) - 20, maxX = Math.max(rd.ax, rd.bx) + 20;
    const minZ = Math.min(rd.az, rd.bz) - 20, maxZ = Math.max(rd.az, rd.bz) + 20;
    const i0 = Math.max(0, Math.floor((minX + this.half) / CELL)), i1 = Math.min(res - 1, Math.ceil((maxX + this.half) / CELL));
    const j0 = Math.max(0, Math.floor((minZ + this.half) / CELL)), j1 = Math.min(res - 1, Math.ceil((maxZ + this.half) / CELL));
    const H = this.heights;
    const src = new Float32Array(H);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = i * CELL - this.half, z = j * CELL - this.half;
      const d = distToSeg(x, z, rd.ax, rd.az, rd.bx, rd.bz);
      if (d < rd.w * 2.5) {
        // average along a small neighbourhood to smooth bumps
        let s = 0, c = 0;
        for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
          const ii = clamp(i + di, 0, res - 1), jj = clamp(j + dj, 0, res - 1);
          s += src[jj * res + ii]; c++;
        }
        const k = 1 - smoothstep(rd.w * 0.8, rd.w * 2.5, d);
        H[j * res + i] = lerp(src[j * res + i], s / c, k);
      }
    }
  }

  _genTowns() {
    const r = new Rng(this.map.seed ^ 0xa11ce);
    const city = this.biome.city || this.map.city;
    const dense = this.map.dense;
    const palette = this.map.biome === 'desert' ? ['#c8b48a', '#d9c7a0', '#b89f78', '#e0d2b4']
      : this.map.biome === 'snow' ? ['#7d8a96', '#a39182', '#8c4b3c', '#c7c2b8']
        : ['#b8b0a2', '#8f8679', '#a6644d', '#c9c1b1', '#76808a', '#9c9486'];
    const addBuilding = (x, z, w, d, h, type) => {
      const y = Math.min(this.heightAt(x - w / 2, z - d / 2), this.heightAt(x + w / 2, z + d / 2), this.heightAt(x - w / 2, z + d / 2), this.heightAt(x + w / 2, z - d / 2), this.heightAt(x, z)) - 0.3;
      if (y < this.waterLevel + 0.5) return false;
      for (const o of this.buildings) {
        if (Math.abs(o.x - x) < (o.w + w) / 2 + 3 && Math.abs(o.z - z) < (o.d + d) / 2 + 3) return false;
      }
      for (const rd of this.roads) if (distToSeg(x, z, rd.ax, rd.az, rd.bx, rd.bz) < Math.max(w, d) / 2 + rd.w) return false;
      h = Math.max(1, Math.round(h / 3.2)) * 3.2; // whole floors, matches rendering
      this.buildings.push({ x, z, w, d, h, y, type, color: r.pick(palette), roof: type === 'house' ? 'pitched' : 'flat' });
      return true;
    };
    const addCover = (x, z, w, d, h, type) => {
      const y = this.heightAt(x, z) - 0.05;
      if (y < this.waterLevel) return;
      for (const o of this.buildings) if (Math.abs(o.x - x) < (o.w + w) / 2 + 0.8 && Math.abs(o.z - z) < (o.d + d) / 2 + 0.8) return;
      this.buildings.push({ x, z, w, d, h, y, type, cover: true, color: type === 'sandbag' ? '#8a7a5a' : type === 'container' ? r.pick(['#8a3b2a', '#2c5a8a', '#4f6b39', '#a8822e']) : '#7a7a74', roof: 'flat' });
    };
    for (const s of this.sites) {
      const count = (city ? 18 : 10) + (dense ? 10 : 0) + (s.kind === 'village' ? -3 : 0);
      for (let k = 0, tries = 0; k < count && tries < count * 12; tries++) {
        const a = r.float(0, Math.PI * 2), dist = r.float(s.radius * 0.55, s.radius * (city ? 3.2 : 2.6));
        const x = s.x + Math.cos(a) * dist, z = s.z + Math.sin(a) * dist;
        let type, w, d, h;
        const roll = r.next();
        if (s.kind === 'industrial' && roll < 0.5) { type = 'warehouse'; w = r.float(16, 28); d = r.float(12, 20); h = r.float(7, 10); }
        else if (city && roll < 0.45) { type = 'apartment'; w = r.float(12, 20); d = r.float(10, 16); h = r.float(10, dense ? 34 : 22); }
        else if (s.kind === 'compound' && roll < 0.4) { type = 'bunker'; w = r.float(8, 12); d = r.float(8, 12); h = r.float(3, 4); }
        else { type = 'house'; w = r.float(7, 12); d = r.float(6, 10); h = r.float(4, 7); }
        if (addBuilding(x, z, w, d, h, type)) k++;
      }
      // cover around the flag
      const nc = 10 + r.int(0, 6);
      for (let k = 0; k < nc; k++) {
        const a = r.float(0, Math.PI * 2), dist = r.float(4, s.radius * 1.4);
        const t = r.pick(['sandbag', 'sandbag', 'concrete', 'container', 'crate']);
        const horiz = r.chance(0.5);
        const L = t === 'container' ? 6.1 : t === 'crate' ? 1.4 : r.float(2.5, 4.5);
        const W = t === 'container' ? 2.45 : t === 'crate' ? 1.4 : 0.8;
        const H = t === 'container' ? 2.6 : t === 'crate' ? 1.4 : t === 'sandbag' ? 1.1 : 1.3;
        addCover(s.x + Math.cos(a) * dist, s.z + Math.sin(a) * dist, horiz ? L : W, horiz ? W : L, H, t);
      }
      s.y = this.heightAt(s.x, s.z);
      // loot points (battle royale)
      for (let k = 0; k < 8; k++) {
        const a = r.float(0, Math.PI * 2), dist = r.float(6, s.radius * 2.4);
        const x = s.x + Math.cos(a) * dist, z = s.z + Math.sin(a) * dist;
        if (!this.pointInBuilding(x, z, 1)) this.loot.push({ x, z, y: this.heightAt(x, z) });
      }
    }
    // scattered farmhouses / ruins along the countryside
    const scattered = city ? 40 : 28;
    for (let k = 0, tries = 0; k < scattered && tries < 600; tries++) {
      const x = r.float(-this.half * 0.85, this.half * 0.85), z = r.float(-this.half * 0.85, this.half * 0.85);
      if (this.slopeAt(x, z) > 0.35) continue;
      if (this.bases.some((b) => Math.hypot(b.x - x, b.z - z) < 110)) continue;
      const type = r.chance(0.7) ? 'house' : 'warehouse';
      if (addBuilding(x, z, type === 'house' ? r.float(7, 11) : r.float(14, 22), type === 'house' ? r.float(6, 9) : r.float(10, 16), type === 'house' ? r.float(4, 6.5) : r.float(6, 9), type)) {
        k++;
        this.loot.push({ x: x + 8, z: z + 8, y: this.heightAt(x + 8, z + 8) });
      }
    }
    // base structures (HQ)
    for (const b of this.bases) {
      b.y = this.heightAt(b.x, b.z);
      addBuilding(b.x + 22, b.z + 10, 20, 14, 8, 'warehouse');
      addBuilding(b.x - 25, b.z - 14, 10, 10, 4, 'bunker');
      for (let k = 0; k < 8; k++) addCover(b.x + r.float(-40, 40), b.z + r.float(-40, 40), 6.1, 2.45, 2.6, 'container');
    }
  }

  _genTrees() {
    const r = new Rng(this.map.seed ^ 0x7ee5);
    const n = makeNoise2D(this.map.seed ^ 0xf0e5);
    const dens = this.biome.treeDensity;
    const target = Math.floor(9000 * dens * (this.size / 2000) ** 2);
    const types = this.biome.trees;
    for (let k = 0, tries = 0; k < target && tries < target * 6; tries++) {
      const x = r.float(-this.half, this.half), z = r.float(-this.half, this.half);
      const forest = fbm(n, x / 260, z / 260, 3);
      if (forest < 0.05 && !r.chance(0.08)) continue;
      const y = this.heightAt(x, z);
      if (y < this.waterLevel + 0.6) continue;
      if (this.slopeAt(x, z) > 0.75) continue;
      if (this.sites.some((s) => Math.hypot(s.x - x, s.z - z) < s.radius * 1.4)) continue;
      if (this.bases.some((b) => Math.hypot(b.x - x, b.z - z) < 70)) continue;
      if (this.roads.some((rd) => distToSeg(x, z, rd.ax, rd.az, rd.bx, rd.bz) < rd.w + 2)) continue;
      if (this.pointInBuilding(x, z, 2)) continue;
      const type = types[Math.floor(r.next() * types.length)];
      this.trees.push({ x, y, z, s: r.float(0.75, 1.35), type, rot: r.float(0, 6.28) });
      k++;
    }
  }

  _genVehicles() {
    const r = new Rng(this.map.seed ^ 0x7a2c);
    this.vehicleSpawns = [];
    this.bases.forEach((b, team) => {
      const toward = Math.atan2(-b.z, -b.x);
      const fwdx = Math.cos(toward), fwdz = Math.sin(toward);
      const sx = -fwdz, sz = fwdx;
      const add = (type, f, s) => {
        const x = b.x + fwdx * f + sx * s, z = b.z + fwdz * f + sz * s;
        this.vehicleSpawns.push({ type, team, x, z, yaw: Math.atan2(b.x, b.z) });
      };
      add('tank', 15, -12); add('tank', 15, 12); add('ifv', 22, 0);
      add('jeep', 5, -24); add('jeep', 5, 24);
      add('heli', -30, -30); add('jet', -45, 30);
      void r;
    });
  }

  _buildIndex() {
    this.gridN = Math.ceil(this.size / GRID) + 1;
    this.bgrid = new Map();
    this.buildings.forEach((b, idx) => {
      const x0 = Math.floor((b.x - b.w / 2 + this.half) / GRID), x1 = Math.floor((b.x + b.w / 2 + this.half) / GRID);
      const z0 = Math.floor((b.z - b.d / 2 + this.half) / GRID), z1 = Math.floor((b.z + b.d / 2 + this.half) / GRID);
      for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) {
        const k = i * 4096 + j;
        if (!this.bgrid.has(k)) this.bgrid.set(k, []);
        this.bgrid.get(k).push(idx);
      }
    });
    this.tgrid = new Map();
    this.trees.forEach((t, idx) => {
      const k = Math.floor((t.x + this.half) / GRID) * 4096 + Math.floor((t.z + this.half) / GRID);
      if (!this.tgrid.has(k)) this.tgrid.set(k, []);
      this.tgrid.get(k).push(idx);
    });
  }

  // ---------- queries ----------
  heightAt(x, z) {
    const fx = clamp((x + this.half) / CELL, 0, this.res - 1.001);
    const fz = clamp((z + this.half) / CELL, 0, this.res - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const r = this.res, H = this.heights;
    const a = H[j * r + i], b = H[j * r + i + 1], c = H[(j + 1) * r + i], d = H[(j + 1) * r + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }

  slopeAt(x, z) {
    const e = 2;
    const dx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const dz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return Math.hypot(dx, dz) / (2 * e);
  }

  normalAt(x, z) {
    const e = 1.5;
    const dx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const dz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    const nx = -dx, ny = 2 * e, nz = -dz;
    const l = Math.hypot(nx, ny, nz);
    return [nx / l, ny / l, nz / l];
  }

  buildingsNear(x, z) {
    const k = Math.floor((x + this.half) / GRID) * 4096 + Math.floor((z + this.half) / GRID);
    return this.bgrid.get(k) || EMPTY;
  }

  pointInBuilding(x, z, pad = 0) {
    for (const b of this.buildings) {
      if (Math.abs(b.x - x) < b.w / 2 + pad && Math.abs(b.z - z) < b.d / 2 + pad) return b;
    }
    return null;
  }

  // Ground height including building roofs (for standing on cover/roofs)
  groundAt(x, z, y = Infinity, radius = 0.35) {
    let g = this.heightAt(x, z);
    for (const idx of this.buildingsNear(x, z)) {
      const b = this.buildings[idx];
      if (Math.abs(b.x - x) < b.w / 2 + radius && Math.abs(b.z - z) < b.d / 2 + radius) {
        const top = topOf(b);
        if (y >= top - 0.6 && top > g) g = top;
      }
    }
    return g;
  }

  // Push a cylinder (x,z,radius) out of buildings and tree trunks. y/height
  // allow walking over low objects and standing on roofs.
  collide(pos, radius, height = 1.8) {
    for (let pass = 0; pass < 2; pass++) {
      const ids = this.buildingsNear(pos.x, pos.z);
      for (const idx of ids) {
        const b = this.buildings[idx];
        const top = topOf(b);
        if (pos.y >= top - 0.45 || pos.y + height < b.y) continue;
        const hx = b.w / 2 + radius, hz = b.d / 2 + radius;
        const dx = pos.x - b.x, dz = pos.z - b.z;
        if (Math.abs(dx) < hx && Math.abs(dz) < hz) {
          const px = hx - Math.abs(dx), pz = hz - Math.abs(dz);
          if (px < pz) pos.x += Math.sign(dx || 1) * px;
          else pos.z += Math.sign(dz || 1) * pz;
        }
      }
    }
    const k = Math.floor((pos.x + this.half) / GRID) * 4096 + Math.floor((pos.z + this.half) / GRID);
    const ts = this.tgrid.get(k);
    if (ts) for (const ti of ts) {
      const t = this.trees[ti];
      const tr = 0.35 * t.s + radius;
      const dx = pos.x - t.x, dz = pos.z - t.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < tr * tr && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        pos.x = t.x + (dx / d) * tr;
        pos.z = t.z + (dz / d) * tr;
      }
    }
    const lim = this.half - 5;
    pos.x = clamp(pos.x, -lim, lim);
    pos.z = clamp(pos.z, -lim, lim);
  }

  // Ray vs terrain + buildings. Returns hit distance (or maxDist) and what was hit.
  raycast(ox, oy, oz, dx, dy, dz, maxDist) {
    let best = maxDist, hitType = null, hitB = null;
    // buildings: walk grid cells along the ray
    const seen = new Set();
    const step = GRID * 0.5;
    for (let t = 0; t <= Math.min(maxDist, best) + step; t += step) {
      const x = ox + dx * t, z = oz + dz * t;
      for (const idx of this.buildingsNear(x, z)) {
        if (seen.has(idx)) continue;
        seen.add(idx);
        const b = this.buildings[idx];
        const hit = rayAABB(ox, oy, oz, dx, dy, dz, b.x - b.w / 2, b.y, b.z - b.d / 2, b.x + b.w / 2, topOf(b), b.z + b.d / 2);
        if (hit >= 0 && hit < best) { best = hit; hitType = 'building'; hitB = b; }
      }
    }
    // terrain: march with adaptive step then refine
    let prevT = 0;
    let t = 0.5;
    const tmax = best;
    while (t < tmax) {
      const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
      const g = this.heightAt(x, z);
      if (y < g) {
        let lo = prevT, hi = t;
        for (let k = 0; k < 8; k++) {
          const mid = (lo + hi) / 2;
          if (oy + dy * mid < this.heightAt(ox + dx * mid, oz + dz * mid)) hi = mid; else lo = mid;
        }
        if (hi < best) { best = hi; hitType = 'terrain'; hitB = null; }
        break;
      }
      prevT = t;
      t += Math.max(0.5, Math.min(8, (y - g) * 0.5));
    }
    return { dist: best, type: hitType, building: hitB };
  }

  lineClear(ax, ay, az, bx, by, bz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const L = Math.hypot(dx, dy, dz);
    if (L < 0.01) return true;
    const r = this.raycast(ax, ay, az, dx / L, dy / L, dz / L, L);
    return r.type === null;
  }

  // Find a corner to walk around a building blocking the segment a->b.
  blockingBuilding(ax, az, bx, bz, pad = 1) {
    const dx = bx - ax, dz = bz - az;
    const L = Math.hypot(dx, dz);
    if (L < 0.01) return null;
    let best = null, bestT = Infinity;
    const seen = new Set();
    for (let t = 0; t <= L + GRID / 2; t += GRID / 2) {
      const tt = Math.min(t, L);
      for (const idx of this.buildingsNear(ax + (dx / L) * tt, az + (dz / L) * tt)) {
        if (seen.has(idx)) continue;
        seen.add(idx);
        const b = this.buildings[idx];
        if (b.cover && b.h < 1.5) continue;
        const h = rayAABB(ax, 0, az, dx / L, 0, dz / L, b.x - b.w / 2 - pad, -1, b.z - b.d / 2 - pad, b.x + b.w / 2 + pad, 1, b.z + b.d / 2 + pad);
        if (h >= 0 && h < L && h < bestT) { bestT = h; best = b; }
      }
    }
    return best;
  }
}

const EMPTY = [];
export const topOf = (b) => b.y + b.h + (b.cover ? 0 : 0.5);

export function distToSeg(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

export function rayAABB(ox, oy, oz, dx, dy, dz, x0, y0, z0, x1, y1, z1) {
  let tmin = -Infinity, tmax = Infinity;
  const axes = [[ox, dx, x0, x1], [oy, dy, y0, y1], [oz, dz, z0, z1]];
  for (const [o, d, a, b] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (o < a || o > b) return -1;
    } else {
      let t1 = (a - o) / d, t2 = (b - o) / d;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
  }
  if (tmax < 0) return -1;
  return tmin >= 0 ? tmin : 0;
}

// Ray vs sphere; returns distance or -1
export function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const lx = cx - ox, ly = cy - oy, lz = cz - oz;
  const tca = lx * dx + ly * dy + lz * dz;
  const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
  if (d2 > r * r) return -1;
  const thc = Math.sqrt(r * r - d2);
  const t0 = tca - thc;
  if (t0 >= 0) return t0;
  const t1 = tca + thc;
  return t1 >= 0 ? 0 : -1;
}

// Ray vs vertical capsule (segment from y0 to y1 at x,z with radius r)
export function rayCapsule(ox, oy, oz, dx, dy, dz, cx, cz, y0, y1, r) {
  // closest approach between ray and vertical segment, sampled analytically in XZ
  const ddx = dx, ddz = dz;
  const a = ddx * ddx + ddz * ddz;
  let best = -1;
  if (a > 1e-9) {
    const fx = ox - cx, fz = oz - cz;
    const b = 2 * (fx * ddx + fz * ddz);
    const c = fx * fx + fz * fz - r * r;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      const t = (-b - sq) / (2 * a);
      const t2 = (-b + sq) / (2 * a);
      for (const tt of [t, t2]) {
        if (tt >= 0) {
          const y = oy + dy * tt;
          if (y >= y0 && y <= y1) { best = tt; break; }
        }
      }
    }
  }
  // caps
  for (const cy of [y0, y1]) {
    const h = raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r);
    if (h >= 0 && (best < 0 || h < best)) best = h;
  }
  return best;
}
