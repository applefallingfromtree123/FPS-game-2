// AI pilots/drivers for tanks, IFVs, jeeps, attack helicopters and jets.
import { VEHICLES } from '../shared/protocol.js';
import { clamp } from '../shared/rng.js';

const angDiff = (a, b) => { let d = (a - b) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };

export class VehicleAI {
  constructor(match, v, driver) {
    this.m = match; this.v = v; this.d = driver; this.rng = match.rng;
    this.spec = VEHICLES[v.type];
    this.goal = null; this.goalUntil = 0; this.target = null; this.scanAt = 0;
    this.orbit = this.rng.next() * Math.PI * 2;
    this.waypoint = null; this.wpAt = 0; this.stuck = { t: match.time, x: v.x, z: v.z }; this.reverseUntil = 0;
    this.skill = driver.bot ? driver.bot.skill : 0.6;
    this.takeoff = this.spec.air;
  }

  update(dt) {
    const v = this.v, m = this.m;
    if (!this.d.alive || this.d.vehicle !== v.id) { v.ai = null; return; }
    if (m.time > this.goalUntil) this.pickGoal();
    if (m.time > this.scanAt) { this.scan(); this.scanAt = m.time + 400; }
    if (v.type === 'heli') this.flyHeli(dt);
    else if (v.type === 'jet') this.flyJet(dt);
    else this.drive(dt);
    this.d.x = v.x; this.d.y = v.y; this.d.z = v.z; this.d.yaw = v.yaw;
  }

  pickGoal() {
    const m = this.m, v = this.v;
    this.goalUntil = m.time + 20000 + this.rng.float(0, 10000);
    let flags = m.objectives;
    if (m.sectors) { const ids = m.sectors[m.sector] || []; flags = m.objectives.filter((o) => ids.includes(o.id)); }
    if (!flags.length) { this.goal = { x: this.rng.float(-300, 300), z: this.rng.float(-300, 300) }; return; }
    const scored = flags.map((o) => ({ o, s: Math.hypot(o.x - v.x, o.z - v.z) / 200 + (o.owner === v.team ? 2 : 0) + this.rng.float(0, 1.5) })).sort((a, b) => a.s - b.s);
    const o = scored[0].o;
    // ground vehicles hold a bit outside the flag to support infantry
    const off = v.type === 'jeep' ? 0 : 30;
    const a = this.rng.float(0, Math.PI * 2);
    this.goal = { x: o.x + Math.cos(a) * off, z: o.z + Math.sin(a) * off, flag: o };
  }

  scan() {
    const m = this.m, v = this.v;
    const range = v.type === 'jet' ? 900 : v.type === 'heli' ? 320 : 260;
    let best = null, bd = Infinity;
    const eyeY = v.y + this.spec.height;
    for (const q of m.players.values()) {
      if (!q.alive || q.team === v.team || q.vehicle >= 0 || v.type === 'jet') continue;
      const d = Math.hypot(q.x - v.x, q.z - v.z);
      if (d > range || d > bd) continue;
      if (!m.world.lineClear(v.x, eyeY, v.z, q.x, q.y + 1.2, q.z)) continue;
      best = { p: q }; bd = d;
    }
    for (const o of m.vehicles) {
      if (o.destroyed || o.team === v.team || o.driver < 0 || o === v) continue;
      const air = VEHICLES[o.type].air;
      if (v.type !== 'jet' && v.type !== 'heli' && air) continue;
      if (v.type === 'jet' && !air && this.rng.next() < 0.5) continue;
      const d = Math.hypot(o.x - v.x, o.z - v.z);
      if (d > range * 1.2 || d * 0.6 > bd) continue;
      if (!m.world.lineClear(v.x, eyeY, v.z, o.x, o.y + 1.5, o.z)) continue;
      best = { v: o }; bd = d * 0.6;
    }
    this.target = best;
  }

  targetPos() {
    if (!this.target) return null;
    if (this.target.p) { const q = this.target.p; if (!q.alive) return null; return { x: q.x, y: q.y + 1.1, z: q.z, inf: true }; }
    const o = this.target.v; if (o.destroyed) return null; return { x: o.x, y: o.y + 1.4, z: o.z, veh: o };
  }

