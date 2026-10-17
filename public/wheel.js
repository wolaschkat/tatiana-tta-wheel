/* Wheel canvas renderer + spin animation controller + sounds + confetti. Used by admin and overlay. */
(function () {
  'use strict';
  const T = window.TTA;
  const TAU = Math.PI * 2;
  const rad = (deg) => (deg * Math.PI) / 180;

  // ---------- sound (synthesized, no asset files) ----------
  const Sound = {
    ctx: null, volume: 0.6, enabled: true, spin: true, win: true,
    unlock() {
      try {
        if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (this.ctx.state === 'suspended') this.ctx.resume();
      } catch (_) {}
    },
    tone(freq, dur, type, gain, when) {
      if (!this.ctx || this.ctx.state !== 'running') return;
      const t = this.ctx.currentTime + (when || 0);
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * this.volume), t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(this.ctx.destination);
      o.start(t); o.stop(t + dur + 0.02);
    },
    tick() { if (this.enabled && this.spin) this.tone(1100 + Math.random() * 80, 0.04, 'square', 0.12); },
    fanfare() {
      if (!this.enabled || !this.win) return;
      [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.28, 'triangle', 0.35, i * 0.11));
      this.tone(1319, 0.7, 'triangle', 0.35, 0.46);
    },
  };

  // ---------- wheel ----------
  function fitText(ctx, text, maxW, maxPx, minPx) {
    let px = maxPx;
    ctx.font = `800 ${px}px "Arial Narrow", Impact, "Segoe UI", sans-serif`;
    while (ctx.measureText(text).width > maxW && px > minPx) { px -= 1; ctx.font = `800 ${px}px "Arial Narrow", Impact, "Segoe UI", sans-serif`; }
    if (ctx.measureText(text).width > maxW) {
      let t = text;
      while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
      return t + '…';
    }
    return text;
  }

  function createWheel(canvas) {
    const ctx = canvas.getContext('2d');
    const off = document.createElement('canvas');
    let layout = [], rotation = 0, size = 0, dpr = 1;

    function resize() {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth || canvas.width;
      size = Math.max(100, Math.round(w * dpr));
      canvas.width = size; canvas.height = size;
      off.width = size; off.height = size;
      paintWheel();
      draw();
    }

    function paintWheel() {
      const c = off.getContext('2d');
      c.clearRect(0, 0, size, size);
      const cx = size / 2, R = size / 2 - size * 0.06;
      c.save(); c.translate(cx, cx);
      if (!layout.length) {
        c.fillStyle = '#1c1c1c'; c.beginPath(); c.arc(0, 0, R, 0, TAU); c.fill();
        c.fillStyle = '#fff'; c.font = `700 ${size * 0.04}px sans-serif`; c.textAlign = 'center'; c.fillText('No active segments', 0, 0);
        c.restore(); return;
      }
      // solid segment fills
      layout.forEach((s) => {
        const a0 = rad(s.start) - Math.PI / 2, a1 = rad(s.end) - Math.PI / 2;
        c.beginPath(); c.moveTo(0, 0); c.arc(0, 0, R, a0, a1); c.closePath();
        c.fillStyle = T.hexOf(s.color); c.fill();
      });
      // clear separators
      c.lineWidth = Math.max(2, size * 0.006); c.strokeStyle = '#2b2b2b'; c.lineJoin = 'round';
      layout.forEach((s) => { const a = rad(s.start) - Math.PI / 2; c.beginPath(); c.moveTo(0, 0); c.lineTo(Math.cos(a) * R, Math.sin(a) * R); c.stroke(); });
      // labels
      layout.forEach((s) => {
        const mid = rad(s.mid) - Math.PI / 2;
        const span = rad(s.end - s.start);
        c.save(); c.rotate(mid);
        const flip = Math.cos(mid) < 0; // left half: flip so the text is not upside-down
        if (flip) c.rotate(Math.PI);
        c.fillStyle = T.textColor(s.color); c.textAlign = flip ? 'left' : 'right'; c.textBaseline = 'middle';
        const rOuter = R * 0.93, rInner = R * 0.27;
        const arcH = 2 * (R * 0.6) * Math.tan(Math.min(span, 2.6) / 2) * 0.62; // available glyph height near mid radius
        const maxPx = Math.max(7 * dpr, Math.min(R * 0.11, arcH));
        const label = fitText(c, s.name, rOuter - rInner, maxPx, 7 * dpr);
        c.fillText(label, flip ? -rOuter : rOuter, 0);
        c.restore();
      });
      // rim: white ring + thin red outer edge
      c.lineWidth = size * 0.012; c.strokeStyle = '#FFFFFF'; c.beginPath(); c.arc(0, 0, R + size * 0.006, 0, TAU); c.stroke();
      c.lineWidth = size * 0.01; c.strokeStyle = '#E50914'; c.beginPath(); c.arc(0, 0, R + size * 0.016, 0, TAU); c.stroke();
      // hub
      c.fillStyle = '#080808'; c.beginPath(); c.arc(0, 0, R * 0.12, 0, TAU); c.fill();
      c.lineWidth = size * 0.01; c.strokeStyle = '#FFFFFF'; c.stroke();
      c.fillStyle = '#E50914'; c.beginPath(); c.arc(0, 0, R * 0.05, 0, TAU); c.fill();
      c.restore();
    }

    function draw() {
      if (!size) return;
      ctx.clearRect(0, 0, size, size);
      const cx = size / 2;
      ctx.save(); ctx.translate(cx, cx); ctx.rotate(rad(rotation)); ctx.translate(-cx, -cx);
      ctx.drawImage(off, 0, 0); ctx.restore();
      // pointer (fixed at top): red body, white detail
      const w = size * 0.05, h = size * 0.095, y0 = size * 0.014;
      ctx.save(); ctx.translate(cx, y0);
      ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = size * 0.02;
      ctx.beginPath(); ctx.moveTo(-w, 0); ctx.lineTo(w, 0); ctx.lineTo(0, h * 1.35); ctx.closePath();
      ctx.fillStyle = '#E50914'; ctx.fill(); ctx.shadowBlur = 0;
      ctx.lineWidth = size * 0.006; ctx.strokeStyle = '#FFFFFF'; ctx.stroke();
      ctx.beginPath(); ctx.arc(0, h * 0.18, size * 0.013, 0, TAU); ctx.fillStyle = '#FFFFFF'; ctx.fill();
      ctx.restore();
    }

    return {
      setLayout(l) { layout = l || []; paintWheel(); draw(); },
      setRotation(r) { rotation = r; draw(); },
      resize,
      get layout() { return layout; },
    };
  }

  // ---------- animation controller (follows server state; never starts a spin) ----------
  // handlers: onReveal(spinOrResult), onSpinStart(spin), onIdle()
  function createController(wheel, handlers) {
    let snap = null, offset = 0, lastSpinId = null, revealedId = null, lastSeg = -1, lastTickAt = 0, raf = 0;

    function frame() {
      raf = requestAnimationFrame(frame);
      if (!snap) return;
      const s = snap.spin;
      if (!s) { wheel.setRotation(snap.rest); return; }
      const now = Date.now() + offset;
      const t = (now - s.startedAt) / s.durationMs;
      const rot = s.fromRot + (s.toRot - s.fromRot) * T.ease(t, s.decel);
      wheel.setRotation(rot);
      if (t < 1) {
        const i = T.segmentAt(wheel.layout, rot);
        if (i !== lastSeg) { if (lastSeg !== -1 && performance.now() - lastTickAt > 28) { Sound.tick(); lastTickAt = performance.now(); } lastSeg = i; }
      } else if (revealedId !== s.id) { revealedId = s.id; handlers.onReveal && handlers.onReveal(s); }
    }

    return {
      update(newSnap) {
        offset = newSnap.serverTime - Date.now();
        const prev = snap; snap = newSnap;
        const s = newSnap.spin;
        if (s && s.id !== lastSpinId) {
          lastSpinId = s.id; lastSeg = -1;
          const fresh = (Date.now() + offset) - s.startedAt < 1500;
          handlers.onSpinStart && handlers.onSpinStart(s, fresh);
          if (fresh) Sound.unlock();
        }
        if (!s && prev && prev.spin && revealedId !== prev.spin.id) { revealedId = prev.spin.id; handlers.onReveal && handlers.onReveal(prev.spin); }
        if (!raf) raf = requestAnimationFrame(frame);
      },
      isRevealed(spin) { return revealedId === spin.id || (Date.now() + offset) >= spin.endsAt; },
    };
  }

  // ---------- confetti ----------
  function confetti(canvas) {
    const c = canvas.getContext('2d');
    canvas.width = canvas.clientWidth; canvas.height = canvas.clientHeight;
    const colors = ['#E50914', '#FFFFFF', '#080808', '#E50914', '#FFFFFF'];
    const ps = Array.from({ length: 140 }, () => ({
      x: canvas.width / 2 + (Math.random() - 0.5) * canvas.width * 0.2, y: canvas.height * 0.45,
      vx: (Math.random() - 0.5) * 16, vy: -Math.random() * 16 - 4, w: 6 + Math.random() * 8, h: 4 + Math.random() * 6,
      r: Math.random() * TAU, vr: (Math.random() - 0.5) * 0.4, col: colors[(Math.random() * colors.length) | 0],
    }));
    let frames = 0;
    (function step() {
      c.clearRect(0, 0, canvas.width, canvas.height);
      ps.forEach((p) => { p.vy += 0.38; p.x += p.vx; p.y += p.vy; p.r += p.vr; c.save(); c.translate(p.x, p.y); c.rotate(p.r); c.fillStyle = p.col; c.strokeStyle = '#E50914'; c.lineWidth = 0.5; c.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); c.strokeRect(-p.w / 2, -p.h / 2, p.w, p.h); c.restore(); });
      if (++frames < 200) requestAnimationFrame(step); else c.clearRect(0, 0, canvas.width, canvas.height);
    })();
  }

  window.TTAWheel = { createWheel, createController, Sound, confetti };
})();
