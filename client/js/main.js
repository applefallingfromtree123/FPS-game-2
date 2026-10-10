// Menu, loadout editor, matchmaking lobby, deploy screen and game lifecycle.
import { Net } from './net.js';
import { Audio } from './audio.js';
import { Game, reportError } from './game.js';
import { MODES } from '/shared/modes.js';
import { MAPS, BIOMES } from '/shared/maps.js';
import { WEAPONS, CATEGORIES, CLASSES, SIGHTS, MUZZLES, weaponsFor, defaultLoadout, sanitizeLoadout } from '/shared/weapons.js';
import { buildMapImage, escapeHtml } from './hud.js';
import { initTouch, isTouchDevice, applyTouchMode } from './touch.js';
import { progress } from '/shared/ranks.js';
import { playIntro } from './intro.js';
import { CharPreview } from './preview.js';
import { LOOK_OPTS, LOOK_KEYS, sanitizeLook, randomLook } from '/shared/look.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('wf_' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('wf_' + k, JSON.stringify(v)); } catch {} },
};

const settings = Object.assign({ touch: 'auto', quality: isTouchDevice() ? 0 : 1, sens: 1, fov: 70, vol: 0.7, invert: false }, store.get('settings', {}));
let loadout = sanitizeLoadout(store.get('loadout', defaultLoadout('assault')));
let selMode = store.get('mode', 'conquest');
const net = new Net();
const audio = new Audio();
audio.setVolume(settings.vol);
let game = null;
let pendingMatch = null;
for (const ev of ['touchend', 'pointerdown', 'keydown', 'click']) addEventListener(ev, () => { try { audio.unlock(); } catch {} }, { passive: true });

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
      if (b.dataset.tab === 'char') openChar(); else closeChar();
      if (b.dataset.tab === 'rank') loadRank('xp');
    });
  }
  $('authTabLogin').onclick = () => openAuth('login'); $('authTabReg').onclick = () => openAuth('reg');
  $('authSubmit').onclick = submitAuth; $('authCancel').onclick = () => $('authModal').classList.remove('open');
  for (const id of ['authName', 'authPass']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAuth(); });
  for (const b of $('rankTabs').children) b.onclick = () => loadRank(b.dataset.by);
  const modes = $('modes');
  const GROUPS = [['large', '대규모 전투'], ['small', '소규모 보병전'], ['special', '특수 모드']];
  modes.innerHTML = GROUPS.map(([g, label]) => `<div class="grp">${label}</div>` + Object.values(MODES).filter((m) => m.group === g).map((m) => `<div class="mode-card ${m.br ? 'redsec' : ''}" data-mode="${m.id}"><div class="cap">${m.maxPlayers}명</div><div class="en">${m.en}</div><div class="ko">${m.name}</div><div class="desc">${m.desc}</div></div>`).join('')).join('');
  const sel = () => { for (const c of modes.querySelectorAll('.mode-card')) c.classList.toggle('sel', c.dataset.mode === selMode); const m = MODES[selMode]; if (m && $('selModeLabel')) $('selModeLabel').innerHTML = `선택한 모드 <b>${m.en}</b> · ${m.name} (${m.maxPlayers}명)`; };
  for (const c of modes.querySelectorAll('.mode-card')) c.addEventListener('click', () => { selMode = c.dataset.mode; store.set('mode', selMode); sel(); });
  sel();
  $('teamSel').value = String(store.get('team', '-1')); if ($('teamSel').value === '') $('teamSel').value = '-1';
  $('mapSel').innerHTML = '<option value="-1">무작위 전장</option>' + MAPS.map((m) => `<option value="${m.id}">${m.name} — ${biomeName(m.biome)}, ${m.size}m</option>`).join('');
  $('btnFind').onclick = () => queue(false);
  $('btnPractice').onclick = () => queue(true);
  $('btnStartNow').onclick = () => net.send({ t: 'startNow' });
  $('btnCancel').onclick = () => { net.send({ t: 'leave' }); stopLobbyPreview(); show('menu'); };
  // settings
  $('setQuality').value = settings.quality; $('setTouch').value = settings.touch;
  $('setSens').value = settings.sens; $('setFov').value = settings.fov; $('setVol').value = settings.vol; $('setInvert').checked = settings.invert;
  const upd = () => {
    settings.quality = +$('setQuality').value; settings.touch = $('setTouch').value; applyTouchMode(settings.touch); settings.sens = +$('setSens').value; settings.fov = +$('setFov').value; settings.vol = +$('setVol').value; settings.invert = $('setInvert').checked;
    $('setSensV').textContent = settings.sens.toFixed(2); $('setFovV').textContent = settings.fov; $('setVolV').textContent = Math.round(settings.vol * 100) + '%';
    audio.setVolume(settings.vol); store.set('settings', settings);
  };
  for (const id of ['setTouch', 'setQuality', 'setSens', 'setFov', 'setVol', 'setInvert']) $(id).addEventListener('input', upd);
  upd();
  // pause menu
  $('btnResume').onclick = () => { $('pause').style.display = 'none'; game && game.lock(); };
  $('btnRedeploy').onclick = () => { net.send({ t: 'suicide' }); $('pause').style.display = 'none'; };
  $('btnTouchToggle').onclick = () => { settings.touch = document.body.classList.contains('touch') ? 'off' : 'on'; $('setTouch').value = settings.touch; applyTouchMode(settings.touch); store.set('settings', settings); };
  $('btnLeave').onclick = () => exitMatch(true);
  $('btnSettings2').onclick = () => { exitPausePanelToSettings(); };
}

