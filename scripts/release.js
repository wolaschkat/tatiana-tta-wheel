'use strict';
/*
 * Publish a new version of the wheel app (run on the developer PC, not on the streaming PC).
 *
 *   npm run release 1.2.0
 *   npm run release 1.2.0 "Bigger wheel text, fixed the gift sound"     (optional notes Tatiana sees)
 *
 * Runs the tests, sets the version in package.json, commits and pushes, builds
 * tatiana-tta-wheel-v1.2.0.zip from the tracked files and creates the GitHub Release.
 * Tatiana's app then shows "Update v1.2.0 — click to install".
 *
 * Needs: git, gh (logged in with write access to the repo), Node 18+.
 * Secrets never go out: .env and data/ are refused, and every file is scanned for the
 * values of this PC's .env / data/*.json before anything is pushed.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Zip = require('../lib/zip.js');
const { compare, parse, isPrivate, ZIP_ROOT } = require('../lib/update.js');

const ROOT = path.join(__dirname, '..');
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts });
const run = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
const fail = (msg) => { console.error('\n  ✗ ' + msg + '\n'); process.exit(1); };
const step = (msg) => console.log('\n→ ' + msg);

// ---------- arguments and preconditions ----------
const pkgFile = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
const version = (process.argv[2] || '').replace(/^v/, '');
if (!parse(version)) fail(`Give the new version, e.g.  npm run release ${pkg.version.replace(/\d+$/, (n) => +n + 1)}`);
if (compare(version, pkg.version) <= 0) fail(`${version} must be higher than the current version ${pkg.version}.`);

try { sh('gh', ['auth', 'status'], { stdio: 'pipe' }); } catch (_) { fail('gh is not logged in. Run: gh auth login'); }
if (sh('git', ['status', '--porcelain']).trim()) fail('You have uncommitted changes. Commit them first (git add -A && git commit -m "...").');
const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
if (branch !== 'main') fail(`Releases are made from main (you are on ${branch}).`);
step('Getting the latest main from GitHub');
run('git', ['pull', '--ff-only']);
if (sh('git', ['tag', '--list', 'v' + version]).trim()) fail(`v${version} already exists.`);

// ---------- secret guard ----------
const files = sh('git', ['ls-files', '-z']).split('\0').filter(Boolean);
const priv = files.filter(isPrivate);
if (priv.length) fail('These private files are tracked by git and must be removed first (git rm --cached): ' + priv.join(', '));

const secretValues = [];
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m && !['PORT', 'HOST', 'KICK_CHANNEL', 'UPDATE_CHECK', 'UPDATE_REPO'].includes(m[1]) && m[2].length >= 8) secretValues.push(m[2]);
  }
} catch (_) {}
const walk = (o, k) => { if (typeof o === 'string') { if (o.length >= 12 && k !== 'scope') secretValues.push(o); } else if (o && typeof o === 'object') for (const [kk, v] of Object.entries(o)) walk(v, kk); };
for (const f of ['secrets.json', 'kick-tokens.json']) { try { walk(JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8'))); } catch (_) {} }
for (const f of files) {
  const text = fs.readFileSync(path.join(ROOT, f)).toString('utf8');
  if (secretValues.some((s) => text.includes(s))) fail(`${f} contains one of your secret keys (.env / data). Remove it before releasing.`);
}
console.log(`  ✓ ${files.length} files, no private files, no secret values (${secretValues.length} checked)`);

// ---------- tests, version, push ----------
step('Running tests');
run(process.execPath, ['test/run.js']);

step(`Setting version ${version}, committing and pushing`);
pkg.version = version;
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
run('git', ['add', 'package.json']);
run('git', ['commit', '-m', 'v' + version]);
run('git', ['push']);
const sha = sh('git', ['rev-parse', 'HEAD']).trim();

// ---------- zip + release ----------
step('Building the download');
const zip = Zip.write(files.map((f) => ({ name: ZIP_ROOT + f, data: fs.readFileSync(path.join(ROOT, f)) })));
const zipPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tta-release-')), `tatiana-tta-wheel-v${version}.zip`);
fs.writeFileSync(zipPath, zip);
console.log(`  ✓ ${path.basename(zipPath)} (${files.length} files, ${(zip.length / 1024).toFixed(0)} KB)`);

step('Publishing the GitHub Release');
// Notes: the text given on the command line, otherwise the commit messages since the previous release.
let notes = process.argv.slice(3).join(' ').trim();
if (!notes) {
  let prev = ''; try { prev = sh('git', ['describe', '--tags', '--abbrev=0', 'HEAD~1'], { stdio: 'pipe' }).trim(); } catch (_) {}
  notes = sh('git', ['log', '--no-merges', '--pretty=- %s', prev ? `${prev}..HEAD~1` : 'HEAD~1']).trim() || '- Small fixes';
}
const notesPath = path.join(path.dirname(zipPath), 'notes.md');
fs.writeFileSync(notesPath, notes + '\n');
run('gh', ['release', 'create', 'v' + version, zipPath, '--target', sha, '--title', 'v' + version, '--notes-file', notesPath]);
console.log(`\n  ✓ v${version} is out. Tatiana's app will show "Update v${version} — click to install" within 6 hours,\n    or right away if she presses "Check for updates".\n`);