  fireAt(t, kind) {
    const v = this.v, m = this.m;
    const oy = v.y + this.spec.height * (v.type === 'heli' ? 0.3 : 0.9);
    const dx = t.x - v.x, dy = t.y - oy, dz = t.z - v.z;
    const L = Math.hypot(dx, dy, dz) || 1;
    const err = (0.02 + (1 - this.skill) * 0.05) * (kind === 'mg' ? 1 : 0.6);
    const d = [dx / L + (this.rng.next() - 0.5) * err, dy / L + (this.rng.next() - 0.5) * err, dz / L + (this.rng.next() - 0.5) * err];
    const o = [v.x + (dx / L) * this.spec.radius * 0.9, oy, v.z + (dz / L) * this.spec.radius * 0.9];
    m.vehicleFire(v, this.d, kind, o, d, null);
  }

  // ---------------------------------------------------------------- ground
  drive(dt) {
    const v = this.v, m = this.m, w = m.world;
    const t = this.targetPos();
    let gx = this.goal ? this.goal.x : v.x, gz = this.goal ? this.goal.z : v.z;
    const dist = Math.hypot(gx - v.x, gz - v.z);
    let throttle = dist > 12 ? 1 : 0;
    if (t && v.type !== 'jeep' && Math.hypot(t.x - v.x, t.z - v.z) < 150) throttle *= 0.35;
    if (v.type === 'jeep' && dist < 15 && this.d.bot) {
      // drop off the soldier at the objective
      m.exitVehicle(this.d);
      return;
    }
    // building avoidance
    if (m.time > this.wpAt) {
      this.wpAt = m.time + 600;
      const look = Math.min(dist, 50);
      const b = w.blockingBuilding(v.x, v.z, v.x + ((gx - v.x) / (dist || 1)) * look, v.z + ((gz - v.z) / (dist || 1)) * look, this.spec.radius);
      this.waypoint = null;
      if (b) {
        const pad = this.spec.radius + 3;
        const cs = [[b.x - b.w / 2 - pad, b.z - b.d / 2 - pad], [b.x + b.w / 2 + pad, b.z - b.d / 2 - pad], [b.x + b.w / 2 + pad, b.z + b.d / 2 + pad], [b.x - b.w / 2 - pad, b.z + b.d / 2 + pad]];
        let bc = Infinity;
        for (const [cx, cz] of cs) { const c = Math.hypot(cx - v.x, cz - v.z) + Math.hypot(gx - cx, gz - cz); if (c < bc) { bc = c; this.waypoint = { x: cx, z: cz }; } }
      }
    }
    if (this.waypoint) { gx = this.waypoint.x; gz = this.waypoint.z; if (Math.hypot(gx - v.x, gz - v.z) < 4) this.waypoint = null; }
    const want = Math.atan2(-(gx - v.x), -(gz - v.z));
    const turnRate = v.type === 'tank' ? 0.8 : v.type === 'ifv' ? 1.0 : 1.6;
    const da = angDiff(want, v.yaw);
    const rev = m.time < this.reverseUntil;
    v.yaw += clamp(da, -turnRate * dt, turnRate * dt) * (rev ? -1 : 1);
    const maxSp = this.spec.speed * (Math.abs(da) > 1 ? 0.4 : 1);
    v.speed += ((rev ? -5 : throttle * maxSp) - v.speed) * Math.min(1, dt * 0.8);
    const nx = v.x - Math.sin(v.yaw) * v.speed * dt, nz = v.z - Math.cos(v.yaw) * v.speed * dt;
    if (w.heightAt(nx, nz) > w.waterLevel - 0.6) {
      const pos = { x: nx, y: v.y, z: nz };
      w.collide(pos, this.spec.radius * 0.8, 2);
      v.x = pos.x; v.z = pos.z;
    } else v.speed = 0;
    v.y = w.heightAt(v.x, v.z);
    const n = w.normalAt(v.x, v.z);
    const fx = -Math.sin(v.yaw), fz = -Math.cos(v.yaw);
    v.pitch = Math.asin(clamp(-(n[0] * fx + n[2] * fz), -1, 1));
    v.roll = -Math.asin(clamp(n[0] * Math.cos(v.yaw) - n[2] * Math.sin(v.yaw), -1, 1));
    // stuck → reverse
    if (m.time - this.stuck.t > 3000) {
      if (throttle > 0 && Math.hypot(v.x - this.stuck.x, v.z - this.stuck.z) < 2) { this.reverseUntil = m.time + 1800; this.waypoint = null; }
      this.stuck = { t: m.time, x: v.x, z: v.z };
    }
    // turret & weapons
    if (t) {
      const tyaw = Math.atan2(-(t.x - v.x), -(t.z - v.z));
      const rel = angDiff(tyaw, v.yaw);
      v.turret += clamp(angDiff(rel, v.turret), -1.2 * dt, 1.2 * dt);
      if (Math.abs(angDiff(rel, v.turret)) < 0.08) {
        const d = Math.hypot(t.x - v.x, t.z - v.z);
        if (this.spec.weapon && (t.veh || d > 25 || v.type === 'ifv')) this.fireAt(t, 'main');
        if (this.spec.mg && t.inf && d < 150) this.fireAt(t, 'mg');
      }
    } else v.turret += clamp(-v.turret, -0.6 * dt, 0.6 * dt);
  }