function exitPausePanelToSettings() {
  const s = prompt('마우스 감도 (0.2 ~ 3.0)', settings.sens);
  if (s && !isNaN(+s)) { settings.sens = Math.max(0.2, Math.min(3, +s)); store.set('settings', settings); $('setSens').value = settings.sens; }
}

function biomeName(b) { return { forest: '숲', autumn: '가을 숲', desert: '사막', snow: '설원', jungle: '정글', plains: '평원', mountains: '산악', urban: '도시', wasteland: '황무지', savanna: '사바나' }[b] || b; }

function queue(practice) {
  // UI feedback first, so the press is always visible even if something below fails
  const mode = MODES[selMode] || MODES.conquest;
  selMode = mode.id;
  pendingMatch = null; lobbySeen = false;
  if (!practice) {
    show('lobby');
    $('lobbyMode').textContent = mode.en + ' · ' + mode.name;
    $('lobbyMap').textContent = '';
    $('lobbyTimer').textContent = '매칭 중…';
    startLobbyPreview();
  } else showLoading('연습전 준비 중', mode.name);
  try { audio.init(); } catch (e) { console.warn('audio init failed', e); }
  const name = $('name').value;
  store.set('name', name);
  net.send({ t: 'hello', name });
  store.set('team', $('teamSel').value);
  net.send({ t: 'queue', mode: selMode, practice, map: +$('mapSel').value, team: +$('teamSel').value, l: loadout });
  // if the server never answers (sleeping free host, lost connection) tell the player instead of hanging
  clearTimeout(queue.watch);
  queue.watch = setTimeout(() => {
    if (!game && !pendingMatch && (document.getElementById('lobby').classList.contains('active') || document.getElementById('loading').classList.contains('active')) && !lobbySeen) {
      const msg = '서버 응답이 없습니다. 무료 서버는 잠들어 있다가 깨어나는 데 1분 가까이 걸릴 수 있습니다. 잠시 기다리거나 취소 후 다시 시도하세요.';
      if (document.getElementById('lobby').classList.contains('active')) $('lobbyTimer').textContent = '서버 연결 중…';
      else $('loadingSub').textContent = msg;
      $('lobbyNames').textContent = msg;
    }
  }, 8000);
}
let lobbySeen = false;

