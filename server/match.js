// Authoritative match simulation: players (humans + bots), vehicles,
// projectiles, objectives, game-mode rules, lag-compensated hit detection.
import { World, rayCapsule, raySphere } from '../shared/world.js';
import { MAPS } from '../shared/maps.js';
import { MODES } from '../shared/modes.js';
import { WEAPONS, WEAPON_BY_NAME, GRENADE, C4, damageAt, sanitizeLoadout, MUZZLES } from '../shared/weapons.js';
import { encodeSnapshot, VEHICLES, PF, VF, hitboxes, EYE } from '../shared/protocol.js';
import { Rng, clamp } from '../shared/rng.js';
import { BotBrain, makeBotLoadout, BOT_NAMES } from './bot.js';
import { VehicleAI } from './vehicleAI.js';

const TICK = 1 / 20;
let MATCH_SEQ = 1;

export class Match {
  constructor(modeId, mapId, opts = {}) {
    this.id = MATCH_SEQ++;
    this.mode = MODES[modeId];
    this.map = MAPS[mapId];
    this.world = new World(this.map);
    this.rng = new Rng((Date.now() ^ (this.id * 7919)) >>> 0);
    this.players = new Map();
    this.vehicles = [];
    this.projectiles = new Map();
    this.boxes = new Map();
    this.nextPid = 1;
    this.nextProj = 1;
    this.time = 0; // ms since start
    this.events = [];
    this.history = [];
    this.ended = false;
    this.onEnd = opts.onEnd || (() => {});
    this.headless = !!opts.headless;
    this.lootOpened = new Set();
    this.lastState = 0;
    this.lastBoard = 0;
    this._setupMode();
    this._spawnVehicles();
  }

  // ---------------------------------------------------------------- setup
  _setupMode() {
    const m = this.mode, w = this.world;
    this.teamCount = m.teams === 0 ? 0 : m.teams;
    this.tickets = [m.tickets || 0, m.tickets || 0];
    this.kills = [0, 0];
    this.objectives = [];
    this.area = null;
    this.ladder = m.ladder ? m.ladder.map((n) => WEAPON_BY_NAME[n].id) : null;
    if (m.id === 'conquest') {
      this.objectives = w.sites.map((s) => this._makeFlag(s.id, s.x, s.z, s.radius));
      // each team starts owning the flag nearest their base
      const sorted = [...this.objectives].sort((a, b) => a.t - b.t);
      sorted[0].owner = 0; sorted[0].prog = -100;
      sorted[sorted.length - 1].owner = 1; sorted[sorted.length - 1].prog = 100;
    } else if (m.id === 'breakthrough') {
      const sorted = [...w.sites].sort((a, b) => a.t - b.t);
      this.objectives = sorted.map((s) => this._makeFlag(s.id, s.x, s.z, s.radius));
      this.sectors = [];
      for (let i = 0; i < this.objectives.length; i += 2) this.sectors.push(this.objectives.slice(i, i + 2).map((o) => o.id));
      this.sector = 0;
      for (const o of this.objectives) { o.owner = 1; o.prog = 100; }
      this.attackers = 0;
      this.tickets = [m.tickets, 0];
    } else if (m.kind === 'hill') {
      // one hill that relocates every few seconds
      const c = w.centerSite;
      const ax = Math.cos(w.axisAngle), az = Math.sin(w.axisAngle);
      this.area = { x: c.x, z: c.z, r: m.area };
      this.hillSpots = [-0.55, 0.0, 0.55, 0.0].map((k, i) => {
        const side = i === 1 ? 0.5 : i === 3 ? -0.5 : 0;
        const spot = this.findFreeSpot(c.x + ax * k * m.area + -az * side * m.area, c.z + az * k * m.area + ax * side * m.area, 6);
        return spot;
      });
      this.hillIdx = 1;
      this.hillMoveAt = m.hillSeconds;
      const h = this.hillSpots[this.hillIdx];
      this.objectives = [this._makeFlag('H', h.x, h.z, 16)];
    } else if (m.kind === 'dom') {
      const c = w.centerSite;
      const ax = Math.cos(w.axisAngle), az = Math.sin(w.axisAngle);
      this.area = { x: c.x, z: c.z, r: m.area };
      const pts = [[-1, 'A'], [0, 'B'], [1, 'C']].map(([k, id]) => {
        let x = c.x + ax * k * m.area * 0.45, z = c.z + az * k * m.area * 0.45;
        const spot = this.findFreeSpot(x, z, 6);
        return this._makeFlag(id, spot.x, spot.z, 14);
      });
      this.objectives = pts;
    } else if (m.kind === 'tdm' || m.kind === 'ffa') {
      const c = w.centerSite;
      this.area = { x: c.x, z: c.z, r: m.area };
    } else if (m.br) {
      const r = this.rng;
      this.zone = { x: 0, z: 0, r: w.half * 1.45, nx: 0, nz: 0, nr: w.half * 1.45, phase: -1, phaseStart: 0, shrinkStart: 0, shrinkEnd: 0, dps: 0 };
      const phases = [];
      let rad = w.half * 1.0, cx = 0, cz = 0;
      const dps = [1, 2, 4, 7, 10, 15];
      for (let i = 0; i < 6; i++) {
        const nr = rad * (i < 5 ? 0.55 : 0.0);
        const off = (rad - nr) * r.float(0, 0.8);
        const a = r.float(0, Math.PI * 2);
        cx = clamp(cx + Math.cos(a) * off, -w.half * 0.6, w.half * 0.6);
        cz = clamp(cz + Math.sin(a) * off, -w.half * 0.6, w.half * 0.6);
        phases.push({ wait: i === 0 ? 120 : 75, shrink: 60, x: cx, z: cz, r: Math.max(nr, 0), dps: dps[i] });
        rad = nr;
      }
      this.zonePhases = phases;
      // flight path across the map
      const a = r.float(0, Math.PI * 2);
      this.flight = { ax: Math.cos(a) * -w.half * 0.9, az: Math.sin(a) * -w.half * 0.9, bx: Math.cos(a) * w.half * 0.9, bz: Math.sin(a) * w.half * 0.9 };
    }
  }

  _makeFlag(id, x, z, radius) {
    const s = this.world.sites.find((q) => q.id === id);
    const ax = Math.cos(this.world.axisAngle), az = Math.sin(this.world.axisAngle);
    return { id, x, z, y: this.world.heightAt(x, z), radius: Math.max(radius, 18), owner: -1, prog: 0, t: s ? s.t : (x * ax + z * az) / this.world.half, contested: false, counts: [0, 0] };
  }

  _spawnVehicles() {
    if (!this.mode.vehicles) return;
    const w = this.world;
    let id = 1;
    if (this.mode.br) {
      // neutral vehicles scattered across the map
      const r = new Rng(this.map.seed ^ 0x99);
      for (let i = 0; i < 10; i++) {
        const s = w.sites[i % w.sites.length];
        const type = i % 4 === 3 ? 'heli' : 'jeep';
        const spot = this.findFreeSpot(s.x + r.float(-60, 60), s.z + r.float(-60, 60), 6);
        this.vehicles.push(this._makeVehicle(id++, type, 255, spot.x, spot.z, r.float(0, 6)));
      }
      return;
    }
    for (const sp of w.vehicleSpawns) {
      const spot = this.findFreeSpot(sp.x, sp.z, VEHICLES[sp.type].radius + 1);
      this.vehicles.push(this._makeVehicle(id++, sp.type, sp.team, spot.x, spot.z, sp.yaw));
    }
  }

  _makeVehicle(id, type, team, x, z, yaw) {
    const y = this.world.heightAt(x, z) + (type === 'jet' || type === 'heli' ? 0.1 : 0.0);
    return { id, type, team, x, y, z, yaw, pitch: 0, roll: 0, turret: 0, hp: VEHICLES[type].hp, driver: -1, destroyed: false,
      spawn: { x, z, yaw }, respawnAt: 0, lastDamageAt: -1e9, flags: 0, speed: 0, idleSince: 0, ai: null, lastMain: 0, lastMg: 0, clip: VEHICLES[type].weapon?.clip || 0 };
  }

