// HUD: objectives/tickets, compass, kill feed, minimap, world-space markers,
// crosshair & hit markers, scoreboard, full map, notices.
import { WEAPONS } from '/shared/weapons.js';
import { VEHICLES, PF } from '/shared/protocol.js';
import { MODES } from '/shared/modes.js';

const $ = (id) => document.getElementById(id);
const FRIEND = '#42b8ff', ENEMY = '#ff4b3a', SQUAD = '#5cff7a', NEUTRAL = '#e8e8e8';

export function buildMapImage(world, size = 512) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const b = world.biome;
  const sunx = -0.6, sunz = -0.5;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const wx = (x / size) * world.size - world.half, wz = (y / size) * world.size - world.half;
    const h = world.heightAt(wx, wz);
    const n = world.normalAt(wx, wz);
    const shade = 0.75 + (n[0] * sunx + n[2] * sunz) * 1.6;
    let col = b.grass;
    if (1 - n[1] > 0.25) col = b.rock;
    let r = col[0], gg = col[1], bb = col[2];
    if (h < world.waterLevel) { const d = Math.min(1, (world.waterLevel - h) / 8); r = 0.1 - d * 0.05; gg = 0.25 - d * 0.08; bb = 0.33 - d * 0.05; }
    const i = (y * size + x) * 4;
    img.data[i] = Math.min(255, r * shade * 255 * 1.1); img.data[i + 1] = Math.min(255, gg * shade * 255 * 1.1); img.data[i + 2] = Math.min(255, bb * shade * 255 * 1.1); img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const sc = size / world.size;
  g.strokeStyle = 'rgba(60,55,48,0.8)'; g.lineCap = 'round';
  for (const r of world.roads) { g.lineWidth = Math.max(1.5, r.w * sc); g.beginPath(); g.moveTo((r.ax + world.half) * sc, (r.az + world.half) * sc); g.lineTo((r.bx + world.half) * sc, (r.bz + world.half) * sc); g.stroke(); }
  for (const bd of world.buildings) {
    g.fillStyle = bd.cover ? 'rgba(90,85,75,0.9)' : 'rgba(70,68,64,0.95)';
    g.fillRect((bd.x - bd.w / 2 + world.half) * sc, (bd.z - bd.d / 2 + world.half) * sc, Math.max(1, bd.w * sc), Math.max(1, bd.d * sc));
  }
  return c;
}

