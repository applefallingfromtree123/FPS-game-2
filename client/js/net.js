// WebSocket connection to the WARFIELD server (same origin, works on Render).
export class Net {
  constructor() { this.handlers = {}; this.ws = null; this.queue = []; this.onBinary = null; }
  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => { for (const m of this.queue) ws.send(m); this.queue = []; this.emit('open'); };
    ws.onclose = () => { this.emit('close'); setTimeout(() => this.connect(), 2000); };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') { if (this.onBinary) this.onBinary(ev.data); return; }
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      this.emit(msg.t, msg);
    };
  }
  on(t, fn) { (this.handlers[t] = this.handlers[t] || []).push(fn); }
  emit(t, msg) { for (const fn of this.handlers[t] || []) fn(msg); }
  send(obj) {
    const s = JSON.stringify(obj);
    if (this.ws && this.ws.readyState === 1) this.ws.send(s); else this.queue.push(s);
  }
}
