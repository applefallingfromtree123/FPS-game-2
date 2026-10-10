// Tiny persistent store for accounts and stats.
// Backends: a JSON file (DATA_DIR, default ./data) or an Upstash Redis REST database when
// UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are set (survives redeploys on hosts with ephemeral disks).
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { promisify } from 'util';
import { progress } from '../shared/ranks.js';

const scrypt = promisify(crypto.scrypt);
const KEY = 'warfield-db-v1';
const NAME_RE = /^[A-Za-z0-9가-힣_]{3,16}$/;
const SESSION_MS = 30 * 24 * 3600 * 1000;

export class Store {
  constructor(opts = {}) {
    this.dir = opts.dir || process.env.DATA_DIR || path.join(process.cwd(), 'data');
    this.file = path.join(this.dir, 'warfield-db.json');
    this.url = process.env.UPSTASH_REDIS_REST_URL || '';
    this.token = process.env.UPSTASH_REDIS_REST_TOKEN || '';
    this.data = { users: {}, sessions: {} };
    this.dirty = false; this.saving = false; this.timer = null; this.lbCache = new Map();
    this.backend = this.url ? 'upstash' : 'file';
    this.ready = false;       // true once the stored data has been read successfully; never write before that
    this.lastBackup = 0;
  }

  // Durable storage = anything that survives a restart/redeploy of the game server.
  get durable() { return this.backend === 'upstash' || process.env.PERSISTENT_DISK === '1' || !(process.env.RENDER || process.env.KOYEB_APP_NAME || process.env.NF_HOSTNAME || process.env.FLY_APP_NAME); }

