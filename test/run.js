'use strict';
const assert = require('assert');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('../public/shared.js');

let passed = 0;
const ok = (name) => { passed++; console.log('  ✓', name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- unit tests ----------
function unit() {
  console.log('Unit: probabilities and layout');
  const cfg = T.defaultConfig();
  assert.ok(T.validate(cfg).ok); ok('default config is valid (100%)');
  const bad = T.defaultConfig(); bad.segments[0].prob = 40;
  assert.ok(!T.validate(bad).ok); ok('total != 100% is invalid');
  const before = JSON.stringify(bad.segments.map((s) => s.prob));
  T.validate(bad); assert.strictEqual(JSON.stringify(bad.segments.map((s) => s.prob)), before); ok('validate never changes values');
  T.normalize(bad); assert.ok(T.validate(bad).ok); ok('NORMALIZE reaches exactly 100%');

  const c = T.defaultConfig();
  c.segments.push({ id: 'zero', name: 'Zero', prob: 0, color: '#FFFFFF', active: true, desc: '' });
  c.segments.push({ id: 'off', name: 'Off', prob: 50, color: '#E50914', active: false, desc: '' });
  const N = 300000, counts = {};
  for (let i = 0; i < N; i++) { const s = T.pickWeighted(c, () => crypto.randomBytes(6).readUIntBE(0, 6) / 2 ** 48); counts[s.name] = (counts[s.name] || 0) + 1; }
  assert.ok(!counts.Zero && !counts.Off); ok('0% and inactive segments never win');
  for (const s of c.segments.filter((x) => x.active && x.prob > 0)) {
    const got = (counts[s.name] || 0) / N * 100;
    assert.ok(Math.abs(got - s.prob) < 0.35, `${s.name}: expected ${s.prob}% got ${got.toFixed(2)}%`);
  }
  ok('weighted selection matches configured percentages over 300k draws');

  for (const equal of [false, true]) {
    const k = T.defaultConfig(); k.equalSize = equal;
    const lay = T.layout(k);
    assert.ok(Math.abs(lay[lay.length - 1].end - 360) < 1e-6);
    for (const seg of lay) for (const off of [0.12, 0.5, 0.88]) {
      for (const from of [0, 123.4, 359.9]) {
        const to = T.computeTarget(lay, seg.id, off, from, 6);
        assert.strictEqual(lay[T.segmentAt(lay, to)].id, seg.id);
      }
    }
  }
  ok('computed stop angle always lands inside the chosen segment (equal and proportional)');

  const r = T.defaultConfig();
  assert.strictEqual(T.spinsForEvent(r, 'new', 1), 1);
  assert.strictEqual(T.spinsForEvent(r, 'gift', 2), 2);
  assert.strictEqual(T.spinsForEvent(r, 'gift', 7), 7);
  r.spinRules.find((x) => x.qty === 5).spins = 8; assert.strictEqual(T.spinsForEvent(r, 'gift', 5), 8);
  r.enabled.renewal = false; assert.strictEqual(T.spinsForEvent(r, 'renewal', 1), 0);
  ok('subs-to-spins rules (exact rule, multiplier, disabled type)');

  const U = require('../lib/update.js');
  assert.ok(U.compare('v1.0.1', '1.0.0') > 0 && U.compare('v1.10.0', '1.9.9') > 0 && U.compare('2.0.0', '10.0.0') < 0);
  assert.strictEqual(U.compare('v1.0.0', '1.0.0'), 0); assert.strictEqual(U.compare('nightly', '1.0.0'), 0);
  ok('update check compares versions numerically and ignores odd tags');

  const Z = require('../lib/zip.js');
  const files = [{ name: 'tatiana-tta-wheel/server.js', data: Buffer.from('ok') }, { name: 'tatiana-tta-wheel/wheel.ico', data: crypto.randomBytes(5000) }];
  const back = Z.read(Z.write(files));
  assert.ok(back.length === 2 && back.every((f, i) => f.name === files[i].name && f.data.equals(files[i].data))); ok('release zip round-trips byte for byte');
  for (const bad of ['tatiana-tta-wheel/.env', 'tatiana-tta-wheel/data/secrets.json', 'tatiana-tta-wheel/../x.js', 'tatiana-tta-wheel/a\\b.js', 'other/server.js', 'tatiana-tta-wheel//x', 'tatiana-tta-wheel/.git/config'])
    assert.strictEqual(U.safeRel(bad), null, bad);
  assert.strictEqual(U.safeRel('tatiana-tta-wheel/public/admin.js'), 'public/admin.js'); assert.strictEqual(U.safeRel('tatiana-tta-wheel/.env.example'), '.env.example');
  ok('updater never writes .env, data/ or paths outside the app folder');
}

// ---------- integration ----------
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = publicKey.export({ type: 'spki', format: 'pem' });
const edKeys = crypto.generateKeyPairSync('ed25519');

function startServer(dir, port, extraEnv) {
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, KICK_PUBLIC_KEY_PEM: PEM, UPDATE_CHECK: '0', ...extraEnv }, stdio: 'ignore' });
  return p;
}
async function waitUp(base) { for (let i = 0; i < 50; i++) { try { await fetch(base + '/'); return; } catch (_) { await sleep(100); } } throw new Error('server did not start'); }