  findFreeSpot(x, z, pad = 1.5) {
    const w = this.world;
    for (let i = 0; i < 30; i++) {
      const r = i === 0 ? 0 : 2 + i * 1.5;
      const a = this.rng.float(0, Math.PI * 2);
      const px = clamp(x + Math.cos(a) * r, -w.half + 10, w.half - 10), pz = clamp(z + Math.sin(a) * r, -w.half + 10, w.half - 10);
      if (!w.pointInBuilding(px, pz, pad) && w.heightAt(px, pz) > w.waterLevel + 0.3) return { x: px, z: pz };
    }
    return { x, z };
  }

  // ---------------------------------------------------------------- players
  addPlayer({ name, client = null, loadout = null, isBot = false, team = null, squad = null }) {
    const id = this.nextPid++;
    const p = {
      id, name, client, isBot, team: 0, squad: 0, loadout: null,
      x: 0, y: 0, z: 0, yaw: 0, pitch: 0, stance: 0, ads: false, slot: 0, weaponId: 0,
      hp: 100, alive: false, deadAt: -1e9, lastDamageAt: -1e9, lastDamager: -1, vehicle: -1,
      kills: 0, deaths: 0, headshots: 0, score: 0, caps: 0, spottedUntil: 0, firingUntil: 0, para: 0,
      lastShot: {}, outSince: 0, eliminated: false, pev: [], joinedAt: this.time, deployPending: !isBot,
      brWeapon: -1, ping: 0,
    };
    p.loadout = isBot ? makeBotLoadout(this.rng, this.mode) : sanitizeLoadout(loadout);
    this.applyModeLoadout(p);
    if (this.mode.br) { p.loadout.primary = -1; p.loadout.gadget = -1; p.slot = 1; }
    this._assignTeam(p, team, squad);
    p.weaponId = this.currentWeapon(p);
    this.players.set(id, p);
    if (isBot) p.bot = new BotBrain(this, p);
    this.events.push(['j', id, name, p.team, p.squad, isBot ? 1 : 0, p.loadout.cls]);
    return p;
  }

  // Mode rules that override the chosen loadout: allowed weapon categories, gadget ban, gun master ladder.
  applyModeLoadout(p) {
    const m = this.mode, l = p.loadout;
    if (m.cats) {
      const cur = WEAPONS[l.primary];
      if (!cur || !m.cats.includes(cur.cat)) {
        const pool = WEAPONS.filter((w) => w.slot === 'primary' && m.cats.includes(w.cat));
        const pick = pool.find((w) => w.classes.includes(l.cls)) || pool[0];
        l.primary = pick.id;
        l.sight = pick.sight;
        l.muzzle = m.cats.includes('sniper') ? 'suppressor' : pick.muzzleDefault;
      }
    }
    if (m.noGadget) l.gadget = -1;
    if (this.ladder) {
      const lv = Math.min(p.kills, this.ladder.length - 1);
      const w = WEAPONS[this.ladder[lv]];
      l.primary = w.id; l.sight = w.sight; l.muzzle = w.muzzleDefault; l.gadget = -1;
    }
    if (p.bot && (m.cats || this.ladder)) { p.bot.mag = {}; p.bot.reloadUntil = 0; }
  }

  advanceLadder(p) {
    if (!this.ladder) return;
    const before = p.loadout.primary;
    this.applyModeLoadout(p);
    if (p.loadout.primary === before) return;
    if (p.slot === 0) p.weaponId = this.currentWeapon(p);
    if (!p.isBot) p.pev.push(['gm', p.loadout.primary, Math.min(p.kills, this.ladder.length)]);
  }

  _assignTeam(p, team, squad) {
    const m = this.mode;
    if (m.teams === 0) { p.team = p.id & 255; p.squad = 0; return; }
    if (m.br) {
      // fill squads of 4; humans are grouped together first
      const counts = new Array(m.teams).fill(0);
      for (const q of this.players.values()) counts[q.team]++;
      let best = 0;
      if (!p.isBot) { best = counts.findIndex((c, i) => c < m.squadSize && [...this.players.values()].some((q) => q.team === i && !q.isBot)); if (best < 0) best = counts.findIndex((c) => c === 0); }
      else best = counts.findIndex((c) => c < m.squadSize);
      p.team = Math.max(0, best); p.squad = p.team;
      return;
    }
    if (team !== null) p.team = team;
    else {
      const c = [0, 0];
      for (const q of this.players.values()) c[q.team]++;
      p.team = c[0] <= c[1] ? 0 : 1;
    }
    if (squad !== null) { p.squad = squad; return; }
    const sq = new Map();
    for (const q of this.players.values()) if (q.team === p.team) sq.set(q.squad, (sq.get(q.squad) || 0) + 1);
    let s = 0;
    while ((sq.get(s) || 0) >= 4) s++;
    p.squad = s;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    if (p.vehicle >= 0) this.exitVehicle(p);
    this.players.delete(id);
    this.events.push(['l', id]);
  }

  humans() { return [...this.players.values()].filter((p) => !p.isBot); }
  bots() { return [...this.players.values()].filter((p) => p.isBot); }

  fillBots() {
    const need = this.mode.maxPlayers - this.players.size;
    const used = new Set([...this.players.values()].map((p) => p.name));
    for (let i = 0; i < need; i++) {
      let name;
      do { name = this.rng.pick(BOT_NAMES) + (this.rng.chance(0.5) ? this.rng.int(1, 99) : ''); } while (used.has(name));
      used.add(name);
      this.addPlayer({ name, isBot: true });
    }
  }

  // A late-joining human replaces a bot to keep the player count constant
  replaceBotWithHuman(name, client, loadout) {
    const bots = this.bots();
    let team = null, squad = null;
    if (bots.length) {
      let victim;
      if (this.mode.teams === 2) {
        const c = [0, 0];
        for (const q of this.players.values()) if (!q.isBot) c[q.team]++;
        const t = c[0] <= c[1] ? 0 : 1;
        victim = bots.find((b) => b.team === t && b.vehicle < 0) || bots[0];
        team = victim.team; squad = victim.squad;
      } else victim = bots[0];
      this.removePlayer(victim.id);
    }
    return this.addPlayer({ name, client, loadout, team, squad });
  }

  currentWeapon(p) {
    if (this.mode.br) {
      if (p.slot === 0 && p.brWeapon >= 0) return p.brWeapon;
      return p.loadout.secondary;
    }
    if (p.slot === 0) return p.loadout.primary;
    if (p.slot === 1) return p.loadout.secondary;
    if (p.slot === 2 && p.loadout.gadget >= 0) return p.loadout.gadget;
    return p.loadout.primary;
  }

  // ---------------------------------------------------------------- spawning
  spawnOptions(p) {
    const opts = [];
    const m = this.mode;
    if (m.br) return opts;
    if (this.area) return [{ id: 'area', label: '전투 구역' }];
    opts.push({ id: 'hq', label: '본부 (HQ)' });
    for (const o of this.objectives) {
      if (o.owner === p.team && !o.contested) {
        if (m.id === 'breakthrough' && p.team === this.attackers) opts.push({ id: 'flag:' + o.id, label: '거점 ' + o.id });
        else if (m.id !== 'breakthrough' || this._sectorIndexOf(o.id) >= this.sector) opts.push({ id: 'flag:' + o.id, label: '거점 ' + o.id });
      }
    }
    for (const q of this.players.values()) {
      if (q.id !== p.id && q.alive && q.team === p.team && q.squad === p.squad && q.vehicle < 0 && this.time - q.lastDamageAt > 4000)
        opts.push({ id: 'squad:' + q.id, label: '분대원 ' + q.name });
    }
    for (const v of this.vehicles) {
      if (!v.destroyed && v.team === p.team && v.driver < 0 && this._nearBase(v, p.team)) opts.push({ id: 'veh:' + v.id, label: VEHICLES[v.type].label });
    }
    return opts;
  }

  _nearBase(v, team) {
    const b = this.world.bases[team];
    return b && Math.hypot(v.x - b.x, v.z - b.z) < 140;
  }

