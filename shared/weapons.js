// WARFIELD weapon database: 110+ weapons generated from category archetypes
// plus per-weapon tuning. Shared by server (damage/validation) and client
// (models, recoil, HUD).
import { hashString, mulberry32 } from './rng.js';
import { sanitizeLook, defaultLook } from './look.js';

export const CATEGORIES = {
  ar:       { label: '돌격소총',  slot: 'primary',   classes: ['assault'] },
  carbine:  { label: '카빈',      slot: 'primary',   classes: ['assault', 'engineer', 'support', 'recon'] },
  smg:      { label: '기관단총',  slot: 'primary',   classes: ['engineer', 'assault'] },
  lmg:      { label: '경기관총',  slot: 'primary',   classes: ['support'] },
  dmr:      { label: '지정사수소총', slot: 'primary', classes: ['recon', 'assault', 'support'] },
  sniper:   { label: '저격소총',  slot: 'primary',   classes: ['recon'] },
  shotgun:  { label: '산탄총',    slot: 'primary',   classes: ['support', 'engineer', 'assault', 'recon'] },
  pistol:   { label: '권총',      slot: 'secondary', classes: ['assault', 'engineer', 'support', 'recon'] },
  launcher: { label: '런처',      slot: 'gadget',    classes: ['engineer'] },
};

// Archetype stats. dmg=[close,far], range=[falloffStart,falloffEnd] meters.
const BASE = {
  ar:      { dmg: [25, 19], range: [30, 80],  rpm: 750, mag: 30, reserve: 150, reload: 2.3, vel: 850, hip: 2.4, ads: 0.35, recoilV: 0.55, recoilH: 0.30, zoom: 1.3, adsTime: 0.22, modes: ['auto', 'semi'], sight: 'holo', weight: 3.5, headMult: 2.0 },
  carbine: { dmg: [24, 17], range: [25, 65],  rpm: 800, mag: 30, reserve: 150, reload: 2.1, vel: 760, hip: 2.0, ads: 0.40, recoilV: 0.50, recoilH: 0.30, zoom: 1.25, adsTime: 0.19, modes: ['auto', 'semi'], sight: 'red', weight: 3.0, headMult: 2.0 },
  smg:     { dmg: [22, 13], range: [12, 40],  rpm: 900, mag: 30, reserve: 180, reload: 1.9, vel: 420, hip: 1.6, ads: 0.55, recoilV: 0.40, recoilH: 0.35, zoom: 1.15, adsTime: 0.16, modes: ['auto', 'semi'], sight: 'red', weight: 2.4, headMult: 1.8 },
  lmg:     { dmg: [26, 20], range: [35, 90],  rpm: 700, mag: 100, reserve: 300, reload: 5.0, vel: 860, hip: 3.6, ads: 0.45, recoilV: 0.50, recoilH: 0.45, zoom: 1.3, adsTime: 0.35, modes: ['auto'], sight: 'red', weight: 8.0, headMult: 2.0 },
  dmr:     { dmg: [45, 36], range: [50, 150], rpm: 300, mag: 20, reserve: 100, reload: 2.6, vel: 900, hip: 4.0, ads: 0.15, recoilV: 1.40, recoilH: 0.35, zoom: 3.0, adsTime: 0.28, modes: ['semi'], sight: 'acog', weight: 4.5, headMult: 2.2 },
  sniper:  { dmg: [95, 80], range: [80, 400], rpm: 50,  mag: 5,  reserve: 30,  reload: 3.4, vel: 900, hip: 6.0, ads: 0.02, recoilV: 3.20, recoilH: 0.60, zoom: 8.0, adsTime: 0.38, modes: ['bolt'], sight: 'scope', weight: 6.0, headMult: 2.6 },
  shotgun: { dmg: [16, 4],  range: [8, 30],   rpm: 75,  mag: 7,  reserve: 42,  reload: 4.0, vel: 400, hip: 4.5, ads: 3.20, recoilV: 2.50, recoilH: 0.80, zoom: 1.1, adsTime: 0.2, modes: ['pump'], sight: 'iron', weight: 3.6, headMult: 1.5, pellets: 9 },
  pistol:  { dmg: [30, 18], range: [12, 40],  rpm: 400, mag: 15, reserve: 60,  reload: 1.6, vel: 380, hip: 1.8, ads: 0.6, recoilV: 0.90, recoilH: 0.40, zoom: 1.1, adsTime: 0.13, modes: ['semi'], sight: 'iron', weight: 1.0, headMult: 2.0 },
  launcher:{ dmg: [130, 130], range: [5, 10], rpm: 20,  mag: 1,  reserve: 4,   reload: 3.6, vel: 120, hip: 2.0, ads: 0.2, recoilV: 3.0, recoilH: 0.5, zoom: 1.6, adsTime: 0.45, modes: ['single'], sight: 'iron', weight: 7.0, headMult: 1.0, projectile: 'rocket', splash: 5, vehDmg: 340 },
};

