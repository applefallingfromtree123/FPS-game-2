// Server-side soldier AI. Bots perceive with field-of-view + line-of-sight,
// react with human-like delay, aim with decaying error, fire in bursts, use
// cover when hurt, throw grenades at hidden enemies, coordinate as squads and
// play the objective of every game mode.
import { WEAPONS, WEAPON_BY_NAME, weaponsFor, CLASSES, GRENADE } from '../shared/weapons.js';
import { VEHICLES, EYE } from '../shared/protocol.js';
import { rayAABB } from '../shared/world.js';
import { clamp } from '../shared/rng.js';
import { randomLook } from '../shared/look.js';

export const BOT_NAMES = ['Viper', 'Ghost', 'Reaper', 'Hawk', 'Wolf', 'Raven', 'Falcon', 'Cobra', 'Titan', 'Blaze', 'Shadow', 'Hunter', 'Storm', 'Razor', 'Frost',
  'Kodiak', 'Maverick', 'Ranger', 'Spectre', 'Nomad', 'Bishop', 'Sarge', 'Duke', 'Ace', 'Echo', 'Bravo', 'Delta', 'Tango', 'Sierra', 'Oscar', 'Kilo', 'Mike',
  'Jaeger', 'Ivan', 'Dmitri', 'Kenji', 'Hiro', 'Minsu', 'Jiho', 'Carlos', 'Diego', 'Luca', 'Marco', 'Erik', 'Lars', 'Omar', 'Yusuf', 'Andre', 'Pierre',
  'Hans', 'Felix', 'Noah', 'Liam', 'Mason', 'Logan', 'Owen', 'Caleb', 'Ryker', 'Kane', 'Briggs', 'Dozer', 'Tank', 'Sniper', 'Fox', 'Lynx', 'Puma',
  'Bear', 'Bison', 'Moose', 'Badger', 'Mantis', 'Scorpion', 'Hornet', 'Wasp', 'Jackal', 'Hyena', 'Coyote', 'Dingo', 'Gecko', 'Python', 'Mamba', 'Taipan'];

const RANGE = { ar: 220, carbine: 180, smg: 110, lmg: 230, dmr: 350, sniper: 600, shotgun: 45, pistol: 70, launcher: 160 };
const IDEAL = { ar: 45, carbine: 35, smg: 18, lmg: 60, dmr: 120, sniper: 220, shotgun: 8, pistol: 15, launcher: 60 };

export function makeBotLoadout(rng, mode) {
  const cls = rng.pick(['assault', 'assault', 'engineer', 'support', 'recon']);
  const prims = weaponsFor(cls, 'primary');
  // prefer the class' signature category
  const sig = { assault: 'ar', engineer: 'smg', support: 'lmg', recon: rng.chance(0.6) ? 'sniper' : 'dmr' }[cls];
  const pool = rng.chance(0.75) ? prims.filter((w) => w.cat === sig) : prims;
  const primary = rng.pick(pool.length ? pool : prims);
  const secondary = rng.pick(weaponsFor(cls, 'secondary'));
  let gadget = -1;
  if (cls === 'engineer') gadget = WEAPON_BY_NAME[rng.pick(['RPG-7', 'RPG-7', 'SMAW', 'Carl Gustaf', 'Stinger', 'Javelin'])].id;
  if (cls === 'assault') gadget = WEAPON_BY_NAME['M32 MGL'].id;
  void mode;
  return { cls, look: randomLook(() => rng.next()), primary: primary.id, secondary: secondary.id, gadget, sight: primary.sight, muzzle: rng.chance(0.2) ? 'suppressor' : primary.muzzleDefault };
}

