// Optic reticles drawn on canvas: collimator sights (red dot / holographic / 2x) are overlaid on the
// weapon view; magnified optics (ACOG 4x, sniper scope 8x) render a full scope picture with
// lens vignette, mil-dot / BDC reticle, range marks and scope edge shadow.
const TAU = Math.PI * 2;

function fit(cv) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.floor(innerWidth * dpr), h = Math.floor(innerHeight * dpr);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  return { w, h, dpr, m: Math.min(w, h) };
}

// ---------- collimator sights (overlay while ADS, weapon stays visible) ----------
export function drawCollimator(cv, kind) {
  const { w, h, m, dpr } = fit(cv);
  const g = cv.getContext('2d');
  g.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2;
  g.shadowColor = 'rgba(255,40,30,0.9)'; g.shadowBlur = 8 * dpr; g.fillStyle = '#ff3a2a'; g.strokeStyle = '#ff3a2a';
  if (kind === 'red') {
    g.beginPath(); g.arc(cx, cy, 2.6 * dpr, 0, TAU); g.fill();
  } else if (kind === 'holo') {
    g.lineWidth = 2 * dpr;
    g.beginPath(); g.arc(cx, cy, m * 0.036, 0, TAU); g.stroke();
    g.beginPath(); g.arc(cx, cy, 1.8 * dpr, 0, TAU); g.fill();
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) { g.beginPath(); g.moveTo(cx + dx * m * 0.036, cy + dy * m * 0.036); g.lineTo(cx + dx * m * 0.048, cy + dy * m * 0.048); g.stroke(); }
  } else if (kind === 'x2') {
    // 2x prism: thin crosshair with a gap, dark post lines to the edge of the sight window
    g.shadowBlur = 0; g.strokeStyle = 'rgba(10,10,10,0.9)'; g.lineWidth = 2 * dpr;
    const gap = m * 0.012, len = m * 0.05;
    g.beginPath(); g.moveTo(cx - len, cy); g.lineTo(cx - gap, cy); g.moveTo(cx + gap, cy); g.lineTo(cx + len, cy); g.moveTo(cx, cy + gap); g.lineTo(cx, cy + len); g.stroke();
    g.shadowBlur = 8 * dpr; g.shadowColor = 'rgba(255,40,30,0.9)'; g.beginPath(); g.arc(cx, cy, 2.2 * dpr, 0, TAU); g.fill();
  }
}

// ---------- magnified optics ----------
const mil = (m, zoom) => m * 0.0095 * (zoom >= 6 ? 1 : 1.5); // pixels per mil-ish spacing

