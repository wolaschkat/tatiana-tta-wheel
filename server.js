'use strict';
/*
 * TATIANA TTA WHEEL — server
 * MANUAL SPIN ONLY: the single code path that can start a spin is POST /api/spin (admin token required),
 * triggered by the SPIN button. Subscription events only call ingestEvent(), which updates the queue.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Load .env automatically so the Kick settings survive restarts (variables already set in the shell win).
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch (_) {}
const T = require('./public/shared.js');
const KickModule = require('./lib/kick.js');

const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- secrets (admin + overlay tokens) ----------
const secretsFile = path.join(DATA_DIR, 'secrets.json');
let secrets = {};
try { secrets = JSON.parse(fs.readFileSync(secretsFile, 'utf8')); } catch (_) {}
if (!secrets.adminToken) secrets.adminToken = crypto.randomBytes(24).toString('base64url');
if (!secrets.overlayToken) secrets.overlayToken = crypto.randomBytes(18).toString('base64url');
fs.writeFileSync(secretsFile, JSON.stringify(secrets, null, 2), { mode: 0o600 });
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || secrets.adminToken;
const OVERLAY_TOKEN = process.env.OVERLAY_TOKEN || secrets.overlayToken;
const safeEq = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ---------- state ----------
const stateFile = path.join(DATA_DIR, 'state.json');
function freshState() {
  return { v: 1, config: T.defaultConfig(), participants: {}, orderCounter: 0, selectedKey: null, spin: null, rest: 0, lastResult: null, history: [], processedEvents: [], activity: [], rev: 0 };
}
let state = freshState();
try {
  const loaded = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  state = { ...state, ...loaded };
  state.config = T.sanitizeConfig(loaded.config, T.defaultConfig());
} catch (_) {}
const processed = new Set(state.processedEvents);

function save() {
  state.rev++;
  state.processedEvents = [...processed].slice(-5000);
  const tmp = stateFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, stateFile);
}
function activity(text, kind) {
  state.activity.unshift({ t: Date.now(), text, kind: kind || 'info' });
  state.activity.length = Math.min(state.activity.length, 60);
}
const httpErr = (code, msg, extra) => Object.assign(new Error(msg), { code, extra });
const rand = () => crypto.randomBytes(6).readUIntBE(0, 6) / 2 ** 48;

// ---------- participants ----------
const pKeyFor = (userId, username) => (userId ? 'id:' + userId : 'u:' + String(username).toLowerCase());
function findParticipant(userId, username) {
  const lower = String(username).toLowerCase();
  for (const p of Object.values(state.participants)) {
    if (userId && p.userId === userId) return p;
    if (!userId && p.username.toLowerCase() === lower) return p;
    if (userId && !p.userId && p.username.toLowerCase() === lower) { p.userId = userId; return p; }
  }
  return null;
}
function ensureParticipant(userId, username) {
  let p = findParticipant(userId, username);
  if (!p) {
    p = { key: pKeyFor(userId, username), userId: userId || null, username: String(username).slice(0, 60), earned: 0, remaining: 0, completed: 0, subEvents: 0, firstAt: Date.now(), lastActivity: Date.now(), order: ++state.orderCounter, grants: [] };
    if (state.participants[p.key]) p.key = p.key + ':' + crypto.randomBytes(3).toString('hex');
    state.participants[p.key] = p;
  } else if (username && p.username !== username) p.username = String(username).slice(0, 60);
  return p;
}
function addSpins(p, n, source, eventId) {
  p.earned += n;
  p.remaining += n;
  p.lastActivity = Date.now();
  p.grants.push({ source, eventId: eventId || null, remaining: n });
  if (p.grants.length > 200) p.grants = p.grants.filter((g) => g.remaining > 0).slice(-200);
}
function consumeGrant(p) {
  const g = p.grants.find((x) => x.remaining > 0);
  if (g) { g.remaining--; return { source: g.source, eventId: g.eventId }; }
  return { source: 'manual', eventId: null };
}
function setRemaining(p, n) {
  n = Math.max(0, Math.min(100000, Math.floor(n)));
  const delta = n - p.remaining;
  if (delta > 0) p.grants.push({ source: 'manual', eventId: null, remaining: delta });
  else if (delta < 0) {
    let cut = -delta;
    for (let i = p.grants.length - 1; i >= 0 && cut > 0; i--) { const t = Math.min(cut, p.grants[i].remaining); p.grants[i].remaining -= t; cut -= t; }
  }
  p.remaining = n;
  p.earned = p.completed + p.remaining;
  p.lastActivity = Date.now();
}
function statusOf(p) {
  if (state.selectedKey === p.key && state.spin) return 'SPINNING';
  if (state.selectedKey === p.key) return 'SELECTED';
  return p.remaining > 0 ? 'WAITING' : 'DONE';
}

// ---------- event ingestion (queue only — never spins) ----------
function ingestEvent(ev) {
  const id = ev.eventId || crypto.createHash('sha1').update([ev.type, ev.userId || ev.username, ev.ts, ev.qty].join('|')).digest('hex');
  if (processed.has(id)) return { duplicate: true };
  processed.add(id);
  const spins = T.spinsForEvent(state.config, ev.type, ev.qty);
  if (spins <= 0) { activity(`${ev.username}: ${ev.type} ×${ev.qty} ignored (0 spins by rules)`, 'event'); save(); broadcast(); return { ignored: true }; }
  const p = ensureParticipant(ev.userId, ev.username);
  addSpins(p, spins, ev.source || 'event', id);
  p.subEvents += 1;
  activity(`${p.username} — +${spins} SPIN${spins === 1 ? '' : 'S'} (${ev.type} ×${ev.qty}${ev.source === 'test' ? ', simulated' : ''})`, 'event');
  save();
  broadcast();
  return { added: spins, key: p.key };
}

// ---------- spin lifecycle ----------
let finishTimer = null;
function scheduleFinish() {
  clearTimeout(finishTimer);
  if (!state.spin || state.spin.status !== 'spinning') return;
  // This timer only FINISHES a spin that the streamer already started. It never starts one.
  finishTimer = setTimeout(finishSpin, Math.max(0, state.spin.endsAt - Date.now()) + 50);
}

function startSpin() {
  if (state.spin) throw httpErr(409, state.spin.status === 'awaiting_confirm' ? 'Confirm the previous result first.' : 'A spin is already in progress.');
  const v = T.validate(state.config);
  if (!v.ok) throw httpErr(400, 'Wheel configuration is invalid.', { problems: v.problems });
  const p = state.participants[state.selectedKey];
  if (!p) throw httpErr(400, 'Select a participant first.');
  if (p.remaining < 1) throw httpErr(400, `${p.username} has no spins remaining.`);
  const seg = T.pickWeighted(state.config, rand);
  if (!seg) throw httpErr(400, 'No segment can win.');
  const lay = T.layout(state.config);
  const offset = 0.12 + rand() * 0.76;
  const anim = state.config.anim;
  const fromRot = state.rest;
  const toRot = T.computeTarget(lay, seg.id, offset, fromRot, anim.rotations);
  const now = Date.now();
  state.spin = {
    id: crypto.randomBytes(6).toString('hex'), key: p.key, username: p.username, spinNumber: p.completed + 1,
    segmentId: seg.id, segmentName: seg.name, segmentColor: seg.color, segmentDesc: seg.desc, offset,
    fromRot, toRot, rotations: anim.rotations, durationMs: Math.round(anim.duration * 1000), decel: anim.decel,
    startedAt: now, endsAt: now + Math.round(anim.duration * 1000), status: 'spinning',
  };
  // The result is persisted BEFORE the animation, so a refresh or crash can never change it.
  save();
  scheduleFinish();
  broadcast();
  return state.spin;
}

function finishSpin() {
  const s = state.spin;
  if (!s || s.status !== 'spinning') return;
  state.rest = T.mod(s.toRot, 360);
  if (state.config.confirmResult) { s.status = 'awaiting_confirm'; save(); broadcast(); return; }
  completeSpin();
}

function completeSpin() {
  const s = state.spin;
  if (!s) throw httpErr(409, 'No spin to complete.');
  const p = state.participants[s.key];
  let src = { source: 'manual', eventId: null };
  if (p) {
    p.remaining = Math.max(0, p.remaining - 1);
    p.completed += 1;
    p.lastActivity = Date.now();
    src = consumeGrant(p);
  }
  const entry = { id: crypto.randomBytes(5).toString('hex'), username: s.username, segment: s.segmentName, color: s.segmentColor, desc: s.segmentDesc, at: Date.now(), spinNumber: s.spinNumber, source: src.source, eventId: src.eventId };
  state.history.unshift(entry);
  if (state.history.length > 20000) state.history.length = 20000;
  state.lastResult = { ...entry };
  state.rest = T.mod(s.toRot, 360);
  state.spin = null;
  activity(`${s.username} won “${s.segmentName}”`, 'win');
  save();
  broadcast();
}

// ---------- projections ----------
function participantList() {
  return Object.values(state.participants).map((p) => ({ key: p.key, username: p.username, earned: p.earned, remaining: p.remaining, completed: p.completed, subEvents: p.subEvents, lastActivity: p.lastActivity, firstAt: p.firstAt, order: p.order, status: statusOf(p) }));
}
function adminView() {
  return {
    role: 'admin', rev: state.rev, serverTime: Date.now(), config: state.config, validation: T.validate(state.config),
    participants: participantList(), selectedKey: state.selectedKey, spin: state.spin, rest: state.rest, lastResult: state.lastResult,
    history: state.history.slice(0, 200), historyTotal: state.history.length, activity: state.activity.slice(0, 40), kick: kick.status(),
  };
}
function overlayView() {
  const sel = state.participants[state.selectedKey];
  const cfg = state.config;
  return {
    role: 'overlay', rev: state.rev, serverTime: Date.now(),
    layout: T.layout(cfg).map(({ id, name, color, start, end }) => ({ id, name, color, start, end })),
    anim: cfg.anim, overlay: cfg.overlay,
    selected: sel ? { username: sel.username, remaining: sel.remaining } : null,
    spin: state.spin, rest: state.rest, lastResult: state.lastResult,
    recent: state.history.slice(0, 6).map((h) => ({ username: h.username, segment: h.segment, color: h.color, at: h.at })),
  };
}

// ---------- SSE ----------
const clients = new Set();
function broadcast() {
  if (!clients.size) return;
  let a = null, o = null;
  for (const c of clients) {
    const payload = c.role === 'admin' ? (a = a || JSON.stringify(adminView())) : (o = o || JSON.stringify(overlayView()));
    c.res.write('event: state\ndata: ' + payload + '\n\n');
  }
}
setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 20000).unref();

// ---------- Kick ----------
const kick = KickModule.create({ dataDir: DATA_DIR, env: process.env, log });
const kickRefresh = () => { if (kick.status().authorized) kick.check().then(broadcast).catch(() => {}); };
setInterval(kickRefresh, 5 * 60 * 1000).unref();

// ---------- http helpers ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const send = (res, code, body, headers) => { res.writeHead(code, { 'Cache-Control': 'no-store', ...(headers || {}) }); res.end(body); };
const sendJson = (res, code, obj) => send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json' });
function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(httpErr(413, 'Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const readJson = async (req) => { const b = await readBody(req); if (!b.length) return {}; try { return JSON.parse(b.toString('utf8')); } catch (_) { throw httpErr(400, 'Invalid JSON'); } };
const isAdmin = (req, q) => safeEq(req.headers['x-admin-token'] || q.get('token'), ADMIN_TOKEN);
const csvCell = (v) => { v = String(v == null ? '' : v); if (/^[=+\-@]/.test(v)) v = "'" + v; return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };

function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/overlay') pathname = '/overlay.html';
  const root = path.join(__dirname, 'public');
  const file = path.normalize(path.join(root, decodeURIComponent(pathname)));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found');
  send(res, 200, fs.readFileSync(file), { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
}

// ---------- routes ----------
async function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  const q = u.searchParams;
  const p = u.pathname;
  const m = req.method;

  // Public: Kick webhook receiver (authenticated by Kick's signature, not by a token)
  if (p === '/webhooks/kick' && m === 'POST') {
    const raw = await readBody(req);
    if (!(await kick.verifyWebhook(req.headers, raw))) { log('webhook rejected: bad signature'); return sendJson(res, 401, { error: 'invalid signature' }); }
    sendJson(res, 200, { ok: true });
    let body; try { body = JSON.parse(raw.toString('utf8')); } catch (_) { return; }
    for (const ev of kick.normalize(req.headers, body, state.config.giftRecipient)) ingestEvent(ev);
    broadcast();
    return;
  }

  // Public (browser redirect from Kick): OAuth callback, protected by the PKCE `state`
  if (p === '/kick/callback' && m === 'GET') {
    try { await kick.handleCallback(Object.fromEntries(q)); broadcast(); return send(res, 302, '', { Location: '/#kick=connected' }); }
    catch (e) { return send(res, 400, `<meta charset=utf-8><body style="font:16px sans-serif;background:#080808;color:#fff;padding:2rem"><h2>Kick connection failed</h2><p>${String(e.message).replace(/</g, '&lt;')}</p><p><a style="color:#E50914" href="/">Back</a></p>`, { 'Content-Type': 'text/html; charset=utf-8' }); }
  }
  if (p === '/kick/login' && m === 'GET') {
    if (!isAdmin(req, q)) return send(res, 401, 'Unauthorized');
    try { return send(res, 302, '', { Location: kick.loginUrl() }); } catch (e) { return send(res, 400, e.message); }
  }

  // SSE
  if (p === '/events' && m === 'GET') {
    const role = q.get('role') === 'overlay' ? 'overlay' : 'admin';
    if (role === 'admin' && !isAdmin(req, q)) return send(res, 401, 'Unauthorized');
    if (role === 'overlay' && !safeEq(q.get('token'), OVERLAY_TOKEN)) return send(res, 401, 'Unauthorized');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const c = { res, role };
    clients.add(c);
    req.on('close', () => clients.delete(c));
    res.write('retry: 2000\nevent: state\ndata: ' + JSON.stringify(role === 'admin' ? adminView() : overlayView()) + '\n\n');
    return;
  }

  if (p.startsWith('/api/')) {
    if (!isAdmin(req, q)) return sendJson(res, 401, { error: 'Unauthorized' });
    const locked = () => { if (state.spin) throw httpErr(409, 'Not allowed while a spin is in progress or awaiting confirmation.'); };

    if (p === '/api/state' && m === 'GET') return sendJson(res, 200, { ...adminView(), overlayToken: OVERLAY_TOKEN });
    if (p === '/api/config' && m === 'POST') {
      locked();
      const b = await readJson(req);
      state.config = T.sanitizeConfig(b.config, state.config);
      activity('Configuration saved'); save(); broadcast(); return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/config/reset' && m === 'POST') { locked(); state.config = T.defaultConfig(); activity('Configuration reset'); save(); broadcast(); return sendJson(res, 200, { ok: true }); }
    if (p === '/api/participants' && m === 'POST') {
      const b = await readJson(req);
      const name = String(b.username || '').trim();
      if (!name) throw httpErr(400, 'Username required');
      const spins = Math.max(0, Math.min(100000, Math.floor(Number(b.spins) || 0)));
      const pt = ensureParticipant(null, name);
      if (spins) addSpins(pt, spins, 'manual', null);
      activity(`${pt.username} added manually${spins ? ' (+' + spins + ' spins)' : ''}`); save(); broadcast();
      return sendJson(res, 200, { ok: true, key: pt.key });
    }
    let mm = p.match(/^\/api\/participants\/(.+)$/);
    if (mm) {
      const key = decodeURIComponent(mm[1]);
      const pt = state.participants[key];
      if (!pt) throw httpErr(404, 'Participant not found');
      if (m === 'PATCH') {
        const b = await readJson(req);
        if (b.remaining != null) setRemaining(pt, Number(b.remaining));
        if (b.username) pt.username = String(b.username).slice(0, 60);
        activity(`${pt.username}: spins edited → ${pt.remaining} remaining`); save(); broadcast(); return sendJson(res, 200, { ok: true });
      }
      if (m === 'DELETE') {
        if (state.spin && state.spin.key === key) throw httpErr(409, 'This participant is mid-spin.');
        delete state.participants[key];
        if (state.selectedKey === key) state.selectedKey = null;
        activity(`${pt.username} removed from queue`); save(); broadcast(); return sendJson(res, 200, { ok: true }); // history is kept
      }
    }
    if (p === '/api/select' && m === 'POST') {
      locked();
      const b = await readJson(req);
      if (b.key && !state.participants[b.key]) throw httpErr(404, 'Participant not found');
      state.selectedKey = b.key || null; save(); broadcast(); return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/skip' && m === 'POST') {
      locked();
      const pt = state.participants[state.selectedKey];
      if (pt) { pt.order = ++state.orderCounter; activity(`${pt.username} skipped`); }
      state.selectedKey = null; save(); broadcast(); return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/spin' && m === 'POST') { startSpin(); return sendJson(res, 200, { ok: true }); } // the ONLY entry point to a spin
    if (p === '/api/spin/confirm' && m === 'POST') {
      if (!state.spin || state.spin.status !== 'awaiting_confirm') throw httpErr(409, 'Nothing to confirm.');
      completeSpin(); return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/history/clear' && m === 'POST') {
      const b = await readJson(req);
      if (b.confirm !== true) throw httpErr(400, 'Confirmation required');
      state.history = []; state.lastResult = null; activity('History cleared'); save(); broadcast(); return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/history.csv' && m === 'GET') {
      const rows = [['timestamp', 'username', 'winning_segment', 'spin_number_for_user', 'source', 'event_id']];
      for (const h of state.history) rows.push([new Date(h.at).toISOString(), h.username, h.segment, h.spinNumber, h.source, h.eventId || '']);
      return send(res, 200, rows.map((r) => r.map(csvCell).join(',')).join('\n'), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="tta-wheel-history.csv"' });
    }
    if (p === '/api/kick/check' && m === 'POST') { await kick.check(); broadcast(); return sendJson(res, 200, kick.status()); }
    if (p === '/api/kick/subscribe' && m === 'POST') { try { await kick.subscribe(); } catch (e) { throw httpErr(400, e.message); } broadcast(); return sendJson(res, 200, kick.status()); }
    if (p === '/api/kick/disconnect' && m === 'POST') { kick.disconnect(); broadcast(); return sendJson(res, 200, kick.status()); }
    if (p === '/api/dev/simulate' && m === 'POST') {
      // Test helper: behaves exactly like a real event (queue only) and is labeled "test" in history.
      const b = await readJson(req);
      const type = ['new', 'renewal', 'gift'].includes(b.type) ? b.type : 'new';
      const name = String(b.username || 'tatia_fan').trim().slice(0, 60);
      const r = ingestEvent({ eventId: 'sim-' + crypto.randomBytes(6).toString('hex'), type, qty: Math.max(1, Math.floor(b.qty) || 1), userId: null, username: name, ts: new Date().toISOString(), source: 'test' });
      return sendJson(res, 200, r);
    }
    throw httpErr(404, 'Unknown endpoint');
  }

  if (m === 'GET') return serveStatic(req, res, u.pathname);
  send(res, 404, 'Not found');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (res.headersSent) return res.end();
    sendJson(res, e.code && e.code < 600 ? e.code : 500, { error: e.message, ...(e.extra || {}) });
    if (!e.code) log('error', e.stack || e);
  });
});

// Recover an interrupted spin: the stored result is reused, never re-rolled.
if (state.spin) {
  if (state.spin.status === 'spinning') { if (Date.now() >= state.spin.endsAt) finishSpin(); else scheduleFinish(); }
}

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    const base = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
    console.log('\n  TATIANA TTA WHEEL  — manual spin mode only');
    console.log('  Admin   :', `${base}/#token=${ADMIN_TOKEN}`);
    console.log('  Overlay :', `${base}/overlay.html?token=${OVERLAY_TOKEN}   (OBS Browser Source, 1920x1080)`);
    console.log('  Kick    :', kick.status().label, '\n');
    kickRefresh(); // restore the subscription status right away instead of waiting 5 minutes
  });
}
module.exports = { server, state, ingestEvent, T };
