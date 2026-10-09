// Compact binary snapshot format (server -> client, ~20Hz).
export const MSG_SNAPSHOT = 1;

export const VEHICLE_TYPES = ['tank', 'ifv', 'jeep', 'heli', 'jet'];
export const VEHICLES = {
  tank: { label: 'M1 전차', hp: 1000, speed: 14, seats: 1, radius: 3.2, height: 2.6, air: false, weapon: { name: '120mm 주포', reload: 3.0, dmg: 120, vehDmg: 300, splash: 6, vel: 260 }, mg: { rpm: 600, dmg: 22 } },
  ifv:  { label: 'BMP 장갑차', hp: 750, speed: 18, seats: 1, radius: 3.0, height: 2.4, air: false, weapon: { name: '30mm 기관포', reload: 0.25, dmg: 45, vehDmg: 40, splash: 2.5, vel: 400 }, mg: null },
  jeep: { label: '전술 차량', hp: 350, speed: 28, seats: 1, radius: 2.4, height: 1.8, air: false, weapon: null, mg: { rpm: 700, dmg: 22 } },
  heli: { label: '공격 헬기', hp: 700, speed: 55, seats: 1, radius: 5.5, height: 3.5, air: true, weapon: { name: '로켓 포드', reload: 0.35, dmg: 90, vehDmg: 110, splash: 4.5, vel: 220, clip: 14, clipReload: 6 }, mg: { rpm: 900, dmg: 24 } },
  jet:  { label: '전투기', hp: 600, speed: 160, seats: 1, radius: 7, height: 3, air: true, weapon: { name: '공대공 미사일', reload: 4.0, dmg: 120, vehDmg: 450, splash: 6, vel: 320, homing: true }, mg: { rpm: 1200, dmg: 26 } },
};

const P_SIZE = 24;
const V_SIZE = 28;

const a2i = (a) => Math.round((((a % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI) * 10000);

// players: [{id,team,flags,x,y,z,yaw,pitch,hp,weapon,veh}], vehicles: [...]
export function encodeSnapshot(time, players, vehicles) {
  const buf = new ArrayBuffer(1 + 4 + 2 + 2 + players.length * P_SIZE + vehicles.length * V_SIZE);
  const dv = new DataView(buf);
  let o = 0;
  dv.setUint8(o, MSG_SNAPSHOT); o += 1;
  dv.setUint32(o, time >>> 0); o += 4;
  dv.setUint16(o, players.length); o += 2;
  dv.setUint16(o, vehicles.length); o += 2;
  for (const p of players) {
    dv.setUint16(o, p.id); o += 2;
    dv.setUint8(o, p.team & 255); o += 1;
    dv.setUint8(o, p.flags); o += 1;
    dv.setFloat32(o, p.x); o += 4;
    dv.setFloat32(o, p.y); o += 4;
    dv.setFloat32(o, p.z); o += 4;
    dv.setInt16(o, Math.max(-32767, Math.min(32767, a2i(p.yaw)))); o += 2;
    dv.setInt16(o, Math.max(-32767, Math.min(32767, Math.round(p.pitch * 10000)))); o += 2;
    dv.setUint8(o, Math.max(0, Math.min(255, Math.round(p.hp)))); o += 1;
    dv.setUint8(o, p.weapon & 255); o += 1;
    dv.setUint16(o, p.veh === undefined || p.veh < 0 ? 65535 : p.veh); o += 2;
  }
  for (const v of vehicles) {
    dv.setUint16(o, v.id); o += 2;
    dv.setUint8(o, VEHICLE_TYPES.indexOf(v.type)); o += 1;
    dv.setUint8(o, v.team & 255); o += 1;
    dv.setFloat32(o, v.x); o += 4;
    dv.setFloat32(o, v.y); o += 4;
    dv.setFloat32(o, v.z); o += 4;
    dv.setInt16(o, a2i(v.yaw)); o += 2;
    dv.setInt16(o, a2i(v.pitch)); o += 2;
    dv.setInt16(o, a2i(v.roll)); o += 2;
    dv.setInt16(o, a2i(v.turret || 0)); o += 2;
    dv.setUint8(o, Math.round((v.hp / VEHICLES[v.type].hp) * 255)); o += 1;
    dv.setUint8(o, v.flags); o += 1;
    dv.setUint16(o, v.driver < 0 ? 65535 : v.driver); o += 2;
  }
  return buf;
}

export function decodeSnapshot(buf) {
  const dv = new DataView(buf);
  let o = 1;
  const time = dv.getUint32(o); o += 4;
  const np = dv.getUint16(o); o += 2;
  const nv = dv.getUint16(o); o += 2;
  const players = [];
  for (let i = 0; i < np; i++) {
    const p = {};
    p.id = dv.getUint16(o); o += 2;
    p.team = dv.getUint8(o); o += 1;
    p.flags = dv.getUint8(o); o += 1;
    p.x = dv.getFloat32(o); o += 4;
    p.y = dv.getFloat32(o); o += 4;
    p.z = dv.getFloat32(o); o += 4;
    p.yaw = dv.getInt16(o) / 10000; o += 2;
    p.pitch = dv.getInt16(o) / 10000; o += 2;
    p.hp = dv.getUint8(o); o += 1;
    p.weapon = dv.getUint8(o); o += 1;
    const veh = dv.getUint16(o); o += 2;
    p.veh = veh === 65535 ? -1 : veh;
    players.push(p);
  }
  const vehicles = [];
  for (let i = 0; i < nv; i++) {
    const v = {};
    v.id = dv.getUint16(o); o += 2;
    v.type = VEHICLE_TYPES[dv.getUint8(o)]; o += 1;
    v.team = dv.getUint8(o); o += 1;
    v.x = dv.getFloat32(o); o += 4;
    v.y = dv.getFloat32(o); o += 4;
    v.z = dv.getFloat32(o); o += 4;
    v.yaw = dv.getInt16(o) / 10000; o += 2;
    v.pitch = dv.getInt16(o) / 10000; o += 2;
    v.roll = dv.getInt16(o) / 10000; o += 2;
    v.turret = dv.getInt16(o) / 10000; o += 2;
    v.hp = (dv.getUint8(o) / 255) * VEHICLES[v.type].hp; o += 1;
    v.flags = dv.getUint8(o); o += 1;
    const d = dv.getUint16(o); o += 2;
    v.driver = d === 65535 ? -1 : d;
    vehicles.push(v);
  }
  return { time, players, vehicles };
}

// player flag bits
export const PF = { ALIVE: 1, CROUCH: 2, ADS: 4, FIRING: 8, BOT: 16, SPOTTED: 32, PARACHUTE: 64, PRONE: 128 };
export const VF = { DESTROYED: 1, OCCUPIED: 2 };

// Hitbox geometry for soldiers (relative to feet position)
export function hitboxes(stance) {
  if (stance === 2) return { head: { y: 0.35, r: 0.15, fwd: 0.85 }, body: { y0: 0.1, y1: 0.35, r: 0.32 } };
  if (stance === 1) return { head: { y: 1.12, r: 0.14 }, body: { y0: 0.2, y1: 0.95, r: 0.3 } };
  return { head: { y: 1.62, r: 0.14 }, body: { y0: 0.15, y1: 1.42, r: 0.29 } };
}
export const EYE = [1.62, 1.1, 0.35];