  // ---------------------------------------------------------------- air
  flyHeli(dt) {
    const v = this.v, m = this.m, w = m.world;
    const t = this.targetPos();
    const c = this.goal || { x: 0, z: 0 };
    this.orbit += dt * 0.18;
    let gx = c.x + Math.cos(this.orbit) * 170, gz = c.z + Math.sin(this.orbit) * 170;
    const alt = w.heightAt(v.x, v.z) + 70;
    const want = t ? Math.atan2(-(t.x - v.x), -(t.z - v.z)) : Math.atan2(-(gx - v.x), -(gz - v.z));
    const da = angDiff(want, v.yaw);
    v.yaw += clamp(da, -1.1 * dt, 1.1 * dt);
    const toGoal = Math.hypot(gx - v.x, gz - v.z);
    const sp = t ? 8 : Math.min(38, toGoal * 0.5);
    const mx = (gx - v.x) / (toGoal || 1), mz = (gz - v.z) / (toGoal || 1);
    v.x += mx * sp * dt; v.z += mz * sp * dt;
    // terrain following with look-ahead
    const ahead = Math.max(w.heightAt(v.x + mx * 60, v.z + mz * 60), w.heightAt(v.x, v.z)) + 55;
    const tgtY = Math.max(alt, ahead);
    v.y += clamp(tgtY - v.y, -8 * dt, 14 * dt);
    v.speed = sp;
    v.pitch += (clamp(-sp / 120, -0.3, 0.3) - v.pitch) * dt * 2;
    v.roll += (clamp(-da * 0.5, -0.4, 0.4) - v.roll) * dt * 2;
    if (t && Math.abs(da) < 0.12) {
      const d = Math.hypot(t.x - v.x, t.z - v.z);
      if (d < 250) this.fireAt(t, 'mg');
      if ((t.veh || this.rng.next() < 0.1) && d < 300) this.fireAt(t, 'main');
    }
    this.clampMap();
  }

  flyJet(dt) {
    const v = this.v, m = this.m, w = m.world;
    const t = this.targetPos();
    if (!this.route || Math.hypot(this.route.x - v.x, this.route.z - v.z) < 150) {
      const lim = w.half * 0.8;
      this.route = { x: this.rng.float(-lim, lim), z: this.rng.float(-lim, lim) };
    }
    const g = t && t.veh ? t : this.route;
    const want = Math.atan2(-(g.x - v.x), -(g.z - v.z));
    const da = angDiff(want, v.yaw);
    v.yaw += clamp(da, -0.7 * dt, 0.7 * dt);
    v.roll += (clamp(-da * 1.2, -1.2, 1.2) - v.roll) * dt * 2;
    const spd = 110;
    v.speed = spd;
    const base = Math.max(w.heightAt(v.x, v.z), w.heightAt(v.x - Math.sin(v.yaw) * 300, v.z - Math.cos(v.yaw) * 300));
    const tgtY = base + (t && t.veh && !VEHICLES[t.veh.type].air ? 140 : 260);
    v.pitch += (clamp((tgtY - v.y) / 300, -0.35, 0.35) - v.pitch) * dt;
    v.x -= Math.sin(v.yaw) * spd * dt; v.z -= Math.cos(v.yaw) * spd * dt;
    v.y += Math.sin(v.pitch) * spd * dt;
    if (v.y < w.heightAt(v.x, v.z) + 40) v.y = w.heightAt(v.x, v.z) + 40;
    if (t && Math.abs(da) < 0.15) {
      const d = Math.hypot(t.x - v.x, t.z - v.z);
      if (d < 700) this.fireAt(t, 'main');
      if (d < 400) this.fireAt(t, 'mg');
    }
    this.clampMap(true);
  }

  clampMap(turn = false) {
    const v = this.v, lim = this.m.world.half - 40;
    if (Math.abs(v.x) > lim || Math.abs(v.z) > lim) {
      v.x = clamp(v.x, -lim, lim); v.z = clamp(v.z, -lim, lim);
      if (turn) this.route = { x: 0, z: 0 };
    }
  }
}