// name, category, overrides
const LIST = [
  // Assault rifles (22)
  ['M4A1', 'ar', { rpm: 800, dmg: [25, 18] }],
  ['M16A4', 'ar', { rpm: 800, modes: ['burst', 'semi'], dmg: [27, 22], recoilV: 0.5 }],
  ['AK-74M', 'ar', { rpm: 650, dmg: [27, 20], recoilV: 0.62 }],
  ['AK-12', 'ar', { rpm: 700, dmg: [26, 20], modes: ['auto', 'burst', 'semi'] }],
  ['AKM', 'ar', { rpm: 600, dmg: [33, 24], recoilV: 0.85, recoilH: 0.45, vel: 715 }],
  ['HK416', 'ar', { rpm: 820, dmg: [25, 18], recoilV: 0.48 }],
  ['SCAR-L', 'ar', { rpm: 625, dmg: [27, 21] }],
  ['SCAR-H', 'ar', { rpm: 600, dmg: [34, 27], mag: 20, recoilV: 0.95, vel: 800 }],
  ['FAMAS', 'ar', { rpm: 1000, dmg: [23, 16], mag: 25, modes: ['burst', 'auto', 'semi'] }],
  ['AUG A3', 'ar', { rpm: 700, dmg: [25, 19], sight: 'acog', zoom: 2.0 }],
  ['QBZ-95', 'ar', { rpm: 650, dmg: [26, 19] }],
  ['ACR', 'ar', { rpm: 700, dmg: [25, 19], recoilV: 0.42 }],
  ['TAR-21', 'ar', { rpm: 850, dmg: [24, 17] }],
  ['F2000', 'ar', { rpm: 850, dmg: [24, 17], recoilH: 0.38 }],
  ['SG 550', 'ar', { rpm: 700, dmg: [26, 21], recoilV: 0.45 }],
  ['Galil ACE', 'ar', { rpm: 680, dmg: [27, 20] }],
  ['ARX-160', 'ar', { rpm: 700, dmg: [25, 19] }],
  ['AN-94', 'ar', { rpm: 600, dmg: [27, 21], modes: ['burst', 'auto'] }],
  ['K2', 'ar', { rpm: 750, dmg: [25, 19] }],
  ['G3A3', 'ar', { rpm: 550, dmg: [36, 28], mag: 20, recoilV: 1.0 }],
  ['FN FAL', 'ar', { rpm: 650, dmg: [35, 28], mag: 20, recoilV: 1.0, modes: ['semi', 'auto'] }],
  ['L85A2', 'ar', { rpm: 700, dmg: [25, 19], sight: 'acog', zoom: 2.0 }],
  // Carbines (10)
  ['G36C', 'carbine', { rpm: 750 }],
  ['AKS-74U', 'carbine', { rpm: 700, dmg: [26, 15], recoilV: 0.65 }],
  ['MTAR-21', 'carbine', { rpm: 900, dmg: [23, 15] }],
  ['SG 553', 'carbine', { rpm: 700, dmg: [25, 17] }],
  ['HK433', 'carbine', { rpm: 750 }],
  ['Mk18 Mod1', 'carbine', { rpm: 850, dmg: [24, 16] }],
  ['AK-105', 'carbine', { rpm: 650, dmg: [27, 18] }],
  ['ACE 21', 'carbine', { rpm: 700 }],
  ['K1A', 'carbine', { rpm: 800, dmg: [23, 16] }],
  ['Honey Badger', 'carbine', { rpm: 800, dmg: [26, 15], muzzleDefault: 'suppressor' }],
  // SMGs (16)
  ['MP5A3', 'smg', { rpm: 800 }],
  ['MP5SD', 'smg', { rpm: 700, muzzleDefault: 'suppressor', dmg: [21, 12] }],
  ['MP7A1', 'smg', { rpm: 950, mag: 40, dmg: [20, 13] }],
  ['UMP-45', 'smg', { rpm: 600, mag: 25, dmg: [29, 15] }],
  ['P90', 'smg', { rpm: 900, mag: 50, dmg: [20, 13] }],
  ['Vector .45', 'smg', { rpm: 1200, mag: 25, dmg: [22, 11], recoilV: 0.3 }],
  ['MPX', 'smg', { rpm: 850 }],
  ['PP-19 Bizon', 'smg', { rpm: 680, mag: 64, dmg: [21, 12] }],
  ['Uzi', 'smg', { rpm: 600, mag: 32, dmg: [25, 13] }],
  ['MP9', 'smg', { rpm: 1000, dmg: [20, 11] }],
  ['Scorpion EVO 3', 'smg', { rpm: 1150, dmg: [19, 11] }],
  ['PP-2000', 'smg', { rpm: 650, mag: 44, dmg: [23, 12] }],
  ['MAC-10', 'smg', { rpm: 1100, dmg: [21, 10], recoilH: 0.5 }],
  ['AUG Para', 'smg', { rpm: 750, mag: 32 }],
  ['PDW-R', 'smg', { rpm: 750, dmg: [24, 15], range: [18, 50] }],
  ['K7', 'smg', { rpm: 1100, muzzleDefault: 'suppressor', dmg: [19, 11] }],
  // LMGs (12)
  ['M249', 'lmg', { rpm: 800, mag: 200, reload: 6.5 }],
  ['M240B', 'lmg', { rpm: 650, mag: 100, dmg: [34, 27], recoilV: 0.7 }],
  ['PKM', 'lmg', { rpm: 650, mag: 100, dmg: [33, 26], recoilV: 0.72 }],
  ['RPK-74', 'lmg', { rpm: 600, mag: 45, reload: 3.0, dmg: [27, 21] }],
  ['MG4', 'lmg', { rpm: 800, mag: 100 }],
  ['Negev NG7', 'lmg', { rpm: 750, mag: 150, dmg: [32, 25] }],
  ['M60E4', 'lmg', { rpm: 600, mag: 100, dmg: [35, 28], recoilV: 0.8 }],
  ['L86A2', 'lmg', { rpm: 650, mag: 30, reload: 2.5, sight: 'acog', zoom: 2.0 }],
  ['Type 88', 'lmg', { rpm: 700, mag: 200, reload: 6.0 }],
  ['MG36', 'lmg', { rpm: 750, mag: 100 }],
  ['Ultimax 100', 'lmg', { rpm: 600, mag: 100, recoilV: 0.3 }],
  ['M27 IAR', 'lmg', { rpm: 750, mag: 45, reload: 2.6, dmg: [27, 21] }],
  // DMRs (10)
  ['Mk14 EBR', 'dmr', { rpm: 350, dmg: [48, 38] }],
  ['SVD', 'dmr', { rpm: 300, dmg: [55, 45], mag: 10, sight: 'scope', zoom: 4.0 }],
  ['M110', 'dmr', { rpm: 300, dmg: [50, 40] }],
  ['SKS', 'dmr', { rpm: 380, dmg: [43, 34], mag: 15 }],
  ['Mini-14', 'dmr', { rpm: 400, dmg: [38, 30] }],
  ['SR-25', 'dmr', { rpm: 320, dmg: [48, 38] }],
  ['RFB', 'dmr', { rpm: 300, dmg: [52, 42] }],
  ['QBU-88', 'dmr', { rpm: 330, dmg: [47, 37], mag: 10 }],
  ['Mk 11', 'dmr', { rpm: 330, dmg: [49, 39] }],
  ['G28', 'dmr', { rpm: 320, dmg: [50, 40], sight: 'scope', zoom: 4.0 }],
  // Snipers (12)
  ['M24', 'sniper', {}],
  ['M40A5', 'sniper', { dmg: [100, 85] }],
  ['L115A3', 'sniper', { dmg: [110, 95], vel: 940 }],
  ['M200', 'sniper', { dmg: [115, 100], mag: 7, rpm: 40 }],
  ['M82A1', 'sniper', { dmg: [110, 100], rpm: 120, mag: 10, modes: ['semi'], recoilV: 4.0, vehDmg: 20 }],
  ['M98B', 'sniper', { dmg: [105, 90] }],
  ['SV-98', 'sniper', { dmg: [100, 85], mag: 10 }],
  ['Scout Elite', 'sniper', { dmg: [90, 75], rpm: 65, adsTime: 0.3 }],
  ['DVL-10', 'sniper', { muzzleDefault: 'suppressor', dmg: [92, 78] }],
  ['Kar98k', 'sniper', { dmg: [98, 82], sight: 'iron', zoom: 2.2 }],
  ['SRR-61', 'sniper', { dmg: [100, 90] }],
  ['TAC-50', 'sniper', { dmg: [120, 105], rpm: 40, mag: 5 }],
  // Shotguns (10)
  ['M870', 'shotgun', {}],
  ['M1014', 'shotgun', { modes: ['semi'], rpm: 200, dmg: [14, 4] }],
  ['SPAS-12', 'shotgun', { rpm: 90, mag: 8 }],
  ['Saiga-12', 'shotgun', { modes: ['semi'], rpm: 240, mag: 10, dmg: [12, 3] }],
  ['AA-12', 'shotgun', { modes: ['auto'], rpm: 300, mag: 20, dmg: [11, 3] }],
  ['KSG', 'shotgun', { rpm: 80, mag: 14 }],
  ['DAO-12', 'shotgun', { modes: ['semi'], rpm: 260, mag: 12, dmg: [12, 3] }],
  ['USAS-12', 'shotgun', { modes: ['auto'], rpm: 360, mag: 10, dmg: [11, 3] }],
  ['Model 1887', 'shotgun', { rpm: 70, mag: 5, dmg: [18, 5] }],
  ['M26 MASS', 'shotgun', { rpm: 70, mag: 5 }],
  // Pistols (14)
  ['M9', 'pistol', {}],
  ['Glock 17', 'pistol', { mag: 17, dmg: [28, 17] }],
  ['Glock 18', 'pistol', { modes: ['auto', 'semi'], rpm: 1100, mag: 19, dmg: [24, 14] }],
  ['Desert Eagle', 'pistol', { mag: 7, rpm: 220, dmg: [60, 40], recoilV: 2.0 }],
  ['USP .45', 'pistol', { mag: 12, dmg: [34, 20] }],
  ['P226', 'pistol', { mag: 15 }],
  ['M1911', 'pistol', { mag: 8, dmg: [36, 22] }],
  ['Five-seveN', 'pistol', { mag: 20, dmg: [27, 20] }],
  ['MP443', 'pistol', { mag: 18 }],
  ['QSZ-92', 'pistol', { mag: 15 }],
  ['CZ-75', 'pistol', { mag: 16, modes: ['semi', 'auto'], rpm: 900 }],
  ['.44 Magnum', 'pistol', { mag: 6, rpm: 170, dmg: [65, 45], recoilV: 2.4, reload: 2.8 }],
  ['M93R', 'pistol', { modes: ['burst', 'semi'], rpm: 1100, mag: 20, dmg: [25, 15] }],
  ['P250', 'pistol', { mag: 13, dmg: [32, 19] }],
  // Launchers (6)
  ['RPG-7', 'launcher', { vel: 115 }],
  ['SMAW', 'launcher', { vel: 130, vehDmg: 360 }],
  ['Carl Gustaf', 'launcher', { vel: 150, dmg: [110, 110], splash: 6, reserve: 5 }],
  ['Javelin', 'launcher', { vel: 90, vehDmg: 480, dmg: [100, 100], homing: 'ground', reload: 4.5 }],
  ['Stinger', 'launcher', { vel: 160, vehDmg: 420, dmg: [60, 60], homing: 'air', reload: 3.8 }],
  ['M32 MGL', 'launcher', { vel: 75, mag: 6, reserve: 12, rpm: 120, dmg: [90, 90], splash: 4.5, vehDmg: 80, projectile: 'grenade', classes: ['assault'] }],
];