async function integration() {
  console.log('Integration: server');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tta-'));
  const port = 4100 + Math.floor(Math.random() * 500);
  const base = 'http://127.0.0.1:' + port;
  let proc = startServer(dir, port);
  try {
    await waitUp(base);
    const secrets = JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8'));
    const H = { 'x-admin-token': secrets.adminToken, 'Content-Type': 'application/json' };
    const api = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
    const state = async () => (await api('GET', '/api/state')).json;

    assert.strictEqual((await fetch(base + '/api/state')).status, 401); ok('admin API rejects requests without a token');
    assert.strictEqual((await fetch(`${base}/events?role=overlay&token=${secrets.adminToken}`)).status, 401); ok('overlay stream rejects the admin token');
    assert.strictEqual((await fetch(`${base}/events?role=admin&token=${secrets.overlayToken}`)).status, 401); ok('admin stream rejects the overlay token');

    // shorten animation for tests
    let s0 = await state();
    const cfg = s0.config; cfg.anim.duration = 2;
    assert.strictEqual((await api('POST', '/api/config', { config: cfg })).status, 200);

    // events only queue
    await api('POST', '/api/dev/simulate', { type: 'gift', username: 'tatia_fan', qty: 2 });
    await api('POST', '/api/dev/simulate', { type: 'new', username: 'redplayer', qty: 1 });
    await api('POST', '/api/dev/simulate', { type: 'gift', username: 'tatia_fan', qty: 3 });
    await sleep(500);
    let st = await state();
    assert.strictEqual(st.spin, null); assert.strictEqual(st.history.length, 0); assert.strictEqual(st.rest, 0);
    const fan = st.participants.find((p) => p.username === 'tatia_fan');
    assert.strictEqual(fan.remaining, 5); assert.strictEqual(fan.earned, 5); assert.strictEqual(fan.completed, 0);
    ok('subscription events add spins (2 + 3 = 5) and the wheel stays still');

    // webhook: signature, dedupe, mapping
    const post = (type, id, body, key = privateKey, ts = new Date().toISOString(), algo = 'RSA-SHA256') => {
      const raw = JSON.stringify(body);
      const sig = crypto.sign(algo === 'ed' ? null : algo, Buffer.from(`${id}.${ts}.${raw}`), key).toString('base64');
      return fetch(base + '/webhooks/kick', { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json', 'Kick-Event-Type': type, 'Kick-Event-Version': '1', 'Kick-Event-Message-Id': id, 'Kick-Event-Message-Timestamp': ts, 'Kick-Event-Signature': sig } });
    };
    const user = (id, name) => ({ is_anonymous: false, user_id: id, username: name });
    const sub = { broadcaster: user(1, 'tatianatta'), subscriber: user(777, 'kick_sub'), duration: 1, created_at: new Date().toISOString() };
    assert.strictEqual((await post('channel.subscription.new', 'evt-1', sub)).status, 200);
    assert.strictEqual((await post('channel.subscription.new', 'evt-1', sub)).status, 200); // Kick retry
    await sleep(200);
    st = await state();
    assert.strictEqual(st.participants.find((p) => p.username === 'kick_sub').remaining, 1); ok('duplicate webhook (same message id) adds spins only once');
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    assert.strictEqual((await post('channel.subscription.new', 'evt-2', sub, other)).status, 401); ok('webhook with a wrong signature is rejected');
    const gift = { broadcaster: user(1, 'tatianatta'), gifter: user(555, 'big_gifter'), giftees: [user(1, 'a'), user(2, 'b'), user(3, 'c')], created_at: new Date().toISOString() };
    assert.strictEqual((await post('channel.subscription.gifts', 'evt-3', gift)).status, 200);
    await sleep(200);
    st = await state();
    assert.strictEqual(st.participants.find((p) => p.username === 'big_gifter').remaining, 3);
    assert.strictEqual(st.spin, null); assert.strictEqual(st.history.length, 0); ok('gift webhook (3 giftees) queues 3 spins for the gifter, no spin started');

    // invalid config blocks spin
    const badCfg = JSON.parse(JSON.stringify(st.config)); badCfg.segments[0].prob = 10;
    await api('POST', '/api/config', { config: badCfg });
    await api('POST', '/api/select', { key: fan.key });
    let r = await api('POST', '/api/spin');
    assert.strictEqual(r.status, 400); assert.ok(r.json.problems && r.json.problems.length); ok('invalid probabilities total blocks the spin and explains why');
    await api('POST', '/api/config', { config: cfg });

    // no selection / no spins
    await api('POST', '/api/select', { key: null });
    assert.strictEqual((await api('POST', '/api/spin')).status, 400); ok('spin needs a selected participant');

    // manual spin, exactly once
    await api('POST', '/api/select', { key: fan.key });
    r = await api('POST', '/api/spin'); assert.strictEqual(r.status, 200);
    assert.strictEqual((await api('POST', '/api/spin')).status, 409); ok('second SPIN during a spin is rejected (no overlap)');
    assert.strictEqual((await api('POST', '/api/config', { config: cfg })).status, 409); ok('config is locked during a spin');
    await sleep(2600);
    st = await state();
    assert.strictEqual(st.history.length, 1); assert.strictEqual(st.spin, null);
    assert.strictEqual(st.participants.find((p) => p.key === fan.key).remaining, 4);
    assert.strictEqual(st.participants.find((p) => p.key === fan.key).completed, 1);
    await sleep(5000);
    st = await state();
    assert.strictEqual(st.history.length, 1); assert.strictEqual(st.participants.find((p) => p.key === fan.key).remaining, 4);
    ok('one click = exactly one spin; 4 spins stay queued; nothing auto-repeats');
    const entry = st.history[0];
    assert.ok(entry.source.startsWith('test') && entry.spinNumber === 1); ok('history stores user, segment, spin number and source');

    // overlay payload isolation
    const es = await fetch(`${base}/events?role=overlay&token=${secrets.overlayToken}`);
    const reader = es.body.getReader(); const chunk = new TextDecoder().decode((await reader.read()).value); reader.cancel();
    assert.ok(chunk.includes('"role":"overlay"')); assert.ok(!chunk.includes('big_gifter') && !chunk.includes('"participants"') && !chunk.includes('"prob"'));
    ok('overlay stream exposes no participant list and no probabilities');

    // persistence of a selected result across a crash
    cfg.anim.duration = 6; await api('POST', '/api/config', { config: cfg });
    await api('POST', '/api/spin');
    const mid = (await state()).spin;
    proc.kill('SIGKILL'); await sleep(300);
    proc = startServer(dir, port); await waitUp(base);
    const after = (await state()).spin;
    assert.ok(after && after.segmentId === mid.segmentId && after.toRot === mid.toRot); ok('result survives a server crash mid-spin (no re-roll)');
    await sleep(6500);
    st = await state(); assert.strictEqual(st.spin, null); assert.strictEqual(st.history.length, 2);
    assert.strictEqual(st.history[0].segment, mid.segmentName); ok('interrupted spin finishes with the originally selected segment');

    // confirm mode
    cfg.confirmResult = true; cfg.anim.duration = 2; await api('POST', '/api/config', { config: cfg });
    const before = (await state()).participants.find((p) => p.key === fan.key).remaining;
    await api('POST', '/api/spin'); await sleep(2700);
    st = await state(); assert.strictEqual(st.spin.status, 'awaiting_confirm');
    assert.strictEqual(st.participants.find((p) => p.key === fan.key).remaining, before);
    assert.strictEqual((await api('POST', '/api/spin')).status, 409);
    await api('POST', '/api/spin/confirm'); st = await state();
    assert.strictEqual(st.participants.find((p) => p.key === fan.key).remaining, before - 1); ok('with confirmation on, the spin is deducted only after CONFIRM');

    // remove keeps history; csv
    await api('DELETE', '/api/participants/' + encodeURIComponent(fan.key)); st = await state();
    assert.ok(!st.participants.find((p) => p.key === fan.key)); assert.ok(st.historyTotal >= 3); ok('removing a participant keeps spin history');
    const csv = await (await fetch(base + '/api/history.csv', { headers: H })).text();
    assert.ok(csv.split('\n')[0].includes('winning_segment') && csv.split('\n').length >= 4); ok('CSV export');
  } finally { proc.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); }
}

(async () => {
  try { unit(); await integration(); console.log(`\nAll ${passed} checks passed.`); }
  catch (e) { console.error('\nFAILED:', e.message || e); process.exit(1); }
})();
