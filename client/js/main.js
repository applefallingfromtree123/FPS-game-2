// Menu, loadout editor, matchmaking lobby, deploy screen and game lifecycle.
import { Net } from './net.js';
import { Audio } from './audio.js';
import { Game } from './game.js';
import { MODES } from '/shared/modes.js';
import { MAPS, BIOMES } from '/shared/maps.js';
import { WEAPONS, CATEGORIES, CLASSES, SIGHTS, MUZZLES, weaponsFor, defaultLoadout, sanitizeLoadout } from '/shared/weapons.js';
import { buildMapImage, escapeHtml } from './hud.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('wf_' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('wf_' + k, JSON.stringify(v)); } catch {} },
};

const settings = Object.assign({ quality: 1, sens: 1, fov: 70, vol: 0.7, invert: false }, store.get('settings', {}));
let loadout = sanitizeLoadout(store.get('loadout', defaultLoadout('assault')));
let selMode = store.get('mode', 'conquest');
const net = new Net();
const audio = new Audio();
audio.setVolume(settings.vol);
let game = null;
let pendingMatch = null;

function show(id) { for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.id === id); }

// ---------------------------------------------------------------- menu
function buildMenu() {
  $('name').value = store.get('name', 'Soldier' + Math.floor(Math.random() * 900 + 100));
  $('name').addEventListener('change', () => { store.set('name', $('name').value); net.send({ t: 'hello', name: $('name').value }); });
  for (const b of document.querySelectorAll('.menu-nav button')) {
    b.addEventListener('click', () => {
      for (const x of document.querySelectorAll('.menu-nav button')) x.classList.toggle('active', x === b);
      for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab);
      if (b.dataset.tab === 'loadout') renderLoadout($('loadoutEditor'));
    });
  }
  const modes = $('modes');
  modes.innerHTML = Object.values(MODES).map((m) => `<div class="mode-card ${m.br ? 'redsec' : ''}" data-mode="${m.id}"><div class="cap">${m.maxPlayers}명</div><div class="en">${m.en}</div><div class="ko">${m.name}</div><div class="desc">${m.desc}</div></div>`).join('');
  const sel = () => { for (const c of modes.children) c.classList.toggle('sel', c.dataset.mode === selMode); };
  for (const c of modes.children) c.addEventListener('click', () => { selMode = c.dataset.mode; store.set('mode', selMode); sel(); });
  sel();
  $('mapSel').innerHTML = '<option value="-1">무작위 전장</option>' + MAPS.map((m) => `<option value="${m.id}">${m.name} — ${biomeName(m.biome)}, ${m.size}m</option>`).join('');
  $('btnFind').onclick = () => queue(false);
  $('btnPractice').onclick = () => queue(true);
  $('btnStartNow').onclick = () => net.send({ t: 'startNow' });
  $('btnCancel').onclick = () => { net.send({ t: 'leave' }); show('menu'); };
  // settings
  $('setQuality').value = settings.quality;
  $('setSens').value = settings.sens; $('setFov').value = settings.fov; $('setVol').value = settings.vol; $('setInvert').checked = settings.invert;
  const upd = () => {
    settings.quality = +$('setQuality').value; settings.sens = +$('setSens').value; settings.fov = +$('setFov').value; settings.vol = +$('setVol').value; settings.invert = $('setInvert').checked;
    $('setSensV').textContent = settings.sens.toFixed(2); $('setFovV').textContent = settings.fov; $('setVolV').textContent = Math.round(settings.vol * 100) + '%';
    audio.setVolume(settings.vol); store.set('settings', settings);
  };
  for (const id of ['setQuality', 'setSens', 'setFov', 'setVol', 'setInvert']) $(id).addEventListener('input', upd);
  upd();
  // pause menu
  $('btnResume').onclick = () => { $('pause').style.display = 'none'; game && game.lock(); };
  $('btnRedeploy').onclick = () => { net.send({ t: 'suicide' }); $('pause').style.display = 'none'; };
  $('btnLeave').onclick = () => exitMatch(true);
  $('btnSettings2').onclick = () => { exitPausePanelToSettings(); };
}

function exitPausePanelToSettings() {
  const s = prompt('마우스 감도 (0.2 ~ 3.0)', settings.sens);
  if (s && !isNaN(+s)) { settings.sens = Math.max(0.2, Math.min(3, +s)); store.set('settings', settings); $('setSens').value = settings.sens; }
}

function biomeName(b) { return { forest: '숲', autumn: '가을 숲', desert: '사막', snow: '설원', jungle: '정글', plains: '평원', mountains: '산악', urban: '도시', wasteland: '황무지', savanna: '사바나' }[b] || b; }