// ---------------------------------------------------------------- character customization
let charPrev = null, lobbyPrev = null;
function previewWeapon() { return loadout.primary; }
function openChar() {
  try {
    if (!charPrev) charPrev = new CharPreview($('charCanvas'));
    charPrev.start(); drawChar();
  } catch (e) { console.warn('char preview failed', e); }
}
function startLobbyPreview() {
  try {
    if (!lobbyPrev) lobbyPrev = new CharPreview($('lobbyCanvas'), { spin: false });
    lobbyPrev.auto = false; lobbyPrev.yaw = Math.PI - 0.5;
    lobbyPrev.set(loadout.look, previewWeapon()); lobbyPrev.start();
  } catch (e) { console.warn('lobby preview failed', e); }
}
function stopLobbyPreview() { if (lobbyPrev) lobbyPrev.stop(); }
function closeChar() { if (charPrev) charPrev.stop(); }
function drawChar() {
  const el = $('charOpts'); loadout.look = sanitizeLook(loadout.look);
  const row = (k, i) => {
    const o = LOOK_OPTS[k];
    const chips = Array.from({ length: o.count }, (_, v) => {
      const sel = loadout.look[i] === v ? ' sel' : '';
      if (k === 'skin' || (k === 'gear')) return `<div class="chip sw${sel}" data-k="${i}" data-v="${v}" title="${o.names ? o.names[v] : ''}" style="background:${o.values[v]}"></div>`;
      return `<div class="chip${sel}" data-k="${i}" data-v="${v}">${o.names[v]}</div>`;
    }).join('');
    return `<div class="char-row"><b>${o.label}</b><div class="chips">${chips}</div></div>`;
  };
  el.innerHTML = LOOK_KEYS.map(row).join('') + '<div class="char-btns"><button id="charRand">무작위</button><button id="charReset">기본값</button></div><p class="hint">변경 사항은 자동 저장되며 다음 배치부터 전장에 적용됩니다. 캐릭터는 드래그해서 돌려볼 수 있어요.</p>';
  for (const c of el.querySelectorAll('.chip')) c.onclick = () => { loadout.look[+c.dataset.k] = +c.dataset.v; saveLook(); };
  $('charRand').onclick = () => { loadout.look = randomLook(Math.random); saveLook(); };
  $('charReset').onclick = () => { loadout.look = sanitizeLook(null); saveLook(); };
  if (charPrev) charPrev.set(loadout.look, previewWeapon());
}
function saveLook() { loadout = sanitizeLoadout(loadout); store.set('loadout', loadout); drawChar(); }

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