export const WEAPONS = LIST.map(([name, cat, ov], id) => {
  const base = BASE[cat];
  const rnd = mulberry32(hashString(name));
  const w = { id, name, cat, ...base, ...ov };
  w.slot = CATEGORIES[cat].slot;
  w.classes = ov.classes || CATEGORIES[cat].classes;
  w.pellets = w.pellets || 1;
  w.fireInterval = 60 / w.rpm;
  w.muzzleDefault = w.muzzleDefault || 'none';
  // Deterministic visual variation for procedural models
  w.look = {
    barrel: 0.75 + rnd() * 0.5,
    body: 0.85 + rnd() * 0.3,
    stock: Math.floor(rnd() * 3),
    mag: Math.floor(rnd() * 3),
    rail: rnd() > 0.35,
    bullpup: ['FAMAS', 'AUG A3', 'QBZ-95', 'TAR-21', 'F2000', 'L85A2', 'MTAR-21', 'P90', 'KSG', 'DAO-12', 'L86A2', 'QBU-88', 'AUG Para'].includes(name),
    tone: rnd() < 0.6 ? 0 : 1 + Math.floor(rnd() * 2), // 0 black, 1 tan, 2 olive (3 wood set below)
    grip: rnd() > 0.5,
  };
  if (['AKM', 'AK-74M', 'SVD', 'SKS', 'Kar98k', 'M1014', 'Model 1887', 'M870', 'RPK-74', 'PKM', 'M24', 'M40A5', 'Mini-14', 'G3A3', 'FN FAL'].includes(name)) w.look.tone = 3;
  return w;
});

