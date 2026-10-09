// Game modes. maxPlayers = humans + bots. When fewer humans are found, the
// remaining slots are filled with AI soldiers.
export const MODES = {
  conquest: {
    id: 'conquest', name: '컨퀘스트', en: 'CONQUEST', maxPlayers: 100, teams: 2, tickets: 1000,
    desc: '100인 전면전. 거점을 점령해 상대 티켓을 소진시키세요. 전차·헬기·전투기 운용.',
    vehicles: true, respawn: true, timeLimit: 40 * 60,
  },
  breakthrough: {
    id: 'breakthrough', name: '브레이크스루', en: 'BREAKTHROUGH', maxPlayers: 100, teams: 2, tickets: 400,
    desc: '공격팀은 구역을 차례로 돌파하고, 방어팀은 전선을 지켜내세요.',
    vehicles: true, respawn: true, timeLimit: 40 * 60,
  },
  redsec: {
    id: 'redsec', name: 'REDSEC 배틀로얄', en: 'REDSEC', maxPlayers: 100, teams: 25, squadSize: 4,
    desc: '4인 분대 25팀. 공중 강하, 보급 상자, 줄어드는 화염 지대. 최후의 분대가 승리.',
    vehicles: true, respawn: false, timeLimit: 25 * 60, br: true,
  },
  tdm: {
    id: 'tdm', name: '팀 데스매치', en: 'TEAM DEATHMATCH', maxPlayers: 48, teams: 2, scoreLimit: 200,
    desc: '도시 구역 보병전. 먼저 200킬을 달성하는 팀이 승리.',
    vehicles: false, respawn: true, timeLimit: 15 * 60, area: 240,
  },
  domination: {
    id: 'domination', name: '도미네이션', en: 'DOMINATION', maxPlayers: 48, teams: 2, tickets: 400,
    desc: '좁은 구역의 3개 거점을 두고 벌이는 빠른 보병전.',
    vehicles: false, respawn: true, timeLimit: 15 * 60, area: 220,
  },
  ffa: {
    id: 'ffa', name: '개인전', en: 'FREE FOR ALL', maxPlayers: 32, teams: 0, scoreLimit: 30,
    desc: '모두가 적. 30킬을 먼저 달성하세요.',
    vehicles: false, respawn: true, timeLimit: 12 * 60, area: 200,
  },
};

export const LOBBY_WAIT_SECONDS = 120;
export const MIN_HUMANS_FOR_TIMER = 2;