export class HUD {
  constructor(game) {
    this.g = game;
    this.overlay = $('overlay');
    this.octx = this.overlay.getContext('2d');
    this.mini = $('minimap').getContext('2d');
    this.mapImg = buildMapImage(game.world);
    this.hitT = 0; this.hitHead = false; this.hitKill = false; this.dmgDirs = [];
    this.noticeT = 0;
    this.killfeedEl = $('killfeed');
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.buildCompass();
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.overlay.width = innerWidth * dpr; this.overlay.height = innerHeight * dpr;
    this.octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  buildCompass() {
    const dirs = ['N', '15', '30', 'NE', '60', '75', 'E', '105', '120', 'SE', '150', '165', 'S', '195', '210', 'SW', '240', '255', 'W', '285', '300', 'NW', '330', '345'];
    let html = '';
    for (let k = 0; k < 3; k++) for (const d of dirs) html += `<span>${d.length > 2 || /^[0-9]/.test(d) ? '<small style="opacity:.6">' + d + '</small>' : '<b>' + d + '</b>'}</span>`;
    $('compassStrip').innerHTML = html;
  }

  notice(text, sub = '', color = '#fff') {
    const n = $('notice');
    n.textContent = text; n.style.color = color; n.style.opacity = 1;
    $('subnotice').textContent = sub;
    this.noticeT = 2.8;
  }

  killfeed(killer, victim, weaponId, head) {
    const g = this.g;
    const name = (id) => {
      const r = g.roster.get(id);
      if (!r) return '<span>?</span>';
      const cls = id === g.me.id ? 'me' : r.team === g.me.team && g.mode.teams !== 0 ? (r.squad === g.me.squad ? 's' : 'f') : 'e';
      return `<span class="${cls}">${escapeHtml(r.name)}</span>`;
    };
    const wname = weaponId < WEAPONS.length ? WEAPONS[weaponId].name : { 240: '차량 기관총', 241: '전차포', 242: '기관포', 243: '차량', 244: '로켓', 245: '미사일', 250: '폭발', 251: '수류탄', 252: 'C4', 253: '충돌', 254: '자살', 255: '화염지대' }[weaponId] || '';
    const div = document.createElement('div');
    div.className = 'kf';
    div.innerHTML = killer >= 0 && killer !== victim ? `${name(killer)}<span class="w">[${wname}${head ? ' ✛' : ''}]</span>${name(victim)}` : `<span class="w">[${wname}]</span>${name(victim)}`;
    this.killfeedEl.prepend(div);
    while (this.killfeedEl.children.length > 6) this.killfeedEl.lastChild.remove();
    setTimeout(() => div.remove(), 7000);
  }

  hit(head, kill) { this.hitT = 0.25; this.hitHead = head; this.hitKill = kill; }
  damaged(fromX, fromZ) { this.dmgDirs.push({ x: fromX, z: fromZ, t: 1.2 }); $('damageFlash').style.opacity = 0.7; setTimeout(() => ($('damageFlash').style.opacity = 0), 150); }

  updateObjectives() {
    const g = this.g, s = g.state;
    if (!s) return;
    const mode = MODES[g.modeId];
    let html = '';
    const my = g.me.team;
    if (s.tk && mode.teams === 2) {
      const other = 1 - my;
      if (g.modeId === 'tdm') html += `<div class="ticket t0">${s.k[my]}</div>`;
      else if (g.modeId === 'breakthrough') html += `<div class="ticket ${s.att === my ? 't0' : 't1'}">${s.tk[s.att]}</div>`;
      else html += `<div class="ticket t0">${s.tk[my]}</div>`;
    }
    if (s.obj) {
      for (const [id, owner, prog, contested] of s.obj) {
        const mine = owner === my, enemy = owner >= 0 && owner !== my;
        let locked = false;
        if (s.secs) locked = !(s.secs[s.sec] || []).includes(id);
        const fillColor = prog < 0 ? (my === 0 ? FRIEND : ENEMY) : (my === 1 ? FRIEND : ENEMY);
        html += `<div class="flag ${mine ? 'own' : enemy ? 'enemy' : ''} ${contested ? 'contested' : ''} ${locked ? 'locked' : ''}"><div class="fill" style="height:${Math.abs(prog)}%;background:${fillColor}"></div><span>${id}</span></div>`;
      }
    }
    if (s.tk && mode.teams === 2) {
      const other = 1 - my;
      if (g.modeId === 'tdm') html += `<div class="ticket t1">${s.k[other]}</div>`;
      else if (g.modeId === 'breakthrough') html += `<div class="ticket ${s.att === my ? 't1' : 't0'}">${s.att === my ? '방어' : '공격'}</div>`;
      else html += `<div class="ticket t1">${s.tk[other]}</div>`;
    }
    if (g.modeId === 'ffa') {
      const top = [...g.board.values()].sort((a, b) => b[1] - a[1])[0];
      const mine = g.board.get(g.me.id);
      html += `<div class="ticket t0">${mine ? mine[1] : 0}</div><div class="timeleft">/ ${mode.scoreLimit} · 1위 ${top ? top[1] : 0}</div>`;
    }
    if (s.alive) html += `<div class="ticket" style="color:#ffd27a">${s.alive[0]}<small style="font-size:13px"> 생존 · ${s.alive[1]}분대</small></div>`;
    const tl = s.tl;
    html += `<div class="timeleft">${Math.floor(tl / 60)}:${String(tl % 60).padStart(2, '0')}</div>`;
    if (s.zone) html += `<div class="timeleft" style="color:#ff9a5a">화염지대 ${s.zone[6] > 0 ? '수축까지 ' + s.zone[6] + '초' : '수축 중'}</div>`;
    $('objBar').innerHTML = html;
  }

  update(dt) {
    const g = this.g;
    if (this.noticeT > 0) { this.noticeT -= dt; if (this.noticeT <= 0) { $('notice').style.opacity = 0; $('subnotice').textContent = ''; } }
    this.hitT = Math.max(0, this.hitT - dt);
    // compass
    const deg = ((-g.cam.yaw * 180) / Math.PI + 360 * 4) % 360;
    $('compassStrip').style.left = `${210 - (deg / 15) * 30 - 24 * 30 - 15}px`;
    this.drawOverlay();
    this.drawMinimap();
  }

  drawOverlay() {
    const g = this.g, ctx = this.octx;
    const W = innerWidth, H = innerHeight;
    ctx.clearRect(0, 0, W, H);
    if (!g.me.alive) return;
    const cam = g.camera;
    const proj = (x, y, z) => {
      const v = g.tmpV.set(x, y, z).project(cam);
      if (v.z > 1 || v.z < -1) return null;
      return [(v.x * 0.5 + 0.5) * W, (-v.y * 0.5 + 0.5) * H];
    };
    const me = g.myPos();
    ctx.font = '600 12px Rajdhani, sans-serif'; ctx.textAlign = 'center';
    // soldiers
    for (const e of g.soldiers.values()) {
      if (!e.visible || !e.alive) continue;
      const r = g.roster.get(e.id);
      if (!r) continue;
      const d = Math.hypot(e.x - me.x, e.z - me.z);
      const friend = g.isFriend(e.team);
      if (friend) {
        if (d > 150) continue;
        const p = proj(e.x, e.y + 2.05, e.z);
        if (!p) continue;
        const squad = r.squad === g.me.squad;
        ctx.fillStyle = squad ? SQUAD : FRIEND;
        ctx.beginPath(); ctx.moveTo(p[0] - 5, p[1] - 6); ctx.lineTo(p[0] + 5, p[1] - 6); ctx.lineTo(p[0], p[1]); ctx.fill();
        if (d < 50) { ctx.globalAlpha = 0.9; ctx.fillText(r.name, p[0], p[1] - 10); ctx.globalAlpha = 1; }
      } else if (e.flags & PF.SPOTTED) {
        const p = proj(e.x, e.y + 2.1, e.z);
        if (!p) continue;
        ctx.fillStyle = ENEMY;
        ctx.beginPath(); ctx.moveTo(p[0], p[1] - 10); ctx.lineTo(p[0] + 6, p[1] - 4); ctx.lineTo(p[0], p[1] + 2); ctx.lineTo(p[0] - 6, p[1] - 4); ctx.fill();
      }
    }
    // objectives
    if (g.state && g.state.obj) {
      ctx.font = '700 16px Rajdhani, sans-serif';
      for (const [id, owner, , contested, x, z] of g.state.obj) {
        if (g.state.secs && !(g.state.secs[g.state.sec] || []).includes(id)) continue;
        const y = g.world.heightAt(x, z) + 10;
        const p = proj(x, y, z);
        if (!p) continue;
        const col = owner < 0 ? NEUTRAL : owner === g.me.team ? FRIEND : ENEMY;
        ctx.save(); ctx.translate(p[0], p[1]); ctx.rotate(Math.PI / 4);
        ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(-10, -10, 20, 20); ctx.strokeRect(-10, -10, 20, 20); ctx.restore();
        ctx.fillStyle = col; ctx.fillText(id, p[0], p[1] + 6);
        ctx.font = '600 11px Rajdhani'; ctx.fillStyle = contested ? '#ffd27a' : '#fff';
        ctx.fillText(Math.round(Math.hypot(x - me.x, z - me.z)) + 'm', p[0], p[1] + 26);
        ctx.font = '700 16px Rajdhani, sans-serif';
      }
    }
    // supply crates (battle royale)
    if (g.lootMeshes) {
      ctx.font = '600 11px Rajdhani';
      for (const [, m] of g.lootMeshes) {
        const d = m.position.distanceTo(g.camera.position);
        if (d > 60) continue;
        const p = proj(m.position.x, m.position.y + 1.2, m.position.z);
        if (p) { ctx.fillStyle = '#ffd27a'; ctx.fillText('▣ 보급', p[0], p[1]); }
      }
    }
    // crosshair
    const cx = W / 2, cy = H / 2;
    if (!g.vehicle) {
      const ads = g.adsT > 0.6;
      const spread = g.currentSpreadPx();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 2;
      ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 2;
      if (!ads && !g.sprinting) {
        const s = Math.max(4, spread);
        ctx.beginPath();
        ctx.moveTo(cx - s - 8, cy); ctx.lineTo(cx - s, cy); ctx.moveTo(cx + s, cy); ctx.lineTo(cx + s + 8, cy);
        ctx.moveTo(cx, cy - s - 8); ctx.lineTo(cx, cy - s); ctx.moveTo(cx, cy + s); ctx.lineTo(cx, cy + s + 8);
        ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.fillRect(cx - 1, cy - 1, 2, 2);
      }
      ctx.shadowBlur = 0;
    } else {
      ctx.strokeStyle = 'rgba(120,255,140,0.9)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(cx, cy, 16, 0, Math.PI * 2); ctx.moveTo(cx - 26, cy); ctx.lineTo(cx - 8, cy); ctx.moveTo(cx + 8, cy); ctx.lineTo(cx + 26, cy); ctx.moveTo(cx, cy + 8); ctx.lineTo(cx, cy + 22); ctx.stroke();
      // aim point of the vehicle's main weapon
      const ap = g.vehicleAimPoint && g.vehicleAimPoint();
      if (ap) { const p = proj(ap.x, ap.y, ap.z); if (p) { ctx.strokeStyle = 'rgba(255,220,120,0.9)'; ctx.strokeRect(p[0] - 6, p[1] - 6, 12, 12); } }
      if (g.lockTarget) { const p = proj(g.lockTarget.x, g.lockTarget.y + 2, g.lockTarget.z); if (p) { ctx.strokeStyle = ENEMY; ctx.lineWidth = 2; ctx.strokeRect(p[0] - 18, p[1] - 18, 36, 36); } }
    }
    if (this.hitT > 0) {
      const a = this.hitT / 0.25;
      ctx.strokeStyle = this.hitKill ? `rgba(255,60,40,${a})` : this.hitHead ? `rgba(255,220,80,${a})` : `rgba(255,255,255,${a})`;
      ctx.lineWidth = this.hitKill ? 3 : 2;
      const s = 7, o = 13;
      ctx.beginPath();
      ctx.moveTo(cx - o, cy - o); ctx.lineTo(cx - s, cy - s); ctx.moveTo(cx + o, cy - o); ctx.lineTo(cx + s, cy - s);
      ctx.moveTo(cx - o, cy + o); ctx.lineTo(cx - s, cy + s); ctx.moveTo(cx + o, cy + o); ctx.lineTo(cx + s, cy + s);
      ctx.stroke();
    }
    // damage direction indicators
    for (const d of this.dmgDirs) {
      d.t -= 1 / 60;
      const ang = Math.atan2(d.x - me.x, d.z - me.z);
      const rel = ang - Math.atan2(-Math.sin(g.cam.yaw), -Math.cos(g.cam.yaw));
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(-rel + Math.PI);
      ctx.strokeStyle = `rgba(255,40,30,${Math.max(0, d.t)})`; ctx.lineWidth = 6;
      ctx.beginPath(); ctx.arc(0, 0, 110, -Math.PI / 2 - 0.3, -Math.PI / 2 + 0.3); ctx.stroke();
      ctx.restore();
    }
    this.dmgDirs = this.dmgDirs.filter((d) => d.t > 0);
    // area warning
    if (g.outOfBounds) {
      ctx.font = '700 26px Rajdhani'; ctx.fillStyle = '#ff5a3a';
      ctx.fillText('전투 구역 이탈! 복귀하십시오', cx, H * 0.35);
    }
    if (g.zoneWarning) {
      ctx.font = '700 22px Rajdhani'; ctx.fillStyle = '#ff7a2a';
      ctx.fillText('화염지대 밖입니다 — 안전 구역으로 이동하세요', cx, H * 0.35);
    }
    if (g.para === 1) { ctx.font = '700 20px Rajdhani'; ctx.fillStyle = '#fff'; ctx.fillText(`고도 ${Math.round(g.altitude())}m — [Space] 낙하산 전개`, cx, H * 0.7); }
  }

  drawMinimap() {
    const g = this.g, ctx = this.mini;
    const S = 220, R = 160; // meters radius shown
    const me = g.myPos();
    const yaw = g.cam.yaw;
    ctx.save();
    ctx.clearRect(0, 0, S, S);
    ctx.beginPath(); ctx.rect(0, 0, S, S); ctx.clip();
    ctx.translate(S / 2, S / 2);
    ctx.rotate(yaw);
    const scale = (S / 2) / R;
    const w = g.world;
    const imgScale = this.mapImg.width / w.size;
    ctx.globalAlpha = 0.9;
    ctx.drawImage(this.mapImg, (me.x + w.half) * imgScale - R * imgScale, (me.z + w.half) * imgScale - R * imgScale, R * 2 * imgScale, R * 2 * imgScale, -S / 2, -S / 2, S, S);
    ctx.globalAlpha = 1;
    const toMap = (x, z) => [(x - me.x) * scale, (z - me.z) * scale];
    // zone / area
    const st = g.state;
    if (st && st.zone) {
      ctx.strokeStyle = '#ff6a2a'; ctx.lineWidth = 2; const [zx, zz] = toMap(st.zone[0], st.zone[1]); ctx.beginPath(); ctx.arc(zx, zz, st.zone[2] * scale, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; const [nx, nz] = toMap(st.zone[3], st.zone[4]); ctx.beginPath(); ctx.arc(nx, nz, st.zone[5] * scale, 0, Math.PI * 2); ctx.stroke();
    }
    if (st && st.area) { ctx.strokeStyle = 'rgba(255,90,60,0.8)'; ctx.lineWidth = 2; const [ax, az] = toMap(st.area[0], st.area[1]); ctx.beginPath(); ctx.arc(ax, az, st.area[2] * scale, 0, Math.PI * 2); ctx.stroke(); }
    if (st && st.obj) {
      for (const [id, owner, , , x, z] of st.obj) {
        const [px, pz] = toMap(x, z);
        ctx.save(); ctx.translate(px, pz); ctx.rotate(-yaw);
        ctx.fillStyle = owner < 0 ? NEUTRAL : owner === g.me.team ? FRIEND : ENEMY;
        ctx.font = '700 13px Rajdhani'; ctx.textAlign = 'center';
        ctx.fillRect(-7, -7, 14, 14); ctx.fillStyle = '#000'; ctx.fillText(id, 0, 5);
        ctx.restore();
      }
    }
    for (const v of g.vehiclesR.values()) {
      if (v.destroyed) continue;
      const [px, pz] = toMap(v.x, v.z);
      if (Math.abs(px) > S || Math.abs(pz) > S) continue;
      const friend = g.isFriend(v.team) || v.team === 255;
      if (!friend && !v.occupied) continue;
      ctx.fillStyle = friend ? FRIEND : ENEMY;
      ctx.save(); ctx.translate(px, pz); ctx.rotate(-v.yaw);
      ctx.fillRect(-4, -6, 8, 12); ctx.restore();
    }
    for (const e of g.soldiers.values()) {
      if (!e.visible || !e.alive) continue;
      const friend = g.isFriend(e.team);
      if (!friend && !(e.flags & PF.SPOTTED) && !(e.flags & PF.FIRING && g.loudShooters.has(e.id))) continue;
      const [px, pz] = toMap(e.x, e.z);
      if (Math.abs(px) > S || Math.abs(pz) > S) continue;
      const r = g.roster.get(e.id);
      ctx.fillStyle = friend ? (r && r.squad === g.me.squad ? SQUAD : FRIEND) : ENEMY;
      ctx.save(); ctx.translate(px, pz); ctx.rotate(-e.yaw);
      ctx.beginPath(); ctx.moveTo(0, -5); ctx.lineTo(4, 4); ctx.lineTo(-4, 4); ctx.fill();
      ctx.restore();
    }
    ctx.restore();
    // player arrow (always up)
    ctx.fillStyle = '#ffd84a';
    ctx.beginPath(); ctx.moveTo(S / 2, S / 2 - 7); ctx.lineTo(S / 2 + 5, S / 2 + 5); ctx.lineTo(S / 2 - 5, S / 2 + 5); ctx.fill();
  }

  drawBigMap() {
    const g = this.g;
    const c = $('bigmapCanvas'), ctx = c.getContext('2d');
    const S = c.width, w = g.world;
    const sc = S / w.size;
    ctx.drawImage(this.mapImg, 0, 0, S, S);
    const P = (x, z) => [(x + w.half) * sc, (z + w.half) * sc];
    const st = g.state;
    if (st && st.zone) {
      ctx.strokeStyle = '#ff6a2a'; ctx.lineWidth = 3; let [x, z] = P(st.zone[0], st.zone[1]); ctx.beginPath(); ctx.arc(x, z, st.zone[2] * sc, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; [x, z] = P(st.zone[3], st.zone[4]); ctx.beginPath(); ctx.arc(x, z, st.zone[5] * sc, 0, Math.PI * 2); ctx.stroke();
    }
    if (st && st.flight && g.para) { ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.setLineDash([8, 6]); const a = P(st.flight[0], st.flight[1]), b = P(st.flight[2], st.flight[3]); ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke(); ctx.setLineDash([]); }
    if (st && st.area) { ctx.strokeStyle = 'rgba(255,90,60,0.9)'; ctx.lineWidth = 3; const [x, z] = P(st.area[0], st.area[1]); ctx.beginPath(); ctx.arc(x, z, st.area[2] * sc, 0, Math.PI * 2); ctx.stroke(); }
    w.bases.forEach((b, i) => { if (g.mode.teams !== 2) return; const [x, z] = P(b.x, b.z); ctx.fillStyle = i === g.me.team ? FRIEND : ENEMY; ctx.font = '700 16px Rajdhani'; ctx.textAlign = 'center'; ctx.fillText('HQ', x, z); });
    if (st && st.obj) for (const [id, owner, , , x0, z0, r] of st.obj) {
      const [x, z] = P(x0, z0);
      ctx.fillStyle = owner < 0 ? NEUTRAL : owner === g.me.team ? FRIEND : ENEMY;
      ctx.globalAlpha = 0.3; ctx.beginPath(); ctx.arc(x, z, r * sc, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
      ctx.fillRect(x - 10, z - 10, 20, 20); ctx.fillStyle = '#000'; ctx.font = '700 16px Rajdhani'; ctx.textAlign = 'center'; ctx.fillText(id, x, z + 6);
    }
    for (const e of g.soldiers.values()) {
      if (!e.visible || !e.alive) continue;
      const friend = g.isFriend(e.team);
      if (!friend && !(e.flags & PF.SPOTTED)) continue;
      const [x, z] = P(e.x, e.z);
      ctx.fillStyle = friend ? FRIEND : ENEMY; ctx.fillRect(x - 2, z - 2, 4, 4);
    }
    for (const v of g.vehiclesR.values()) {
      if (v.destroyed || (!g.isFriend(v.team) && v.team !== 255)) continue;
      const [x, z] = P(v.x, v.z); ctx.fillStyle = FRIEND; ctx.font = '600 11px Rajdhani'; ctx.fillText(VEHICLES[v.type].label, x, z - 6); ctx.fillRect(x - 3, z - 3, 6, 6);
    }
    const me = g.myPos();
    const [mx, mz] = P(me.x, me.z);
    ctx.fillStyle = '#ffd84a'; ctx.beginPath(); ctx.arc(mx, mz, 5, 0, Math.PI * 2); ctx.fill();
  }

  renderScoreboard() {
    const g = this.g;
    const rows = [...g.roster.values()].map((r) => {
      const b = g.board.get(r.id) || [r.id, 0, 0, 0, 0, 0];
      const e = g.soldiers.get(r.id);
      return { ...r, k: b[1], d: b[2], s: b[3], ping: b[5], alive: r.id === g.me.id ? g.me.alive : !!(e && e.alive) };
    });
    const row = (r, i) => `<tr class="${r.id === g.me.id ? 'me' : ''} ${r.alive ? '' : 'dead'}"><td>${i + 1}</td><td>${escapeHtml(r.name)} ${r.bot ? '<span class="bot">BOT</span>' : ''}</td><td>${r.k}</td><td>${r.d}</td><td>${r.s}</td><td>${r.bot ? '-' : r.ping}</td></tr>`;
    const table = (list) => `<table><tr><th>#</th><th>이름</th><th>K</th><th>D</th><th>점수</th><th>핑</th></tr>${list.sort((a, b) => b.s - a.s).slice(0, 50).map(row).join('')}</table>`;
    let html;
    if (g.mode.teams === 2) {
      const my = g.me.team;
      html = `<div class="cols"><div class="col t0"><h3>아군 (${rows.filter((r) => r.team === my).length})</h3>${table(rows.filter((r) => r.team === my))}</div><div class="col t1"><h3>적군 (${rows.filter((r) => r.team !== my).length})</h3>${table(rows.filter((r) => r.team !== my))}</div></div>`;
    } else {
      html = `<div class="cols"><div class="col"><h3>순위</h3>${table(rows)}</div></div>`;
    }
    $('scoreboard').innerHTML = html;
  }
}

export function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