export function drawScope(cv, kind, zoom) {
  const { w, h, m, dpr } = fit(cv);
  const g = cv.getContext('2d');
  g.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2;
  const R = m * (kind === 'scope' ? 0.46 : kind === 'x2' ? 0.43 : 0.40);

  // outside the lens: the surroundings stay visible (blurred by the #scopeBlur CSS layer); a thick scope-tube ring frames the lens
  g.fillStyle = 'rgba(0,0,0,0.22)';
  g.beginPath(); g.rect(0, 0, w, h); g.arc(cx, cy, R, 0, TAU, true); g.fill('evenodd');
  const rim = R * 0.13;
  // gun-rail body rising from the bottom of the screen into the scope ring (like looking through a real scope on a rifle)
  {
    const bw = R * 0.62, top = cy + R * 0.9;
    const rg = g.createLinearGradient(cx - bw, 0, cx + bw, 0);
    rg.addColorStop(0, '#0b0c0e'); rg.addColorStop(0.25, '#26292d'); rg.addColorStop(0.5, '#15171a'); rg.addColorStop(0.75, '#26292d'); rg.addColorStop(1, '#0b0c0e');
    g.fillStyle = rg; g.beginPath(); g.moveTo(cx - bw * 0.55, top); g.lineTo(cx + bw * 0.55, top); g.lineTo(cx + bw, h); g.lineTo(cx - bw, h); g.closePath(); g.fill();
    g.fillStyle = '#050607';
    for (let y = top + R * 0.04, i = 0; y < h; y += R * 0.075, i++) { const k = (y - top) / (h - top); g.fillRect(cx - bw * (0.5 + 0.45 * k) * 0.92, y, bw * (0.5 + 0.45 * k) * 1.84, R * 0.022); }
  }
  // outer ring: matte black with a metallic sheen, knurled edge ticks and an inner chamfer
  g.lineWidth = rim; g.strokeStyle = '#08090a'; g.beginPath(); g.arc(cx, cy, R + rim / 2 - 1 * dpr, 0, TAU); g.stroke();
  const sheen = g.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
  sheen.addColorStop(0, 'rgba(210,222,235,0.42)'); sheen.addColorStop(0.3, 'rgba(210,222,235,0.06)'); sheen.addColorStop(0.7, 'rgba(0,0,0,0)'); sheen.addColorStop(1, 'rgba(160,175,190,0.22)');
  g.lineWidth = rim * 0.55; g.strokeStyle = sheen; g.beginPath(); g.arc(cx, cy, R + rim * 0.5, 0, TAU); g.stroke();
  g.strokeStyle = 'rgba(0,0,0,0.9)'; g.lineWidth = 1.6 * dpr;
  for (let i = 0; i < 72; i++) { const a = (i / 72) * TAU, r1 = R + rim * 0.74, r2 = R + rim * 0.94; g.beginPath(); g.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); g.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2); g.stroke(); }
  g.lineWidth = 2.2 * dpr; g.strokeStyle = 'rgba(160,175,190,0.4)'; g.beginPath(); g.arc(cx, cy, R + rim - 1 * dpr, 0, TAU); g.stroke();     // outer edge highlight
  g.lineWidth = 3 * dpr; g.strokeStyle = '#000'; g.beginPath(); g.arc(cx, cy, R + 1.5 * dpr, 0, TAU); g.stroke();                                // lens seat
  g.lineWidth = 1.2 * dpr; g.strokeStyle = 'rgba(190,205,220,0.5)'; g.beginPath(); g.arc(cx, cy, R - 0.5 * dpr, 0, TAU); g.stroke();             // inner chamfer glint
  // elevation turret cap on top and windage knob at the side
  g.fillStyle = '#0d0e10'; g.strokeStyle = 'rgba(160,175,190,0.35)'; g.lineWidth = 1.5 * dpr;
  g.beginPath(); g.roundRect(cx - R * 0.09, cy - R - rim - R * 0.07, R * 0.18, R * 0.09, 6 * dpr); g.fill(); g.stroke();
  g.beginPath(); g.roundRect(cx + R + rim - R * 0.01, cy - R * 0.09, R * 0.08, R * 0.18, 6 * dpr); g.fill(); g.stroke();
  const edge = g.createRadialGradient(cx, cy, R * 0.86, cx, cy, R);
  edge.addColorStop(0, 'rgba(0,0,0,0)'); edge.addColorStop(0.8, 'rgba(0,0,0,0.25)'); edge.addColorStop(1, 'rgba(0,0,0,0.7)');
  g.fillStyle = edge; g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.fill();
  // glass rim + faint lens tint / glint
  g.strokeStyle = 'rgba(120,150,170,0.35)'; g.lineWidth = 3 * dpr; g.beginPath(); g.arc(cx, cy, R - 1.5 * dpr, 0, TAU); g.stroke();
  const tint = g.createRadialGradient(cx - R * 0.35, cy - R * 0.45, 0, cx, cy, R);
  tint.addColorStop(0, 'rgba(180,220,255,0.10)'); tint.addColorStop(0.5, 'rgba(90,140,180,0.03)'); tint.addColorStop(1, 'rgba(0,20,40,0.12)');
  g.fillStyle = tint; g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.fill();

  g.save();
  g.beginPath(); g.arc(cx, cy, R - 2 * dpr, 0, TAU); g.clip();
  const k = mil(m, zoom);
  if (kind === 'scope') {
    // mil-dot duplex reticle: thick outer posts, fine centre cross, dots every mil, ranging ticks
    g.fillStyle = '#050505'; g.strokeStyle = '#050505';
    const thick = 5 * dpr, fine = 1.4 * dpr, inner = k * 1.2;
    g.fillRect(cx - R, cy - thick / 2, R - inner * 2.2, thick); g.fillRect(cx + inner * 2.2, cy - thick / 2, R - inner * 2.2, thick);
    g.fillRect(cx - thick / 2, cy + inner * 2.2, thick, R - inner * 2.2); g.fillRect(cx - thick / 2, cy - R, thick, R - inner * 2.2);
    g.lineWidth = fine;
    g.beginPath(); g.moveTo(cx - inner * 2.3, cy); g.lineTo(cx + inner * 2.3, cy); g.moveTo(cx, cy - inner * 2.3); g.lineTo(cx, cy + inner * 2.3); g.stroke();
    for (let i = 1; i <= 9; i++) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (i > 2.3 / 1.2 * 1.2 && i < 2) continue;
        const d = i * k;
        if (d < inner * 2.3 && i < 3) { if (i === 1 || i === 2) { g.beginPath(); g.arc(cx + dx * d, cy + dy * d, 2 * dpr, 0, TAU); g.fill(); } continue; }
        g.beginPath(); g.arc(cx + dx * d, cy + dy * d, 2.2 * dpr, 0, TAU); g.fill();
      }
    }
    // holdover ticks below centre
    g.lineWidth = 1.4 * dpr;
    for (let i = 3; i <= 9; i += 2) { g.beginPath(); g.moveTo(cx - 10 * dpr, cy + i * k * 1.0); g.lineTo(cx + 10 * dpr, cy + i * k * 1.0); g.stroke(); }
    // tiny centre dot
    g.fillStyle = '#c21b12'; g.beginPath(); g.arc(cx, cy, 1.6 * dpr, 0, TAU); g.fill();
  } else if (kind === 'x2') {
    // 2x combat optic: thin cross with an illuminated ring-and-dot, wide field of view
    g.strokeStyle = 'rgba(8,8,8,0.92)'; g.lineWidth = 2.4 * dpr;
    g.beginPath(); g.moveTo(cx - R, cy); g.lineTo(cx - m * 0.05, cy); g.moveTo(cx + m * 0.05, cy); g.lineTo(cx + R, cy); g.moveTo(cx, cy + m * 0.05); g.lineTo(cx, cy + R); g.moveTo(cx, cy - m * 0.05); g.lineTo(cx, cy - R); g.stroke();
    g.shadowColor = 'rgba(255,50,30,0.95)'; g.shadowBlur = 9 * dpr; g.strokeStyle = '#ff3b2a'; g.fillStyle = '#ff3b2a'; g.lineWidth = 2.2 * dpr;
    g.beginPath(); g.arc(cx, cy, m * 0.03, 0, TAU); g.stroke(); g.beginPath(); g.arc(cx, cy, 2 * dpr, 0, TAU); g.fill();
    for (let i = 1; i <= 4; i++) { const y = cy + m * 0.03 + i * k * 1.4; g.beginPath(); g.moveTo(cx - m * 0.012 * (i % 2 ? 1 : 1.8), y); g.lineTo(cx + m * 0.012 * (i % 2 ? 1 : 1.8), y); g.stroke(); }
  } else {
    // ACOG-style: illuminated chevron with ballistic drop marks
    g.shadowColor = 'rgba(255,50,30,0.95)'; g.shadowBlur = 10 * dpr; g.strokeStyle = '#ff3b2a'; g.fillStyle = '#ff3b2a'; g.lineWidth = 2.6 * dpr;
    const c = m * 0.034;
    g.beginPath(); g.moveTo(cx - c, cy + c * 0.9); g.lineTo(cx, cy - c * 0.15); g.lineTo(cx + c, cy + c * 0.9); g.stroke();
    g.beginPath(); g.arc(cx, cy, 1.8 * dpr, 0, TAU); g.fill();
    g.lineWidth = 2 * dpr;
    for (let i = 1; i <= 5; i++) {
      const y = cy + c * 0.9 + i * k * 1.15, wdt = (i % 2 ? 0.55 : 0.85) * c;
      g.beginPath(); g.moveTo(cx - wdt, y); g.lineTo(cx + wdt, y); g.stroke();
    }
    g.shadowBlur = 0; g.strokeStyle = 'rgba(8,8,8,0.9)'; g.lineWidth = 3 * dpr;
    g.beginPath(); g.moveTo(cx - R, cy); g.lineTo(cx - c * 2.4, cy); g.moveTo(cx + R, cy); g.lineTo(cx + c * 2.4, cy); g.stroke();
    g.beginPath(); g.moveTo(cx, cy + R); g.lineTo(cx, cy + c * 6.2); g.stroke();
  }
  g.restore();
}