const angDiff = (a, b) => { let d = (a - b) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
const gauss = (rng) => { let u = 0, v = 0; while (u === 0) u = rng.next(); while (v === 0) v = rng.next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

export class BotBrain {
  constructor(match, p) {
    this.m = match; this.p = p; this.rng = match.rng;
    this.skill = clamp(0.55 + this.rng.next() * 0.45, 0, 1);
    this.reset();
  }

  reset() {
    this.target = null; this.targetVeh = null; this.lastSeen = null; this.reactAt = 0; this.acquiredAt = 0;
    this.aimYaw = this.p.yaw; this.aimPitch = 0; this.errYaw = 0; this.errPitch = 0; this.errNext = 0;
    this.goal = null; this.goalKind = null; this.goalUntil = 0; this.waypoint = null; this.wpCheck = 0;
    this.thinkAt = 0; this.burst = 0; this.burstPauseUntil = 0; this.nextShot = 0;
    this.reloadUntil = 0; this.strafe = 1; this.strafeUntil = 0; this.cover = null; this.coverUntil = 0;
    this.grenadeReady = this.m.time + 8000; this.stuckCheck = { t: 0, x: 0, z: 0 }; this.detour = null;
    this.heard = null; this.lookYaw = this.p.yaw; this.lookUntil = 0; this.mag = {};
    this.landing = null; this.lootTarget = -1; this.campSpot = null;
  }

  onSpawn() { this.reset(); this.p.yaw = this.aimYaw = this.p.yaw; }
  onDeath() { this.target = null; }

  weapon() { return WEAPONS[this.p.weaponId]; }

  onDamaged(attacker, fx, fz) {
    if (!attacker || attacker.id === this.p.id) return;
    if (!this.target || !this.target.alive) {
      // turn toward the threat; we know roughly where it came from
      this.lastSeen = { x: attacker.x, y: attacker.y, z: attacker.z, t: this.m.time, id: attacker.id };
      this.lookYaw = Math.atan2(-(fx - this.p.x), -(fz - this.p.z));
      this.lookUntil = this.m.time + 2500;
      this.thinkAt = Math.min(this.thinkAt, this.m.time + 120);
    }
    if (this.p.hp < 45 && this.m.time > this.coverUntil) this.seekCover(fx, fz);
  }

  hearShot(shooter, x, z, suppressed) {
    if (!shooter || shooter.team === this.p.team || shooter.id === this.p.id) return;
    const d = Math.hypot(x - this.p.x, z - this.p.z);
    if (d > (suppressed ? 25 : 140)) return;
    if (!this.target && (!this.heard || this.m.time - this.heard.t > 3000)) {
      this.heard = { x, z, t: this.m.time };
      if (d < 90 && this.m.time > this.lookUntil) { this.lookYaw = Math.atan2(-(x - this.p.x), -(z - this.p.z)); this.lookUntil = this.m.time + 1500; }
    }
  }

  chooseSpawn(opts) {
    if (!opts.length) return 'hq';
    const flags = opts.filter((o) => o.id.startsWith('flag:'));
    const squad = opts.filter((o) => o.id.startsWith('squad:'));
    const r = this.rng.next();
    if (squad.length && r < 0.35) return this.rng.pick(squad).id;
    if (flags.length && r < 0.8) {
      // prefer the owned flag closest to the front line
      const m = this.m;
      let best = flags[0], bd = Infinity;
      for (const f of flags) {
        const o = m.objectives.find((q) => 'flag:' + q.id === f.id);
        let d = Infinity;
        for (const e of m.objectives) if (e.owner !== this.p.team) d = Math.min(d, Math.hypot(e.x - o.x, e.z - o.z));
        d += this.rng.float(0, 150);
        if (d < bd) { bd = d; best = f; }
      }
      return best.id;
    }
    return opts[0].id;
  }

  // ------------------------------------------------------------ main update
  update(dt) {
    const p = this.p, m = this.m;
    if (p.vehicle >= 0) return; // VehicleAI drives
    if (p.para) return this.updateAir(dt);
    if (m.time >= this.thinkAt) { this.think(); this.thinkAt = m.time + 220 + this.rng.float(0, 120); }
    this.updateAim(dt);
    this.updateMove(dt);
    this.updateFire();
  }

  updateAir(dt) {
    const p = this.p, w = this.m.world;
    if (!this.landing) {
      const L = w.loot.length ? w.loot[Math.floor(this.rng.next() * w.loot.length)] : { x: 0, z: 0 };
      this.landing = { x: L.x + this.rng.float(-20, 20), z: L.z + this.rng.float(-20, 20) };
    }
    const g = w.heightAt(p.x, p.z);
    const dx = this.landing.x - p.x, dz = this.landing.z - p.z, d = Math.hypot(dx, dz) || 1;
    const hs = p.para === 1 ? 38 : 9, vs = p.para === 1 ? 48 : 6;
    p.x += (dx / d) * Math.min(hs * dt, d); p.z += (dz / d) * Math.min(hs * dt, d);
    p.y -= vs * dt;
    p.yaw = Math.atan2(-dx, -dz);
    if (p.para === 1 && p.y - g < 140) p.para = 2;
    if (p.y <= g) { p.y = g; p.para = 0; }
  }

  // ------------------------------------------------------------ perception & decisions
  think() {
    const p = this.p, m = this.m, w = this.weapon();
    const eyeY = p.y + EYE[p.stance];
    const range = RANGE[w.cat] || 150;
    // collect candidates
    const cand = [];
    for (const q of m.players.values()) {
      if (!q.alive || !m.isEnemy(p, q) || q.vehicle >= 0 || q.para === 1) continue;
      const dx = q.x - p.x, dz = q.z - p.z;
      const d = Math.abs(dx) + Math.abs(dz);
      if (d > range * 1.4) continue;
      cand.push([Math.hypot(dx, dz), q]);
    }
    cand.sort((a, b) => a[0] - b[0]);
    let best = null, bestScore = Infinity;
    let checks = 0;
    for (const [d, q] of cand) {
      if (d > range || checks >= 8) break;
      const yawTo = Math.atan2(-(q.x - p.x), -(q.z - p.z));
      const fov = Math.abs(angDiff(yawTo, p.yaw)) < 1.35;
      const noticed = fov || d < 16 || (m.time < q.firingUntil && d < 80) || (this.target === q);
      if (!noticed) continue;
      // concealment: crouched/prone targets far away in vegetation are harder to see
      if (q.stance > 0 && d > 70 && this.target !== q && this.rng.next() < (q.stance === 2 ? 0.75 : 0.4)) continue;
      checks++;
      const ty = q.y + (q.stance === 2 ? 0.3 : q.stance === 1 ? 1.0 : 1.4);
      if (!m.world.lineClear(p.x, eyeY, p.z, q.x, ty, q.z)) continue;
      let score = d * (fov ? 1 : 1.6);
      if (q.id === p.lastDamager && m.time - p.lastDamageAt < 3000) score -= 60;
      if (this.target === q) score -= 25;
      if (score < bestScore) { bestScore = score; best = q; }
    }
    // enemy vehicles for engineers
    this.targetVeh = null;
    const gadget = WEAPONS[p.loadout.gadget];
    if (gadget && gadget.cat === 'launcher' && p.loadout.cls === 'engineer') {
      for (const v of m.vehicles) {
        if (v.destroyed || v.driver < 0 || v.team === p.team) continue;
        const air = VEHICLES[v.type].air;
        if (air !== (gadget.homing === 'air')) continue;
        const d = Math.hypot(v.x - p.x, v.z - p.z);
        if (d > (air ? 400 : 170)) continue;
        if (m.world.lineClear(p.x, eyeY, p.z, v.x, v.y + 1.5, v.z)) { this.targetVeh = v; break; }
      }
    }
    if (best) {
      if (this.target !== best) {
        this.target = best;
        const surprise = (this.lastSeen && this.lastSeen.id === best.id && m.time - this.lastSeen.t < 2500) ? 0.4 : 1;
        this.reactAt = m.time + (110 + (1 - this.skill) * 300 + this.rng.float(0, 110)) * surprise;
        this.acquiredAt = m.time;
        this.errNext = 0;
      }
      this.lastSeen = { x: best.x, y: best.y, z: best.z, t: m.time, id: best.id };
      const d0 = Math.hypot(best.x - p.x, best.z - p.z);
      // share intel with nearby squad mates
      for (const q of m.players.values()) {
        if (q.bot && q !== p && q.alive && q.team === p.team && q.squad === p.squad && !q.bot.target && Math.hypot(q.x - p.x, q.z - p.z) < 120) {
          q.bot.lastSeen = { ...this.lastSeen };
        }
      }
      if (d0 > 12 && d0 < 38 && m.time > this.grenadeReady && this.rng.next() < 0.06 + this.skill * 0.06) this.throwGrenade({ x: best.x, y: best.y, z: best.z });
      if (p.loadout.cls === 'recon') best.spottedUntil = Math.max(best.spottedUntil, m.time + 5000);
      // switch to secondary when the primary is useless at this range
      const d = d0;
      if (p.slot === 2) this.setSlot(0);
      if (w.cat === 'sniper' && d < 12 && this.rng.next() < 0.5) this.setSlot(1);
      if (p.slot === 1 && this.primaryWeapon() && d > 15) this.setSlot(0);
    } else {
      this.target = null;
      if (this.targetVeh) this.setSlot(2);
      else if (p.slot !== 0 && this.primaryWeapon()) this.setSlot(0);
      // throw a grenade at an enemy who just went behind cover
      const ls = this.lastSeen;
      if (ls && m.time - ls.t < 3500 && m.time > this.grenadeReady) {
        const d = Math.hypot(ls.x - p.x, ls.z - p.z);
        if (d > 10 && d < 35 && this.rng.next() < 0.35 + this.skill * 0.3) this.throwGrenade(ls);
      }
      if (ls && m.time - ls.t > 9000) this.lastSeen = null;
    }
    // reload while out of combat
    const mag = this.magOf(w);
    if (!this.target && mag < w.mag * 0.4 && m.time > this.reloadUntil) this.startReload(w);
    // objectives
    if (m.time > this.goalUntil || !this.goal) this.chooseGoal();
  }

  primaryWeapon() { return this.m.mode.br ? this.p.brWeapon >= 0 : this.p.loadout.primary >= 0; }
  setSlot(s) { const p = this.p; if (p.slot === s) return; p.slot = s; p.weaponId = this.m.currentWeapon(p); this.nextShot = this.m.time + 450; }
  magOf(w) { if (this.mag[w.id] === undefined) this.mag[w.id] = w.mag; return this.mag[w.id]; }
  startReload(w) { this.reloadUntil = this.m.time + w.reload * 1000 * (1.1 - this.skill * 0.2); this.mag[w.id] = w.mag; }

  chooseGoal() {
    const p = this.p, m = this.m, w = m.world, mode = m.mode;
    this.goalUntil = m.time + 8000 + this.rng.float(0, 6000);
    this.waypoint = null;
    // follow a human squad leader
    for (const q of m.players.values()) {
      if (!q.isBot && q.alive && q.team === p.team && q.squad === p.squad && mode.teams !== 0 && q.vehicle < 0) {
        if (Math.hypot(q.x - p.x, q.z - p.z) > 25 && this.rng.next() < 0.7) {
          this.goal = { x: q.x + this.rng.float(-8, 8), z: q.z + this.rng.float(-8, 8) }; this.goalKind = 'follow'; this.goalUntil = m.time + 4000;
          return;
        }
      }
    }
    if (mode.br) return this.chooseGoalBR();
    if (m.area) {
      // infantry modes: hunt toward recent intel, else roam
      const a = m.area;
      let tx, tz;
      const intel = this.lastSeen || this.heard;
      if (intel && m.time - intel.t < 8000) { tx = intel.x; tz = intel.z; }
      else if (m.objectives.length) {
        const opts = m.objectives.map((o) => ({ o, s: Math.hypot(o.x - p.x, o.z - p.z) / 60 + (o.owner === p.team ? 3 : 0) + (o.contested ? -1 : 0) + this.rng.float(0, 2.5) }));
        opts.sort((x, y) => x.s - y.s);
        const o = opts[0].o;
        tx = o.x + this.rng.float(-o.radius, o.radius) * 0.7; tz = o.z + this.rng.float(-o.radius, o.radius) * 0.7;
        this.goalKind = 'flag';
      } else {
        const ang = this.rng.float(0, Math.PI * 2), r = Math.sqrt(this.rng.next()) * a.r * 0.8;
        tx = a.x + Math.cos(ang) * r; tz = a.z + Math.sin(ang) * r;
        this.goalKind = 'roam';
      }
      this.goal = { x: tx, z: tz };
      return;
    }
    // conquest / breakthrough
    let flags = m.objectives;
    if (mode.id === 'breakthrough') {
      const ids = m.sectors[m.sector] || [];
      flags = m.objectives.filter((o) => ids.includes(o.id));
    }
    if (!flags.length) { this.goal = { x: 0, z: 0 }; return; }
    // squad-wide decision (stored on the match) so squads move together
    const key = p.team * 1000 + p.squad;
    m.squadGoals = m.squadGoals || new Map();
    let sg = m.squadGoals.get(key);
    const curFlag = sg && flags.find((o) => o.id === sg.id);
    const stale = !sg || m.time > sg.until || !curFlag || (curFlag.owner === p.team && !curFlag.contested && mode.id === 'conquest' && this.rng.next() < 0.5);
    if (stale) {
      const scored = flags.map((o) => {
        const d = Math.hypot(o.x - p.x, o.z - p.z);
        let s = d / 120;
        if (o.owner === p.team) s += o.contested ? -1.5 : 2.5;
        else if (o.owner === -1) s -= 1.5;
        else s -= 1;
        if (mode.id === 'breakthrough' && p.team !== m.attackers) s = d / 200 + (o.contested ? -2 : 0) + (o.counts[p.team] > 6 ? 1.5 : 0);
        return { o, s: s + this.rng.float(0, 1.8) };
      }).sort((a, b) => a.s - b.s);
      sg = { id: scored[0].o.id, until: m.time + 25000 + this.rng.float(0, 15000) };
      m.squadGoals.set(key, sg);
    }
    const o = flags.find((q) => q.id === sg.id) || flags[0];
    const wpn = this.weapon();
    if ((wpn.cat === 'sniper' || wpn.cat === 'dmr') && this.rng.next() < 0.75) {
      // overwatch position: higher ground some distance from the objective
      const base = w.bases[p.team];
      const bx = base.x - o.x, bz = base.z - o.z, bl = Math.hypot(bx, bz) || 1;
      let best = null, bh = -Infinity;
      const dist = wpn.cat === 'sniper' ? 160 : 90;
      for (let i = 0; i < 6; i++) {
        const ang = Math.atan2(bz, bx) + this.rng.float(-0.9, 0.9);
        const x = o.x + Math.cos(ang) * dist * this.rng.float(0.8, 1.3), z = o.z + Math.sin(ang) * dist * this.rng.float(0.8, 1.3);
        const h = w.heightAt(x, z);
        if (h < w.waterLevel + 1 || w.pointInBuilding(x, z, 1)) continue;
        if (h > bh) { bh = h; best = { x, z }; }
      }
      void bl;
      if (best) { this.goal = best; this.goalKind = 'overwatch'; this.goalUntil = m.time + 40000; return; }
    }
    this.goal = { x: o.x + this.rng.float(-o.radius, o.radius) * 0.75, z: o.z + this.rng.float(-o.radius, o.radius) * 0.75 };
    this.goalKind = 'flag';
  }

  chooseGoalBR() {
    const p = this.p, m = this.m, w = m.world, z = m.zone;
    if (p.brWeapon < 0 || this.rng.next() < 0.15) {
      let best = -1, bd = 260;
      w.loot.forEach((L, i) => {
        if (m.lootOpened.has(i)) return;
        const d = Math.hypot(L.x - p.x, L.z - p.z);
        if (d < bd && (!z || Math.hypot(L.x - z.nx, L.z - z.nz) < Math.max(z.r, 60))) { bd = d; best = i; }
      });
      if (best >= 0) { this.lootTarget = best; const L = w.loot[best]; this.goal = { x: L.x, z: L.z }; this.goalKind = 'loot'; this.goalUntil = m.time + 30000; return; }
    }
    const tr = Math.max(20, (z ? z.nr : 300) * 0.6);
    const ang = this.rng.float(0, Math.PI * 2), r = Math.sqrt(this.rng.next()) * tr;
    this.goal = { x: (z ? z.nx : 0) + Math.cos(ang) * r, z: (z ? z.nz : 0) + Math.sin(ang) * r };
    this.goalKind = 'zone';
  }

  seekCover(tx, tz) {
    const p = this.p, w = this.m.world;
    let best = null, bd = Infinity;
    const seen = new Set();
    for (let gx = -1; gx <= 1; gx++) for (let gz = -1; gz <= 1; gz++) {
      for (const idx of w.buildingsNear(p.x + gx * 40, p.z + gz * 40)) {
        if (seen.has(idx)) continue;
        seen.add(idx);
        const b = w.buildings[idx];
        const d0 = Math.hypot(b.x - p.x, b.z - p.z);
        if (d0 > 35) continue;
        const ax = b.x - tx, az = b.z - tz, al = Math.hypot(ax, az) || 1;
        const ext = Math.abs(ax / al) * b.w / 2 + Math.abs(az / al) * b.d / 2;
        const cx = b.x + (ax / al) * (ext + 1.0), cz = b.z + (az / al) * (ext + 1.0);
        if (w.pointInBuilding(cx, cz, 0.4)) continue;
        const cy = w.groundAt(cx, cz);
        if (w.lineClear(tx, w.heightAt(tx, tz) + 1.6, tz, cx, cy + 0.9, cz)) continue;
        const d = Math.hypot(cx - p.x, cz - p.z);
        if (d < bd) { bd = d; best = { x: cx, z: cz }; }
      }
    }
    if (best) { this.cover = best; this.coverUntil = this.m.time + 6000; this.waypoint = null; }
  }

  throwGrenade(ls) {
    const p = this.p, m = this.m;
    this.grenadeReady = m.time + 18000 + this.rng.float(0, 8000);
    const ox = p.x, oy = p.y + 1.6, oz = p.z;
    const dx = ls.x - ox, dz = ls.z - oz, d = Math.hypot(dx, dz);
    const h = (ls.y + 0.3) - oy;
    const th = 0.75;
    const g = 9.8;
    const denom = 2 * Math.cos(th) ** 2 * (d * Math.tan(th) - h);
    if (denom <= 0) return;
    const v = Math.min(26, Math.sqrt((g * d * d) / denom)) * this.rng.float(0.92, 1.08);
    const vx = (dx / d) * Math.cos(th) * v, vz = (dz / d) * Math.cos(th) * v, vy = Math.sin(th) * v;
    m.spawnProjectile(p, 'frag', ox, oy, oz, vx, vy, vz, { dmg: GRENADE.dmg, splash: GRENADE.splash, vehDmg: 60 }, { weaponId: 251, life: 10 });
  }

  // ------------------------------------------------------------ aiming
  updateAim(dt) {
    const p = this.p, m = this.m;
    let desiredYaw = null, desiredPitch = 0;
    const eyeY = p.y + EYE[p.stance];
    if (this.target && this.target.alive) {
      const q = this.target;
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      const headshot = this.skill > 0.7 && d < 40;
      const ty = q.y + (q.stance === 2 ? 0.3 : q.stance === 1 ? (headshot ? 1.1 : 0.8) : (headshot ? 1.6 : 1.25));
      desiredYaw = Math.atan2(-(q.x - p.x), -(q.z - p.z));
      desiredPitch = Math.atan2(ty - eyeY, d);
      // aim error: large on acquisition, settles over time, worse vs moving targets
      if (m.time >= this.errNext) {
        const settle = clamp(1 - (m.time - this.acquiredAt) / (1500 - this.skill * 700), 0, 1);
        const base = (0.008 + (1 - this.skill) * 0.03) * (1 + settle * 2.5) * (p.hp < 40 ? 1.3 : 1);
        this.errYaw = gauss(this.rng) * base; this.errPitch = gauss(this.rng) * base * 0.7;
        this.errNext = m.time + 280 + this.rng.float(0, 250);
      }
      desiredYaw += this.errYaw; desiredPitch += this.errPitch;
    } else if (this.targetVeh) {
      const v = this.targetVeh;
      const d = Math.hypot(v.x - p.x, v.z - p.z);
      desiredYaw = Math.atan2(-(v.x - p.x), -(v.z - p.z));
      const w = this.weapon();
      const tof = d / (w.vel || 100);
      desiredPitch = Math.atan2(v.y + 1.4 - eyeY + (w.projectile === 'grenade' ? 0.5 * 9.8 * tof * tof : 0), d);
    } else if (m.time < this.lookUntil) {
      desiredYaw = this.lookYaw;
    } else if (this.lastSeen && m.time - this.lastSeen.t < 5000) {
      desiredYaw = Math.atan2(-(this.lastSeen.x - p.x), -(this.lastSeen.z - p.z));
    }
    const turn = (3.6 + this.skill * 5.0) * dt;
    if (desiredYaw !== null) {
      const dy = angDiff(desiredYaw, this.aimYaw);
      this.aimYaw += clamp(dy, -turn, turn) * (Math.abs(dy) < 0.3 ? 0.55 + this.skill * 0.35 : 1);
      this.aimPitch += clamp(desiredPitch - this.aimPitch, -turn, turn) * 0.7;
      p.yaw = this.aimYaw; p.pitch = this.aimPitch;
    } else {
      this.aimYaw = p.yaw; this.aimPitch *= 0.9; p.pitch = this.aimPitch;
    }
  }

  updateFire() {
    const p = this.p, m = this.m;
    const w = this.weapon();
    if (m.time < this.reloadUntil || m.time < this.nextShot) return;
    let tx, ty, tz;
    if (this.target && this.target.alive) {
      if (m.time < this.reactAt) return;
      const q = this.target; tx = q.x; ty = q.y + 1.2; tz = q.z;
    } else if (this.targetVeh && w.cat === 'launcher') {
      const v = this.targetVeh; tx = v.x; ty = v.y + 1.4; tz = v.z;
    } else return;
    const d = Math.hypot(tx - p.x, tz - p.z);
    const eyeY = p.y + EYE[p.stance];
    const wantYaw = Math.atan2(-(tx - p.x), -(tz - p.z));
    const wantPitch = Math.atan2(ty - eyeY, d);
    const tol = Math.max(0.035, Math.atan2(1.0, d));
    if (Math.abs(angDiff(wantYaw, this.aimYaw)) > tol * 2.5 || Math.abs(wantPitch - this.aimPitch) > tol * 3 && w.cat !== 'launcher') return;
    if (m.time < this.burstPauseUntil) return;
    if (this.magOf(w) <= 0) { this.startReload(w); return; }
    // weapon spread (degrees) depending on stance/movement/ADS
    const moving = this.moving;
    const adsing = d > 18 && !moving;
    p.ads = adsing;
    let spreadDeg = adsing ? w.ads : w.hip * (moving ? 1.25 : 0.85);
    if (p.stance === 1) spreadDeg *= 0.8;
    if (w.cat === 'shotgun') spreadDeg = w.hip;
    spreadDeg += Math.min(this.burst, 8) * 0.06 * w.recoilV;
    const ox = p.x, oy = eyeY, oz = p.z;
    const dirs = [];
    for (let i = 0; i < w.pellets; i++) {
      const s = (spreadDeg * Math.PI) / 180;
      const a = this.rng.float(0, Math.PI * 2), r = Math.sqrt(this.rng.next()) * s * 0.5;
      const yaw = this.aimYaw + Math.cos(a) * r, pitch = this.aimPitch + Math.sin(a) * r;
      dirs.push([-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)]);
    }
    this.mag[w.id]--;
    if (w.cat === 'launcher') {
      const [dx, dy, dz] = dirs[0];
      const homing = w.homing && this.targetVeh ? this.targetVeh.id : null;
      m.spawnProjectile(p, w.projectile === 'grenade' ? 'grenade' : 'rocket', ox, oy, oz, dx * w.vel, dy * w.vel, dz * w.vel, { dmg: w.dmg[0], vehDmg: w.vehDmg, splash: w.splash }, { homing, weaponId: w.id });
      this.nextShot = m.time + 1500;
      if (this.magOf(w) <= 0) this.startReload(w);
      return;
    }
    m.fireHitscan(p, w, ox, oy, oz, dirs, null, { muzzle: w.id === p.loadout.primary ? p.loadout.muzzle : 'none' });
    let interval = w.fireInterval * 1000;
    const auto = w.modes[0] === 'auto';
    if (!auto) interval = Math.max(interval, w.cat === 'sniper' ? 1400 : w.cat === 'shotgun' ? interval : 170 + (1 - this.skill) * 200);
    this.nextShot = m.time + interval;
    this.burst++;
    const maxBurst = d > 80 ? 3 : d > 35 ? 5 : 9;
    if (auto && this.burst >= maxBurst + this.rng.int(0, 3)) {
      this.burst = 0;
      this.burstPauseUntil = m.time + 180 + this.rng.float(0, 220) + d * 2;
    }
  }

  // ------------------------------------------------------------ movement
  updateMove(dt) {
    const p = this.p, m = this.m, w = m.world;
    let tx = null, tz = null;
    let speed = 4.2;
    let wantCrouch = false;
    let faceMove = true;
    const engaged = this.target && this.target.alive;
    const wpn = this.weapon();
    // run away from live grenades
    let danger = null;
    for (const pr of m.projectiles.values()) {
      if (pr.kind !== 'frag' || pr.owner === p.id || pr.team === p.team && m.mode.teams !== 0) continue;
      const dd = Math.hypot(pr.x - p.x, pr.z - p.z);
      if (dd < 9 && (!danger || dd < danger.d)) danger = { d: dd, x: pr.x, z: pr.z };
    }
    if (danger) {
      const ax = p.x - danger.x, az = p.z - danger.z, al = Math.hypot(ax, az) || 1;
      tx = p.x + (ax / al) * 8; tz = p.z + (az / al) * 8; speed = 6.8; faceMove = !engaged;
    } else if (this.cover && m.time < this.coverUntil) {
      tx = this.cover.x; tz = this.cover.z; speed = 6.2;
      if (Math.hypot(tx - p.x, tz - p.z) < 1.2) { tx = null; wantCrouch = true; if (p.hp > 80) this.cover = null; else this.coverUntil = Math.max(this.coverUntil, m.time + 500); }
      faceMove = !engaged;
    } else if (engaged) {
      faceMove = false;
      const q = this.target;
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      const ideal = IDEAL[wpn.cat] || 40;
      if (m.time > this.strafeUntil) { this.strafe = this.rng.next() < 0.5 ? -1 : 1; this.strafeUntil = m.time + 500 + this.rng.float(0, 1200); if (this.rng.next() < 0.3) this.strafe = 0; }
      const ux = (q.x - p.x) / (d || 1), uz = (q.z - p.z) / (d || 1);
      let mx = -uz * this.strafe, mz = ux * this.strafe;
      if (d > ideal * 1.6) { mx += ux * 0.8; mz += uz * 0.8; }
      else if (d < ideal * 0.5 && wpn.cat !== 'shotgun') { mx -= ux * 0.6; mz -= uz * 0.6; }
      if (this.strafe === 0 && d > 28) wantCrouch = true;
      if (p.hp < 35 && !this.cover && d > 6) { mx = -ux * 1.2 + mx * 0.5; mz = -uz * 1.2 + mz * 0.5; }
      if (d > 50 && (wpn.cat === 'sniper' || wpn.cat === 'dmr' || wpn.cat === 'lmg' || this.rng.next() < 0.02)) { mx = 0; mz = 0; wantCrouch = true; }
      if (Math.hypot(mx, mz) > 0.01) { tx = p.x + mx * 5; tz = p.z + mz * 5; }
      speed = 3.4;
      if (p.hp < 45 && m.time > this.coverUntil && this.rng.next() < 0.05) this.seekCover(q.x, q.z);
    } else {
      // hunt last known enemy if close, otherwise objective
      const ls = this.lastSeen;
      if (ls && m.time - ls.t < 6000 && Math.hypot(ls.x - p.x, ls.z - p.z) < 70 && this.goalKind !== 'overwatch') {
        tx = ls.x; tz = ls.z; speed = 4.6; wantCrouch = false;
      } else if (this.heard && m.time - this.heard.t < 5000 && Math.hypot(this.heard.x - p.x, this.heard.z - p.z) < 90 && this.goalKind !== 'overwatch' && !m.mode.br) {
        tx = this.heard.x; tz = this.heard.z; speed = 4.8;
      } else if (m.mode.br && m.zone && Math.hypot(p.x - m.zone.x, p.z - m.zone.z) > m.zone.r - 10) {
        tx = m.zone.nx; tz = m.zone.nz; speed = 6.5;
      } else if (this.goal) {
        tx = this.goal.x; tz = this.goal.z;
        const dg = Math.hypot(tx - p.x, tz - p.z);
        if (this.goalKind === 'loot' && dg < 2.5 && this.lootTarget >= 0) {
          if (!m.lootOpened.has(this.lootTarget)) m.openLoot(p, this.lootTarget);
          this.lootTarget = -1; this.goalUntil = 0;
        }
        if (dg < 3) {
          tx = null;
          if (this.goalKind === 'overwatch') wantCrouch = true;
          else if (m.time > this.goalUntil - 3000) this.goalUntil = 0;
          else if (this.goalKind === 'flag' && this.rng.next() < 0.02) {
            // wander around the objective
            const o = m.objectives.find((q) => Math.hypot(q.x - p.x, q.z - p.z) < q.radius * 1.5);
            if (o) this.goal = { x: o.x + this.rng.float(-o.radius, o.radius) * 0.8, z: o.z + this.rng.float(-o.radius, o.radius) * 0.8 };
          }
        } else speed = dg > 25 && p.hp > 50 ? 6.4 : 4.2;
      }
      if (m.time < this.lookUntil) faceMove = false;
    }
    p.stance = wantCrouch ? 1 : 0;
    if (wantCrouch) speed = Math.min(speed, 2.2);
    this.moving = false;
    if (tx === null) { this.stuckCheck.t = m.time; this.stuckCheck.x = p.x; this.stuckCheck.z = p.z; return; }
    // obstacle avoidance via building corners
    if (this.detour && m.time < this.detour.until) { tx = this.detour.x; tz = this.detour.z; }
    else {
      this.detour = null;
      if (m.time > this.wpCheck) {
        this.wpCheck = m.time + 400;
        const dx = tx - p.x, dz = tz - p.z, dl = Math.hypot(dx, dz);
        const look = Math.min(dl, 45);
        const lx = p.x + (dx / (dl || 1)) * look, lz = p.z + (dz / (dl || 1)) * look;
        const b = w.blockingBuilding(p.x, p.z, lx, lz, 0.8);
        this.waypoint = b ? this.cornerAround(b, tx, tz) : null;
      }
      if (this.waypoint) {
        if (Math.hypot(this.waypoint.x - p.x, this.waypoint.z - p.z) < 1.5) { this.waypoint = null; this.wpCheck = 0; }
        else { tx = this.waypoint.x; tz = this.waypoint.z; }
      }
    }
    let dx = tx - p.x, dz = tz - p.z;
    const dl = Math.hypot(dx, dz);
    if (dl < 0.3) return;
    dx /= dl; dz /= dl;
    // separation from team mates
    for (const q of m.players.values()) {
      if (q === p || !q.alive || q.team !== p.team) continue;
      const sx = p.x - q.x, sz = p.z - q.z;
      const s2 = sx * sx + sz * sz;
      if (s2 < 4 && s2 > 1e-4) { const s = Math.sqrt(s2); dx += (sx / s) * 0.6; dz += (sz / s) * 0.6; }
    }
    const nl = Math.hypot(dx, dz) || 1; dx /= nl; dz /= nl;
    // avoid deep water and cliffs: rotate the heading until passable
    const step = speed * dt;
    let ok = false;
    for (const rot of [0, 0.6, -0.6, 1.2, -1.2, 1.9, -1.9]) {
      const c = Math.cos(rot), s = Math.sin(rot);
      const rx = dx * c - dz * s, rz = dx * s + dz * c;
      const nx = p.x + rx * Math.max(step, 1.5), nz = p.z + rz * Math.max(step, 1.5);
      const h = w.heightAt(nx, nz);
      if (h < w.waterLevel - 0.9) continue;
      if ((h - w.heightAt(p.x, p.z)) / Math.max(step, 1.5) > 1.4) continue;
      dx = rx; dz = rz; ok = true; break;
    }
    if (!ok) { this.detour = { x: p.x - dx * 8 + this.rng.float(-6, 6), z: p.z - dz * 8 + this.rng.float(-6, 6), until: m.time + 2000 }; return; }
    const pos = { x: p.x + dx * step, y: p.y, z: p.z + dz * step };
    w.collide(pos, 0.4, 1.8);
    pos.y = w.groundAt(pos.x, pos.z, p.y + 0.6);
    if (pos.y < w.waterLevel - 1.3) pos.y = w.waterLevel - 1.3;
    p.x = pos.x; p.z = pos.z; p.y = pos.y;
    this.moving = true;
    if (faceMove) {
      const want = Math.atan2(-dx, -dz);
      p.yaw += clamp(angDiff(want, p.yaw), -5 * dt, 5 * dt);
      this.aimYaw = p.yaw;
    }
    // stuck detection
    if (m.time - this.stuckCheck.t > 1500) {
      if (Math.hypot(p.x - this.stuckCheck.x, p.z - this.stuckCheck.z) < 0.8 && !engaged) {
        const a = this.rng.float(0, Math.PI * 2);
        this.detour = { x: p.x + Math.cos(a) * 9, z: p.z + Math.sin(a) * 9, until: m.time + 1800 };
        this.waypoint = null;
      }
      this.stuckCheck = { t: m.time, x: p.x, z: p.z };
    }
  }

  cornerAround(b, gx, gz) {
    const p = this.p;
    const pad = 2.2;
    const corners = [
      [b.x - b.w / 2 - pad, b.z - b.d / 2 - pad], [b.x + b.w / 2 + pad, b.z - b.d / 2 - pad],
      [b.x + b.w / 2 + pad, b.z + b.d / 2 + pad], [b.x - b.w / 2 - pad, b.z + b.d / 2 + pad],
    ];
    let best = null, bc = Infinity;
    for (const [cx, cz] of corners) {
      const dx = cx - p.x, dz = cz - p.z, L = Math.hypot(dx, dz);
      if (L < 0.5) continue;
      const blocked = rayAABB(p.x, 0, p.z, dx / L, 0, dz / L, b.x - b.w / 2 - 0.6, -1, b.z - b.d / 2 - 0.6, b.x + b.w / 2 + 0.6, 1, b.z + b.d / 2 + 0.6);
      const cost = L + Math.hypot(gx - cx, gz - cz) + (blocked >= 0 && blocked < L ? 1000 : 0);
      if (cost < bc) { bc = cost; best = { x: cx, z: cz }; }
    }
    return best;
  }
}

void CLASSES;
