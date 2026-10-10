// Game modes. maxPlayers = humans + bots. When fewer humans are found, the
// remaining slots are filled with AI soldiers.
// kind: conquest | breakthrough | br | tdm | dom | hill | ffa  (selects the rule set in server/match.js)
// Optional modifiers: cats (allowed primary weapon categories), noGadget, dmgMult, noRegen,
// ladder (gun master weapon order), bleed (ticket drain speed), noDeathTickets, hillSeconds.
const GUN_LADDER = ['MP7A1', 'P90', 'UMP-45', 'Vector .45', 'MP5A3', 'G36C', 'Mk18 Mod1', 'M4A1', 'AK-74M', 'SCAR-H', 'M249', 'M870', 'AA-12', 'Mk14 EBR', 'SVD', 'M24', 'Desert Eagle', 'M9'];

export const MODES = {
  conquest: {
    id: 'conquest', kind: 'conquest', name: '컨퀘스트', en: 'CONQUEST', maxPlayers: 100, teams: 2, tickets: 1000, group: 'large',
    desc: '100인 전면전. 거점을 점령해 상대 티켓을 소진시키세요. 전차·헬기·전투기 운용.',
    vehicles: true, respawn: true, timeLimit: 40 * 60,
  },
  breakthrough: {
    id: 'breakthrough', kind: 'breakthrough', name: '브레이크스루', en: 'BREAKTHROUGH', maxPlayers: 100, teams: 2, tickets: 400, group: 'large',
    desc: '공격팀은 구역을 차례로 돌파하고, 방어팀은 전선을 지켜내세요.',
    vehicles: true, respawn: true, timeLimit: 40 * 60,
  },
  redsec: {
    id: 'redsec', kind: 'br', name: 'REDSEC 배틀로얄', en: 'REDSEC', maxPlayers: 100, teams: 25, squadSize: 4, group: 'large',
    desc: '4인 분대 25팀. 공중 강하, 보급 상자, 줄어드는 화염 지대. 최후의 분대가 승리.',
    vehicles: true, respawn: false, timeLimit: 25 * 60, br: true,
  },
  tdm: {
    id: 'tdm', kind: 'tdm', name: '팀 데스매치', en: 'TEAM DEATHMATCH', maxPlayers: 48, teams: 2, scoreLimit: 200, group: 'small',
    desc: '도시 구역 보병전. 먼저 200킬을 달성하는 팀이 승리.',
    vehicles: false, respawn: true, timeLimit: 15 * 60, area: 240,
  },
  domination: {
    id: 'domination', kind: 'dom', name: '도미네이션', en: 'DOMINATION', maxPlayers: 48, teams: 2, tickets: 400, group: 'small',
    desc: '좁은 구역의 3개 거점을 두고 벌이는 빠른 보병전.',
    vehicles: false, respawn: true, timeLimit: 15 * 60, area: 220,
  },
  hardpoint: {
    id: 'hardpoint', kind: 'hill', name: '하드포인트', en: 'HARDPOINT', maxPlayers: 48, teams: 2, tickets: 300, group: 'small',
    desc: '75초마다 위치가 바뀌는 단 하나의 거점. 점령하고 있는 동안 상대 점수가 줄어듭니다.',
    vehicles: false, respawn: true, timeLimit: 15 * 60, area: 270, bleed: 1.4, noDeathTickets: true, hillSeconds: 75,
  },
  ffa: {
    id: 'ffa', kind: 'ffa', name: '개인전', en: 'FREE FOR ALL', maxPlayers: 32, teams: 0, scoreLimit: 30, group: 'small',
    desc: '모두가 적. 30킬을 먼저 달성하세요.',
    vehicles: false, respawn: true, timeLimit: 12 * 60, area: 200,
  },
  gunmaster: {
    id: 'gunmaster', kind: 'ffa', name: '건마스터', en: 'GUN MASTER', maxPlayers: 24, teams: 0, scoreLimit: GUN_LADDER.length, ladder: GUN_LADDER, group: 'special',
    desc: '킬할 때마다 무기가 바뀝니다. 마지막 권총까지 올라가 킬하면 승리.',
    vehicles: false, respawn: true, timeLimit: 15 * 60, area: 170,
  },
  cqb: {
    id: 'cqb', kind: 'tdm', name: '근접전투', en: 'CLOSE QUARTERS', maxPlayers: 32, teams: 2, scoreLimit: 100, group: 'special',
    desc: '좁은 구역의 시가전. 기관단총·산탄총·권총만 사용할 수 있습니다.',
    vehicles: false, respawn: true, timeLimit: 12 * 60, area: 130, cats: ['smg', 'shotgun'], noGadget: true,
  },
  sniper: {
    id: 'sniper', kind: 'tdm', name: '저격전', en: 'SNIPER SHOWDOWN', maxPlayers: 24, teams: 2, scoreLimit: 50, group: 'special',
    desc: '넓은 구역에서 저격소총만 쓰는 장거리 전투. 소음기와 위치 선정이 승부를 가릅니다.',
    vehicles: false, respawn: true, timeLimit: 12 * 60, area: 290, cats: ['sniper'], noGadget: true,
  },
  hardcore: {
    id: 'hardcore', kind: 'tdm', name: '하드코어', en: 'HARDCORE', maxPlayers: 48, teams: 2, scoreLimit: 150, group: 'special',
    desc: '피해량 2.2배, 체력 자동 회복 없음. 한 번의 실수가 곧 죽음인 전술전.',
    vehicles: false, respawn: true, timeLimit: 15 * 60, area: 240, dmgMult: 2.2, noRegen: true,
  },
};

export const LOBBY_WAIT_SECONDS = 120;
export const MIN_HUMANS_FOR_TIMER = 2;