export const WEAPON_BY_NAME = Object.fromEntries(WEAPONS.map((w) => [w.name, w]));

// Throwables / special (not counted in list above, used by everyone)
export const GRENADE = { name: 'M67 Frag', fuse: 3.0, dmg: 120, splash: 7, vel: 22 };
export const C4 = { name: 'C4', dmg: 160, splash: 6, vehDmg: 500, vel: 12 };

export const SIGHTS = {
  iron:  { label: '기본 가늠자', zoom: 1.0 },
  red:   { label: '레드 닷 (1x)', zoom: 1.0 },
  holo:  { label: '홀로그래픽 (1x)', zoom: 1.0 },
  x2:    { label: '2x 스코프', zoom: 2.0 },
  acog:  { label: 'ACOG (4x)', zoom: 4.0 },
  scope: { label: '저격 스코프 (8x)', zoom: 8.0 },
};
export const MUZZLES = {
  none:       { label: '없음', recoil: 1.0, dmg: 1.0, loud: true },
  suppressor: { label: '소음기', recoil: 0.9, dmg: 0.9, loud: false },
  comp:       { label: '보정기', recoil: 0.8, dmg: 1.0, loud: true },
};

export const CLASSES = {
  assault:  { label: '돌격병',   gadget: 'M32 MGL', desc: '돌격소총 · 유탄발사기 · 자가치유' },
  engineer: { label: '공병',     gadget: 'RPG-7',   desc: '기관단총 · 대전차 런처 · 차량 수리' },
  support:  { label: '지원병',   gadget: 'Ammo Box', desc: '경기관총 · 탄약/의료 보급' },
  recon:    { label: '정찰병',   gadget: 'C4',      desc: '저격소총 · C4 · 적 스팟' },
};

