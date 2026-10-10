// Matchmaking: per-mode lobbies. As soon as 2+ humans are waiting a 2 minute
// countdown starts; when it ends (or the lobby is full) the match starts and
// all remaining slots are filled with AI soldiers. Late joiners replace bots.
import { Match } from './match.js';
import { MODES, LOBBY_WAIT_SECONDS, MIN_HUMANS_FOR_TIMER } from '../shared/modes.js';
import { MAPS } from '../shared/maps.js';

let LOBBY_SEQ = 1;

export class Matchmaker {
  constructor(opts = {}) {
    this.opts = opts;
    this.lobbies = new Map(); // id -> lobby
    this.matches = new Map();
    this.loop = setInterval(() => this.update(), 1000);
    this.tickLoop = null;
    this._startTickLoop();
  }

  _startTickLoop() {
    let last = Date.now();
    let acc = 0;
    const step = 50;
    this.tickLoop = setInterval(() => {
      const now = Date.now();
      acc += Math.min(now - last, 250);
      last = now;
      while (acc >= step) {
        acc -= step;
        for (const m of this.matches.values()) {
          try { m.tick(); } catch (e) { console.error('[match tick]', e); }
        }
      }
      for (const m of this.matches.values()) {
        try { m.flush(); } catch (e) { console.error('[match flush]', e); }
      }
    }, step);
  }

  stats() {
    return {
      lobbies: [...this.lobbies.values()].map((l) => ({ mode: l.mode, humans: l.clients.size })),
      matches: [...this.matches.values()].map((m) => ({ id: m.id, mode: m.mode.id, map: m.map.name, humans: m.humans().length, players: m.players.size, t: Math.round(m.time / 1000) })),
    };
  }

  queue(client, modeId, practice = false, mapId = -1) {
    this.leave(client);
    const mode = MODES[modeId];
    if (!mode) return;
    client.loadoutReq = client.loadoutReq || null;
    if (practice) {
      const lobby = this._newLobby(modeId, mapId);
      lobby.clients.add(client);
      client.lobby = lobby;
      this._startLobby(lobby);
      return;
    }
    // 1) join a running match in progress (a bot gives up its slot)
    if (!mode.br) {
      for (const m of this.matches.values()) {
        if (m.mode.id === modeId && !m.ended && m.humans().length < mode.maxPlayers && m.time / 1000 < mode.timeLimit - 180) {
          this._joinMatch(m, client, true);
          return;
        }
      }
    }
    // 2) waiting lobby
    let lobby = [...this.lobbies.values()].find((l) => l.mode === modeId && l.clients.size < mode.maxPlayers);
    if (!lobby) lobby = this._newLobby(modeId, mapId);
    lobby.clients.add(client);
    client.lobby = lobby;
    if (lobby.clients.size >= MIN_HUMANS_FOR_TIMER && !lobby.deadline) lobby.deadline = Date.now() + LOBBY_WAIT_SECONDS * 1000;
    if (lobby.clients.size >= mode.maxPlayers) return this._startLobby(lobby);
    this._broadcastLobby(lobby);
  }

  _newLobby(modeId, mapId) {
    const id = LOBBY_SEQ++;
    const map = mapId >= 0 && MAPS[mapId] ? mapId : Math.floor(Math.random() * MAPS.length);
    const lobby = { id, mode: modeId, map, clients: new Set(), deadline: 0 };
    this.lobbies.set(id, lobby);
    return lobby;
  }

  // Start right away with bots when the player is alone and asks for it
  startNow(client) {
    const l = client.lobby;
    if (!l) return;
    if (l.clients.size === 1) this._startLobby(l);
  }

