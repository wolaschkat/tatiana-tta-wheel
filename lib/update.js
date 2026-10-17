'use strict';
/*
 * Update checker: compares package.json "version" with the latest GitHub Release of the app repo.
 * Read-only: it never downloads or installs anything, it only tells the admin page that a new version exists.
 * The repo is public, so no GitHub token is needed (and none must ever be stored here).
 */

// "v1.2.3" / "1.2.3" -> [1, 2, 3]; anything unparseable -> null
function parse(v) {
  const m = String(v || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return m ? m.slice(1).map(Number) : null;
}
// > 0 when a is newer than b
function compare(a, b) {
  const x = parse(a), y = parse(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

function create({ current, repo, enabled = true, log = () => {} }) {
  const st = { current, repo, enabled, latest: null, available: false, url: `https://github.com/${repo}/releases`, notes: '', publishedAt: null, checkedAt: null, error: null };

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
        const available = compare(j.tag_name, current) > 0;
        Object.assign(st, { latest: String(j.tag_name).replace(/^v/, ''), available, url: j.html_url, notes: String(j.body || '').slice(0, 4000), publishedAt: j.published_at, error: null });
        if (available) log(`update available: v${st.latest} (running v${current}) - ${st.url}`);
      }
    } catch (e) {
      st.error = e.name === 'TimeoutError' ? 'GitHub did not answer in time' : e.message;
    }
    st.checkedAt = Date.now();
    return st;
  }

  return { check, status: () => ({ ...st }) };
}

module.exports = { create, compare, parse };