function queue(practice) {
  audio.init();
  store.set('name', $('name').value);
  net.send({ t: 'hello', name: $('name').value });
  net.send({ t: 'queue', mode: selMode, practice, map: +$('mapSel').value, l: loadout });
  if (!practice) {
    show('lobby');
    $('lobbyMode').textContent = MODES[selMode].en;
    $('lobbyMap').textContent = '';
    $('lobbyTimer').textContent = '매칭 중…';
  } else showLoading('연습전 준비 중');
}

// ---------------------------------------------------------------- loadout editor
function statBar(label, v, max, txt) { return `<div class="stat"><span>${label}</span><div class="b"><i style="width:${Math.max(3, Math.min(100, (v / max) * 100))}%"></i></div><em>${txt ?? Math.round(v)}</em></div>`; }

function renderLoadout(el, compact = false) {
  let tab = el.dataset.tab || 'primary';
  const draw = () => {
    el.dataset.tab = tab;
    const slotIds = { primary: loadout.primary, secondary: loadout.secondary, gadget: loadout.gadget };
    const list = tab === 'gadget' ? weaponsFor(loadout.cls, 'gadget') : weaponsFor(loadout.cls, tab);
    const byCat = {};
    for (const w of list) (byCat[w.cat] = byCat[w.cat] || []).push(w);
    const selW = WEAPONS[slotIds[tab]] || WEAPONS[loadout.primary];
    const gadgetNote = loadout.cls === 'support' ? '지원병 가젯: 보급 상자 (아군 체력/탄약 보급)' : loadout.cls === 'recon' ? '정찰병 가젯: C4 폭약 ×3 (좌클릭 투척 / 우클릭 기폭)' : '';
    el.innerHTML = `
      <div class="lo-classes">${Object.entries(CLASSES).map(([k, c]) => `<div class="lo-class ${k === loadout.cls ? 'sel' : ''}" data-cls="${k}"><b>${c.label}</b><span>${c.desc}</span></div>`).join('')}</div>
      <div class="lo-grid">
        <div>
          <div class="lo-tabs">${['primary', 'secondary', 'gadget'].map((t) => `<button class="${t === tab ? 'sel' : ''}" data-tab="${t}">${{ primary: '주무기', secondary: '보조무기', gadget: '가젯' }[t]}</button>`).join('')}</div>
          <div class="lo-list">${list.length ? Object.entries(byCat).map(([cat, ws]) => `<div class="lo-cat">${CATEGORIES[cat].label} (${ws.length})</div>${ws.map((w) => `<div class="lo-item ${w.id === slotIds[tab] ? 'sel' : ''}" data-id="${w.id}"><span>${w.name}</span><small>${w.cat === 'launcher' ? '' : w.rpm + ' RPM · ' + w.mag + '발'}</small></div>`).join('')}`).join('') : `<div class="lo-item">${gadgetNote}</div>`}</div>
        </div>
        <div class="lo-stats">
          <div class="wn">${selW.name}</div><div class="wc">${CATEGORIES[selW.cat].label}</div>
          ${statBar('피해량', selW.dmg[0] * selW.pellets, 130, Math.round(selW.dmg[0]) + (selW.pellets > 1 ? '×' + selW.pellets : ''))}
          ${statBar('연사력', selW.rpm, 1200, selW.rpm)}
          ${statBar('사거리', selW.range[1], 400, selW.range[1] + 'm')}
          ${statBar('정확도', 6 - selW.hip, 6, (6 - selW.hip).toFixed(1))}
          ${statBar('반동제어', 4 - selW.recoilV, 4, (4 - selW.recoilV).toFixed(1))}
          ${statBar('장탄수', selW.mag, 200, selW.mag)}
          ${statBar('조준속도', 0.5 - selW.adsTime, 0.4, Math.round(selW.adsTime * 1000) + 'ms')}
          <div class="lo-att">
            <label>조준경 <select id="loSight">${Object.entries(SIGHTS).map(([k, s]) => `<option value="${k}" ${k === loadout.sight ? 'selected' : ''}>${s.label}</option>`).join('')}</select></label>
            <label>총구 <select id="loMuzzle">${Object.entries(MUZZLES).map(([k, s]) => `<option value="${k}" ${k === loadout.muzzle ? 'selected' : ''}>${s.label}</option>`).join('')}</select></label>
          </div>
          <div class="lo-summary">주무기: <b>${WEAPONS[loadout.primary].name}</b><br>보조무기: <b>${WEAPONS[loadout.secondary].name}</b><br>가젯: <b>${loadout.gadget >= 0 ? WEAPONS[loadout.gadget].name : loadout.cls === 'support' ? '보급 상자' : loadout.cls === 'recon' ? 'C4 폭약' : '-'}</b> · 수류탄 ×2</div>
        </div>
      </div>`;
    for (const c of el.querySelectorAll('.lo-class')) c.onclick = () => { const cls = c.dataset.cls; loadout = sanitizeLoadout({ ...defaultLoadout(cls), secondary: loadout.secondary }); save(); draw(); };
    for (const b of el.querySelectorAll('.lo-tabs button')) b.onclick = () => { tab = b.dataset.tab; draw(); };
    for (const it of el.querySelectorAll('.lo-item[data-id]')) it.onclick = () => {
      const w = WEAPONS[+it.dataset.id];
      if (tab === 'primary') { loadout.primary = w.id; loadout.sight = w.sight; loadout.muzzle = w.muzzleDefault; }
      else if (tab === 'secondary') loadout.secondary = w.id; else loadout.gadget = w.id;
      save(); draw();
    };
    const s = el.querySelector('#loSight'), m = el.querySelector('#loMuzzle');
    if (s) s.onchange = () => { loadout.sight = s.value; save(); };
    if (m) m.onchange = () => { loadout.muzzle = m.value; save(); };
  };
  const save = () => { loadout = sanitizeLoadout(loadout); store.set('loadout', loadout); };
  void compact;
  draw();
}

