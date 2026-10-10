// XP → level → rank title. Shared by server (profile payloads) and client (UI).
export const RANKS = [
  [1, '이등병', 'RECRUIT'], [4, '일병', 'PRIVATE'], [8, '상병', 'CORPORAL'], [13, '병장', 'SERGEANT'],
  [19, '하사', 'STAFF SGT'], [26, '중사', 'SGT FIRST CLASS'], [34, '상사', 'MASTER SGT'], [43, '소위', 'LIEUTENANT'],
  [53, '대위', 'CAPTAIN'], [64, '소령', 'MAJOR'], [76, '중령', 'COLONEL'], [90, '대령', 'BRIGADIER'], [105, '장군', 'GENERAL'],
];
export const levelFor = (xp) => Math.min(150, Math.floor(Math.sqrt(Math.max(0, xp) / 120)) + 1);
export const xpForLevel = (lv) => Math.round((lv - 1) ** 2 * 120);
export function rankFor(level) {
  let r = RANKS[0];
  for (const x of RANKS) if (level >= x[0]) r = x;
  return { ko: r[1], en: r[2], tier: RANKS.indexOf(r) };
}
export function progress(xp) {
  const level = levelFor(xp);
  const a = xpForLevel(level), b = xpForLevel(level + 1);
  return { level, into: xp - a, need: b - a, ...rankFor(level) };
}
