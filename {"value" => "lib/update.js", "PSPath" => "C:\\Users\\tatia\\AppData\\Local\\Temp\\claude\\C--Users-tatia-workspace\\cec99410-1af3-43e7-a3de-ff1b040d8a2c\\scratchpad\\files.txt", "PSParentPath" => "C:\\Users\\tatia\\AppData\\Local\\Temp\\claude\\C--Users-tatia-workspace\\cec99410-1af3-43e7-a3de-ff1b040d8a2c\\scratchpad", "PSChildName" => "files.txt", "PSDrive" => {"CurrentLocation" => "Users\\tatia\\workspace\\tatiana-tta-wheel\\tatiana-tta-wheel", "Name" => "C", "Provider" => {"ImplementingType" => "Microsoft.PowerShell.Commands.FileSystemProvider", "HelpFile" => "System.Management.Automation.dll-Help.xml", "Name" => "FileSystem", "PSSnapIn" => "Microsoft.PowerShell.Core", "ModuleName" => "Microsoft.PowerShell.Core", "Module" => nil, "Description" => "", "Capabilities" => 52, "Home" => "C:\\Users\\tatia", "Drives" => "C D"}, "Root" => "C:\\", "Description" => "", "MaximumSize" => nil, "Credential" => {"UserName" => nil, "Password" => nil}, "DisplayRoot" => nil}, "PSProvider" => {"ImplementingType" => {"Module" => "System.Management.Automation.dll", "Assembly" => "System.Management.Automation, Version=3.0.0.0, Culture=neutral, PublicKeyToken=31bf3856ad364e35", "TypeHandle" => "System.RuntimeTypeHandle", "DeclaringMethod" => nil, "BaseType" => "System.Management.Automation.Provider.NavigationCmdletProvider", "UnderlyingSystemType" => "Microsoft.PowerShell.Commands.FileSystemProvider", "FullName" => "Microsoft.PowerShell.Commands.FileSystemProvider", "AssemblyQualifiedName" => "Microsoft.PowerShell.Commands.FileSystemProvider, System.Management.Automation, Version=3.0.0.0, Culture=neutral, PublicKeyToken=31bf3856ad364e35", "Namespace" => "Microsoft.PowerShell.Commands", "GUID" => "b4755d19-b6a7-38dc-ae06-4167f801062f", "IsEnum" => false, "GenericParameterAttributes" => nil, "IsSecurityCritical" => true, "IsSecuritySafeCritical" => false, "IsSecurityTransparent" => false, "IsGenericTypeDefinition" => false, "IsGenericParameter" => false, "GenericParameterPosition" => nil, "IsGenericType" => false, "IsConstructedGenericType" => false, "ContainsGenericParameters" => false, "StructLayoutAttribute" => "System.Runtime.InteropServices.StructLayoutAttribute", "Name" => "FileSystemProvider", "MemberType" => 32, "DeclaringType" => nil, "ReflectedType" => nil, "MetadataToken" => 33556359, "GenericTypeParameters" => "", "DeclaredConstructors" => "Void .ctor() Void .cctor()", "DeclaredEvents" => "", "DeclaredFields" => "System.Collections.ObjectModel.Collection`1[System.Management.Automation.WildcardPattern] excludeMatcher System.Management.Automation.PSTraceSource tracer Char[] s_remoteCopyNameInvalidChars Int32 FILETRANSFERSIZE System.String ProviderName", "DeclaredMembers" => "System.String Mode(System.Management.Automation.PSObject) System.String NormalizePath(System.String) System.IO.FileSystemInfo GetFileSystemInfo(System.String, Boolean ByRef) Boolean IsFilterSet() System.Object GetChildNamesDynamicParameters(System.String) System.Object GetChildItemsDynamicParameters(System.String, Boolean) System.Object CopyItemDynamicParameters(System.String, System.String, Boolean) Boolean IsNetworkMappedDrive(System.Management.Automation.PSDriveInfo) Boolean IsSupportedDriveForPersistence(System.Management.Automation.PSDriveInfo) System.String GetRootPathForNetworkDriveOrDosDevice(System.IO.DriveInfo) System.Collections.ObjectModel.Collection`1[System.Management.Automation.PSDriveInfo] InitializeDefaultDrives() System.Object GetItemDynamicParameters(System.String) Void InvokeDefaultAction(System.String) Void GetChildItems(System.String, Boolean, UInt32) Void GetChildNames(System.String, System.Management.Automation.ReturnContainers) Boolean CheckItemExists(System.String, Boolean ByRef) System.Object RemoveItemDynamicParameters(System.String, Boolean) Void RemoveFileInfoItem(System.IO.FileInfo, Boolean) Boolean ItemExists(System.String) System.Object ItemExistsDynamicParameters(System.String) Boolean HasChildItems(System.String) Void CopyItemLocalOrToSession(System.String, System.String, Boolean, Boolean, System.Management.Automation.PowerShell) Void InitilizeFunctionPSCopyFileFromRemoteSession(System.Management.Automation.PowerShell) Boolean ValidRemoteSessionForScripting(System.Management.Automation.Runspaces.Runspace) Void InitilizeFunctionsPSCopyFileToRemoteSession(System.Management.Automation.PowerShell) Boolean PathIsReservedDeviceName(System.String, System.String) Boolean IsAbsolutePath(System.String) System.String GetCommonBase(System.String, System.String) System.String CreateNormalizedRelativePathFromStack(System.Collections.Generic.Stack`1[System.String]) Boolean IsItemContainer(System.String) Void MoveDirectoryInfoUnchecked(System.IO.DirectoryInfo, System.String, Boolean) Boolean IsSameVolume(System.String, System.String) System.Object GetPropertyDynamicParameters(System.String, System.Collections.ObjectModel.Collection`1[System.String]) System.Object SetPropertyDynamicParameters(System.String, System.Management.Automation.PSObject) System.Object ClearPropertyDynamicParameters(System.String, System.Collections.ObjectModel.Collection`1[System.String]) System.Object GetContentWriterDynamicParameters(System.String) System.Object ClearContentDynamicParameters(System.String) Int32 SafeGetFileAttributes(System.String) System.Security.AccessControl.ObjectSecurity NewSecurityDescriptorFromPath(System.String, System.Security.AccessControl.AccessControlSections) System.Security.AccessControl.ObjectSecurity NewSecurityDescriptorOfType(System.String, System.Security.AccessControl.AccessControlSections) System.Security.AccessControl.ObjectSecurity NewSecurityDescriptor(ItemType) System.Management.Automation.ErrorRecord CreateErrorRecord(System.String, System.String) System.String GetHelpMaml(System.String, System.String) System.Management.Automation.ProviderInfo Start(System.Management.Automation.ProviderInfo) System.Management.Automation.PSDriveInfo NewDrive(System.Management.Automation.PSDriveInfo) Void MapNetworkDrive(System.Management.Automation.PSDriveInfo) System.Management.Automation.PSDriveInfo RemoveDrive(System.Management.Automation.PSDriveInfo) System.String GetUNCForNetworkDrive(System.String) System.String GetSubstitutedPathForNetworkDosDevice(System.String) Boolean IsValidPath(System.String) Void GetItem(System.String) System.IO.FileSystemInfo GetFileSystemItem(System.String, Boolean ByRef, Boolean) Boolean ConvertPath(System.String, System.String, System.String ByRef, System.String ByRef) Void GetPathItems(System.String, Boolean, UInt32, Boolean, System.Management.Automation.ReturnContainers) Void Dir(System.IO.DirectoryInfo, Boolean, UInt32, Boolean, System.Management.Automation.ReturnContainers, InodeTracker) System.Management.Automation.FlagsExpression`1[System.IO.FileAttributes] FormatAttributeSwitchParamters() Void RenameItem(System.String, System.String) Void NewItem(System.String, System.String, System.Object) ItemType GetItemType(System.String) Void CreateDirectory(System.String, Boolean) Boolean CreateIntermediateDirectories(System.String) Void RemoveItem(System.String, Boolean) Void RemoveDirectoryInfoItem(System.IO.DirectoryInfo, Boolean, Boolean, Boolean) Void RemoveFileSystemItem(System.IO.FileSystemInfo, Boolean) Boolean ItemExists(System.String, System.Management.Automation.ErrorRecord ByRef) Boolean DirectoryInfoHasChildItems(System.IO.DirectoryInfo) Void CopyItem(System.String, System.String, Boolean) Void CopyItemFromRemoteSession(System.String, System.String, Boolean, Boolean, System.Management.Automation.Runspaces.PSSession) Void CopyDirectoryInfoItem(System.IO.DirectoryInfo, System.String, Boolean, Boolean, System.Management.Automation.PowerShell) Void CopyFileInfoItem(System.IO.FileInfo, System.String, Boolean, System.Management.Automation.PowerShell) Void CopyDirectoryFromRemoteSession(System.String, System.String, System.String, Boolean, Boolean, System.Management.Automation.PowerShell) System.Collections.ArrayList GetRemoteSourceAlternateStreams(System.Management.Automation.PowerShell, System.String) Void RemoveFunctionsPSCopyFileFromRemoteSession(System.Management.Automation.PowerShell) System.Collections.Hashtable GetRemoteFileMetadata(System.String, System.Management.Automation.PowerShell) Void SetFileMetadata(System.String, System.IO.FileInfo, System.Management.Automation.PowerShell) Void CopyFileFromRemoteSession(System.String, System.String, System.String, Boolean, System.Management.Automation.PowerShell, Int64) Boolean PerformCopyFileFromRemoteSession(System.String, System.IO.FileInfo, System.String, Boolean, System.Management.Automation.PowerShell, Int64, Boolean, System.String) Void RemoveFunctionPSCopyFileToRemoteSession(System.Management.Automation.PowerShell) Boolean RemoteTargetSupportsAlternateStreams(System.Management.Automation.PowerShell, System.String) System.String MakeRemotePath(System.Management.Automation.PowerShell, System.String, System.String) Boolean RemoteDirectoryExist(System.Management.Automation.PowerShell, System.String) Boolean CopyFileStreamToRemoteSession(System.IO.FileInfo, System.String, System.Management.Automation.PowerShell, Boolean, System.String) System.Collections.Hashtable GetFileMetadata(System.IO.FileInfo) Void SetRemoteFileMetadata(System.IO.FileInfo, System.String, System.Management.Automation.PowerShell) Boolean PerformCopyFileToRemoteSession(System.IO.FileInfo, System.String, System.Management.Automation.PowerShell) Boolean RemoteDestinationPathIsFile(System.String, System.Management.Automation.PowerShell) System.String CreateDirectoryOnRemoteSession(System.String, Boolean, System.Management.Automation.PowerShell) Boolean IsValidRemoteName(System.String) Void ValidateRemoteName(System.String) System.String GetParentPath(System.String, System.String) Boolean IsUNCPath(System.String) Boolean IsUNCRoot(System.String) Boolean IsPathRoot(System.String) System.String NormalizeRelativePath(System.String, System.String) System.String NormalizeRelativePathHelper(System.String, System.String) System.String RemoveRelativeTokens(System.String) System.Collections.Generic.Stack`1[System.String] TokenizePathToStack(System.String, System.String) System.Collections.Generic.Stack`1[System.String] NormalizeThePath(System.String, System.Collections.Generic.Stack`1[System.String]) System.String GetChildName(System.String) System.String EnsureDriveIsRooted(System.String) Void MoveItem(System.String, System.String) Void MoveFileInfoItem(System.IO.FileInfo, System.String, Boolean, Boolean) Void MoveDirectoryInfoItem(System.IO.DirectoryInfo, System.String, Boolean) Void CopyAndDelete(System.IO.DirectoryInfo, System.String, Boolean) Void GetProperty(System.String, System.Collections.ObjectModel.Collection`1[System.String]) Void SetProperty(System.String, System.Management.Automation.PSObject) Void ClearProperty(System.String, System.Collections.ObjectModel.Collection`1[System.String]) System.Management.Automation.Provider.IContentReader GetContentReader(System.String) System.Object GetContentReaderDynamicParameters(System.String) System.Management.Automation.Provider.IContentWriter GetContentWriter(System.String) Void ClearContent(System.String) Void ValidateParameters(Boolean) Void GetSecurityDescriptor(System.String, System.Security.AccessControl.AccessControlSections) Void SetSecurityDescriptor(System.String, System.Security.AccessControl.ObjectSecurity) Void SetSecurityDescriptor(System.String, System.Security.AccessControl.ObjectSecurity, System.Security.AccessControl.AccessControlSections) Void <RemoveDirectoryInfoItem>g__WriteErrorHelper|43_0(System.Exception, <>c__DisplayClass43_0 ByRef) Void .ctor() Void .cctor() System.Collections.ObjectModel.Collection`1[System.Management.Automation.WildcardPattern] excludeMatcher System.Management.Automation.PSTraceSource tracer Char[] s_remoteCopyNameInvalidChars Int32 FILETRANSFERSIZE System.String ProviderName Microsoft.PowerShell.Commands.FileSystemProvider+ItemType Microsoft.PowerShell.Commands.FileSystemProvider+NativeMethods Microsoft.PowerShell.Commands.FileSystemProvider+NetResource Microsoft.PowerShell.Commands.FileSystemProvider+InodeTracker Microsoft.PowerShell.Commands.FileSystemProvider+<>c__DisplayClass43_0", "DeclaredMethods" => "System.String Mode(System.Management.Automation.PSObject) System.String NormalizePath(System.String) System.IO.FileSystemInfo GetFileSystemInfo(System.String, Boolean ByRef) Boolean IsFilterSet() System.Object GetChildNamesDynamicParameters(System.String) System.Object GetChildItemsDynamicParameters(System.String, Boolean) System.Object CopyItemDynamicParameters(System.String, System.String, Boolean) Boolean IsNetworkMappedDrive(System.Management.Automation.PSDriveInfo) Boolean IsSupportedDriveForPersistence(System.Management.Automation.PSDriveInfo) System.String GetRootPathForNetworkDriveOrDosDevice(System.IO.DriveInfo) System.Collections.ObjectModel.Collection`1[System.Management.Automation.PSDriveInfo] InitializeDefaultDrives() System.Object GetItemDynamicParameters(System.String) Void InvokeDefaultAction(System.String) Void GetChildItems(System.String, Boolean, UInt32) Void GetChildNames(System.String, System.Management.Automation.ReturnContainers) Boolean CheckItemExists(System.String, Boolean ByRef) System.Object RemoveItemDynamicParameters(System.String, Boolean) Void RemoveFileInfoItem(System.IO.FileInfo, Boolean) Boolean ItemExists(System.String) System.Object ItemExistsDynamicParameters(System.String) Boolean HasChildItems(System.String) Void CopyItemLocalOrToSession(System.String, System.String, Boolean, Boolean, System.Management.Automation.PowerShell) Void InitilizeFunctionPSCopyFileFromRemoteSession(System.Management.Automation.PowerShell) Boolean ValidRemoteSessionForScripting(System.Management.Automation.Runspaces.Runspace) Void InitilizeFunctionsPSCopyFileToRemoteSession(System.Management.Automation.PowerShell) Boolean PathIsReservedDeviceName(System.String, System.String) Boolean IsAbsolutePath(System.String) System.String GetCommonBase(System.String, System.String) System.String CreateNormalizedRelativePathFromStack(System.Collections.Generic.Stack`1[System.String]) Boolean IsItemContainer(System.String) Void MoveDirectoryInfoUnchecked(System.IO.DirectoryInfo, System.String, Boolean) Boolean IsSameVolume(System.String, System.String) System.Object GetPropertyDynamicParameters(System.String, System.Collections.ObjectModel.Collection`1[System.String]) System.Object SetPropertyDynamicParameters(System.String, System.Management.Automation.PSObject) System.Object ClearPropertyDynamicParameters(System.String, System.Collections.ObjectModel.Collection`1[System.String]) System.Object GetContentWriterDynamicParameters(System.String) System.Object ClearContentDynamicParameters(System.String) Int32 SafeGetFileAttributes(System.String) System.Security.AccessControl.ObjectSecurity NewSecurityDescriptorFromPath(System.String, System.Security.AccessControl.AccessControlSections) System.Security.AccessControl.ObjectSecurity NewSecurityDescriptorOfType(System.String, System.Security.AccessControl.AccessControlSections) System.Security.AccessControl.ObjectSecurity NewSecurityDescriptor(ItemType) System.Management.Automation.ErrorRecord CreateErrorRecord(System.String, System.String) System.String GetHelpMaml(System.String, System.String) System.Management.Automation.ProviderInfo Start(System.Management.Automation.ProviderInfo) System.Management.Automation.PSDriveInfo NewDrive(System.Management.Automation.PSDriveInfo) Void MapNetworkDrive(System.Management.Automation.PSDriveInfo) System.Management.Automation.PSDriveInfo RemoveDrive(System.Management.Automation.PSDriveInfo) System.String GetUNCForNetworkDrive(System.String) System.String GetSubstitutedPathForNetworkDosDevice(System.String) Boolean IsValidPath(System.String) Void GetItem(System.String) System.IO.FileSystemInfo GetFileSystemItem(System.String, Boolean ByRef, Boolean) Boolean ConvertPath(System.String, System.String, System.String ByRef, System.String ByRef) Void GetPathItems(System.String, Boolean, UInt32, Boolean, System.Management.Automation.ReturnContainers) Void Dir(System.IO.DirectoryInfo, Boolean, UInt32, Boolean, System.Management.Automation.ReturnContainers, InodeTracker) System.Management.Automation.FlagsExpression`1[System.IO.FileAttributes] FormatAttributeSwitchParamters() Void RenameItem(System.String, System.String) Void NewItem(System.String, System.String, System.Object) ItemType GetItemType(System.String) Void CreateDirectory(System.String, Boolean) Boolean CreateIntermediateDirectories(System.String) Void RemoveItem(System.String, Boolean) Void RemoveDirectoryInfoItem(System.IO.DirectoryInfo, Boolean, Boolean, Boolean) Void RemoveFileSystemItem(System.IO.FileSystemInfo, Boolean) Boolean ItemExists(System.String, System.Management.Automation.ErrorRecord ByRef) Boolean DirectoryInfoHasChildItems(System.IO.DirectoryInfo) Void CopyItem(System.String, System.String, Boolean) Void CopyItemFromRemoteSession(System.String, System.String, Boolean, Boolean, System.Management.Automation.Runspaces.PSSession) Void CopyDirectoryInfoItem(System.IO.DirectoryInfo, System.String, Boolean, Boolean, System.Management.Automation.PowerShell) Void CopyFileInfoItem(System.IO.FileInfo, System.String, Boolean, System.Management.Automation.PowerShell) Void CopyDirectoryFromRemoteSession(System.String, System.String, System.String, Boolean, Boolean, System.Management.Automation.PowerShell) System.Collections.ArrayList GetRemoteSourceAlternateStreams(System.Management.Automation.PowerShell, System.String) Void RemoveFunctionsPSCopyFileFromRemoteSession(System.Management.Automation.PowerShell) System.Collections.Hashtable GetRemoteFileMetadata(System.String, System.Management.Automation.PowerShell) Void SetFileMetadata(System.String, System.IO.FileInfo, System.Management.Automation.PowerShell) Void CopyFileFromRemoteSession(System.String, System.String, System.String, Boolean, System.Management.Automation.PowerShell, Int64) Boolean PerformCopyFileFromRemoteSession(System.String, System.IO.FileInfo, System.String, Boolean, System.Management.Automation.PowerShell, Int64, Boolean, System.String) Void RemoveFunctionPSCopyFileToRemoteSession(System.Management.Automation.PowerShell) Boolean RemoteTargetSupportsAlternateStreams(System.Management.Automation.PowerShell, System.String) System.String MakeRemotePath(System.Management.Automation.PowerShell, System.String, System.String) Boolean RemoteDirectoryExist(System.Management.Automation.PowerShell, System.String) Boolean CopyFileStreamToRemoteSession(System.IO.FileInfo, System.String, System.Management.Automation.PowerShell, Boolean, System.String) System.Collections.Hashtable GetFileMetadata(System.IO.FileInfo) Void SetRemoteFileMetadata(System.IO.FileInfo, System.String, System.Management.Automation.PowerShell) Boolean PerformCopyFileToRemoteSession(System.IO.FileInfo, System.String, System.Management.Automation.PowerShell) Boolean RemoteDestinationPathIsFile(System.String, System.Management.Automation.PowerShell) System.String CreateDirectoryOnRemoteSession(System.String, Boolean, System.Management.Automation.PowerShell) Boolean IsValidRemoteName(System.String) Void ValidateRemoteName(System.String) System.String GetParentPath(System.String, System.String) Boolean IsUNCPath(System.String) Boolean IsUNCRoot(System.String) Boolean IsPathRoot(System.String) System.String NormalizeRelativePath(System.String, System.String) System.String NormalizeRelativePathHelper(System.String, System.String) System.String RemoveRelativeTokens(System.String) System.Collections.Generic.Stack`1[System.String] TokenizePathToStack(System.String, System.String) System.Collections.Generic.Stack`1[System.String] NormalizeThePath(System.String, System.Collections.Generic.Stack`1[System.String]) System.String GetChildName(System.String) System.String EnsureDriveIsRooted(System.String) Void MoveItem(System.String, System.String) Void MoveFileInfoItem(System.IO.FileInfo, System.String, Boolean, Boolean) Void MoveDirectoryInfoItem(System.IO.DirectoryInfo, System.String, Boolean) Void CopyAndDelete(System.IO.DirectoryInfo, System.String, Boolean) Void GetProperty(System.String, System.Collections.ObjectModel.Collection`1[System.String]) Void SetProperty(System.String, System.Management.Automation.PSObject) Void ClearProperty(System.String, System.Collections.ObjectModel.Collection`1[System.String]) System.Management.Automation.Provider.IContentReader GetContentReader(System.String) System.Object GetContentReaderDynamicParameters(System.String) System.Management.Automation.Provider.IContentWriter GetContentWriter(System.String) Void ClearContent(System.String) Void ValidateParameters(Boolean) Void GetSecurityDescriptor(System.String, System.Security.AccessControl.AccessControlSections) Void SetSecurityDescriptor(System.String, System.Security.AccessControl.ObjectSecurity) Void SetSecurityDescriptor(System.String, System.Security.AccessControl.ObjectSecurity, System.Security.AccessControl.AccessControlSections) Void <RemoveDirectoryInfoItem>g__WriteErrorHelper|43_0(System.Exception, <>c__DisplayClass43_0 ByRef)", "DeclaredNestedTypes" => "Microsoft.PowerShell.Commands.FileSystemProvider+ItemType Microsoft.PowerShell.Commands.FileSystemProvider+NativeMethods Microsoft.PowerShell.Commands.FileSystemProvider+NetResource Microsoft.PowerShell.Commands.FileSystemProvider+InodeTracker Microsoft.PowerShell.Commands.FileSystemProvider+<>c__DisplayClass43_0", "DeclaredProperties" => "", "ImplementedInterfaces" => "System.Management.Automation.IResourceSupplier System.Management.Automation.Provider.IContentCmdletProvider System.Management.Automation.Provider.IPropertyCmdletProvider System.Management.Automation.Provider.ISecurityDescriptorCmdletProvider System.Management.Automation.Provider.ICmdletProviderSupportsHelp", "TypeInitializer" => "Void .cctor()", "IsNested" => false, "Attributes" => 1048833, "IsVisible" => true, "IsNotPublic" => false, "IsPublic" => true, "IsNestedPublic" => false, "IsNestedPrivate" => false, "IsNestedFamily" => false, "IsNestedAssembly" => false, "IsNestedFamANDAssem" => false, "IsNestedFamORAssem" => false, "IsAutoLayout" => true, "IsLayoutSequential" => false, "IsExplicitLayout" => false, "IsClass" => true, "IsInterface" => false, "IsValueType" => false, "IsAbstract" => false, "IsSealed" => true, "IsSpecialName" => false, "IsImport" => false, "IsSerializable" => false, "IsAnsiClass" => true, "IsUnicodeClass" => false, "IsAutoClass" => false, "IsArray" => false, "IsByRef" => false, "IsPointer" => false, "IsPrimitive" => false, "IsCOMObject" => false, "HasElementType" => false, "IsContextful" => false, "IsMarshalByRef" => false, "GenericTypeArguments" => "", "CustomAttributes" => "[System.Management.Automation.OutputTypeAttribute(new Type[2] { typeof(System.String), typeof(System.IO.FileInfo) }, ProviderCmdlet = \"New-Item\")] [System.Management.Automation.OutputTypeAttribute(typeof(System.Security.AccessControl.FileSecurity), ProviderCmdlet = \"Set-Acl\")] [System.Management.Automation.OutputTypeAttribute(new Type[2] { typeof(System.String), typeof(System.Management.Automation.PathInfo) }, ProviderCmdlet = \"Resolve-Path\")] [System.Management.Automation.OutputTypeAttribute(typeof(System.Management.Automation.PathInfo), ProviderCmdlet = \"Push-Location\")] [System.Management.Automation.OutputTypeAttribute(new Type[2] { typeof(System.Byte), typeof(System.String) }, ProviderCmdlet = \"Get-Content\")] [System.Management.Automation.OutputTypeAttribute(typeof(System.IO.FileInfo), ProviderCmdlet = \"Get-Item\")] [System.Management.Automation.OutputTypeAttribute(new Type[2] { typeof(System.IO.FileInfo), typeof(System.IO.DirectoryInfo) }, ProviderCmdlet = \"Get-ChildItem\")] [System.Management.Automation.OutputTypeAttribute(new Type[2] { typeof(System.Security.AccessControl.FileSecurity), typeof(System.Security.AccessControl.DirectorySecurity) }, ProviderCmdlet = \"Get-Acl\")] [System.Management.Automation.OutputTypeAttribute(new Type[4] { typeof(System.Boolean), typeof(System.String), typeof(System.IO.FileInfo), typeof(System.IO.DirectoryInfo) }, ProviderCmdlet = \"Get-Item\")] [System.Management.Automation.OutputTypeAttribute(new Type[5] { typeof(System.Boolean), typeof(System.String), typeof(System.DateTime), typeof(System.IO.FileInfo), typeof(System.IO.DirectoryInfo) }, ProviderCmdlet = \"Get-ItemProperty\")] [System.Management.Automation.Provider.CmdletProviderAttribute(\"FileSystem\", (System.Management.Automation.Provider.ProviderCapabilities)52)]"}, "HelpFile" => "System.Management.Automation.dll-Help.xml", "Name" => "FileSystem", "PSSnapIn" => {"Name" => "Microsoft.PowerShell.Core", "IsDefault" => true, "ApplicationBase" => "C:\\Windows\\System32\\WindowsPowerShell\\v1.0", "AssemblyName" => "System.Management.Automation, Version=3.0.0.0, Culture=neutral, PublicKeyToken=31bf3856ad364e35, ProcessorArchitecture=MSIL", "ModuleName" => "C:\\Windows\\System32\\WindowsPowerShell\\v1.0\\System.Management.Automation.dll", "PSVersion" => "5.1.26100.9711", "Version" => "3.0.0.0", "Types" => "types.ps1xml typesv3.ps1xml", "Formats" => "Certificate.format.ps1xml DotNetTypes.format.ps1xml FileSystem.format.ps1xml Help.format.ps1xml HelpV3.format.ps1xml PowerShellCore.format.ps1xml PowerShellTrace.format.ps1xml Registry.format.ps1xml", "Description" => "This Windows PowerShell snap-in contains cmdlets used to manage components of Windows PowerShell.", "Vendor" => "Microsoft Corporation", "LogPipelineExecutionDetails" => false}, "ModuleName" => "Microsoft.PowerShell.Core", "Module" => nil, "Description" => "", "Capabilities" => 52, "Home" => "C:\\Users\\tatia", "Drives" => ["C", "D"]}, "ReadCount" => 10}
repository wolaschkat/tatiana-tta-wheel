'use strict';
/*
 * App updates from GitHub Releases.
 *  - check():   compares package.json "version" with the latest release of the app repo.
 *  - install(): only when the admin presses INSTALL UPDATE. Downloads the release zip, checks it,
 *               backs up the files it replaces into data/update-backup/, then writes the new files.
 * Private files are never downloaded over, never published: .env (Kick keys) and data/ (tokens, queue, history).
 * The repo is public, so no GitHub token is needed (and none must ever be stored here).
 */