  // Save a finished (or abandoned) match into the account's stats, once per player.
  _record(m, p) {
    if (!p || p.recorded || !p.client || !p.client.userKey || !this.opts.record) return;
    p.recorded = true;
    const seconds = Math.max(0, Math.round((m.time - p.joinedAt) / 1000));
    if (p.score === 0 && p.kills === 0 && seconds < 60) return; // just walked in and out
    const won = !!(m.ended && m.result && m.result.winner === p.team && m.result.winner !== -1);
    const out = this.opts.record(p.client, { kills: p.kills, deaths: p.deaths, headshots: p.headshots || 0, score: p.score, caps: p.caps, seconds, won, mode: m.mode.id });
    if (out) p.client.send({ t: 'profile', gained: out.gained, leveledUp: out.leveledUp, won, profile: out.profile });
  }

  leave(client) {
    if (client.lobby) {
      const l = client.lobby;
      l.clients.delete(client);
      client.lobby = null;
      if (l.clients.size < MIN_HUMANS_FOR_TIMER) l.deadline = 0;
      if (l.clients.size === 0) this.lobbies.delete(l.id);
      else this._broadcastLobby(l);
    }
    if (client.match) {
      const m = client.match;
      if (client.player) {
        this._record(m, client.player);
        m.removePlayer(client.player.id);
        // keep the battle full: a bot takes the empty slot
        if (!m.ended && !m.mode.br) m.fillBots();
      }
      client.match = null; client.player = null;
      if (m.humans().length === 0) this._closeMatch(m);
    }
  }

  update() {
    const now = Date.now();
    for (const l of [...this.lobbies.values()]) {
      if (l.deadline && now >= l.deadline) this._startLobby(l);
      else this._broadcastLobby(l);
    }
  }

  _broadcastLobby(l) {
    const mode = MODES[l.mode];
    const msg = JSON.stringify({ t: 'lobby', mode: l.mode, map: l.map, humans: l.clients.size, max: mode.maxPlayers,
      countdown: l.deadline ? Math.max(0, Math.ceil((l.deadline - Date.now()) / 1000)) : null, names: [...l.clients].map((c) => c.name).slice(0, 100) });
    for (const c of l.clients) c.sendRaw(msg);
  }

  _startLobby(l) {
    this.lobbies.delete(l.id);
    const match = new Match(l.mode, l.map, { onEnd: (m) => { for (const p of m.players.values()) this._record(m, p); setTimeout(() => this._closeMatch(m), 20000); } });
    this.matches.set(match.id, match);
    for (const c of l.clients) { c.lobby = null; this._joinMatch(match, c, false); }
    match.fillBots();
    match.start();
    console.log(`[match ${match.id}] ${match.mode.id} on ${match.map.name}: ${l.clients.size} humans + ${match.bots().length} bots`);
  }

  _joinMatch(m, client, inProgress) {
    const p = inProgress ? m.replaceBotWithHuman(client.name, client, client.loadoutReq) : m.addPlayer({ name: client.name, client, loadout: client.loadoutReq });
    client.match = m; client.player = p;
    client.send({ t: 'match', id: m.id, mode: m.mode.id, map: m.map.id, you: p.id, team: p.team, squad: p.squad, roster: m.rosterMsg(),
      vehicles: m.vehicles.map((v) => [v.id, v.type, v.team]), time: m.time, inProgress, br: !!m.mode.br });
    client.send(m.stateMsg());
    if (inProgress && m.mode.br) m.startBattleRoyale();
  }

  _closeMatch(m) {
    if (!this.matches.has(m.id)) return;
    this.matches.delete(m.id);
    for (const p of m.players.values()) {
      if (p.client) { p.client.match = null; p.client.player = null; p.client.send({ t: 'closed' }); }
    }
  }

  handle(client, msg) {
    if (msg.t === 'queue') { client.loadoutReq = msg.l || null; this.queue(client, String(msg.mode), !!msg.practice, Number.isInteger(msg.map) ? msg.map : -1); }
    else if (msg.t === 'startNow') this.startNow(client);
    else if (msg.t === 'leave') this.leave(client);
    else if (client.match && client.player) {
      if (msg.t === 'deploy' && msg.l) client.loadoutReq = msg.l;
      client.match.handleInput(client.player, msg);
    }
  }
}