// ---------------------------------------------------------------- account & ranking
const account = { token: store.get('token', null), profile: null, durable: true, lostName: store.get('lastName', null) };
let authMode = 'login';
const api = async (path, opts = {}) => {
  let r;
  try { r = await fetch(path, { ...opts, signal: AbortSignal.timeout(25000), headers: { 'Content-Type': 'application/json', ...(account.token ? { Authorization: 'Bearer ' + account.token } : {}), ...(opts.headers || {}) } }); }
  catch { throw new Error('서버에 연결하지 못했습니다. 무료 서버가 깨어나는 중일 수 있으니 잠시 후 다시 시도하세요.'); }
  let j = {}; try { j = await r.json(); } catch {}
  if (!r.ok) throw new Error(j.error || '요청에 실패했습니다.');
  return j;
};
function renderAccount() {
  const el = $('account');
  const p = account.profile;
  $('guestName').style.display = p ? 'none' : '';
  if (!p) {
    el.innerHTML = `<div class="acc-card"><div class="acc-name">게스트</div><div class="acc-rank">로그인하면 기록과 랭킹이 저장됩니다</div>${account.lostName ? `<div class="acc-warn">서버가 초기화되어 "${escapeHtml(account.lostName)}" 계정이 사라졌습니다. 같은 이름으로 다시 가입해 주세요.</div>` : ''}${account.durable ? '' : '<div class="acc-warn">이 서버는 계정을 영구 저장하지 못합니다(재시작 시 초기화).</div>'}<div class="acc-btns"><button id="accLogin" class="primary">로그인 / 가입</button></div></div>`;
    $('accLogin').onclick = () => openAuth('login');
    return;
  }
  const pr = progress(p.xp);
  el.innerHTML = `<div class="acc-card"><div class="acc-name">${escapeHtml(p.name)}</div><div class="acc-rank">Lv.${pr.level} · ${pr.ko} <span style="opacity:.6">${pr.en}</span></div>
    <div class="acc-bar"><i style="width:${Math.min(100, (pr.into / pr.need) * 100)}%"></i></div>
    <div class="acc-sub"><span>${p.xp.toLocaleString()} XP</span><span>K/D ${p.kd} · ${p.wins}승</span></div>
    ${account.durable ? '' : '<div class="acc-warn">임시 저장소: 서버가 재시작되면 계정이 초기화됩니다.</div>'}<div class="acc-btns"><button id="accRank">내 랭킹</button><button id="accOut">로그아웃</button></div></div>`;
  $('accRank').onclick = () => { for (const b of document.querySelectorAll('.menu-nav button')) if (b.dataset.tab === 'rank') b.click(); };
  $('accOut').onclick = async () => { try { await api('/api/logout', { method: 'POST' }); } catch {} account.token = null; account.profile = null; store.set('token', null); net.send({ t: 'auth', token: null }); renderAccount(); };
}
function openAuth(mode) {
  authMode = mode; $('authErr').textContent = '';
  $('authTabLogin').classList.toggle('sel', mode === 'login'); $('authTabReg').classList.toggle('sel', mode === 'reg');
  $('authSubmit').textContent = mode === 'login' ? '로그인' : '계정 만들기';
  $('authPass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('authModal').classList.add('open'); setTimeout(() => $('authName').focus(), 50);
}
async function submitAuth() {
  $('authErr').textContent = '';
  $('authSubmit').disabled = true; $('authErr').textContent = '처리 중…';
  try {
    const j = await api(authMode === 'login' ? '/api/login' : '/api/register', { method: 'POST', body: JSON.stringify({ name: $('authName').value.trim(), password: $('authPass').value }) });
    account.token = j.token; account.profile = j.profile; account.lostName = null; store.set('token', j.token); store.set('lastName', j.profile.name);
    net.send({ t: 'auth', token: j.token });
    $('authModal').classList.remove('open'); $('authPass').value = ''; $('authErr').textContent = '';
    renderAccount();
  } catch (e) { $('authErr').textContent = e.message; }
  $('authSubmit').disabled = false;
}
async function loadRank(by = 'xp') {
  const box = $('rankTable');
  box.textContent = '불러오는 중…';
  for (const b of $('rankTabs').children) b.classList.toggle('sel', b.dataset.by === by);
  try {
    const j = await api('/api/leaderboard?by=' + by + '&limit=100');
    const me = account.profile && account.profile.name.toLowerCase();
    const col = { xp: ['XP', (r) => r.xp.toLocaleString()], kills: ['킬', (r) => r.kills.toLocaleString()], wins: ['승리', (r) => r.wins], kd: ['K/D', (r) => r.kd], headshots: ['헤드샷', (r) => r.headshots] }[by];
    box.innerHTML = j.rows.length ? `<table><tr><th>#</th><th>이름</th><th>레벨</th><th>${col[0]}</th><th>경기</th><th>킬</th><th>승</th></tr>${j.rows.map((r) => `<tr class="${r.name.toLowerCase() === me ? 'me' : ''} ${r.rank <= 3 ? 'top' + r.rank : ''}"><td>${r.rank}</td><td>${escapeHtml(r.name)}<span class="rank-badge">${r.ko}</span></td><td>${r.level}</td><td>${col[1](r)}</td><td>${r.matches}</td><td>${r.kills}</td><td>${r.wins}</td></tr>`).join('')}</table>`
      : '<p class="hint">아직 기록이 없습니다. 로그인하고 매치를 플레이해 첫 랭커가 되어 보세요!</p>';
    $('rankNote').textContent = '로그인해야 기록이 쌓입니다. K/D 랭킹은 3경기·20킬 이상부터 집계됩니다.' + (j.backend === 'file' ? ' (서버가 파일 저장소를 사용 중입니다. 임시 디스크 서버에서는 재배포 시 기록이 지워질 수 있습니다.)' : '');
    if (j.me && j.me.rank) box.insertAdjacentHTML('afterbegin', `<p class="hint" style="margin:0 0 8px">내 순위: <b style="color:#fff">${j.me.rank}위</b> (${escapeHtml(j.me.profile.name)})</p>`);
  } catch (e) { box.textContent = e.message; }
}

// ---------------------------------------------------------------- lobby & match
const CLIENT_BUILD = 'fix-2';
net.on('welcome', (m) => {
  lobbySeen = false;
  account.durable = m.durable !== false; renderAccount();
  if (account.token) net.send({ t: 'auth', token: account.token }); $('online').textContent = `● 서버 온라인 · 접속자 ${m.online}명 · 서버 ${m.build} · 화면 ${CLIENT_BUILD}${document.body.classList.contains('touch') ? ' · 터치 조작 켜짐' : ''}`; net.send({ t: 'hello', name: $('name').value }); });
net.on('close', () => { $('online').textContent = '서버 연결 끊김 — 재연결 중…'; });
net.on('lobby', (m) => {
  lobbySeen = true;
  if (game) return;
  show('lobby');
  startLobbyPreview();
  $('lobbyMode').textContent = MODES[m.mode].en + ' · ' + MODES[m.mode].name;
  $('lobbyMap').textContent = MAPS[m.map].name;
  $('lobbyHumans').textContent = m.humans; $('lobbyMax').textContent = m.max;
  $('lobbyNames').textContent = m.names.join(' · ');
  if (m.countdown !== null) {
    $('lobbyTimer').textContent = `${Math.floor(m.countdown / 60)}:${String(m.countdown % 60).padStart(2, '0')}`;
    $('btnStartNow').style.display = 'none';
  } else {
    $('lobbyTimer').textContent = '2:00';
    $('lobbyNames').textContent = (m.names.join(' · ') || '') + '  — 2명이 모이면 2분 카운트가 시작됩니다';
    $('btnStartNow').style.display = m.humans === 1 ? '' : 'none';
  }
});

net.on('auth', (m) => {
  if (m.ok) { account.profile = m.profile; account.lostName = null; store.set('lastName', m.profile.name); } else if (account.token) { account.token = null; account.profile = null; store.set('token', null); account.lostName = store.get('lastName', null); }
  renderAccount();
});
net.on('profile', (m) => {
  account.profile = m.profile; renderAccount();
  const box = $('endScreen');
  if (game && game.ended && box && box.style.display === 'block') {
    const pr = progress(m.profile.xp);
    const line = `<div class="gain">+${m.gained} XP · Lv.${pr.level} ${pr.ko}${m.leveledUp ? ' · 레벨 업!' : ''}</div>`;
    const btn = box.querySelector('#btnEndMenu');
    if (btn) btn.insertAdjacentHTML('beforebegin', line); else box.insertAdjacentHTML('beforeend', line);
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
  stopLobbyPreview();
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
  else g.hud.notice('강하 준비', 'W/A/S/D로 활강 · Space 낙하산', '#bfe9ff');
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
    const md = MODES[g.modeId];
    $('deployNote').textContent = md.cats ? '이 모드는 사용 가능한 무기가 제한됩니다. 허용되지 않는 주무기는 자동으로 교체됩니다.' : md.ladder ? '건마스터: 킬할 때마다 무기가 자동으로 바뀝니다.' : md.dmgMult ? '하드코어: 피해량 증가, 체력 자동 회복 없음.' : '';
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
      for (const o of opts) if (o.x !== undefined) { const [x, z] = P(o.x, o.z); ctx.strokeStyle = o.id === spawnChoice ? '#cfefff' : '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, z, o.id === spawnChoice ? 10 : 6, 0, 7); ctx.stroke(); }
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

window.addEventListener('error', (e) => reportError('error', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => reportError('promise', e.reason));
playIntro(audio);
buildMenu();
renderAccount();
if (account.token) api('/api/me').then((j) => { account.profile = j.profile; renderAccount(); }).catch(() => { account.token = null; store.set('token', null); renderAccount(); });
initTouch(() => game, () => settings.touch);
net.connect();
show('menu');