  _sectorIndexOf(fid) {
    if (!this.sectors) return 0;
    return this.sectors.findIndex((s) => s.includes(fid));
  }

  spawnPlayer(p, choice = 'hq', loadout = null) {
    if (p.alive || p.eliminated) return false;
    if (loadout && !p.isBot) {
      const keepBr = p.brWeapon;
      p.loadout = sanitizeLoadout(loadout);
      this.applyModeLoadout(p);
      if (this.mode.br) { p.loadout.primary = -1; p.loadout.gadget = -1; p.brWeapon = keepBr; }
    }
    const w = this.world;
    let pos = null;
    let vehicle = null;
    const m = this.mode;
    if (m.br) {
      return false; // BR spawns only at match start
    } else if (this.area) {
      pos = this._areaSpawn(p);
    } else if (choice.startsWith('flag:')) {
      const o = this.objectives.find((q) => 'flag:' + q.id === choice);
      if (o && o.owner === p.team && !o.contested) pos = this.findFreeSpot(o.x + this.rng.float(-o.radius, o.radius) * 0.8, o.z + this.rng.float(-o.radius, o.radius) * 0.8);
    } else if (choice.startsWith('squad:')) {
      const q = this.players.get(+choice.slice(6));
      if (q && q.alive && q.team === p.team && q.vehicle < 0) pos = this.findFreeSpot(q.x + this.rng.float(-2, 2), q.z + this.rng.float(-2, 2), 0.6);
    } else if (choice.startsWith('veh:')) {
      const v = this.vehicles.find((q) => 'veh:' + q.id === choice);
      if (v && !v.destroyed && v.driver < 0 && v.team === p.team) { vehicle = v; pos = { x: v.x, z: v.z }; }
    }
    if (!pos) {
      let base = w.bases[p.team] || w.bases[0];
      if (m.id === 'breakthrough' && p.team !== this.attackers) {
        // defenders spawn behind the active sector
        const ids = this.sectors[Math.min(this.sector + 1, this.sectors.length - 1)];
        const o = this.objectives.find((q) => q.id === ids[0]);
        if (this.sector + 1 < this.sectors.length && o && o.owner === p.team) base = o;
      } else if (m.id === 'breakthrough' && p.team === this.attackers && this.sector > 0) {
        const prev = this.sectors[this.sector - 1].map((id) => this.objectives.find((q) => q.id === id));
        if (prev[0]) base = prev[0];
      }
      pos = this.findFreeSpot(base.x + this.rng.float(-25, 25), base.z + this.rng.float(-25, 25));
    }
    p.x = pos.x; p.z = pos.z; p.y = w.groundAt(p.x, p.z);
    p.hp = 100; p.alive = true; p.stance = 0; p.para = 0; p.slot = 0;
    p.lastDamageAt = -1e9; p.deployPending = false; p.outSince = 0;
    p.yaw = Math.atan2(-(0 - p.x), -(0 - p.z)); // face map centre
    p.weaponId = this.currentWeapon(p);
    if (p.bot) p.bot.onSpawn();
    if (vehicle) this.enterVehicle(p, vehicle.id, true);
    if (!p.isBot) p.pev.push(['sp', +p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2), +p.yaw.toFixed(3), p.vehicle, p.loadout]);
    return true;
  }

  _areaSpawn(p) {
    const a = this.area;
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < 12; i++) {
      const ang = this.rng.float(0, Math.PI * 2), r = Math.sqrt(this.rng.next()) * a.r * 0.85;
      const s = this.findFreeSpot(a.x + Math.cos(ang) * r, a.z + Math.sin(ang) * r);
      let minD = 999;
      for (const q of this.players.values()) if (q.alive && this.isEnemy(p, q)) minD = Math.min(minD, Math.hypot(q.x - s.x, q.z - s.z));
      const score = Math.min(minD, 60) + this.rng.float(0, 10);
      if (score > bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  startBattleRoyale() {
    const f = this.flight;
    const ps = [...this.players.values()];
    for (const p of ps) {
      // each squad jumps from a point along the flight path
      const t = ((p.team * 0.618) % 1) * 0.8 + 0.1 + this.rng.float(-0.02, 0.02);
      p.x = f.ax + (f.bx - f.ax) * t + this.rng.float(-15, 15);
      p.z = f.az + (f.bz - f.az) * t + this.rng.float(-15, 15);
      p.y = this.world.heightAt(p.x, p.z) + 650;
      p.alive = true; p.hp = 100; p.para = 1; p.deployPending = false; p.slot = 1;
      p.weaponId = this.currentWeapon(p);
      p.yaw = Math.atan2(-(f.bx - f.ax), -(f.bz - f.az));
      if (p.bot) p.bot.onSpawn();
      if (!p.isBot) p.pev.push(['sp', +p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2), +p.yaw.toFixed(3), -1, p.loadout, 1]);
    }
  }

  start() {
    if (this.mode.br) this.startBattleRoyale();
    else for (const p of this.players.values()) if (p.isBot) this.spawnPlayer(p, 'hq');
  }

  isEnemy(a, b) {
    if (a.id === b.id) return false;
    return a.team !== b.team;
  }

  // ---------------------------------------------------------------- vehicles
  enterVehicle(p, vid, force = false) {
    const v = this.vehicles.find((q) => q.id === vid);
    if (!v || v.destroyed || !p.alive) return false;
    if (v.team !== 255 && v.team !== p.team) return false;
    if (!force && Math.hypot(v.x - p.x, v.z - p.z) > VEHICLES[v.type].radius + 4) return false;
    if (v.driver >= 0) {
      const d = this.players.get(v.driver);
      if (d && !d.isBot) return false;
      if (d) this.exitVehicle(d); // humans take priority over bot drivers
    }
    v.driver = p.id;
    p.vehicle = v.id;
    p.stance = 0;
    v.idleSince = 0;
    if (!p.isBot) {
      v.ai = null;
      p.pev.push(['ve', v.id, v.type, +v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2), +v.yaw.toFixed(3), +v.pitch.toFixed(3), +v.roll.toFixed(3), Math.round(v.hp), v.clip]);
    } else v.ai = new VehicleAI(this, v, p);
    return true;
  }

  exitVehicle(p, pos = null) {
    const v = this.vehicles.find((q) => q.id === p.vehicle);
    p.vehicle = -1;
    if (!v) return;
    v.driver = -1;
    v.ai = null;
    v.idleSince = this.time;
    const side = VEHICLES[v.type].radius + 1.2;
    const sp = pos || this.findFreeSpot(v.x + Math.cos(v.yaw) * side, v.z - Math.sin(v.yaw) * side, 0.5);
    p.x = sp.x; p.z = sp.z;
    const g = this.world.groundAt(p.x, p.z);
    p.y = Math.max(g, pos && pos.y !== undefined ? pos.y : g);
    if (VEHICLES[v.type].air && v.y - this.world.heightAt(v.x, v.z) > 15) { p.y = v.y - 3; p.para = 2; }
    if (!p.isBot) p.pev.push(['vx', +p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2), p.para]);
  }

  damageVehicle(v, amount, attacker, weaponId) {
    if (v.destroyed) return;
    v.hp -= amount;
    v.lastDamageAt = this.time;
    if (attacker && !attacker.isBot) attacker.pev.push(['h', Math.round(amount), 0, 0, 1]);
    if (v.hp <= 0) this.destroyVehicle(v, attacker, weaponId);
  }

  destroyVehicle(v, attacker, weaponId = 250) {
    v.hp = 0; v.destroyed = true; v.respawnAt = this.time + 45000;
    this.events.push(['vd', v.id, +v.x.toFixed(1), +v.y.toFixed(1), +v.z.toFixed(1)]);
    if (attacker) { attacker.score += 200; }
    if (v.driver >= 0) {
      const d = this.players.get(v.driver);
      v.driver = -1;
      if (d) { d.vehicle = -1; this.killPlayer(d, attacker, weaponId, false); }
    }
  }

  // ---------------------------------------------------------------- combat
  // Lag compensation: find recorded hitbox positions near time t
  _historyAt(t) {
    if (!t || this.history.length === 0) return null;
    const tt = Math.max(t, this.time - 350);
    let best = null, bd = Infinity;
    for (const h of this.history) { const d = Math.abs(h.t - tt); if (d < bd) { bd = d; best = h; } }
    return best && bd < 120 ? best.pos : null;
  }

  // Hitscan shot. dirs: array of unit vectors (shotgun pellets)
  fireHitscan(p, w, ox, oy, oz, dirs, viewTime, opts = {}) {
    const hist = p.isBot ? null : this._historyAt(viewTime);
    const maxDist = w.cat === 'sniper' ? 1500 : w.cat === 'dmr' ? 1000 : opts.maxDist || 800;
    const muzzle = opts.muzzle || 'none';
    let firstEnd = null, firstHit = 0;
    const totals = new Map();
    for (const [dx, dy, dz] of dirs) {
      const wr = this.world.raycast(ox, oy, oz, dx, dy, dz, maxDist);
      let best = wr.dist, hitP = null, head = false, hitV = null;
      for (const q of this.players.values()) {
        if (!q.alive || q.id === p.id || q.vehicle >= 0) continue;
        if (!this.isEnemy(p, q) ) continue;
        let qx = q.x, qy = q.y, qz = q.z, st = q.stance;
        if (hist) { const h = hist.get(q.id); if (h) { qx = h[0]; qy = h[1]; qz = h[2]; st = h[3]; } }
        // broad phase
        const bx = qx - ox, by = qy + 1 - oy, bz = qz - oz;
        const along = bx * dx + by * dy + bz * dz;
        if (along < 0 || along > best + 2) continue;
        const perp2 = bx * bx + by * by + bz * bz - along * along;
        if (perp2 > 4) continue;
        const hb = hitboxes(st);
        let hx = qx, hz = qz;
        if (st === 2) { hx += Math.sin(q.yaw) * -0.8; hz += Math.cos(q.yaw) * -0.8; }
        const th = raySphere(ox, oy, oz, dx, dy, dz, hx, qy + hb.head.y, hz, hb.head.r);
        const tb = rayCapsule(ox, oy, oz, dx, dy, dz, qx, qz, qy + hb.body.y0, qy + hb.body.y1, hb.body.r);
        if (th >= 0 && th < best && (tb < 0 || th <= tb + 0.05)) { best = th; hitP = q; head = true; }
        else if (tb >= 0 && tb < best) { best = tb; hitP = q; head = false; }
      }
      for (const v of this.vehicles) {
        if (v.destroyed || v.id === p.vehicle) continue;
        if (v.team !== 255 && v.team === p.team && v.driver >= 0) continue;
        const R = VEHICLES[v.type].radius * (v.type === 'jet' || v.type === 'heli' ? 0.7 : 0.8);
        const t = raySphere(ox, oy, oz, dx, dy, dz, v.x, v.y + VEHICLES[v.type].height * 0.5, v.z, R);
        if (t >= 0 && t < best) { best = t; hitV = v; hitP = null; }
      }
      const ex = ox + dx * best, ey = oy + dy * best, ez = oz + dz * best;
      if (!firstEnd) { firstEnd = [ex, ey, ez]; firstHit = hitP ? 1 : hitV ? 3 : wr.type ? 2 : 0; }
      if (hitP) {
        let dmg = (opts.dmg || damageAt(w, best, muzzle)) * (head ? w.headMult || 2 : 1);
        const hb = hitboxes(hitP.stance);
        if (!head && ey < hitP.y + hb.body.y0 + (hb.body.y1 - hb.body.y0) * 0.35) dmg *= 0.85; // legs
        const cur = totals.get(hitP) || { dmg: 0, head: false };
        cur.dmg += dmg; cur.head = cur.head || head;
        totals.set(hitP, cur);
      } else if (hitV) {
        const vd = opts.vehDmg !== undefined ? opts.vehDmg : (w.vehDmg || (w.cat === 'sniper' ? 6 : 1.5));
        this.damageVehicle(hitV, vd, p, w.id);
      }
    }
    for (const [q, r] of totals) this.applyDamage(q, r.dmg, p, opts.weaponId ?? w.id, r.head, ox, oz);
    if (firstEnd) this.events.push(['s', p.id, +firstEnd[0].toFixed(1), +firstEnd[1].toFixed(1), +firstEnd[2].toFixed(1), firstHit, opts.weaponId ?? w.id, MUZZLES[muzzle] && !MUZZLES[muzzle].loud ? 1 : 0]);
    p.firingUntil = this.time + 300;
    if (!MUZZLES[muzzle] || MUZZLES[muzzle].loud) p.spottedUntil = Math.max(p.spottedUntil, this.time + 1500);
    if (this.onShot) this.onShot(p, ox, oz);
    for (const q of this.players.values()) if (q.bot && q.alive) q.bot.hearShot(p, ox, oz, MUZZLES[muzzle] && !MUZZLES[muzzle].loud);
  }

  applyDamage(q, dmg, attacker, weaponId, head, fromX, fromZ) {
    if (!q.alive || dmg <= 0) return;
    if (attacker && attacker.id !== q.id && !this.isEnemy(attacker, q)) return;
    if (this.mode.dmgMult && attacker) dmg *= this.mode.dmgMult;
    q.hp -= dmg;
    q.lastDamageAt = this.time;
    q.lastDamager = attacker ? attacker.id : -1;
    const killed = q.hp <= 0;
    if (attacker && !attacker.isBot && attacker.id !== q.id) attacker.pev.push(['h', Math.round(dmg), head ? 1 : 0, killed ? 1 : 0, 0]);
    if (!q.isBot) q.pev.push(['d', +fromX.toFixed(1), +fromZ.toFixed(1), Math.max(0, Math.round(q.hp))]);
    if (q.bot) q.bot.onDamaged(attacker, fromX, fromZ);
    if (killed) this.killPlayer(q, attacker, weaponId, head);
  }

  killPlayer(q, attacker, weaponId, head) {
    if (!q.alive) return;
    q.alive = false; q.hp = 0; q.deadAt = this.time; q.deaths++;
    q.deployPending = !q.isBot;
    if (q.vehicle >= 0) {
      const v = this.vehicles.find((x) => x.id === q.vehicle);
      if (v) { v.driver = -1; v.ai = null; v.idleSince = this.time; }
      q.vehicle = -1;
    }
    if (attacker && attacker.id !== q.id) {
      attacker.kills++;
      if (head) attacker.headshots++;
      attacker.score += 100 + (head ? 25 : 0);
      if (this.mode.teams === 2) this.kills[attacker.team]++;
      if (this.ladder) this.advanceLadder(attacker);
    }
    if (this.mode.teams === 2 && this.mode.tickets && !this.mode.noDeathTickets && !(this.mode.id === 'breakthrough' && q.team !== this.attackers)) {
      this.tickets[q.team] = Math.max(0, this.tickets[q.team] - 1);
    }
    if (this.mode.br) {
      q.eliminated = true;
      // drop weapon crate where the player died
      if (q.brWeapon >= 0) {
        this.world.loot.push({ x: q.x, z: q.z, y: q.y, weapon: q.brWeapon, dropped: true });
        this.events.push(['ld', this.world.loot.length - 1, +q.x.toFixed(1), +q.y.toFixed(1), +q.z.toFixed(1), q.brWeapon]);
      }
    }
    this.events.push(['k', attacker ? attacker.id : -1, q.id, weaponId, head ? 1 : 0, +q.x.toFixed(1), +q.y.toFixed(1), +q.z.toFixed(1)]);
    if (q.bot) q.bot.onDeath();
  }

  // ---------------------------------------------------------------- projectiles
  spawnProjectile(owner, kind, ox, oy, oz, vx, vy, vz, spec, extra = {}) {
    const id = this.nextProj++;
    const pr = { id, owner: owner ? owner.id : -1, team: owner ? owner.team : -1, kind, x: ox, y: oy, z: oz, vx, vy, vz,
      dmg: spec.dmg, vehDmg: spec.vehDmg ?? spec.dmg, splash: spec.splash || 4, life: extra.life || 12,
      gravity: kind === 'grenade' || kind === 'frag' || kind === 'c4' ? 9.8 : kind === 'shell' ? 1.5 : 0,
      fuse: kind === 'frag' ? GRENADE.fuse : 0, homing: extra.homing || null, weaponId: extra.weaponId ?? 250, stuck: false, age: 0 };
    this.projectiles.set(id, pr);
    this.events.push(['p', id, kind, +ox.toFixed(2), +oy.toFixed(2), +oz.toFixed(2), +vx.toFixed(2), +vy.toFixed(2), +vz.toFixed(2), pr.owner]);
    return pr;
  }

  _stepProjectiles(dt) {
    const w = this.world;
    for (const pr of [...this.projectiles.values()]) {
      pr.age += dt;
      if (pr.stuck) { if (pr.age > 300) this.projectiles.delete(pr.id); continue; }
      if (pr.homing) {
        const tgt = this.vehicles.find((v) => v.id === pr.homing && !v.destroyed);
        if (tgt) {
          const sp = Math.hypot(pr.vx, pr.vy, pr.vz);
          const tx = tgt.x - pr.x, ty = tgt.y + 1.5 - pr.y, tz = tgt.z - pr.z;
          const tl = Math.hypot(tx, ty, tz) || 1;
          const k = Math.min(1, dt * 2.2);
          pr.vx += (tx / tl * sp - pr.vx) * k; pr.vy += (ty / tl * sp - pr.vy) * k; pr.vz += (tz / tl * sp - pr.vz) * k;
          this.events.push(['pu', pr.id, +pr.x.toFixed(2), +pr.y.toFixed(2), +pr.z.toFixed(2), +pr.vx.toFixed(2), +pr.vy.toFixed(2), +pr.vz.toFixed(2)]);
        }
      }
      pr.vy -= pr.gravity * dt;
      const sp = Math.hypot(pr.vx, pr.vy, pr.vz);
      const step = sp * dt;
      if (step > 1e-4) {
        const dx = pr.vx / sp, dy = pr.vy / sp, dz = pr.vz / sp;
        const hit = w.raycast(pr.x, pr.y, pr.z, dx, dy, dz, step);
        let tHit = hit.type ? hit.dist : Infinity;
        let hitVeh = null;
        let hitPl = null;
        if (pr.kind !== 'c4') {
          for (const v of this.vehicles) {
            if (v.destroyed || (pr.age < 0.15 && v.driver === pr.owner)) continue;
            const t = raySphere(pr.x, pr.y, pr.z, dx, dy, dz, v.x, v.y + VEHICLES[v.type].height * 0.5, v.z, VEHICLES[v.type].radius * 0.85);
            if (t >= 0 && t < step && t < tHit) { tHit = t; hitVeh = v; }
          }
          if (pr.kind !== 'frag') for (const q of this.players.values()) {
            if (!q.alive || q.id === pr.owner || q.vehicle >= 0) continue;
            const t = rayCapsule(pr.x, pr.y, pr.z, dx, dy, dz, q.x, q.z, q.y + 0.2, q.y + 1.6, 0.4);
            if (t >= 0 && t < step && t < tHit) { tHit = t; hitPl = q; hitVeh = null; }
          }
        }
        if (tHit < Infinity) {
          pr.x += dx * tHit; pr.y += dy * tHit; pr.z += dz * tHit;
          if (pr.kind === 'frag') {
            // bounce
            const n = hit.type === 'terrain' ? w.normalAt(pr.x, pr.z) : [0, 1, 0];
            const vn = pr.vx * n[0] + pr.vy * n[1] + pr.vz * n[2];
            pr.vx = (pr.vx - 2 * vn * n[0]) * 0.35; pr.vy = (pr.vy - 2 * vn * n[1]) * 0.35; pr.vz = (pr.vz - 2 * vn * n[2]) * 0.35;
            pr.x += n[0] * 0.05; pr.y += n[1] * 0.05; pr.z += n[2] * 0.05;
            this.events.push(['pu', pr.id, +pr.x.toFixed(2), +pr.y.toFixed(2), +pr.z.toFixed(2), +pr.vx.toFixed(2), +pr.vy.toFixed(2), +pr.vz.toFixed(2)]);
          } else if (pr.kind === 'c4') {
            pr.stuck = true; pr.vx = pr.vy = pr.vz = 0; pr.age = 0;
            this.events.push(['pu', pr.id, +pr.x.toFixed(2), +pr.y.toFixed(2), +pr.z.toFixed(2), 0, 0, 0]);
            continue;
          } else {
            this.explode(pr, hitVeh, hitPl);
            continue;
          }
        } else {
          pr.x += pr.vx * dt; pr.y += pr.vy * dt; pr.z += pr.vz * dt;
        }
      }
      if (pr.kind === 'frag' && pr.age >= pr.fuse) { this.explode(pr); continue; }
      if (pr.age > pr.life || Math.abs(pr.x) > w.half + 200 || Math.abs(pr.z) > w.half + 200 || pr.y < w.waterLevel - 2) {
        if (pr.kind === 'c4') continue;
        this.projectiles.delete(pr.id);
        this.events.push(['x', pr.id, +pr.x.toFixed(1), +pr.y.toFixed(1), +pr.z.toFixed(1), 0]);
      }
    }
  }

  explode(pr, directVeh = null, directPl = null) {
    this.projectiles.delete(pr.id);
    const owner = this.players.get(pr.owner) || null;
    const big = pr.splash >= 5 ? 2 : 1;
    this.events.push(['x', pr.id, +pr.x.toFixed(1), +pr.y.toFixed(1), +pr.z.toFixed(1), big]);
    if (directVeh) this.damageVehicle(directVeh, pr.vehDmg, owner, pr.weaponId);
    for (const v of this.vehicles) {
      if (v.destroyed || v === directVeh) continue;
      const d = Math.hypot(v.x - pr.x, v.y + 1 - pr.y, v.z - pr.z) - VEHICLES[v.type].radius * 0.6;
      if (d < pr.splash) this.damageVehicle(v, pr.vehDmg * 0.5 * (1 - Math.max(0, d) / pr.splash), owner, pr.weaponId);
    }
    for (const q of this.players.values()) {
      if (!q.alive || q.vehicle >= 0) continue;
      const d = Math.hypot(q.x - pr.x, q.y + 0.9 - pr.y, q.z - pr.z);
      const R = pr.splash * 1.4;
      if (q === directPl || d < R) {
        if (q !== directPl && !this.world.lineClear(pr.x, pr.y + 0.3, pr.z, q.x, q.y + 1.0, q.z)) continue;
        const f = q === directPl ? 1 : Math.max(0, 1 - d / R) ** 0.8;
        const dmg = pr.dmg * f;
        if (owner && q.id !== owner.id && !this.isEnemy(owner, q)) continue;
        this.applyDamage(q, dmg, owner || q, pr.weaponId, false, pr.x, pr.z);
      }
    }
    for (const qq of this.players.values()) if (qq.bot && qq.alive) qq.bot.hearShot({ id: pr.owner, x: pr.x, z: pr.z, team: pr.team }, pr.x, pr.z, false);
  }

  detonateC4(p) {
    for (const pr of [...this.projectiles.values()]) if (pr.kind === 'c4' && pr.owner === p.id) this.explode(pr);
  }

  // ---------------------------------------------------------------- client input
  handleInput(p, msg) {
    switch (msg.t) {
      case 'st': {
        if (!p.alive) return;
        if (Array.isArray(msg.p) && msg.p.length === 3 && msg.p.every(Number.isFinite)) {
          const lim = this.world.half - 2;
          p.x = clamp(msg.p[0], -lim, lim); p.y = clamp(msg.p[1], -200, 3000); p.z = clamp(msg.p[2], -lim, lim);
        }
        if (Array.isArray(msg.r)) { p.yaw = +msg.r[0] || 0; p.pitch = clamp(+msg.r[1] || 0, -1.6, 1.6); }
        p.stance = msg.s === 1 ? 1 : msg.s === 2 ? 2 : 0;
        p.ads = !!msg.a;
        p.para = msg.pa | 0;
        if (msg.w === 0 || msg.w === 1 || msg.w === 2) { p.slot = msg.w; p.weaponId = this.currentWeapon(p); }
        if (p.vehicle >= 0 && msg.v) {
          const v = this.vehicles.find((q) => q.id === p.vehicle);
          if (v && Array.isArray(msg.v) && msg.v.every(Number.isFinite)) {
            [v.x, v.y, v.z, v.yaw, v.pitch, v.roll, v.turret] = msg.v;
            v.speed = msg.vs || 0;
            p.x = v.x; p.y = v.y; p.z = v.z;
          }
        }
        break;
      }
      case 'fire': {
        if (!p.alive || p.vehicle >= 0) return;
        const w = WEAPONS[msg.w];
        if (!w || !this._ownsWeapon(p, w.id)) return;
        const last = p.lastShot[w.id] || -1e9;
        if (this.time - last < w.fireInterval * 1000 * 0.6 - 25) return;
        p.lastShot[w.id] = this.time;
        if (!valid3(msg.o) || !Array.isArray(msg.d)) return;
        if (Math.hypot(msg.o[0] - p.x, msg.o[2] - p.z) > 6) return;
        const dirs = msg.d.slice(0, 12).filter(valid3).map(norm3);
        if (!dirs.length) return;
        if (w.projectile || w.cat === 'launcher') {
          const d = dirs[0];
          let homing = null;
          if (w.homing) homing = this._lockTarget(p, msg.o, d, w.homing);
          this.spawnProjectile(p, w.projectile === 'grenade' ? 'grenade' : 'rocket', msg.o[0], msg.o[1], msg.o[2], d[0] * w.vel, d[1] * w.vel, d[2] * w.vel,
            { dmg: w.dmg[0], vehDmg: w.vehDmg, splash: w.splash }, { homing, weaponId: w.id });
          p.spottedUntil = this.time + 3000;
        } else {
          this.fireHitscan(p, w, msg.o[0], msg.o[1], msg.o[2], dirs, msg.vt, { muzzle: w.id === p.loadout.primary ? p.loadout.muzzle : 'none' });
        }
        break;
      }
      case 'throw': {
        if (!p.alive || p.vehicle >= 0 || !valid3(msg.o) || !valid3(msg.v)) return;
        const kind = msg.k === 'c4' ? 'c4' : 'frag';
        if (kind === 'c4' && p.loadout.cls !== 'recon') return;
        const key = 'throw_' + kind;
        if (this.time - (p.lastShot[key] || -1e9) < (kind === 'c4' ? 1500 : 4000)) return;
        p.lastShot[key] = this.time;
        const v = msg.v.map((x) => clamp(x, -30, 30));
        this.spawnProjectile(p, kind, msg.o[0], msg.o[1], msg.o[2], v[0], v[1], v[2], kind === 'c4' ? C4 : { dmg: GRENADE.dmg, splash: GRENADE.splash, vehDmg: 60 }, { weaponId: kind === 'c4' ? 252 : 251, life: kind === 'c4' ? 600 : 10 });
        break;
      }
      case 'det': this.detonateC4(p); break;
      case 'vfire': {
        if (!p.alive || p.vehicle < 0 || !valid3(msg.o) || !valid3(msg.d)) return;
        const v = this.vehicles.find((q) => q.id === p.vehicle);
        if (v) this.vehicleFire(v, p, msg.k === 'mg' ? 'mg' : 'main', msg.o, norm3(msg.d), msg.vt);
        break;
      }
      case 'enter': if (p.alive && p.vehicle < 0) this.enterVehicle(p, msg.id | 0); break;
      case 'exit': if (p.vehicle >= 0) this.exitVehicle(p, valid3(msg.p) ? { x: msg.p[0], y: msg.p[1], z: msg.p[2] } : null); break;
      case 'vcrash': {
        const v = this.vehicles.find((q) => q.id === p.vehicle);
        if (v) this.destroyVehicle(v, null, 253);
        break;
      }
      case 'deploy': {
        if (p.alive || this.mode.br) return;
        if (this.time - p.deadAt < 4500 && p.deaths > 0) return;
        this.spawnPlayer(p, String(msg.s || 'hq'), msg.l);
        break;
      }
      case 'suicide': if (p.alive) this.killPlayer(p, null, 254, false); break;
      case 'spot': {
        if (!p.alive || !valid3(msg.o) || !valid3(msg.d)) return;
        const d = norm3(msg.d);
        for (const q of this.players.values()) {
          if (!q.alive || !this.isEnemy(p, q)) continue;
          const tx = q.x - msg.o[0], ty = q.y + 1.2 - msg.o[1], tz = q.z - msg.o[2];
          const L = Math.hypot(tx, ty, tz);
          if (L > 600) continue;
          if ((tx * d[0] + ty * d[1] + tz * d[2]) / L > 0.985 && this.world.lineClear(msg.o[0], msg.o[1], msg.o[2], q.x, q.y + 1.2, q.z)) q.spottedUntil = this.time + 9000;
        }
        break;
      }
      case 'box': {
        if (!p.alive || p.loadout.cls !== 'support') return;
        if (this.time - (p.lastShot.box || -1e9) < 20000) return;
        p.lastShot.box = this.time;
        const id = this.nextProj++;
        this.boxes.set(id, { id, x: p.x, y: p.y, z: p.z, team: p.team, owner: p.id, until: this.time + 30000 });
        this.events.push(['bx', id, +p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1), p.team]);
        break;
      }
      case 'loot': {
        if (!p.alive || !this.mode.br) return;
        const idx = msg.i | 0;
        const L = this.world.loot[idx];
        if (!L || this.lootOpened.has(idx) || Math.hypot(L.x - p.x, L.z - p.z) > 4) return;
        this.openLoot(p, idx);
        break;
      }
      case 'ping': p.ping = clamp(msg.v | 0, 0, 999); break;
    }
  }

  openLoot(p, idx) {
    const L = this.world.loot[idx];
    this.lootOpened.add(idx);
    const prim = WEAPONS.filter((w) => w.slot === 'primary');
    const wpn = L.weapon !== undefined ? WEAPONS[L.weapon] : prim[Math.floor(this.rng.next() * prim.length)];
    p.brWeapon = wpn.id;
    p.slot = 0; p.weaponId = wpn.id;
    p.hp = Math.min(100, p.hp + 50);
    this.events.push(['lo', idx, p.id, wpn.id]);
    if (!p.isBot) p.pev.push(['lw', wpn.id]);
  }

  _ownsWeapon(p, wid) {
    if (this.mode.br) return wid === p.brWeapon || wid === p.loadout.secondary;
    return wid === p.loadout.primary || wid === p.loadout.secondary || wid === p.loadout.gadget;
  }

  _lockTarget(p, o, d, kind) {
    let best = null, bd = 0.94;
    for (const v of this.vehicles) {
      if (v.destroyed || (v.team === p.team && v.team !== 255)) continue;
      const air = VEHICLES[v.type].air;
      if ((kind === 'air') !== air) continue;
      if (kind === 'ground' && v.driver < 0) continue;
      const tx = v.x - o[0], ty = v.y - o[1], tz = v.z - o[2];
      const L = Math.hypot(tx, ty, tz);
      if (L > 900) continue;
      const c = (tx * d[0] + ty * d[1] + tz * d[2]) / L;
      if (c > bd) { bd = c; best = v.id; }
    }
    return best;
  }

  vehicleFire(v, p, kind, o, d, viewTime) {
    const spec = VEHICLES[v.type];
    if (kind === 'mg') {
      if (!spec.mg) return;
      if (this.time - v.lastMg < (60000 / spec.mg.rpm) * 0.6) return;
      v.lastMg = this.time;
      const fake = { id: 240, cat: 'lmg', dmg: [spec.mg.dmg, spec.mg.dmg * 0.8], range: [60, 300], headMult: 1.5, vehDmg: 4 };
      this.fireHitscan(p, fake, o[0], o[1], o[2], [d], viewTime, { weaponId: 240, maxDist: 900 });
    } else {
      const wsp = spec.weapon;
      if (!wsp) return;
      if (v.clip !== undefined && wsp.clip) {
        if (v.clip <= 0) { if (this.time - v.lastMain > wsp.clipReload * 1000) v.clip = wsp.clip; else return; }
      }
      if (this.time - v.lastMain < wsp.reload * 1000 * 0.9) return;
      v.lastMain = this.time;
      if (wsp.clip) v.clip--;
      const kindP = v.type === 'tank' ? 'shell' : v.type === 'ifv' ? 'shell' : 'rocket';
      let homing = null;
      if (wsp.homing) homing = this._lockTarget(p, o, d, 'air') || this._lockTarget(p, o, d, 'ground');
      const vel = wsp.vel + (v.speed || 0);
      this.spawnProjectile(p, kindP, o[0], o[1], o[2], d[0] * vel, d[1] * vel, d[2] * vel, wsp, { homing, weaponId: 240 + ['tank', 'ifv', 'jeep', 'heli', 'jet'].indexOf(v.type) + 1, life: 6 });
    }
  }

  // ---------------------------------------------------------------- tick
  tick() {
    if (this.ended) return;
    const dt = TICK;
    this.time += dt * 1000;
    // bots
    for (const p of this.players.values()) {
      if (p.isBot) {
        if (p.alive) p.bot.update(dt);
        else if (!p.eliminated && this.mode.respawn && this.time - p.deadAt > 6000 + (p.id % 7) * 300) {
          const choice = p.bot.chooseSpawn(this.spawnOptions(p));
          this.spawnPlayer(p, choice);
        }
      }
    }
    // vehicles
    for (const v of this.vehicles) {
      if (v.destroyed) {
        if (this.mode.respawn && this.time > v.respawnAt) {
          Object.assign(v, this._makeVehicle(v.id, v.type, v.team, v.spawn.x, v.spawn.z, v.spawn.yaw));
          this.events.push(['vr', v.id]);
        }
        continue;
      }
      if (v.ai) v.ai.update(dt);
      else if (v.driver < 0) {
        // gravity for abandoned air vehicles
        const g = this.world.heightAt(v.x, v.z);
        if (v.y > g + 0.2) { v.y = Math.max(g, v.y - 25 * dt); if (v.y <= g + 0.2 && VEHICLES[v.type].air && v.speed > 30) this.destroyVehicle(v, null); v.speed *= 0.98; }
        if (v.y < this.world.waterLevel - 1.5) this.destroyVehicle(v, null);
        // let bots take abandoned vehicles at base
        if (this.mode.respawn && !this.mode.br && this.time - v.idleSince > 12000 && this._nearBase(v, v.team)) this._assignBotDriver(v);
      }
      if (this.time - v.lastDamageAt > 10000 && v.hp < VEHICLES[v.type].hp) v.hp = Math.min(VEHICLES[v.type].hp, v.hp + 12 * dt);
      v.flags = (v.destroyed ? VF.DESTROYED : 0) | (v.driver >= 0 ? VF.OCCUPIED : 0);
    }
    this._stepProjectiles(dt);
    // health regen, boxes, parachutes, bounds
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      if (!this.mode.noRegen && this.time - p.lastDamageAt > 5000 && p.hp < 100) p.hp = Math.min(100, p.hp + 14 * dt);
      if (this.area && p.vehicle < 0) {
        const d = Math.hypot(p.x - this.area.x, p.z - this.area.z);
        if (d > this.area.r + 15) { if (!p.outSince) p.outSince = this.time; else if (this.time - p.outSince > 10000) this.killPlayer(p, null, 254, false); }
        else p.outSince = 0;
      }
      if (p.y < this.world.waterLevel - 3 && p.vehicle < 0) this.applyDamage(p, 10 * dt, null, 254, false, p.x, p.z);
      if (p.vehicle >= 0) { const v = this.vehicles.find((q) => q.id === p.vehicle); if (v) { p.x = v.x; p.y = v.y; p.z = v.z; } }
    }
    if (this.boxes.size) {
      for (const b of [...this.boxes.values()]) {
        if (this.time > b.until) { this.boxes.delete(b.id); this.events.push(['bxr', b.id]); continue; }
        if (Math.floor(this.time / 1000) !== Math.floor((this.time - dt * 1000) / 1000)) {
          for (const p of this.players.values()) {
            if (p.alive && p.team === b.team && Math.hypot(p.x - b.x, p.z - b.z) < 6) {
              p.hp = Math.min(100, p.hp + 15);
              if (!p.isBot) p.pev.push(['rs']);
            }
          }
        }
      }
    }
    this._modeTick(dt);
    // history for lag compensation
    const pos = new Map();
    for (const p of this.players.values()) if (p.alive) pos.set(p.id, [p.x, p.y, p.z, p.stance]);
    this.history.push({ t: this.time, pos });
    if (this.history.length > 12) this.history.shift();
  }

  _assignBotDriver(v) {
    const cand = [...this.players.values()].find((p) => p.isBot && !p.alive && !p.eliminated && p.team === v.team && this.time - p.deadAt > 3000);
    if (cand) this.spawnPlayer(cand, 'veh:' + v.id);
  }

  _modeTick(dt) {
    const m = this.mode;
    const t = this.time / 1000;
    // flags
    for (const o of this.objectives) {
      o.counts = [0, 0];
      for (const p of this.players.values()) {
        if (!p.alive || p.team > 1) continue;
        if (p.vehicle >= 0) { const v = this.vehicles.find((q) => q.id === p.vehicle); if (v && VEHICLES[v.type].air) continue; }
        if (Math.hypot(p.x - o.x, p.z - o.z) < o.radius && Math.abs(p.y - o.y) < 20) o.counts[p.team]++;
      }
      let locked = false;
      if (m.id === 'breakthrough') locked = !this.sectors[this.sector] || !this.sectors[this.sector].includes(o.id);
      const diff = o.counts[0] - o.counts[1];
      o.contested = o.counts[0] > 0 && o.counts[1] > 0;
      if (locked || diff === 0) continue;
      const rate = 7 * Math.min(Math.abs(diff), 4) * dt * (m.kind === 'dom' ? 1.6 : m.kind === 'hill' ? 1.4 : 1);
      const prev = o.prog;
      // prog: -100 = team0, +100 = team1
      if (diff > 0) o.prog = Math.max(-100, o.prog - rate); else o.prog = Math.min(100, o.prog + rate);
      if (prev > 0 && o.prog <= 0 || prev < 0 && o.prog >= 0) { o.owner = -1; }
      if (o.prog <= -100 && o.owner !== 0) this._captured(o, 0);
      if (o.prog >= 100 && o.owner !== 1) this._captured(o, 1);
    }
    // ticket bleed
    if (m.kind === 'conquest' || m.kind === 'dom' || m.kind === 'hill') {
      if (m.kind === 'hill' && t >= this.hillMoveAt) this._moveHill(t);
      const own = [0, 0];
      for (const o of this.objectives) if (o.owner >= 0) own[o.owner]++;
      const half = this.objectives.length / 2;
      for (let team = 0; team < 2; team++) {
        if (own[team] > half) this.tickets[1 - team] = Math.max(0, this.tickets[1 - team] - (own[team] - own[1 - team]) * (m.bleed || 0.35) * dt * (m.kind === 'dom' ? 2 : 1));
      }
      if (this.tickets[0] <= 0 || this.tickets[1] <= 0) return this.end(this.tickets[0] > this.tickets[1] ? 0 : 1);
    } else if (m.id === 'breakthrough') {
      const sec = this.sectors[this.sector];
      if (sec && sec.every((id) => this.objectives.find((o) => o.id === id).owner === this.attackers)) {
        this.sector++;
        this.tickets[this.attackers] += 150;
        this.events.push(['sec', this.sector]);
        if (this.sector >= this.sectors.length) return this.end(this.attackers);
      }
      if (this.tickets[this.attackers] <= 0) return this.end(1 - this.attackers);
    } else if (m.kind === 'tdm') {
      if (this.kills[0] >= m.scoreLimit || this.kills[1] >= m.scoreLimit) return this.end(this.kills[0] > this.kills[1] ? 0 : 1);
    } else if (m.kind === 'ffa') {
      for (const p of this.players.values()) if (p.kills >= m.scoreLimit) return this.end(p.team, p);
    } else if (m.br) {
      this._zoneTick(dt);
      const alive = new Set();
      for (const p of this.players.values()) if (p.alive) alive.add(p.team);
      if (alive.size <= 1 && t > 5) return this.end(alive.size ? [...alive][0] : -1);
    }
    if (t > m.timeLimit) {
      let winner = -1;
      if (m.teams === 2) winner = m.kind === 'tdm' ? (this.kills[0] >= this.kills[1] ? 0 : 1) : m.id === 'breakthrough' ? 1 - this.attackers : (this.tickets[0] >= this.tickets[1] ? 0 : 1);
      else if (m.kind === 'ffa') { const b = [...this.players.values()].sort((a, b) => b.kills - a.kills)[0]; return this.end(b ? b.team : -1, b); }
      else if (m.br) { const al = [...this.players.values()].filter((p) => p.alive).sort((a, b) => b.kills - a.kills); winner = al[0] ? al[0].team : -1; }
      return this.end(winner);
    }
  }

  _zoneTick(dt) {
    const z = this.zone, t = this.time / 1000;
    if (z.phase < 0) { z.phase = 0; z.phaseStart = t; }
    const ph = this.zonePhases[z.phase];
    if (!ph) return;
    const shrinkStart = z.phaseStart + ph.wait, shrinkEnd = shrinkStart + ph.shrink;
    z.nx = ph.x; z.nz = ph.z; z.nr = ph.r; z.dps = ph.dps;
    z.shrinkStart = shrinkStart; z.shrinkEnd = shrinkEnd;
    if (t >= shrinkStart) {
      if (!z.from) z.from = { x: z.x, z: z.z, r: z.r };
      const k = clamp((t - shrinkStart) / ph.shrink, 0, 1);
      z.x = z.from.x + (ph.x - z.from.x) * k; z.z = z.from.z + (ph.z - z.from.z) * k; z.r = z.from.r + (ph.r - z.from.r) * k;
      if (k >= 1) { z.phase++; z.phaseStart = t; z.from = null; }
    }
    for (const p of this.players.values()) {
      if (!p.alive || p.para === 1) continue;
      if (Math.hypot(p.x - z.x, p.z - z.z) > z.r) this.applyDamage(p, z.dps * dt, null, 255, false, z.x, z.z);
    }
  }

  _moveHill(t) {
    const m = this.mode, o = this.objectives[0];
    this.hillIdx = (this.hillIdx + 1) % this.hillSpots.length;
    this.hillMoveAt = t + m.hillSeconds;
    const h = this.hillSpots[this.hillIdx];
    Object.assign(o, { x: h.x, z: h.z, y: this.world.heightAt(h.x, h.z), owner: -1, prog: 0, contested: false });
    this.events.push(['hill', +h.x.toFixed(1), +h.z.toFixed(1)]);
  }

  _captured(o, team) {
    o.owner = team;
    this.events.push(['cap', o.id, team]);
    for (const p of this.players.values()) {
      if (p.alive && p.team === team && Math.hypot(p.x - o.x, p.z - o.z) < o.radius) { p.score += 150; p.caps++; }
    }
  }

  end(winner, mvp = null) {
    if (this.ended) return;
    this.ended = true;
    const board = this.scoreboard();
    this.result = { t: 'end', winner, mvp: mvp ? mvp.id : -1, board };
    this.broadcastJSON(this.result);
    this.onEnd(this);
  }

  scoreboard() {
    return [...this.players.values()].map((p) => [p.id, p.kills, p.deaths, p.score, p.caps, p.ping]);
  }

  // ---------------------------------------------------------------- networking
  rosterMsg() {
    return [...this.players.values()].map((p) => [p.id, p.name, p.team, p.squad, p.isBot ? 1 : 0, p.loadout.cls]);
  }

  stateMsg() {
    const m = this.mode;
    const s = { t: 'state', tl: Math.max(0, Math.round(m.timeLimit - this.time / 1000)) };
    if (this.objectives.length) s.obj = this.objectives.map((o) => [o.id, o.owner, Math.round(o.prog), o.contested ? 1 : 0, +o.x.toFixed(1), +o.z.toFixed(1), o.radius]);
    if (m.teams === 2) { s.tk = this.tickets.map((x) => Math.ceil(x)); s.k = this.kills; }
    if (this.sectors) { s.sec = this.sector; s.secs = this.sectors; s.att = this.attackers; }
    if (this.area) s.area = [this.area.x, this.area.z, this.area.r];
    if (this.zone) {
      const z = this.zone;
      s.zone = [+z.x.toFixed(1), +z.z.toFixed(1), +z.r.toFixed(1), +z.nx.toFixed(1), +z.nz.toFixed(1), +z.nr.toFixed(1), Math.max(0, Math.round((z.shrinkStart || 0) - this.time / 1000)), z.phase];
      const squads = new Set(); let alive = 0;
      for (const p of this.players.values()) if (p.alive) { squads.add(p.team); alive++; }
      s.alive = [alive, squads.size];
      if (this.flight) s.flight = [this.flight.ax, this.flight.az, this.flight.bx, this.flight.bz];
    }
    return s;
  }

  snapshot() {
    const players = [];
    for (const p of this.players.values()) {
      if (!p.alive && this.time - p.deadAt > 3000) continue;
      const flags = (p.alive ? PF.ALIVE : 0) | (p.stance === 1 ? PF.CROUCH : 0) | (p.stance === 2 ? PF.PRONE : 0) | (p.ads ? PF.ADS : 0) |
        (this.time < p.firingUntil ? PF.FIRING : 0) | (p.isBot ? PF.BOT : 0) | (this.time < p.spottedUntil ? PF.SPOTTED : 0) | (p.para ? PF.PARACHUTE : 0);
      players.push({ id: p.id, team: p.team, flags, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, hp: p.hp, weapon: p.weaponId, veh: p.vehicle });
    }
    return encodeSnapshot(this.time, players, this.vehicles);
  }

  broadcastJSON(obj) {
    const s = JSON.stringify(obj);
    for (const p of this.players.values()) if (p.client) p.client.sendRaw(s);
  }

  flush() {
    if (this.headless) { this.events.length = 0; for (const p of this.players.values()) p.pev.length = 0; return; }
    const snap = this.snapshot();
    const sendState = this.time - this.lastState >= 500;
    const sendBoard = this.time - this.lastBoard >= 2000;
    const state = sendState ? JSON.stringify(this.stateMsg()) : null;
    const board = sendBoard ? JSON.stringify({ t: 'board', b: this.scoreboard() }) : null;
    if (sendState) this.lastState = this.time;
    if (sendBoard) this.lastBoard = this.time;
    const global = this.events;
    this.events = [];
    for (const p of this.players.values()) {
      if (!p.client) { p.pev.length = 0; continue; }
      p.client.sendBinary(snap);
      // filter far-away shot events per client
      const evs = [];
      for (const e of global) {
        if (e[0] === 's') {
          if (Math.abs(e[2] - p.x) > 700 || Math.abs(e[4] - p.z) > 700) {
            const sh = this.players.get(e[1]);
            if (!sh || Math.abs(sh.x - p.x) > 700 || Math.abs(sh.z - p.z) > 700) continue;
          }
        }
        evs.push(e);
      }
      if (evs.length || p.pev.length) p.client.send({ t: 'ev', e: evs, pe: p.pev });
      p.pev = [];
      if (state) p.client.sendRaw(state);
      if (board) p.client.sendRaw(board);
    }
  }
}

function valid3(a) { return Array.isArray(a) && a.length === 3 && a.every((x) => typeof x === 'number' && Number.isFinite(x)); }
function norm3(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
export { EYE, WEAPON_BY_NAME };
