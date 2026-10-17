# TATIANA TTA WHEEL

Custom spinning-wheel app for https://kick.com/tatianatta.
Red / black / white wheel, exact winning probabilities, a subscriber spin queue, and an OBS overlay.

Created by exp4nsive.

**Every spin is started by you pressing SPIN. Nothing else can start one.**

- Node.js 18+ (tested on 22). No npm dependencies, nothing to install.
- All data lives in `data/` (`state.json`, `secrets.json`, `kick-tokens.json`).

## Run it

```bash
npm start
```

The console prints two URLs:

```
Admin   : http://127.0.0.1:3000/#token=<admin token>
Overlay : http://127.0.0.1:3000/overlay.html?token=<overlay token>
```

Open the Admin URL once; the token is remembered in your browser. Keep the admin token private.
Tokens are generated on first start and stored in `data/secrets.json` (or set `ADMIN_TOKEN` / `OVERLAY_TOKEN`).

Run the tests with `npm test` (27 checks: probabilities, queue, manual-only spinning, crash recovery, webhook signatures).

## Using the app

| Area | What it does |
|---|---|
| Left: Wheel settings | Segments (name, exact %, red/black/white or custom color, active, description, order, duplicate, delete), Normalize, equal-size toggle, animation and sound, Subs to spins, Kick, OBS overlay. Save / Reset / Export / Import at the bottom. |
| Center | Wheel, SPIN button, selected participant, result, participant dropdown, Skip, Remove from queue, Confirm result. |
| Right: Subs & spins | Participants with earned / remaining / completed, search, sort, "pending only", manual add, inline spin-count edit, recent winners, activity, full history, CSV export. |

**Probabilities.** Active segments must add up to 100%. Otherwise SPIN is disabled and the reason is shown. Values are never changed silently; **Normalize probabilities** only runs when you press it. Selection is a weighted random draw on the configured percentages (crypto-grade randomness), independent of visual size. 0% and inactive segments cannot win. Visual size is proportional to probability by default (a tiny minimum keeps 0% slices visible), or switch on equal-sized segments.

**Save first.** Edits stay a draft until you press Save configuration. SPIN is disabled while there are unsaved changes, so the wheel you see is the wheel that is used. Configuration is locked while a spin runs.

**Spin lifecycle.** SPIN → server validates → picks the winner → **saves the result** → animation runs → result shows → the spin is deducted from that participant and written to history. If the browser or server is interrupted mid-spin, the stored result is restored and finishes; it is never re-rolled. With "Require CONFIRM RESULT" on, the spin is only deducted after you confirm.

**Not included:** pausing an animation mid-spin. The result and timing are decided on the server, so a pause would desync the overlay. It was marked optional in the brief.

## Manual spin guarantees

- The only code path that starts a spin is `POST /api/spin`, which needs the admin token and is called only by the SPIN button.
- Subscription events call one function, `ingestEvent()`, which only updates the queue.
- There is no auto mode, no repeat mode, and no queue advancement. A participant with 10 spins needs 10 clicks.
- The only timer in the spin code *finishes* a spin you already started.
- Covered by `npm test` ("subscription events ... the wheel stays still", "one click = exactly one spin").

## Subs to spins

Configured in "Subs to spins":

- Per event type (new, renewal, gift): on/off and spins per sub.
- Exact quantity rules (default 1→1, 2→2, 5→5, 10→10). An exact rule wins; otherwise spins = quantity × multiplier.
- Gifted subs: spins go to the **gifter** (default) or to **each recipient**.

