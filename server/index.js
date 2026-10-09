// WARFIELD server: static client + WebSocket game server (Render-ready).
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { Matchmaker } from './matchmaker.js';

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

const mm = new Matchmaker();
let online = 0;
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/api/status', (_req, res) => res.json({ build: BUILD, online, ...mm.stats() }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

class Client {
  constructor(ws) {
    this.ws = ws; this.name = 'Soldier'; this.lobby = null; this.match = null; this.player = null; this.loadoutReq = null;
    this.msgCount = 0; this.msgWindow = Date.now();
  }
  send(obj) { this.sendRaw(JSON.stringify(obj)); }
  sendRaw(s) { if (this.ws.readyState === 1 && this.ws.bufferedAmount < 2e6) this.ws.send(s); }
  sendBinary(buf) { if (this.ws.readyState === 1 && this.ws.bufferedAmount < 2e6) this.ws.send(buf, { binary: true }); }
}

wss.on('connection', (ws) => {
  const c = new Client(ws);
  online++;
  c.send({ t: 'welcome', online, build: BUILD });
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    // simple flood protection
    const now = Date.now();
    if (now - c.msgWindow > 1000) { c.msgWindow = now; c.msgCount = 0; }
    if (++c.msgCount > 200) return;
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    if (msg.t === 'hello') { c.name = String(msg.name || 'Soldier').replace(/[^\p{L}\p{N}_\- ]/gu, '').slice(0, 16) || 'Soldier'; return; }
    if (msg.t === 'pi') { c.send({ t: 'po', c: msg.c, s: c.match ? c.match.time : 0 }); return; }
    try { mm.handle(c, msg); } catch (e) { console.error('[handle]', e); }
  });
  ws.on('close', () => { online--; mm.leave(c); });
  ws.on('error', () => {});
});

server.listen(PORT, () => console.log(`WARFIELD server listening on :${PORT}`));