const fs = require('fs');
const path = require('path');
const Zip = require('./zip.js');

const ZIP_ROOT = 'tatiana-tta-wheel/';
const MAX_ZIP = 25 * 1024 * 1024;

// "v1.2.3" / "1.2.3" -> [1, 2, 3]; anything unparseable -> null
function parse(v) {
  const m = String(v || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  return m ? m.slice(1).map(Number) : null;
}
// > 0 when a is newer than b
function compare(a, b) {
  const x = parse(a), y = parse(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}
// Files that belong to this computer only. Shared with scripts/release.js.
function isPrivate(rel) {
  rel = rel.replace(/\\/g, '/');
  const base = rel.split('/').pop();
  return (/^\.env/.test(base) && base !== '.env.example') || /^(data|\.git|node_modules)(\/|$)/.test(rel);
}
// Zip entry -> safe relative path inside the app folder, or null
function safeRel(name) {
  if (!name.startsWith(ZIP_ROOT)) return null;
  const rel = name.slice(ZIP_ROOT.length);
  if (!rel || rel.includes('\\') || rel.startsWith('/') || rel.split('/').some((s) => s === '..' || s === '' || s === '.')) return null;
  return isPrivate(rel) ? null : rel;
}

function create({ current, repo, appDir, backupDir, enabled = true, log = () => {} }) {
  const st = { current, repo, enabled, latest: null, available: false, url: `https://github.com/${repo}/releases`, notes: '', publishedAt: null, checkedAt: null, error: null, installing: false, installed: null };
  let asset = null;

  async function check() {
    if (!enabled) return st;
    try {
      const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'tatiana-tta-wheel/' + current },
        signal: AbortSignal.timeout(10000),
      });
      if (r.status === 404) Object.assign(st, { latest: null, available: false, error: null }); // no release published yet
      else if (!r.ok) throw new Error('GitHub answered HTTP ' + r.status);
      else {
        const j = await r.json();
        const latest = String(j.tag_name).replace(/^v/, '');
        asset = (j.assets || []).find((a) => a.name === `tatiana-tta-wheel-v${latest}.zip`) || null;
        const available = compare(latest, current) > 0 && st.installed !== latest;
        Object.assign(st, { latest, available, url: j.html_url, notes: String(j.body || '').slice(0, 4000), publishedAt: j.published_at, error: null });
        if (available) log(`update available: v${latest} (running v${current}) - ${st.url}`);
      }
    } catch (e) {
      st.error = e.name === 'TimeoutError' ? 'GitHub did not answer in time' : e.message;
    }
    st.checkedAt = Date.now();
    return st;
  }

  async function install() {
    if (st.installing) throw new Error('An update is already being installed.');
    await check();
    if (st.error) throw new Error('Could not reach GitHub: ' + st.error);
    if (!st.available) throw new Error('You already have the latest version.');
    if (!asset) throw new Error(`Release v${st.latest} has no tatiana-tta-wheel-v${st.latest}.zip to install.`);
    st.installing = true;
    try {
      const expected = `https://github.com/${repo}/releases/download/`;
      if (!asset.browser_download_url.startsWith(expected)) throw new Error('Unexpected download address.');
      const r = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'tatiana-tta-wheel/' + current }, signal: AbortSignal.timeout(120000) });
      if (!r.ok) throw new Error('Download failed: HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_ZIP) throw new Error('Download is unexpectedly large.');

      const files = [];
      for (const e of Zip.read(buf)) { const rel = safeRel(e.name); if (rel) files.push({ rel, data: e.data }); }
      const pkg = files.find((f) => f.rel === 'package.json');
      if (!pkg || !files.some((f) => f.rel === 'server.js')) throw new Error('The download is not a wheel app release.');
      if (JSON.parse(pkg.data.toString('utf8')).version !== st.latest) throw new Error('The download does not match the release version.');

      // Back up what gets replaced, then write each file atomically.
      const bdir = path.join(backupDir, 'v' + current);
      for (const { rel } of files) {
        const dst = path.join(appDir, rel);
        if (fs.existsSync(dst)) { fs.mkdirSync(path.dirname(path.join(bdir, rel)), { recursive: true }); fs.copyFileSync(dst, path.join(bdir, rel)); }
      }
      for (const { rel, data } of files) {
        const dst = path.join(appDir, rel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.writeFileSync(dst + '.new', data);
        fs.renameSync(dst + '.new', dst);
      }
      st.installed = st.latest; st.available = false;
      log(`installed v${st.latest} (${files.length} files, backup of v${current} in ${bdir})`);
      return { version: st.latest, files: files.length };
    } finally { st.installing = false; }
  }

  return { check, install, status: () => ({ ...st }) };
}

module.exports = { create, compare, parse, isPrivate, safeRel, ZIP_ROOT };