  async load() {
    for (let attempt = 1; ; attempt++) {
      try {
        if (this.url) {
          const r = await this._redis(['GET', KEY]);
          if (r && r.result) this.data = JSON.parse(r.result);
        } else if (fs.existsSync(this.file)) this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        break;
      } catch (e) {
        // Never continue with an empty database when the real one could not be read:
        // the next save would overwrite every account.
        console.error(`[store] load failed (attempt ${attempt}): ${e.message}`);
        if (!this.url || attempt >= 5) {
          if (!this.url && fs.existsSync(this.file)) { fs.copyFileSync(this.file, this.file + '.corrupt-' + Date.now()); console.error('[store] unreadable file kept as .corrupt backup'); break; }
          if (this.url) { this._retryLoad(); this.ready = false; return; }
          break;
        }
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    this._afterLoad();
  }

  _retryLoad() {
    console.error('[store] remote database unreachable — accounts are read-only until it answers again');
    const t = setInterval(async () => {
      try {
        const r = await this._redis(['GET', KEY]);
        if (r && r.result) this.data = JSON.parse(r.result);
        clearInterval(t); this._afterLoad(); console.log('[store] remote database reachable again');
      } catch {}
    }, 10000);
    t.unref();
  }

  _afterLoad() {
    this.data.users = this.data.users || {}; this.data.sessions = this.data.sessions || {};
    this._gcSessions();
    this.ready = true;
    if (!this.durable) console.warn('[store] WARNING: file storage on a host with an ephemeral disk — accounts are lost on redeploy/restart. Set UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (free).');
    console.log(`[store] ${this.backend} backend (${this.durable ? 'durable' : 'NOT durable'}), ${Object.keys(this.data.users).length} accounts`);
  }

  async _redis(cmd) {
    const res = await fetch(this.url, { method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
    if (!res.ok) throw new Error('redis ' + res.status);
    return res.json();
  }

  touch() {
    this.dirty = true;
    this.lbCache.clear();
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 3000);
  }

  async flush() {
    if (!this.dirty || this.saving || !this.ready) return;
    this.saving = true; this.dirty = false;
    try {
      const json = JSON.stringify(this.data);
      if (this.url) {
        await this._redis(['SET', KEY, json]);
        // rolling snapshot every 6 hours in case of a bad write
        if (Date.now() - this.lastBackup > 6 * 3600e3) { this.lastBackup = Date.now(); await this._redis(['SET', KEY + ':backup', json]); }
      }
      else { fs.mkdirSync(this.dir, { recursive: true }); const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, json); fs.renameSync(tmp, this.file); }
    } catch (e) { console.error('[store] save failed:', e.message); this.dirty = true; }
    this.saving = false;
  }

  _gcSessions() {
    const now = Date.now();
    for (const [k, s] of Object.entries(this.data.sessions)) if (s.exp < now) delete this.data.sessions[k];
  }

  static validName(n) { return typeof n === 'string' && NAME_RE.test(n); }
  static validPass(p) { return typeof p === 'string' && p.length >= 6 && p.length <= 64; }

  async register(name, pass) {
    if (!this.ready) return { error: '계정 저장소에 연결 중입니다. 잠시 후 다시 시도하세요.' };
    if (!Store.validName(name)) return { error: '이름은 3~16자의 한글/영문/숫자/_ 만 가능합니다.' };
    if (!Store.validPass(pass)) return { error: '비밀번호는 6자 이상이어야 합니다.' };
    const key = name.toLowerCase();
    if (this.data.users[key]) return { error: '이미 사용 중인 이름입니다.' };
    if (Object.keys(this.data.users).length >= 20000) return { error: '현재 가입을 받을 수 없습니다.' };
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = (await scrypt(pass, salt, 32)).toString('hex');
    if (this.data.users[key]) return { error: '이미 사용 중인 이름입니다.' };
    this.data.users[key] = { name, salt, hash, created: Date.now(), last: Date.now(), xp: 0, matches: 0, wins: 0, kills: 0, deaths: 0, headshots: 0, score: 0, caps: 0, seconds: 0, modes: {} };
    this.touch();
    return { token: this._newSession(key), profile: this.profile(key) };
  }

  async login(name, pass) {
    if (!this.ready) return { error: '계정 저장소에 연결 중입니다. 잠시 후 다시 시도하세요.' };
    const key = String(name || '').toLowerCase();
    const u = this.data.users[key];
    // always do the hash work so timing does not reveal whether the account exists
    const salt = u ? u.salt : '00'.repeat(16);
    const hash = (await scrypt(String(pass || ''), salt, 32)).toString('hex');
    if (!u || !crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(u.hash, 'hex'))) return { error: '이름 또는 비밀번호가 올바르지 않습니다.' };
    u.last = Date.now(); this.touch();
    return { token: this._newSession(key), profile: this.profile(key) };
  }

  _newSession(key) {
    const token = crypto.randomBytes(32).toString('hex');
    const mine = Object.entries(this.data.sessions).filter(([, s]) => s.user === key).sort((a, b) => a[1].exp - b[1].exp);
    while (mine.length >= 5) delete this.data.sessions[mine.shift()[0]];
    this.data.sessions[this._h(token)] = { user: key, exp: Date.now() + SESSION_MS };
    this.touch();
    return token;
  }

  _h(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }

  userFromToken(token) {
    if (!token) return null;
    const s = this.data.sessions[this._h(token)];
    if (!s || s.exp < Date.now() || !this.data.users[s.user]) return null;
    return s.user;
  }

  logout(token) { if (this.data.sessions[this._h(token)]) { delete this.data.sessions[this._h(token)]; this.touch(); } }

  profile(key) {
    const u = this.data.users[key];
    if (!u) return null;
    return { name: u.name, xp: u.xp, matches: u.matches, wins: u.wins, kills: u.kills, deaths: u.deaths, headshots: u.headshots, score: u.score, caps: u.caps, seconds: u.seconds, kd: +(u.kills / Math.max(1, u.deaths)).toFixed(2), ...progress(u.xp) };
  }

  // Add one finished match to an account. Returns { gained, profile, leveledUp }.
  record(key, r) {
    if (!this.ready) return null;
    const u = this.data.users[key];
    if (!u) return null;
    const before = progress(u.xp).level;
    const gained = Math.max(0, Math.round(r.score + (r.won ? 300 : 0) + 50));
    u.xp += gained; u.matches++; u.wins += r.won ? 1 : 0; u.kills += r.kills; u.deaths += r.deaths; u.headshots += r.headshots; u.score += r.score; u.caps += r.caps; u.seconds += r.seconds;
    const m = (u.modes[r.mode] = u.modes[r.mode] || { matches: 0, wins: 0, kills: 0 });
    m.matches++; m.wins += r.won ? 1 : 0; m.kills += r.kills;
    this.touch();
    const profile = this.profile(key);
    return { gained, profile, leveledUp: profile.level > before };
  }

  leaderboard(by = 'xp', limit = 100) {
    const cacheKey = by + ':' + limit;
    const hit = this.lbCache.get(cacheKey);
    if (hit && Date.now() - hit.t < 10000) return hit.rows;
    const sorts = {
      xp: (a, b) => b.xp - a.xp, kills: (a, b) => b.kills - a.kills, wins: (a, b) => b.wins - a.wins,
      kd: (a, b) => b.kd - a.kd, headshots: (a, b) => b.headshots - a.headshots,
    };
    const f = sorts[by] || sorts.xp;
    let rows = Object.keys(this.data.users).map((k) => this.profile(k));
    if (by === 'kd') rows = rows.filter((r) => r.matches >= 3 && r.kills >= 20);
    rows = rows.filter((r) => r.matches > 0 || by === 'xp').sort(f).slice(0, limit).map((r, i) => ({ rank: i + 1, ...r }));
    this.lbCache.set(cacheKey, { t: Date.now(), rows });
    return rows;
  }

  rankOf(key, by = 'xp') {
    const rows = this.leaderboard(by, 100000);
    const i = rows.findIndex((r) => r.name.toLowerCase() === key);
    return i < 0 ? null : i + 1;
  }
}
