'use strict';
/*
 * KICK INTEGRATION (official Kick Public API)
 *  - OAuth 2.1 + PKCE against https://id.kick.com   (client secret stays on this server)
 *  - Event subscriptions via POST https://api.kick.com/public/v1/events/subscriptions (method: webhook)
 *  - Webhook signature verification with the public key from GET https://api.kick.com/public/v1/public-key
 *  - Supported events used here: channel.subscription.new / .renewal / .gifts
 * Nothing here ever starts a spin. Events are only handed to onEvent(), which updates the queue.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API = 'https://api.kick.com/public/v1';
const ID = 'https://id.kick.com';
const SCOPES = 'user:read channel:read events:subscribe';
const EVENTS = [
  { name: 'channel.subscription.new', version: 1 },
  { name: 'channel.subscription.renewal', version: 1 },
  { name: 'channel.subscription.gifts', version: 1 },
];
const b64u = (buf) => Buffer.from(buf).toString('base64url');

function create({ dataDir, env, log }) {
  const clientId = env.KICK_CLIENT_ID || '';
  const clientSecret = env.KICK_CLIENT_SECRET || '';
  const publicUrl = (env.PUBLIC_URL || '').replace(/\/+$/, '');
  const expectedSlug = (env.KICK_CHANNEL || 'tatianatta').toLowerCase();
  const tokenFile = path.join(dataDir, 'kick-tokens.json');

  const st = {
    tokens: null,
    pending: new Map(), // oauth state -> {verifier, exp}
    publicKeyPem: null,
    subscriptions: [],
    lastCheckedAt: null,
    lastEventAt: null,
    lastEventType: null,
    lastError: null,
    channelSlug: null,
    broadcasterId: null,
    eventsReceived: 0,
  };

  try {
    st.tokens = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    st.channelSlug = st.tokens.channel_slug || null;
    st.broadcasterId = st.tokens.broadcaster_user_id || null;
  } catch (_) {}

  function saveTokens() {
    if (!st.tokens) return;
    fs.writeFileSync(tokenFile, JSON.stringify(st.tokens, null, 2), { mode: 0o600 });
  }

  const configured = () => !!(clientId && clientSecret && publicUrl);
  const redirectUri = () => publicUrl + '/kick/callback';
  const webhookUrl = () => (publicUrl ? publicUrl + '/webhooks/kick' : null);

  async function form(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(body).toString(),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Kick OAuth ' + r.status + ': ' + (j.error_description || j.error || j.message || 'request failed'));
    return j;
  }

  function loginUrl() {
    if (!configured()) throw new Error('Set KICK_CLIENT_ID, KICK_CLIENT_SECRET and PUBLIC_URL first (see README).');
    const verifier = b64u(crypto.randomBytes(48));
    const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
    const state = b64u(crypto.randomBytes(18));
    st.pending.set(state, { verifier, exp: Date.now() + 10 * 60 * 1000 });
    for (const [k, v] of st.pending) if (v.exp < Date.now()) st.pending.delete(k);
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri(),
      scope: SCOPES,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    });
    return ID + '/oauth/authorize?' + q.toString();
  }

  async function handleCallback(query) {
    const p = st.pending.get(query.state);
    if (!p || p.exp < Date.now()) throw new Error('Unknown or expired OAuth state. Start the connection again.');
    st.pending.delete(query.state);
    if (query.error) throw new Error('Kick refused authorization: ' + (query.error_description || query.error));
    const j = await form(ID + '/oauth/token', {
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri(),
      code_verifier: p.verifier,
      code: query.code,
    });
    st.tokens = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000, scope: j.scope };
    saveTokens();
    await identify();
    await subscribe();
  }

  async function accessToken() {
    if (!st.tokens) throw new Error('Not authorized with Kick yet.');
    if (st.tokens.expires_at - 60000 > Date.now()) return st.tokens.access_token;
    const j = await form(ID + '/oauth/token', {
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: st.tokens.refresh_token,
    });
    st.tokens = { ...st.tokens, access_token: j.access_token, refresh_token: j.refresh_token || st.tokens.refresh_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000 };
    saveTokens();
    return st.tokens.access_token;
  }

  async function call(method, pathname, body) {
    const token = await accessToken();
    const r = await fetch(API + pathname, {
      method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Kick API ' + method + ' ' + pathname + ' -> ' + r.status + ' ' + (j.message || ''));
    return j;
  }

  // Which channel did the streamer authorize? Must be the expected one.
  async function identify() {
    const ch = await call('GET', '/channels');
    const c = (ch.data || [])[0] || {};
    st.channelSlug = c.slug || null;
    st.broadcasterId = c.broadcaster_user_id || null;
    if (!st.broadcasterId) {
      const u = await call('GET', '/users');
      st.broadcasterId = ((u.data || [])[0] || {}).user_id || null;
    }
    st.tokens.channel_slug = st.channelSlug;
    st.tokens.broadcaster_user_id = st.broadcasterId;
    saveTokens();
  }

  async function subscribe() {
    if (!st.broadcasterId) await identify();
    if ((st.channelSlug || '').toLowerCase() !== expectedSlug)
      throw new Error('Authorized Kick channel is "' + st.channelSlug + '", expected "' + expectedSlug + '". Log in to Kick as the channel owner.');
    await call('POST', '/events/subscriptions', { broadcaster_user_id: st.broadcasterId, events: EVENTS, method: 'webhook' });
    await check();
  }

  async function check() {
    st.lastCheckedAt = Date.now();
    try {
      const j = await call('GET', '/events/subscriptions');
      st.subscriptions = (j.data || []).map((s) => s.event || s.name).filter(Boolean);
      st.lastError = null;
    } catch (e) {
      st.lastError = e.message;
    }
    return status();
  }

  function disconnect() {
    st.tokens = null;
    st.subscriptions = [];
    st.channelSlug = null;
    st.broadcasterId = null;
    try { fs.unlinkSync(tokenFile); } catch (_) {}
  }

  async function loadPublicKey(force) {
    // Optional: pin the key yourself (KICK_PUBLIC_KEY_PEM) instead of fetching it from Kick.
    if (env.KICK_PUBLIC_KEY_PEM) return env.KICK_PUBLIC_KEY_PEM.replace(/\\n/g, '\n');
    if (st.publicKeyPem && !force) return st.publicKeyPem;
    const r = await fetch(API + '/public-key', { headers: { Accept: 'application/json' } });
    const j = await r.json().catch(() => ({}));
    const pem = (j.data && j.data.public_key) || j.public_key;
    if (!r.ok || !pem) throw new Error('Could not fetch Kick public key (' + r.status + ')');
    st.publicKeyPem = pem;
    return pem;
  }

  // Signed content: "<Kick-Event-Message-Id>.<Kick-Event-Message-Timestamp>.<raw body>".
  // The key type is detected, so both RSA-SHA256 and Ed25519 keys work.
  function verifyWith(pem, headers, raw) {
    const id = headers['kick-event-message-id'];
    const ts = headers['kick-event-message-timestamp'];
    const sig = headers['kick-event-signature'];
    if (!id || !ts || !sig) return false;
    const key = crypto.createPublicKey(pem);
    const msg = Buffer.concat([Buffer.from(id + '.' + ts + '.'), raw]);
    const sigBuf = Buffer.from(sig, 'base64');
    const t = key.asymmetricKeyType;
    return t === 'ed25519' || t === 'ed448' ? crypto.verify(null, msg, key, sigBuf) : crypto.verify('RSA-SHA256', msg, key, sigBuf);
  }

  async function verifyWebhook(headers, raw) {
    let ok = false;
    try { ok = verifyWith(await loadPublicKey(false), headers, raw); } catch (_) { ok = false; }
    if (!ok) {
      try { ok = verifyWith(await loadPublicKey(true), headers, raw); } catch (e) { st.lastError = e.message; }
    }
    return ok;
  }

  // Convert a verified webhook into 0..n normalized sub events for the queue.
  function normalize(headers, bodyObj, giftRecipient) {
    const type = headers['kick-event-type'];
    const msgId = headers['kick-event-message-id'];
    const ts = bodyObj.created_at || new Date().toISOString();
    st.lastEventAt = Date.now();
    st.lastEventType = type;
    st.eventsReceived++;
    const who = (u) => (u && !u.is_anonymous && u.username ? { userId: u.user_id != null ? String(u.user_id) : null, username: u.username } : null);
    if (type === 'channel.subscription.new' || type === 'channel.subscription.renewal') {
      const w = who(bodyObj.subscriber);
      if (!w) return [];
      return [{ eventId: msgId, type: type.endsWith('new') ? 'new' : 'renewal', qty: 1, ...w, ts, source: 'kick:' + type }];
    }
    if (type === 'channel.subscription.gifts') {
      const giftees = Array.isArray(bodyObj.giftees) ? bodyObj.giftees : [];
      const qty = Math.max(1, giftees.length);
      if (giftRecipient === 'giftees') {
        return giftees.map(who).filter(Boolean).map((w, i) => ({ eventId: msgId + ':' + i, type: 'gift', qty: 1, ...w, ts, source: 'kick:' + type }));
      }
      const g = who(bodyObj.gifter) || { userId: null, username: 'Anonymous gifter' };
      return [{ eventId: msgId, type: 'gift', qty, ...g, ts, source: 'kick:' + type }];
    }
    return []; // other event types are ignored
  }

  function status() {
    let state, label;
    if (!configured()) { state = 'NOT_CONFIGURED'; label = 'NOT CONFIGURED — set KICK_CLIENT_ID, KICK_CLIENT_SECRET, PUBLIC_URL'; }
    else if (!st.tokens) { state = 'NOT_AUTHORIZED'; label = 'NOT AUTHORIZED — connect your Kick account'; }
    else if (st.lastError) { state = 'ERROR'; label = 'ERROR — ' + st.lastError; }
    else if (!st.subscriptions.length) { state = 'NO_SUBSCRIPTIONS'; label = 'AUTHORIZED, but no active event subscriptions'; }
    else { state = 'SUBSCRIBED'; label = 'SUBSCRIBED — waiting for webhooks from Kick'; }
    return {
      state, label,
      configured: configured(),
      authorized: !!st.tokens,
      channelSlug: st.channelSlug,
      expectedSlug,
      subscriptions: st.subscriptions,
      lastCheckedAt: st.lastCheckedAt,
      lastEventAt: st.lastEventAt,
      lastEventType: st.lastEventType,
      eventsReceived: st.eventsReceived,
      webhookUrl: webhookUrl(),
      redirectUri: publicUrl ? redirectUri() : null,
    };
  }

  return { configured, loginUrl, handleCallback, subscribe, check, disconnect, verifyWebhook, normalize, status };
}

module.exports = { create };
