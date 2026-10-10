// Character customization. A look is a compact array of option indices:
// [skin, face, head, eyes, camo, gear, pack]. Shared by client (rendering, UI) and server (validation/roster).
export const LOOK_OPTS = {
  skin: { label: '피부색', values: ['#f1cfb4', '#d9a98a', '#b9825f', '#8f5d3f', '#6b4430', '#4a2f22'], count: 6 },
  face: { label: '얼굴', names: ['깔끔', '짧은 수염', '수염', '콧수염', '구레나룻'], count: 5 },
  head: { label: '머리 장비', names: ['헬멧', '헬멧 + 야시경', '부니햇', '비니', '반다나', '캡 모자'], count: 6 },
  eyes: { label: '안면 장비', names: ['없음', '전술 안경', '선글라스', '발라클라바', '고글'], count: 5 },
  camo: { label: '위장 무늬', names: ['기본', '변형 A', '변형 B', '변형 C'], count: 4 },
  gear: { label: '장구 색', names: ['블랙', '올리브', '탄', '그레이'], values: ['#23262a', '#4b5238', '#8b7a58', '#6a7076'], count: 4 },
  pack: { label: '등 장비', names: ['배낭', '무전기', '없음', '대형 배낭'], count: 4 },
};
export const LOOK_KEYS = ['skin', 'face', 'head', 'eyes', 'camo', 'gear', 'pack'];
export const defaultLook = () => [1, 0, 1, 0, 0, 0, 0];

export function sanitizeLook(l) {
  const out = defaultLook();
  if (!Array.isArray(l)) return out;
  LOOK_KEYS.forEach((k, i) => { const v = Number.isInteger(l[i]) ? l[i] : 0; out[i] = v >= 0 && v < LOOK_OPTS[k].count ? v : 0; });
  return out;
}

export function randomLook(rnd) {
  return LOOK_KEYS.map((k) => Math.floor(rnd() * LOOK_OPTS[k].count));
}