// ---------------------------------------------------------------- lobby & match
net.on('welcome', (m) => { $('online').textContent = `● 서버 온라인 · 접속자 ${m.online}명`; net.send({ t: 'hello', name: $('name').value }); });
net.on('close', () => { $('online').textContent = '서버 연결 끊김 — 재연결 중…'; });
net.on('lobby', (m) => {
  if (game) return;
  show('lobby');
  $('lobbyMode').textContent = MODES[m.mode].en + ' · ' + MODES[m.mode].name;
  $('lobbyMap').textContent = MAPS[m.map].name;
  $('lobbyHumans').textContent = m.humans; $('lobbyMax').textContent = m.max;
  $('lobbyNames').textContent = m.names.join(' · ');
  if (m.countdown !== null) {
    $('lobbyTimer').textContent = `${Math.floor(m.countdown / 60)}:${String(m.countdown % 60).padStart(2, '0')}`;
    $('btnStartNow').style.display = 'none';
  } else {
    $('lobbyTimer').textContent = '추가 플레이어 대기 중…';
    $('btnStartNow').style.display = m.humans === 1 ? '' : 'none';
  }
});

const TIPS = ['Q 키로 적을 스팟하면 아군 미니맵에 표시됩니다.', '체력은 5초간 피해를 입지 않으면 자동 회복됩니다.', '공병의 RPG로 전차를 파괴하세요. 스팅어는 헬기와 전투기를 추적합니다.',
  '앉거나 엎드리면 반동과 탄 퍼짐이 줄어듭니다.', '분대원 위치로 재배치할 수 있습니다.', 'REDSEC에서는 보급 상자를 열어 무기를 획득하세요.', '총소리를 내면 적 미니맵에 잠시 노출됩니다. 소음기를 사용해 보세요.'];

function showLoading(title, sub = '') {
  show('loading');
  $('loadingTitle').textContent = title; $('loadingSub').textContent = sub; $('loadingBar').style.width = '0%';
  $('loadingTip').textContent = 'TIP · ' + TIPS[Math.floor(Math.random() * TIPS.length)];
}

net.on('match', async (m) => {
  if (game) { game.stop(); game = null; }
  pendingMatch = m;
  const map = MAPS[m.map];
  showLoading(map.name, `${MODES[m.mode].name} · ${biomeName(map.biome)} · ${map.size}×${map.size}m`);
  await new Promise((r) => setTimeout(r, 30));
  const g = new Game({ net, audio, settings, match: m, ui });
  game = g;
  window.__wf = g;
  try {
    await g.load((p, msg) => { $('loadingBar').style.width = Math.round(p * 100) + '%'; if (msg) $('loadingSub').textContent = msg; });
  } catch (e) {
    console.error(e);
    $('loadingSub').textContent = '로딩 실패: ' + e.message;
    return;
  }
  if (game !== g) return;
  show('none');
  $('hud').classList.add('active');
  g.start();
  for (const q of earlyMsgs) route(q);
  earlyMsgs.length = 0;
  if (!m.br) ui.showDeploy(g);
  else g.hud.notice('강하 준비', 'W/A/S/D로 활강 · Space 낙하산', '#ffd27a');
});

