/* Shared logic for TATIANA TTA WHEEL — used by the Node server AND the browser (admin + overlay). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TTA = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PALETTE = { red: '#E50914', black: '#080808', white: '#FFFFFF' };
  const ORDER = ['red', 'black', 'white'];
  const MIN_VISUAL_PCT = 1.5; // 0% / tiny segments stay visible as a sliver in proportional mode

  const mod = (a, n) => ((a % n) + n) % n;
  const clamp = (v, lo, hi, d) => {
    v = Number(v);
    if (!Number.isFinite(v)) return d;
    return Math.min(hi, Math.max(lo, v));
  };
  const uid = () => 's_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3);

  function hexOf(c) {
    if (typeof c !== 'string') return PALETTE.red;
    if (PALETTE[c.toLowerCase()]) return PALETTE[c.toLowerCase()];
    return /^#[0-9a-f]{6}$/i.test(c) ? c.toUpperCase() : PALETTE.red;
  }
  function textColor(hex) {
    const n = parseInt(hexOf(hex).slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return lum > 0.6 ? '#080808' : '#FFFFFF';
  }
  function colorName(hex) {
    const h = hexOf(hex).toUpperCase();
    for (const k of ORDER) if (PALETTE[k].toUpperCase() === h) return k;
    return 'custom';
  }

  // Alternating red/black/white for a new segment appended to the list.
  function autoColor(segments) {
    const last = segments.length ? hexOf(segments[segments.length - 1].color) : null;
    const first = segments.length > 1 ? hexOf(segments[0].color) : null;
    for (let i = 0; i < 3; i++) {
      const c = PALETTE[ORDER[(segments.length + i) % 3]];
      if (c !== last && c !== first) return c;
    }
    return PALETTE[ORDER[segments.length % 3]];
  }

  function defaultConfig() {
    const seg = (name, prob, color, desc) => ({ id: uid(), name, prob, color: PALETTE[color], active: true, desc: desc || '' });
    return {
      segments: [
        seg('Prize A', 50, 'red'),
        seg('Prize B', 25, 'black'),
        seg('Prize C', 15, 'white'),
        seg('Prize D', 8, 'red'),
        seg('Prize E', 2, 'black'),
      ],
      equalSize: false,
      confirmResult: false,
      anim: { duration: 8, rotations: 6, decel: 3.5, sound: true, spinSound: true, winSound: true, volume: 0.6, effects: true },
      perSub: { new: 1, renewal: 1, gift: 1 },
      enabled: { new: true, renewal: true, gift: true },
      spinRules: [{ qty: 1, spins: 1 }, { qty: 2, spins: 2 }, { qty: 5, spins: 5 }, { qty: 10, spins: 10 }],
      giftRecipient: 'gifter', // 'gifter' = spins go to the person who gifted; 'giftees' = to each recipient
      overlay: { wheelX: 700, wheelY: 540, wheelSize: 760, panelX: 1240, panelY: 120, panelScale: 1, showPanel: true, showRecent: true, showResult: true },
    };
  }

  function sanitizeConfig(input, fb) {
    fb = fb || defaultConfig();
    const c = input && typeof input === 'object' ? input : {};
    const out = {};
    const seen = new Set();
    out.segments = (Array.isArray(c.segments) ? c.segments : fb.segments).slice(0, 200).map((s, i) => {
      let id = typeof s.id === 'string' && s.id ? s.id.slice(0, 40) : uid();
      if (seen.has(id)) id = uid();
      seen.add(id);
      return {
        id,
        name: String(s.name == null ? 'Segment ' + (i + 1) : s.name).slice(0, 60),
        prob: Math.round(clamp(s.prob, 0, 100, 0) * 10000) / 10000,
        color: hexOf(s.color),
        active: s.active !== false,
        desc: String(s.desc || '').slice(0, 200),
      };
    });
    out.equalSize = !!c.equalSize;
    out.confirmResult = !!c.confirmResult;
    const a = c.anim || {}, fa = fb.anim;
    out.anim = {
      duration: clamp(a.duration, 2, 60, fa.duration),
      rotations: Math.round(clamp(a.rotations, 1, 30, fa.rotations)),
      decel: clamp(a.decel, 1.2, 8, fa.decel),
      sound: a.sound !== false,
      spinSound: a.spinSound !== false,
      winSound: a.winSound !== false,
      volume: clamp(a.volume, 0, 1, fa.volume),
      effects: a.effects !== false,
    };
    const ps = c.perSub || {}, en = c.enabled || {};
    out.perSub = {};
    out.enabled = {};
    for (const k of ['new', 'renewal', 'gift']) {
      out.perSub[k] = Math.round(clamp(ps[k], 0, 1000, fb.perSub[k]));
      out.enabled[k] = en[k] !== false;
    }
    out.spinRules = (Array.isArray(c.spinRules) ? c.spinRules : fb.spinRules)
      .slice(0, 50)
      .map((r) => ({ qty: Math.round(clamp(r.qty, 1, 100000, 1)), spins: Math.round(clamp(r.spins, 0, 100000, 0)) }));
    out.giftRecipient = c.giftRecipient === 'giftees' ? 'giftees' : 'gifter';
    const o = c.overlay || {}, fo = fb.overlay;
    out.overlay = {
      wheelX: clamp(o.wheelX, -500, 2500, fo.wheelX),
      wheelY: clamp(o.wheelY, -500, 1600, fo.wheelY),
      wheelSize: clamp(o.wheelSize, 200, 1500, fo.wheelSize),
      panelX: clamp(o.panelX, -500, 2500, fo.panelX),
      panelY: clamp(o.panelY, -500, 1600, fo.panelY),
      panelScale: clamp(o.panelScale, 0.3, 3, fo.panelScale),
      showPanel: o.showPanel !== false,
      showRecent: o.showRecent !== false,
      showResult: o.showResult !== false,
    };
    return out;
  }

  const activeSegments = (cfg) => cfg.segments.filter((s) => s.active);

  function validate(cfg) {
    const problems = [];
    const act = activeSegments(cfg);
    let total = 0;
    for (const s of act) total += Number(s.prob) || 0;
    total = Math.round(total * 10000) / 10000;
    if (!act.length) problems.push('There are no active segments.');
    if (act.some((s) => !(Number(s.prob) >= 0))) problems.push('A segment has an invalid probability.');
    if (act.some((s) => !String(s.name).trim())) problems.push('A segment has no name.');
    if (act.length && Math.abs(total - 100) > 0.001) problems.push('Active probabilities add up to ' + total + '%, not 100%.');
    if (act.length && !act.some((s) => s.prob > 0)) problems.push('At least one active segment needs a probability above 0%.');
    return { ok: problems.length === 0, total, problems };
  }

  // Scales active probabilities to sum to exactly 100. Only called when the streamer asks for it.
  function normalize(cfg) {
    const act = activeSegments(cfg);
    if (!act.length) return cfg;
    const sum = act.reduce((a, s) => a + (Number(s.prob) || 0), 0);
    if (sum <= 0) {
      const each = Math.floor((100 / act.length) * 100) / 100;
      act.forEach((s) => (s.prob = each));
    } else act.forEach((s) => (s.prob = Math.round(((Number(s.prob) || 0) * 10000) / sum) / 100));
    const diff = Math.round((100 - act.reduce((a, s) => a + s.prob, 0)) * 100) / 100;
    if (diff) {
      const big = act.reduce((m, s) => (s.prob > m.prob ? s : m), act[0]);
      big.prob = Math.round((big.prob + diff) * 100) / 100;
    }
    return cfg;
  }

  // Weighted random selection by configured probability (NOT by visual size).
  function pickWeighted(cfg, rand) {
    const pool = activeSegments(cfg).filter((s) => s.prob > 0);
    if (!pool.length) return null;
    const total = pool.reduce((a, s) => a + s.prob, 0);
    let r = rand() * total;
    for (const s of pool) {
      if (r < s.prob) return s;
      r -= s.prob;
    }
    return pool[pool.length - 1];
  }

  // Visual layout: degrees clockwise from the top (the pointer).
  function layout(cfg) {
    const act = activeSegments(cfg);
    if (!act.length) return [];
    const w = act.map((s) => (cfg.equalSize ? 1 : Math.max(Number(s.prob) || 0, MIN_VISUAL_PCT)));
    const sum = w.reduce((a, b) => a + b, 0);
    let a = 0;
    return act.map((s, i) => {
      const span = (w[i] / sum) * 360;
      const item = { id: s.id, name: s.name, color: s.color, start: a, end: a + span, mid: a + span / 2 };
      a += span;
      return item;
    });
  }

  // Total rotation so that point `offset` (0..1) of segment `segId` ends under the pointer.
  function computeTarget(lay, segId, offset, fromRot, rotations) {
    const it = lay.find((l) => l.id === segId);
    if (!it) return null;
    const p = it.start + offset * (it.end - it.start);
    return fromRot + rotations * 360 + mod(-p - fromRot, 360);
  }

  const ease = (t, decel) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), decel);

  function segmentAt(lay, rotation) {
    const p = mod(-rotation, 360);
    for (let i = 0; i < lay.length; i++) if (p >= lay[i].start && p < lay[i].end) return i;
    return lay.length - 1;
  }

  // Spins granted for a supported Kick event. Exact-quantity rule wins, else qty * per-sub multiplier.
  function spinsForEvent(cfg, type, qty) {
    if (!cfg.enabled[type]) return 0;
    qty = Math.max(1, Math.floor(qty) || 1);
    const rule = cfg.spinRules.find((r) => r.qty === qty);
    if (rule) return rule.spins;
    return qty * (cfg.perSub[type] || 0);
  }

  return { PALETTE, ORDER, mod, uid, hexOf, textColor, colorName, autoColor, defaultConfig, sanitizeConfig, activeSegments, validate, normalize, pickWeighted, layout, computeTarget, ease, segmentAt, spinsForEvent };
});
