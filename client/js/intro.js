// "PRESENTED BY GG GAMES" opening sequence (CSS-animated, dust particles on canvas, optional synth sting).
const $ = (id) => document.getElementById(id);
const TOTAL_MS = 6800;

export function playIntro(audio) {
  return new Promise((resolve) => {
    const root = $('intro');
    if (!root) return resolve();
    const gg = $('inGG');
    gg.innerHTML = [...'GG GAMES'].map((ch, i) => (ch === ' ' ? '<span class="sp"></span>' : `<span style="animation-delay:${1.3 + i * 0.09}s">${ch}</span>`)).join('');
    // drifting dust / light motes
    const cv = $('introFx'), ctx = cv.getContext('2d');
    const fit = () => { cv.width = innerWidth; cv.height = innerHeight; };
    fit(); window.addEventListener('resize', fit);
    const P = Array.from({ length: 70 }, () => ({ x: Math.random(), y: Math.random(), z: 0.3 + Math.random() * 0.7, s: 0.3 + Math.random() * 1.6 }));
    let raf = 0, t0 = performance.now(), done = false;
    const draw = (now) => {
      if (done) return;
      raf = requestAnimationFrame(draw);
      const t = (now - t0) / 1000;
      ctx.clearRect(0, 0, cv.width, cv.height);
      for (const p of P) {
        p.x += (0.004 + p.z * 0.01) * 0.016; p.y -= 0.002 * p.z * 0.016 * 4;
        if (p.x > 1.02) p.x = -0.02; if (p.y < -0.02) p.y = 1.02;
        const a = (0.12 + 0.35 * p.z) * Math.min(1, t / 1.2) * (0.6 + 0.4 * Math.sin(t * 2 + p.s * 9));
        ctx.fillStyle = `rgba(150,210,255,${a})`;
        ctx.beginPath(); ctx.arc(p.x * cv.width, p.y * cv.height, p.s * p.z * 1.6, 0, Math.PI * 2); ctx.fill();
      }
    };
    raf = requestAnimationFrame(draw);

    const sting = () => {
      try {
        const c = audio && audio.ctx;
        if (!c || c.state !== 'running') return;
        const t = c.currentTime;
        audio._tone(t + 3.55, 1.6, 70, 28, 0.55, 0);          // sub boom with the flash
        audio._noise(t + 3.5, 1.8, 900, 0.5, 0.35, 0, 'lowpass');
        audio._tone(t + 1.3, 2.4, 220, 440, 0.05, 0, 'sine');  // rising shimmer under the letters
        audio._noise(t + 3.3, 0.5, 5000, 2, 0.12, 0, 'highpass');
      } catch {}
    };
    if (audio) { try { audio.init(); if (audio.ctx && audio.ctx.state === 'suspended') audio.ctx.resume().catch(() => {}); } catch {} }
    sting();

    const finish = () => {
      if (done) return;
      done = true; cancelAnimationFrame(raf);
      window.removeEventListener('resize', fit);
      root.classList.add('out');
      setTimeout(() => { root.classList.add('gone'); resolve(); }, 900);
    };
    const skip = () => { if (performance.now() - t0 > 400) finish(); };
    root.addEventListener('pointerdown', skip);
    window.addEventListener('keydown', function k(e) { if (!done) { skip(); } else window.removeEventListener('keydown', k); });
    setTimeout(finish, TOTAL_MS);
  });
}