export function weaponsFor(cls, slot) {
  return WEAPONS.filter((w) => w.slot === slot && w.classes.includes(cls));
}

export function zoomFor(w, sight) {
  const s = sight || w.sight;
  if (s === 'iron' || s === 'red' || s === 'holo') return w.zoom > 1.6 && s === 'iron' ? w.zoom : Math.max(1.15, Math.min(w.zoom, 1.35));
  return SIGHTS[s] ? SIGHTS[s].zoom : w.zoom;
}

export function damageAt(w, dist, muzzle = 'none') {
  const [c, f] = w.dmg;
  const [r1, r2] = w.range;
  let d;
  if (dist <= r1) d = c;
  else if (dist >= r2) d = f;
  else d = c + (f - c) * ((dist - r1) / (r2 - r1));
  return d * (MUZZLES[muzzle] ? MUZZLES[muzzle].dmg : 1);
}

export function defaultLoadout(cls = 'assault') {
  const prim = { assault: 'M4A1', engineer: 'MP7A1', support: 'M249', recon: 'M24' }[cls];
  return { cls, look: defaultLook(), primary: WEAPON_BY_NAME[prim].id, secondary: WEAPON_BY_NAME['M9'].id,
    gadget: WEAPON_BY_NAME[CLASSES[cls].gadget] ? WEAPON_BY_NAME[CLASSES[cls].gadget].id : -1,
    sight: WEAPON_BY_NAME[prim].sight, muzzle: WEAPON_BY_NAME[prim].muzzleDefault };
}

export function sanitizeLoadout(l) {
  const cls = l && CLASSES[l.cls] ? l.cls : 'assault';
  const d = defaultLoadout(cls);
  const p = WEAPONS[l && l.primary];
  const s = WEAPONS[l && l.secondary];
  const g = WEAPONS[l && l.gadget];
  const out = { ...d };
  out.look = sanitizeLook(l && l.look);
  if (p && p.slot === 'primary' && p.classes.includes(cls)) out.primary = p.id;
  if (s && s.slot === 'secondary') out.secondary = s.id;
  if (g && g.slot === 'gadget' && g.classes.includes(cls)) out.gadget = g.id;
  if (cls === 'support' || cls === 'recon') out.gadget = -1; // class gadget handled separately
  if (l && SIGHTS[l.sight]) out.sight = l.sight; else out.sight = WEAPONS[out.primary].sight;
  if (l && MUZZLES[l.muzzle]) out.muzzle = l.muzzle; else out.muzzle = WEAPONS[out.primary].muzzleDefault;
  return out;
}