Notes: a new sub or renewal counts as quantity 1 (Kick's `duration` field is ignored). Anonymous gifters are grouped under "Anonymous gifter". Participants are matched by Kick user ID, with the username as fallback.

## Kick integration

Verified against Kick's official developer docs (KickEngineering/KickDevDocs). Kick has **no chat or event socket in its official API**; it delivers events as **webhooks** to a public HTTPS URL.

Supported events used: `channel.subscription.new`, `channel.subscription.renewal`, `channel.subscription.gifts`.

### Setup

1. Create an app at https://kick.com/settings/developer.
2. Make this server reachable over **HTTPS** at a public URL (Cloudflare Tunnel, ngrok, or a VPS with a reverse proxy) forwarding to `localhost:3000`.
3. In the Kick app settings, set:
   - Redirect URI: `<PUBLIC_URL>/kick/callback`
   - Webhook URL: `<PUBLIC_URL>/webhooks/kick`, and enable webhooks.
4. Copy `.env.example` to `.env` (or export the variables) and set `KICK_CLIENT_ID`, `KICK_CLIENT_SECRET`, `PUBLIC_URL`. Start with `node --env-file=.env server.js` (Node 20.6+), or export the variables and run `npm start`.
5. In the admin page: Kick integration → **Connect Kick**. Log in as the `tatianatta` channel owner and approve. Scopes requested: `user:read channel:read events:subscribe`. The server then creates the three subscriptions.

The client secret, tokens and refresh logic stay on the server. The app never asks for a Kick password. If the authorized channel is not `tatianatta`, subscribing is refused.

### What "connected" means

The status pill reads from real data: configuration present, OAuth token present, and the subscription list returned by Kick (re-checked every 5 minutes and on **Check status**). It also shows the number of webhooks received and the time of the last one. It never claims a live connection that does not exist.

### Reliability and security

- Every webhook is verified against Kick's public key from `GET https://api.kick.com/public/v1/public-key`. The signed string is `<Kick-Event-Message-Id>.<Kick-Event-Message-Timestamp>.<raw body>`. The key type (RSA or Ed25519) is detected automatically, and the key is re-fetched once if verification fails. Invalid signatures get HTTP 401. You can pin the key with `KICK_PUBLIC_KEY_PEM`.
- Duplicates (Kick retries, at-least-once delivery) are dropped by `Kick-Event-Message-Id`; the last 5000 IDs are persisted across restarts.
- Missed events: Kick does not replay old webhooks, so events during downtime are lost. Use **Edit spin count** or **Add participant** to fix up manually.

### If direct integration is not possible

Use **Simulate an event** (Kick integration section) to test the full flow offline. It uses the same `ingestEvent()` path and is labeled `test` in history. A third-party event relay can post to the same function by forwarding to `/webhooks/kick` with valid signatures, or you can add a small adapter that calls `ingestEvent()` in `server.js`.

## OBS overlay

1. OBS → Sources → **Browser** → URL = the Overlay URL, **Width 1920, Height 1080**. Leave "Shutdown source when not visible" off.
2. Background is transparent. No controls and no admin functions.
3. Position the wheel and panel in the admin page (OBS overlay section), press Save, and watch the live preview.
4. Add `&sound=1` to the URL to play sounds through OBS ("Control audio via OBS" in the source properties).

The overlay uses its own token and only receives what it draws: wheel layout (no probabilities), current participant and remaining spins, the latest result and recent winners. It cannot call admin endpoints. The winner is revealed only when the animation ends.

## Security notes

- The server listens on `127.0.0.1` by default. Only the tunnel/proxy should expose it; set `HOST=0.0.0.0` deliberately if needed.
- Admin actions need the admin token. Webhooks need Kick's signature. The overlay needs the overlay token.
- Tokens travel in URLs for the SSE stream and OBS (browser sources cannot send headers), so use HTTPS when exposed publicly and do not show the URLs on stream.
- Behind a public tunnel, only `/webhooks/kick` and `/kick/callback` need to be reachable from the internet; `/api/*`, `/events` and the pages stay token-protected anyway.

## Files

```
server.js          state, queue, manual spin, SSE, REST, webhook route
lib/kick.js        Kick OAuth (PKCE), subscriptions, signature check, status
public/shared.js   palette, validation, weighted pick, layout, spin math (server + browser)
public/wheel.js    wheel drawing, animation, sounds, confetti
public/index.html, style.css, admin.js   admin UI
public/overlay.html                      OBS overlay
test/run.js        automated checks
```