const earlyMsgs = [];
function route(msg) {
  if (!game || !game.running) { earlyMsgs.push(msg); return; }
  if (msg.t === 'ev') game.onEvents(msg);
  else if (msg.t === 'state') game.onState(msg);
  else if (msg.t === 'board') game.onBoard(msg.b);
  else if (msg.t === 'end') game.showEnd(msg);
  else if (msg.t === 'po') game.ping = Math.round(performance.now() - msg.c);
}
for (const t of ['ev', 'state', 'board', 'end', 'po']) net.on(t, route);
net.onBinary = (buf) => { if (game && game.running) game.onSnapshot(buf); };
let pingSent = 0;
setInterval(() => { if (game && game.ping !== undefined && performance.now() - pingSent > 5000) { pingSent = performance.now(); net.send({ t: 'ping', v: game.ping }); } }, 1000);
net.on('closed', () => exitMatch(false));

function exitMatch(sendLeave = true) {
  if (sendLeave) net.send({ t: 'leave' });
  if (game) { game.stop(); game = null; }
  $('hud').classList.remove('active');
  for (const id of ['deploy', 'endScreen', 'pause', 'scoreboard', 'bigmap', 'deathCam']) $(id).style.display = '';
  $('deploy').classList.remove('active');
  $('killfeed').innerHTML = '';
  const ctx = $('overlay').getContext('2d'); ctx.clearRect(0, 0, 99999, 99999);
  show('menu');
}

// ---------------------------------------------------------------- deploy
let spawnChoice = 'hq';
const ui = {
  showDeploy(g) {
    if (document.pointerLockElement) document.exitPointerLock();
    g.engaged = false;
    $('deploy').style.display = 'flex';
    renderLoadout($('deployLoadout'), true);
    const draw = () => {
      if ($('deploy').style.display !== 'flex' || !game) return;
      const opts = g.spawnOptions();
      if (!opts.find((o) => o.id === spawnChoice)) spawnChoice = opts[0] ? opts[0].id : 'hq';
      $('spawnList').innerHTML = opts.map((o) => `<button data-s="${o.id}" class="${o.id === spawnChoice ? 'sel' : ''}">${escapeHtml(o.label)}</button>`).join('');
      for (const b of $('spawnList').children) b.onclick = () => { spawnChoice = b.dataset.s; draw(); };
      const c = $('deployMap'), ctx = c.getContext('2d');
      if (!g._deployImg) g._deployImg = buildMapImage(g.world, 512);
      ctx.drawImage(g._deployImg, 0, 0, 512, 512);
      const sc = 512 / g.world.size, P = (x, z) => [(x + g.world.half) * sc, (z + g.world.half) * sc];
      if (g.state && g.state.obj) for (const [id, owner, , , x, z] of g.state.obj) {
        const [px, pz] = P(x, z); ctx.fillStyle = owner < 0 ? '#ddd' : owner === g.me.team ? '#42b8ff' : '#ff4b3a';
        ctx.fillRect(px - 9, pz - 9, 18, 18); ctx.fillStyle = '#000'; ctx.font = '700 14px Rajdhani'; ctx.textAlign = 'center'; ctx.fillText(id, px, pz + 5);
      }
      if (g.state && g.state.area) { const [x, z] = P(g.state.area[0], g.state.area[1]); ctx.strokeStyle = '#ff5a3a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, z, g.state.area[2] * sc, 0, 7); ctx.stroke(); }
      for (const o of opts) if (o.x !== undefined) { const [x, z] = P(o.x, o.z); ctx.strokeStyle = o.id === spawnChoice ? '#ffd84a' : '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, z, o.id === spawnChoice ? 10 : 6, 0, 7); ctx.stroke(); }
      const wait = Math.max(0, Math.ceil((g.deathAt + 5000 - performance.now()) / 1000));
      $('deployTimer').textContent = g.deathAt && wait > 0 ? `${wait}초 후 배치 가능` : '';
      setTimeout(draw, 500);
    };
    draw();
  },
  hideDeploy() { $('deploy').style.display = 'none'; },
  exitMatch: () => exitMatch(true),
};
$('btnDeploy').onclick = () => {
  if (!game) return;
  audio.init();
  net.send({ t: 'deploy', s: spawnChoice, l: loadout });
  game.lock();
};

document.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && game && !game.me.alive && !game.ended && !game.mode.respawn) exitMatch(true);
});

buildMenu();
net.connect();
show('menu');
