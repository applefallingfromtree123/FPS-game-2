// WARFIELD server: static client + WebSocket game server (Render-ready).
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { Matchmaker } from './matchmaker.js';
import { Store } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const PORT = process.env.PORT || 3000;
const BUILD = (process.env.RENDER_GIT_COMMIT || process.env.GIT_SHA || process.env.NF_GIT_COMMIT || 'local').slice(0, 7);

const app = express();
// Game code changes often: always revalidate (ETag) so browsers never run a stale build.
const noCache = (res) => res.setHeader('Cache-Control', 'no-cache');
app.use(express.static(path.join(root, 'client'), { setHeaders: noCache }));
app.use('/shared', express.static(path.join(root, 'shared'), { setHeaders: noCache }));
app.use('/vendor/three', express.static(path.join(root, 'node_modules', 'three'), { maxAge: '7d' }));

const store = new Store();
await store.load();
const mm = new Matchmaker({ record: (client, r) => store.record(client.userKey, r) });
let online = 0;

// ---------------------------------------------------------------- accounts & ranking API
app.set('trust proxy', 1);
app.use(express.json({ limit: '2kb' }));
const hits = new Map(); // ip -> { n, reset }
const limited = (req, res, max, windowMs, bucket) => {
  const k = bucket + req.ip, now = Date.now();
  let h = hits.get(k);
  if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(k, h); }
  if (++h.n > max) { res.status(429).json({ error: '시도가 너무 많습니다. 잠시 후 다시 시도하세요.' }); return true; }
  return false;
};
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (h.reset < now) hits.delete(k); }, 60000).unref();
const bearer = (req) => { const m = /^Bearer (\w{20,100})$/.exec(req.headers.authorization || ''); return m ? m[1] : null; };

app.post('/api/register', async (req, res) => {
  if (limited(req, res, 5, 3600e3, 'reg')) return;
  const { name, password } = req.body || {};
  const r = await store.register(name, password);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ ok: true, token: r.token, profile: r.profile });
});
app.post('/api/login', async (req, res) => {
  if (limited(req, res, 12, 600e3, 'login')) return;
  const { name, password } = req.body || {};
  const r = await store.login(name, password);
  if (r.error) return res.status(401).json({ error: r.error });
  res.json({ ok: true, token: r.token, profile: r.profile });
});
app.post('/api/logout', (req, res) => { const t = bearer(req); if (t) store.logout(t); res.json({ ok: true }); });
app.get('/api/me', (req, res) => {
  const key = store.userFromToken(bearer(req));
  if (!key) return res.status(401).json({ error: 'not logged in' });
  res.json({ ok: true, profile: store.profile(key), rank: store.rankOf(key) });
});
app.get('/api/leaderboard', (req, res) => {
  const by = ['xp', 'kills', 'wins', 'kd', 'headshots'].includes(req.query.by) ? req.query.by : 'xp';
  const rows = store.leaderboard(by, Math.min(100, +req.query.limit || 50));
  const key = store.userFromToken(bearer(req));
  res.json({ by, rows, me: key ? { rank: store.rankOf(key, by), profile: store.profile(key) } : null, backend: store.backend, durable: store.durable });
});
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/api/status', (_req, res) => res.json({ build: BUILD, online, storage: { backend: store.backend, durable: store.durable, ready: store.ready, error: store.lastError || undefined, misconfigured: store.misconfigured || undefined }, ...mm.stats() }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

class Client {
  constructor(ws) {
    this.ws = ws; this.name = 'Soldier'; this.userKey = null; this.lobby = null; this.match = null; this.player = null; this.loadoutReq = null;
    this.msgCount = 0; this.msgWindow = Date.now();
  }
  send(obj) { this.sendRaw(JSON.stringify(obj)); }
  sendRaw(s) { if (this.ws.readyState === 1 && this.ws.bufferedAmount < 2e6) this.ws.send(s); }
  sendBinary(buf) { if (this.ws.readyState === 1 && this.ws.bufferedAmount < 2e6) this.ws.send(buf, { binary: true }); }
}

wss.on('connection', (ws) => {
  const c = new Client(ws);
  online++;
  c.send({ t: 'welcome', online, build: BUILD, durable: store.durable, ready: store.ready, error: store.lastError || undefined, misconfigured: store.misconfigured || undefined });
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    // simple flood protection
    const now = Date.now();
    if (now - c.msgWindow > 1000) { c.msgWindow = now; c.msgCount = 0; }
    if (++c.msgCount > 200) return;
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    if (msg.t === 'auth') {
      const key = store.userFromToken(msg.token);
      c.userKey = key;
      if (key) { const p = store.profile(key); c.name = p.name; c.send({ t: 'auth', ok: true, profile: p }); } else c.send({ t: 'auth', ok: false });
      return;
    }
    if (msg.t === 'hello') { if (c.userKey) return; c.name = String(msg.name || 'Soldier').replace(/[^\p{L}\p{N}_\- ]/gu, '').slice(0, 16) || 'Soldier'; return; }
    if (msg.t === 'pi') { c.send({ t: 'po', c: msg.c, s: c.match ? c.match.time : 0 }); return; }
    try { mm.handle(c, msg); } catch (e) { console.error('[handle]', e); }
  });
  ws.on('close', () => { online--; mm.leave(c); });
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { await store.flush(); process.exit(0); });
  ws.on('error', () => {});
});

server.listen(PORT, () => console.log(`WARFIELD server listening on :${PORT}`));
