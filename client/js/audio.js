// Synthesised positional audio (WebAudio): gunshots by weapon class, distant
// shot propagation delay, explosions, hits, footsteps and vehicle engines.
export class Audio {
  constructor() {
    this.ctx = null; this.master = null; this.volume = 0.7; this.listener = { x: 0, y: 0, z: 0, yaw: 0 };
    this.engine = null;
  }
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain(); this.master.gain.value = this.volume;
    const comp = this.ctx.createDynamicsCompressor();
    this.master.connect(comp); comp.connect(this.ctx.destination);
    const len = this.ctx.sampleRate * 2;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.startAmbience();
  }
  unlock() { this.init(); if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {}); }
  setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v; }

  _pan(x, z) {
    const l = this.listener;
    const dx = x - l.x, dz = z - l.z;
    const rx = Math.cos(l.yaw) * dx - Math.sin(l.yaw) * dz;
    const d = Math.hypot(dx, dz) || 1;
    return Math.max(-1, Math.min(1, rx / d));
  }

  _noise(t, dur, freq, q, gain, pan = 0, type = 'bandpass', dest = null) {
    const c = this.ctx;
    const src = c.createBufferSource(); src.buffer = this.noise; src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = c.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = c.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const p = c.createStereoPanner(); p.pan.value = pan;
    src.connect(f); f.connect(g); g.connect(p); p.connect(dest || this.master);
    src.start(t, Math.random() * 1.5); src.stop(t + dur + 0.05);
  }

  _tone(t, dur, f0, f1, gain, pan = 0, type = 'sine') {
    const c = this.ctx;
    const o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = c.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const p = c.createStereoPanner(); p.pan.value = pan;
    o.connect(g); g.connect(p); p.connect(this.master); o.start(t); o.stop(t + dur + 0.05);
  }

  gunshot(cat, x, y, z, suppressed = false, local = false) {
    if (!this.ctx) return;
    const l = this.listener;
    const dist = local ? 0 : Math.hypot(x - l.x, y - l.y, z - l.z);
    if (dist > 1200) return;
    const delay = local ? 0 : dist / 343;
    const t = this.ctx.currentTime + delay;
    const att = local ? 1 : Math.min(1, 25 / (dist + 10));
    const pan = local ? 0 : this._pan(x, z);
    const far = Math.min(1, dist / 400);
    const P = {
      ar: [1400, 0.22, 110], carbine: [1500, 0.2, 120], smg: [1800, 0.15, 140], lmg: [1100, 0.26, 95], dmr: [1000, 0.35, 80],
      sniper: [800, 0.6, 60], shotgun: [700, 0.4, 70], pistol: [2000, 0.14, 160], launcher: [400, 0.8, 50], veh: [600, 0.5, 55], mg: [1200, 0.2, 100],
    }[cat] || [1400, 0.22, 110];
    let [freq, dur, thump] = P;
    if (suppressed) { freq *= 1.6; dur *= 0.4; }
    const vol = (suppressed ? 0.25 : 0.9) * att;
    this._noise(t, dur * (1 + far * 1.5), freq * (1 - far * 0.7), 0.7, vol, pan);
    if (!suppressed) this._tone(t, dur * 0.8, thump * 2, thump * 0.5, vol * 0.8, pan);
    if (!local && dist > 150 && !suppressed) this._noise(t + 0.05, 1.2, 300, 0.4, vol * 0.4, pan, 'lowpass'); // echo
    if (local && !suppressed) this._noise(t + 0.02, 0.5, 600, 0.3, 0.12, 0, 'lowpass');
  }

  explosion(x, y, z, big = 1) {
    if (!this.ctx) return;
    const l = this.listener;
    const dist = Math.hypot(x - l.x, y - l.y, z - l.z);
    const t = this.ctx.currentTime + dist / 343;
    const att = Math.min(1.2, 60 / (dist + 20)) * (big >= 2 ? 1.3 : 1);
    const pan = this._pan(x, z);
    this._noise(t, 1.8, 180, 0.5, att, pan, 'lowpass');
    this._tone(t, 0.9, 90, 25, att * 0.9, pan);
    this._noise(t, 0.3, 1600, 0.8, att * 0.4, pan);
  }

  hit(head) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this._tone(t, 0.06, head ? 2600 : 1800, head ? 2400 : 1600, 0.18, 0, 'triangle');
    if (head) this._tone(t + 0.03, 0.12, 3200, 3000, 0.12, 0, 'sine');
  }
  kill() { if (!this.ctx) return; const t = this.ctx.currentTime; this._tone(t, 0.12, 900, 700, 0.2, 0, 'square'); this._tone(t + 0.08, 0.2, 1300, 1200, 0.15, 0, 'triangle'); }
  hurt() { if (!this.ctx) return; this._noise(this.ctx.currentTime, 0.15, 400, 1, 0.3, 0, 'lowpass'); }
  click() { if (!this.ctx) return; this._tone(this.ctx.currentTime, 0.03, 3000, 2000, 0.08, 0, 'square'); }
  reload() { if (!this.ctx) return; const t = this.ctx.currentTime; this._noise(t, 0.08, 2500, 3, 0.25); this._noise(t + 0.6, 0.06, 3000, 3, 0.3); this._noise(t + 0.9, 0.1, 1800, 3, 0.3); }
  step(run) { if (!this.ctx) return; this._noise(this.ctx.currentTime, run ? 0.12 : 0.09, run ? 500 : 380, 0.8, run ? 0.12 : 0.07, (Math.random() - 0.5) * 0.3, 'lowpass'); }
  whiz(x, z) { if (!this.ctx) return; this._noise(this.ctx.currentTime, 0.12, 3000, 4, 0.12, this._pan(x, z)); }

  startAmbience() {
    const c = this.ctx;
    const src = c.createBufferSource(); src.buffer = this.noise; src.loop = true;
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 400;
    const g = c.createGain(); g.gain.value = 0.035;
    src.connect(f); f.connect(g); g.connect(this.master); src.start();
    this.wind = g;
  }

  setRain(on) {
    if (!this.ctx || this.rain || !on) return;
    const c = this.ctx;
    const src = c.createBufferSource(); src.buffer = this.noise; src.loop = true;
    const f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 2500;
    const g = c.createGain(); g.gain.value = 0.06;
    src.connect(f); f.connect(g); g.connect(this.master); src.start();
    this.rain = src;
  }

  // continuous engine for the local vehicle
  setEngine(type, rpm) {
    if (!this.ctx) return;
    if (!type) { if (this.engine) { this.engine.g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2); const e = this.engine; setTimeout(() => { try { e.o.stop(); e.n.stop(); } catch {} }, 800); this.engine = null; } return; }
    if (!this.engine || this.engine.type !== type) {
      this.setEngine(null);
      const c = this.ctx;
      const o = c.createOscillator(); o.type = type === 'jet' ? 'sawtooth' : 'sawtooth';
      const n = c.createBufferSource(); n.buffer = this.noise; n.loop = true;
      const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = type === 'jet' ? 2000 : 500;
      const g = c.createGain(); g.gain.value = 0;
      const lfo = c.createOscillator(); const lg = c.createGain(); lfo.frequency.value = type === 'heli' ? 18 : 0.1; lg.gain.value = type === 'heli' ? 0.12 : 0;
      lfo.connect(lg); lg.connect(g.gain); lfo.start();
      o.connect(f); n.connect(f); f.connect(g); g.connect(this.master);
      o.start(); n.start();
      this.engine = { o, n, f, g, type };
    }
    const e = this.engine;
    const base = { tank: 35, ifv: 45, jeep: 60, heli: 40, jet: 90 }[type];
    e.o.frequency.setTargetAtTime(base * (1 + rpm), this.ctx.currentTime, 0.1);
    e.f.frequency.setTargetAtTime((type === 'jet' ? 1500 : 400) * (1 + rpm), this.ctx.currentTime, 0.1);
    e.g.gain.setTargetAtTime(type === 'jet' ? 0.14 : 0.18, this.ctx.currentTime, 0.2);
  }
}
