(function () {
  'use strict';
  const T = window.TTA, W = window.TTAWheel;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // ---------- token ----------
  let token = '';
  (function initToken() {
    const m = location.hash.match(/token=([^&]+)/);
    if (m) { localStorage.setItem('tta_admin', decodeURIComponent(m[1])); history.replaceState(null, '', location.pathname); }
    token = localStorage.getItem('tta_admin') || '';
  })();

  let server = null, draft = null, overlayToken = '', winnerShownFor = null, layoutKey = '';
  const wheel = W.createWheel($('wheel'));
  const stageObserver = new ResizeObserver(() => wheel.resize());
  stageObserver.observe($('wheel'));

  // ---------- helpers ----------
  let toastTimer;
  function toast(msg, ok) {
    const t = $('toast'); t.textContent = msg; t.className = 'toast show' + (ok ? ' ok' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = 'toast'), 4200);
  }
  async function api(method, path, body) {
    const r = await fetch(path, { method, headers: { 'x-admin-token': token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { askToken(); throw new Error('Unauthorized'); }
    if (!r.ok) { const e = new Error(j.error || 'Request failed'); e.problems = j.problems; throw e; }
    return j;
  }
  const act = (fn) => async (...a) => { try { await fn(...a); } catch (e) { if (e.message !== 'Unauthorized') toast(e.message + (e.problems ? ' ' + e.problems.join(' ') : '')); } };
  function askToken() {
    const d = $('tokenDlg'); if (!d.open) d.showModal();
    $('tokenForm').onsubmit = () => { const v = $('tokenIn').value.trim(), m = v.match(/token=([^&\s]+)/); token = m ? decodeURIComponent(m[1]) : v; localStorage.setItem('tta_admin', token); setTimeout(() => location.reload(), 50); };
  }
  const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
  function setPath(o, p, v) { const ks = p.split('.'); const last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; }
  const isDirty = () => draft && server && JSON.stringify(draft) !== JSON.stringify(server.config);
  const ago = (t) => { const s = Math.max(0, (Date.now() - t) / 1000 | 0); return s < 60 ? s + 's ago' : s < 3600 ? (s / 60 | 0) + 'm ago' : s < 86400 ? (s / 3600 | 0) + 'h ago' : (s / 86400 | 0) + 'd ago'; };

  // ---------- SSE ----------
  function connect() {
    if (!token) return askToken();
    const es = new EventSource('/events?role=admin&token=' + encodeURIComponent(token));
    es.addEventListener('state', (e) => onState(JSON.parse(e.data)));
    es.onopen = () => { $('conn').textContent = 'live'; $('conn').className = 'pill ok'; };
    es.onerror = () => { $('conn').textContent = 'reconnecting…'; $('conn').className = 'pill bad'; };
    api('GET', '/api/state').then((s) => { overlayToken = s.overlayToken; setupOverlay(); }).catch(() => {});
  }

  const controller = W.createController(wheel, {
    onSpinStart(s, fresh) { if (fresh) { $('fx').getContext('2d').clearRect(0, 0, 9999, 9999); } renderCenter(); },
    onReveal(s) { renderCenter(); if (server && server.config.anim.effects) W.confetti($('fx')); W.Sound.fanfare(); },
  });

  function onState(s) {
    const first = !server;
    server = s;
    if (!draft || !isDirty()) { const was = draft; draft = clone(s.config); if (first || JSON.stringify(was) !== JSON.stringify(draft)) { renderSegments(); syncInputs(); } }
    const a = s.config.anim;
    W.Sound.enabled = a.sound; W.Sound.spin = a.spinSound; W.Sound.win = a.winSound; W.Sound.volume = a.volume;
    updateWheelLayout();
    controller.update(s);
    renderAll();
  }

  function updateWheelLayout() {
    const cfg = server.spin ? server.config : draft; // never reshuffle the wheel mid-spin
    const lay = T.layout(cfg);
    const key = JSON.stringify(lay.map((l) => [l.id, l.name, l.color, Math.round(l.start * 100)]));
    if (key !== layoutKey) { layoutKey = key; wheel.setLayout(lay); }
  }

  // ---------- left panel ----------
  function syncInputs() {
    document.querySelectorAll('[data-path]').forEach((el) => {
      if (document.activeElement === el) return;
      const v = getPath(draft, el.dataset.path);
      if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
    });
    renderRules();
  }
  document.addEventListener('input', (e) => {
    const el = e.target; if (!el.dataset || !el.dataset.path || !draft) return;
    let v = el.type === 'checkbox' ? el.checked : el.dataset.type === 'num' ? (el.value === '' ? 0 : Number(el.value)) : el.value;
    setPath(draft, el.dataset.path, v);
    afterDraftChange();
  });
  function afterDraftChange() { updateWheelLayout(); renderTotals(); renderDirty(); renderSpinState(); }

  function renderSegments() {
    const list = $('segList');
    list.innerHTML = draft.segments.map((s, i) => {
      const cn = T.colorName(s.color);
      return `<div class="seg ${s.active ? '' : 'off'}" data-i="${i}" style="border-left-color:${esc(s.color)};${s.color.toUpperCase() === '#080808' ? 'border-left-color:#fff' : ''}">
        <div class="r1"><input data-f="name" value="${esc(s.name)}" aria-label="Segment name" maxlength="60">
          <input data-f="prob" type="number" min="0" max="100" step="0.01" value="${s.prob}" aria-label="Probability %" title="Winning probability (%)"></div>
        <div class="r2">
          <button class="sw red ${cn === 'red' ? 'on' : ''}" data-c="red" title="Red" aria-label="Red"></button>
          <button class="sw black ${cn === 'black' ? 'on' : ''}" data-c="black" title="Black" aria-label="Black"></button>
          <button class="sw white ${cn === 'white' ? 'on' : ''}" data-c="white" title="White" aria-label="White"></button>
          <input type="color" data-f="color" value="${esc(s.color.toLowerCase())}" aria-label="Custom color" title="Custom color">
          <label class="check" style="margin:0"><input type="checkbox" data-f="active" ${s.active ? 'checked' : ''}> Active</label>
          <span class="acts">
            <button class="btn small" data-a="up" title="Move up" aria-label="Move up">↑</button>
            <button class="btn small" data-a="down" title="Move down" aria-label="Move down">↓</button>
            <button class="btn small" data-a="dup">Duplicate</button>
            <button class="btn small" data-a="del">Delete</button>
          </span>
        </div>
        <div class="r3"><input data-f="desc" value="${esc(s.desc || '')}" placeholder="Optional action or description" maxlength="200" aria-label="Description"></div>
      </div>`;
    }).join('') || '<div class="empty">No segments yet. Add one.</div>';
    renderTotals();
  }
  $('segList').addEventListener('input', (e) => {
    const row = e.target.closest('.seg'); if (!row || !e.target.dataset.f) return;
    const s = draft.segments[+row.dataset.i], f = e.target.dataset.f;
    if (f === 'prob') s.prob = e.target.value === '' ? 0 : Number(e.target.value);
    else if (f === 'active') { s.active = e.target.checked; row.classList.toggle('off', !s.active); }
    else if (f === 'color') { s.color = e.target.value.toUpperCase(); renderSegments(); }
    else s[f] = e.target.value;
    afterDraftChange();
  });
  $('segList').addEventListener('click', (e) => {
    const row = e.target.closest('.seg'); if (!row) return;
    const i = +row.dataset.i, segs = draft.segments;
    const sw = e.target.closest('[data-c]');
    if (sw) { segs[i].color = T.PALETTE[sw.dataset.c]; renderSegments(); return afterDraftChange(); }
    const a = e.target.closest('[data-a]'); if (!a) return;
    if (a.dataset.a === 'del') segs.splice(i, 1);
    if (a.dataset.a === 'dup') segs.splice(i + 1, 0, { ...clone(segs[i]), id: T.uid(), name: segs[i].name + ' copy' });
    if (a.dataset.a === 'up' && i > 0) [segs[i - 1], segs[i]] = [segs[i], segs[i - 1]];
    if (a.dataset.a === 'down' && i < segs.length - 1) [segs[i + 1], segs[i]] = [segs[i], segs[i + 1]];
    renderSegments(); afterDraftChange();
  });
  $('addSeg').onclick = () => {
    draft.segments.push({ id: T.uid(), name: 'Segment ' + (draft.segments.length + 1), prob: 0, color: T.autoColor(draft.segments), active: true, desc: '' });
    renderSegments(); afterDraftChange();
    const rows = $('segList').querySelectorAll('.seg'); const last = rows[rows.length - 1]; if (last) last.querySelector('input').focus();
  };
  $('normalize').onclick = () => { T.normalize(draft); renderSegments(); afterDraftChange(); toast('Probabilities normalized to 100%. Save to apply.', true); };

  function renderTotals() {
    const v = T.validate(draft);
    const box = $('totalBox');
    box.className = 'total ' + (v.ok ? 'ok' : 'bad');
    box.innerHTML = `Total probability (active): ${v.total}% ${v.ok ? '— OK' : '— must be 100%'}
      <div class="bar"><i style="width:${Math.min(100, v.total)}%"></i></div>
      ${v.ok ? '' : '<ul>' + v.problems.map((p) => '<li>' + esc(p) + '</li>').join('') + '</ul>'}`;
  }
  function renderDirty() { $('dirty').classList.toggle('hidden', !isDirty()); }

  function renderRules() {
    $('rules').innerHTML = draft.spinRules.map((r, i) => `<div class="row gap" data-r="${i}"><label style="flex:1">Qty<input type="number" min="1" data-rf="qty" value="${r.qty}"></label><label style="flex:1">Spins<input type="number" min="0" data-rf="spins" value="${r.spins}"></label><button class="btn small" data-rd="${i}" aria-label="Delete rule">✕</button></div>`).join('') || '<div class="hint">No exact rules — multiplier is used.</div>';
  }
  $('rules').addEventListener('input', (e) => { const row = e.target.closest('[data-r]'); if (!row || !e.target.dataset.rf) return; draft.spinRules[+row.dataset.r][e.target.dataset.rf] = Number(e.target.value) || 0; renderDirty(); });
  $('rules').addEventListener('click', (e) => { const d = e.target.closest('[data-rd]'); if (!d) return; draft.spinRules.splice(+d.dataset.rd, 1); renderRules(); renderDirty(); });
  $('addRule').onclick = () => { draft.spinRules.push({ qty: 1, spins: 1 }); renderRules(); renderDirty(); };

  $('saveCfg').onclick = act(async () => { await api('POST', '/api/config', { config: draft }); toast('Configuration saved', true); const f = $('prev'); if (f.src) f.src = f.src; });
  $('resetCfg').onclick = act(async () => { if (!confirm('Reset all settings and segments to the defaults?')) return; await api('POST', '/api/config/reset'); draft = clone(server.config); toast('Configuration reset', true); });
  $('exportCfg').onclick = () => {
    const blob = new Blob([JSON.stringify({ app: 'tatiana-tta-wheel', version: 1, config: draft }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'tta-wheel-settings.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('importCfg').onclick = () => $('importFile').click();
  $('importFile').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      const j = JSON.parse(await f.text()); const c = j.config || j;
      if (!c || !Array.isArray(c.segments)) throw new Error('This file has no segments.');
      draft = T.sanitizeConfig(c, draft); renderSegments(); syncInputs(); afterDraftChange();
      toast('Settings imported. Review them, then press Save configuration.', true);
    } catch (err) { toast('Import failed: ' + err.message); }
  };

  // ---------- Kick box ----------
  function renderKick() {
    const k = server.kick;
    const pill = $('kickPill');
    pill.textContent = 'Kick: ' + ({ SUBSCRIBED: 'subscribed', NOT_CONFIGURED: 'not configured', NOT_AUTHORIZED: 'not authorized', NO_SUBSCRIPTIONS: 'no subscriptions', ERROR: 'error' }[k.state] || k.state);
    pill.className = 'pill ' + (k.state === 'SUBSCRIBED' ? 'ok' : 'bad'); pill.title = k.label;
    $('kickBox').innerHTML = `<p><b class="${k.state === 'SUBSCRIBED' ? 'kick-ok' : ''}">${esc(k.label)}</b></p>
      <div class="hint">Channel: ${esc(k.channelSlug || '—')} (expected ${esc(k.expectedSlug)})<br>
      Subscriptions: ${k.subscriptions.length ? esc(k.subscriptions.join(', ')) : 'none'}<br>
      Webhooks received: ${k.eventsReceived}${k.lastEventAt ? ' · last ' + esc(k.lastEventType) + ' ' + ago(k.lastEventAt) : ''}<br>
      Webhook URL: ${esc(k.webhookUrl || 'set PUBLIC_URL')}<br>OAuth redirect URI: ${esc(k.redirectUri || 'set PUBLIC_URL')}</div>`;
    $('kickConnect').href = '/kick/login?token=' + encodeURIComponent(token);
    $('kickConnect').classList.toggle('hidden', !k.configured);
    $('kickSub').classList.toggle('hidden', !k.authorized);
    $('kickDisc').classList.toggle('hidden', !k.authorized);
  }
  $('kickCheck').onclick = act(async () => { await api('POST', '/api/kick/check'); toast('Status refreshed', true); });
  $('kickSub').onclick = act(async () => { await api('POST', '/api/kick/subscribe'); toast('Subscribed', true); });
  $('kickDisc').onclick = act(async () => { if (confirm('Remove the stored Kick authorization?')) await api('POST', '/api/kick/disconnect'); });
  $('simGo').onclick = act(async () => { const r = await api('POST', '/api/dev/simulate', { username: $('simName').value, type: $('simType').value, qty: Number($('simQty').value) || 1 }); toast(r.added ? 'Simulated event: +' + r.added + ' spins queued. The wheel did not move.' : 'Event ignored by rules', true); });

  function setupOverlay() {
    const url = location.origin + '/overlay.html?token=' + encodeURIComponent(overlayToken);
    $('overlayUrl').value = url;
    $('prev').src = url;
    const fit = () => { const w = $('prevWrap').clientWidth; if (w) $('prev').style.transform = 'scale(' + w / 1920 + ')'; };
    fit(); new ResizeObserver(fit).observe($('prevWrap'));
  }
  $('copyOverlay').onclick = async () => { try { await navigator.clipboard.writeText($('overlayUrl').value); toast('Overlay URL copied', true); } catch (_) { $('overlayUrl').select(); toast('Press Ctrl+C to copy'); } };

  // ---------- center ----------
  function selectedP() { return server && server.participants.find((p) => p.key === server.selectedKey); }

  function spinBlockReason() {
    if (!server) return 'Connecting…';
    if (server.spin) return server.spin.status === 'awaiting_confirm' ? 'Confirm the result to continue.' : '';
    if (isDirty()) return 'Save the configuration before spinning.';
    const v = T.validate(server.config);
    if (!v.ok) return v.problems.join(' ') + ' Fix it or press Normalize, then save.';
    const p = selectedP();
    if (!p) return 'Select a participant to spin for.';
    if (p.remaining < 1) return p.username + ' has no spins remaining.';
    return '';
  }

  function renderSpinState() {
    if (!server) return;
    const reason = spinBlockReason();
    const busy = !!server.spin;
    $('spinBtn').disabled = busy || !!reason;
    $('spinMsg').textContent = busy ? '' : reason;
  }

  function renderCenter() {
    if (!server) return;
    const s = server.spin, p = selectedP();
    const nn = $('nowName');
    if (s) { nn.textContent = s.username; nn.className = 'now-name sel'; $('nowSub').textContent = 'Spin #' + s.spinNumber; }
    else if (p) { nn.textContent = p.username; nn.className = 'now-name sel'; $('nowSub').textContent = p.remaining + ' spin' + (p.remaining === 1 ? '' : 's') + ' remaining'; }
    else { nn.textContent = '—'; nn.className = 'now-name'; $('nowSub').textContent = 'No participant selected'; }

    const res = $('result');
    let shown = null;
    if (s) { if (controller.isRevealed(s)) shown = { segment: s.segmentName, desc: s.segmentDesc, username: s.username, pending: s.status === 'awaiting_confirm' }; else { res.className = 'result'; res.innerHTML = ''; } }
    else if (server.lastResult) shown = { segment: server.lastResult.segment, desc: server.lastResult.desc, username: server.lastResult.username };
    if (shown) { res.className = 'result show'; res.innerHTML = `<div>${esc(shown.segment)}<small>${esc(shown.username)}${shown.desc ? ' — ' + esc(shown.desc) : ''}${shown.pending ? ' — waiting for your confirmation' : ''}</small></div>`; }
    else if (!s) { res.className = 'result'; res.innerHTML = ''; }

    const awaiting = s && s.status === 'awaiting_confirm';
    $('confirmBtn').classList.toggle('hidden', !awaiting);
    $('skipBtn').disabled = !!s || !p; $('removeBtn').disabled = (!!s && s.key === server.selectedKey) || !p;

    const sel = $('pickSel');
    const opts = '<option value="">— choose —</option>' + server.participants.filter((x) => x.remaining > 0 || x.key === server.selectedKey).sort((a, b) => a.order - b.order).map((x) => `<option value="${esc(x.key)}">${esc(x.username)} (${x.remaining})</option>`).join('');
    if (sel.dataset.sig !== opts) { sel.innerHTML = opts; sel.dataset.sig = opts; }
    sel.value = server.selectedKey || ''; sel.disabled = !!s;
    renderSpinState();
  }

  $('spinBtn').onclick = act(async () => { W.Sound.unlock(); $('spinBtn').disabled = true; await api('POST', '/api/spin'); });
  $('confirmBtn').onclick = act(async () => { await api('POST', '/api/spin/confirm'); });
  $('pickSel').onchange = act(async (e) => { await api('POST', '/api/select', { key: e.target.value || null }); });
  $('skipBtn').onclick = act(async () => { await api('POST', '/api/skip'); });
  $('removeBtn').onclick = act(async () => { const p = selectedP(); if (p && confirm('Remove ' + p.username + ' from the queue? Their history is kept.')) await api('DELETE', '/api/participants/' + encodeURIComponent(p.key)); });
  document.addEventListener('click', () => W.Sound.unlock(), { once: true });

  // ---------- right panel ----------
  function renderRight() {
    const ps = server.participants;
    $('stWait').textContent = ps.reduce((a, p) => a + p.remaining, 0);
    $('stPeople').textContent = ps.length;
    $('stDone').textContent = server.historyTotal;
    const q = $('search').value.trim().toLowerCase(), sort = $('sort').value, only = $('pendingOnly').checked;
    let list = ps.filter((p) => (!q || p.username.toLowerCase().includes(q)) && (!only || p.remaining > 0));
    list.sort((a, b) => sort === 'remaining' ? b.remaining - a.remaining || a.order - b.order : sort === 'name' ? a.username.localeCompare(b.username) : a.order - b.order);
    const box = $('plist');
    if (box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return renderFeeds();
    box.innerHTML = list.map((p) => `<div class="p ${p.key === server.selectedKey ? 'sel' : ''}" data-k="${esc(p.key)}" tabindex="0" role="button" aria-label="Select ${esc(p.username)}">
      <div class="h"><span class="u">${esc(p.username)}</span><span class="badge">${p.status}</span></div>
      <div class="m"><span>Earned: <b>${p.earned}</b></span><label style="margin:0">Remaining: <input type="number" min="0" data-rem="${esc(p.key)}" value="${p.remaining}" aria-label="Remaining spins for ${esc(p.username)}"></label><span>Completed: <b>${p.completed}</b></span>${p.subEvents ? `<span>Sub events: ${p.subEvents}</span>` : ''}</div>
      <div class="t">Last activity ${ago(p.lastActivity)}</div>
      <div class="b"><button class="btn small" data-rm="${esc(p.key)}">Remove</button></div></div>`).join('') || `<div class="empty">${ps.length ? 'No matches.' : 'Nobody in the queue yet. Subscription events will appear here, or add someone manually.'}</div>`;
    renderFeeds();
  }
  function renderFeeds() {
    $('winners').innerHTML = server.history.slice(0, 8).map((h) => `<div class="win"><span class="dot" style="background:${esc(h.color)}"></span><span><b>${esc(h.username)}</b> — ${esc(h.segment)} <span class="hint">${ago(h.at)}</span></span></div>`).join('') || '<div class="hint">No spins yet.</div>';
    $('activity').innerHTML = server.activity.slice(0, 14).map((a) => `<div>${esc(a.text)} <span class="hint">${ago(a.t)}</span></div>`).join('');
  }
  $('plist').addEventListener('click', act(async (e) => {
    if (e.target.closest('input')) return;
    const rm = e.target.closest('[data-rm]');
    if (rm) { const p = server.participants.find((x) => x.key === rm.dataset.rm); if (p && confirm('Remove ' + p.username + ' from the queue? Their history is kept.')) await api('DELETE', '/api/participants/' + encodeURIComponent(p.key)); return; }
    const row = e.target.closest('.p'); if (row) await api('POST', '/api/select', { key: row.dataset.k });
  }));
  $('plist').addEventListener('keydown', act(async (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('p')) { e.preventDefault(); await api('POST', '/api/select', { key: e.target.dataset.k }); } }));
  $('plist').addEventListener('change', act(async (e) => { const k = e.target.dataset.rem; if (k != null) await api('PATCH', '/api/participants/' + encodeURIComponent(k), { remaining: Number(e.target.value) || 0 }); }));
  ['search', 'sort', 'pendingOnly'].forEach((id) => $(id).addEventListener('input', () => server && renderRight()));
  $('addForm').addEventListener('submit', act(async (e) => { e.preventDefault(); const n = $('addName').value.trim(); if (!n) return; await api('POST', '/api/participants', { username: n, spins: Number($('addSpins').value) || 0 }); $('addName').value = ''; }));

  // history dialog
  $('histBtn').onclick = () => {
    $('histInfo').textContent = `Showing the latest ${server.history.length} of ${server.historyTotal} spins. CSV export contains everything.`;
    $('histTable').innerHTML = '<thead><tr><th>Time</th><th>User</th><th>Result</th><th>#</th><th>Source</th><th>Event ID</th></tr></thead><tbody>' + server.history.map((h) => `<tr><td>${new Date(h.at).toLocaleString()}</td><td>${esc(h.username)}</td><td>${esc(h.segment)}</td><td>${h.spinNumber}</td><td>${esc(h.source)}</td><td>${esc(h.eventId || '')}</td></tr>`).join('') + '</tbody>';
    $('histDlg').showModal();
  };
  $('histClose').onclick = () => $('histDlg').close();
  $('histClear').onclick = act(async () => { if (confirm('Clear the entire spin history? This cannot be undone.')) { await api('POST', '/api/history/clear', { confirm: true }); $('histDlg').close(); } });
  $('csvBtn').onclick = act(async (e) => {
    e.preventDefault();
    const r = await fetch('/api/history.csv', { headers: { 'x-admin-token': token } }); if (!r.ok) throw new Error('Export failed');
    const a = document.createElement('a'); a.href = URL.createObjectURL(await r.blob()); a.download = 'tta-wheel-history.csv'; a.click();
  });

  function renderAll() { renderDirty(); renderTotals(); renderKick(); renderCenter(); renderRight(); }
  setInterval(() => { if (server) renderRight(); }, 30000);
  window.addEventListener('beforeunload', (e) => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });
  connect();
})();
