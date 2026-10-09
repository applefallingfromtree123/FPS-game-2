// On-screen touch controls (iPad / phones): virtual joystick, look-drag, fire/ADS/jump/etc buttons.
// They drive the same `keys` / `mouse` state and key handlers as the keyboard, so every mode works.
const $ = (id) => document.getElementById(id);
export const isTouchDevice = () => (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window ||
  (window.matchMedia && (matchMedia('(any-pointer: coarse)').matches || matchMedia('(pointer: coarse)').matches));
// setting: 'auto' | 'on' | 'off'
export function applyTouchMode(mode) {
  const on = mode === 'on' || (mode !== 'off' && (isTouchDevice() || window.__sawTouch));
  document.body.classList.toggle('touch', on);
  return on;
}

const BUTTONS = [
  // id, label, css position, behaviour
  { id: 'tFire', label: '발사', cls: 'fire', kind: 'fire' },
  { id: 'tAds', label: '조준', cls: 'ads', kind: 'ads' },
  { id: 'tJump', label: '점프', cls: 'jump', kind: 'hold', key: 'Space' },
  { id: 'tCrouch', label: '앉기', cls: 'crouch', kind: 'hold', key: 'KeyC' },
  { id: 'tProne', label: '엎드려', cls: 'prone', kind: 'tap', key: 'KeyZ' },
  { id: 'tReload', label: '장전', cls: 'reload', kind: 'tap', key: 'KeyR' },
  { id: 'tGren', label: '수류탄', cls: 'gren', kind: 'tap', key: 'KeyG' },
  { id: 'tUse', label: '탑승/사용', cls: 'use', kind: 'tap', key: 'KeyE' },
  { id: 'tSwap', label: '무기', cls: 'swap', kind: 'swap' },
  { id: 'tMode', label: '모드', cls: 'mode', kind: 'tap', key: 'KeyB' },
  { id: 'tSpot', label: '스팟', cls: 'spot', kind: 'tap', key: 'KeyQ' },
  { id: 'tView', label: '시점', cls: 'view', kind: 'tap', key: 'KeyV' },
  { id: 'tScore', label: '점수', cls: 'score', kind: 'score' },
  { id: 'tMap', label: '지도', cls: 'map', kind: 'map' },
  { id: 'tPause', label: 'Ⅱ', cls: 'pause', kind: 'pause' },
];

export function initTouch(getGame, getMode = () => 'auto') {
  // Always build the controls; they only show when body.touch is set (auto-detected, first touch, or forced on).
  applyTouchMode(getMode());
  window.addEventListener('touchstart', () => { if (!window.__sawTouch) { window.__sawTouch = true; applyTouchMode(getMode()); } }, { passive: true, capture: true });
  const root = document.createElement('div');
  root.id = 'touch';
  root.innerHTML = '<div id="tStick"><i></i></div>' + BUTTONS.map((b) => `<div class="tb ${b.cls}" id="${b.id}" data-k="${b.kind}">${b.label}</div>`).join('');
  $('hud').prepend(root);
  const stick = $('tStick'), knob = stick.firstChild;
  const R = 60;
  let stickId = null, stickC = null, lookId = null, lookLast = null;
  const fireTouches = new Map(); // touch id -> last pos (fire button also steers the view)
  const held = new Map();        // touch id -> {key|kind}
  const G = () => getGame();
  const LOOK_GAIN = 1.5;

  const setKeys = (g, x, y) => {
    const k = g.keys;
    k.KeyW = y < -0.25; k.KeyS = y > 0.25; k.KeyA = x < -0.3; k.KeyD = x > 0.3;
    k.ShiftLeft = y < -0.9 && Math.hypot(x, y) > 0.95; // push the stick all the way up to sprint
  };
  const clearMove = (g) => { if (g) for (const c of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft']) g.keys[c] = false; };

  const onStart = (e) => {
    window.__tc = (window.__tc || 0) + e.changedTouches.length; // diagnostics shown in the corner
    const g = G(); if (!g || !g.running) return;
    e.preventDefault();
    for (const t of e.changedTouches) {
      const el = document.elementFromPoint(t.clientX, t.clientY);
      const btn = el && el.closest && el.closest('.tb');
      if (btn) { buttonDown(g, btn, t); continue; }
      if (t.clientX < innerWidth * 0.42 && stickId === null) {
        stickId = t.identifier; stickC = { x: t.clientX, y: t.clientY };
        stick.style.cssText = `display:block;left:${t.clientX - R}px;top:${t.clientY - R}px`; knob.style.transform = 'translate(0,0)';
      } else if (lookId === null) { lookId = t.identifier; lookLast = { x: t.clientX, y: t.clientY }; }
    }
  };
  const onMove = (e) => {
    const g = G(); if (!g || !g.running) return;
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier === stickId) {
        let dx = t.clientX - stickC.x, dy = t.clientY - stickC.y;
        const l = Math.hypot(dx, dy);
        if (l > R) { dx = (dx / l) * R; dy = (dy / l) * R; }
        knob.style.transform = `translate(${dx}px,${dy}px)`;
        setKeys(g, dx / R, dy / R);
      } else if (t.identifier === lookId) {
        g.mouse.dx += (t.clientX - lookLast.x) * LOOK_GAIN; g.mouse.dy += (t.clientY - lookLast.y) * LOOK_GAIN;
        lookLast = { x: t.clientX, y: t.clientY };
      } else if (fireTouches.has(t.identifier)) {
        const p = fireTouches.get(t.identifier);
        g.mouse.dx += (t.clientX - p.x) * LOOK_GAIN; g.mouse.dy += (t.clientY - p.y) * LOOK_GAIN;
        fireTouches.set(t.identifier, { x: t.clientX, y: t.clientY });
      }
    }
  };
  const onEnd = (e) => {
    const g = G();
    for (const t of e.changedTouches) {
      if (t.identifier === stickId) { stickId = null; stick.style.display = 'none'; clearMove(g); }
      else if (t.identifier === lookId) lookId = null;
      if (fireTouches.has(t.identifier)) { fireTouches.delete(t.identifier); if (g && fireTouches.size === 0) g.mouse.left = false; }
      if (held.has(t.identifier)) { const h = held.get(t.identifier); held.delete(t.identifier); if (g) buttonUp(g, h); }
    }
  };

  const buttonDown = (g, btn, t) => {
    const def = BUTTONS.find((b) => b.id === btn.id);
    btn.classList.add('down');
    const id = t.identifier;
    switch (def.kind) {
      case 'fire': g.mouse.left = true; g.mouse.leftPressed = true; fireTouches.set(id, { x: t.clientX, y: t.clientY }); held.set(id, { btn }); break;
      case 'ads':
        if (g.vehicle) { g.mouse.right = true; g.mouse.rightPressed = true; held.set(id, { ads: true, btn }); }
        else { g.mouse.right = !g.mouse.right; if (g.mouse.right) g.mouse.rightPressed = true; held.set(id, { btn }); btn.classList.toggle('on', g.mouse.right); }
        break;
      case 'hold': g.keys[def.key] = true; g.onKey(def.key); held.set(id, { key: def.key, btn }); break;
      case 'tap': g.onKey(def.key); held.set(id, { btn }); break;
      case 'swap': { const order = g.mode.br ? [0, 1] : [0, 1, 2]; const i = order.indexOf(g.slot); g.switchSlot(order[(i + 1) % order.length]); held.set(id, { btn }); break; }
      case 'score': { const s = $('scoreboard'); const on = s.style.display !== 'block'; s.style.display = on ? 'block' : 'none'; if (on) g.hud.renderScoreboard(); held.set(id, { btn }); break; }
      case 'map': { const m = $('bigmap'); const on = m.style.display !== 'flex'; m.style.display = on ? 'flex' : 'none'; if (on) g.hud.drawBigMap(); held.set(id, { btn }); break; }
      case 'pause': g.unlock(); held.set(id, { btn }); break;
    }
  };
  const buttonUp = (g, h) => {
    h.btn.classList.remove('down');
    if (h.key) g.keys[h.key] = false;
    if (h.ads) g.mouse.right = false;
  };

  root.addEventListener('touchstart', onStart, { passive: false });
  root.addEventListener('touchmove', onMove, { passive: false });
  root.addEventListener('touchend', onEnd, { passive: false });
  root.addEventListener('touchcancel', onEnd, { passive: false });
  // stop Safari from scrolling / zooming / selecting while playing
  for (const ev of ['gesturestart', 'gesturechange']) document.addEventListener(ev, (e) => { if (G()) e.preventDefault(); });
  document.addEventListener('touchmove', (e) => { if (G() && G().running && !e.target.closest('#pause, #endScreen, #deploy, #scoreboard')) e.preventDefault(); }, { passive: false });
}
