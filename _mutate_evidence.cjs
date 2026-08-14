// Reintroduces each way the evidence panel could be turned into a lie, and
// confirms the suite catches it. Restores on ANY exit, including a kill.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const root = 'C:/Users/Studio/AppData/Roaming/AGNT/projects/gitstarter.wt/evidence';
const files = {
  server: `${root}/server/server.js`,
  client: `${root}/client/app.js`,
  db: `${root}/server/db.js`,
  test: `${root}/server/test/evidence.test.js`,
};
const original = Object.fromEntries(Object.entries(files).map(([k, p]) => [k, fs.readFileSync(p, 'utf8')]));

let done = false;
const restore = () => {
  if (done) return;
  done = true;
  for (const [k, p] of Object.entries(files)) {
    if (fs.readFileSync(p, 'utf8') !== original[k]) fs.writeFileSync(p, original[k]);
  }
};
process.on('exit', restore);
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(s, () => { restore(); process.exit(130); });
process.on('uncaughtException', e => { restore(); console.error(e); process.exit(1); });

const run = () => {
  try { execFileSync('node', ['--test', 'server/test/evidence.test.js'], { cwd: root, stdio: 'pipe' }); return true; }
  catch { return false; }
};

const cases = [
  ['server', 'THE BUG: accept evidence without checking the hash',
    /if \(digest\.length !== committed\.length \|\| !crypto\.timingSafeEqual\(digest, committed\)\) \{[\s\S]*?\r?\n    \}/, ''],
  ['server', 'trust a hash supplied by the caller instead of the chain',
    /const committed = Buffer\.from\(chain\.submission\.evidenceHash, 'hex'\);/,
    "const committed = Buffer.from(req.body.evidenceHash || '', 'hex');"],
  ['server', 'compare with a timing-leaky equality',
    /crypto\.timingSafeEqual\(digest, committed\)/, 'digest.equals(committed)'],
  ['server', 'let evidence be filed against any milestone',
    /if \(chain\.submission\.milestoneIndex !== milestoneIndex\) \{[\s\S]*?\r?\n    \}/, ''],
  ['server', 'read the commitment from a stale cache',
    /await rpc\('getAccountInfo'/, 'await cachedAccountInfo('],
  // Expected MISS, verified by probe rather than assumed: the outer regex
  // `^https?://\S+// Reintroduces each way the evidence panel could be turned into a lie, and
// confirms the suite catches it. Restores on ANY exit, including a kill.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const root = 'C:/Users/Studio/AppData/Roaming/AGNT/projects/gitstarter.wt/evidence';
const files = {
  server: `${root}/server/server.js`,
  client: `${root}/client/app.js`,
  db: `${root}/server/db.js`,
  test: `${root}/server/test/evidence.test.js`,
};
const original = Object.fromEntries(Object.entries(files).map(([k, p]) => [k, fs.readFileSync(p, 'utf8')]));

let done = false;
const restore = () => {
  if (done) return;
  done = true;
  for (const [k, p] of Object.entries(files)) {
    if (fs.readFileSync(p, 'utf8') !== original[k]) fs.writeFileSync(p, original[k]);
  }
};
process.on('exit', restore);
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(s, () => { restore(); process.exit(130); });
process.on('uncaughtException', e => { restore(); console.error(e); process.exit(1); });

const run = () => {
  try { execFileSync('node', ['--test', 'server/test/evidence.test.js'], { cwd: root, stdio: 'pipe' }); return true; }
  catch { return false; }
};

const cases = [
  ['server', 'THE BUG: accept evidence without checking the hash',
    /if \(digest\.length !== committed\.length \|\| !crypto\.timingSafeEqual\(digest, committed\)\) \{[\s\S]*?\r?\n    \}/, ''],
  ['server', 'trust a hash supplied by the caller instead of the chain',
    /const committed = Buffer\.from\(chain\.submission\.evidenceHash, 'hex'\);/,
    "const committed = Buffer.from(req.body.evidenceHash || '', 'hex');"],
  ['server', 'compare with a timing-leaky equality',
    /crypto\.timingSafeEqual\(digest, committed\)/, 'digest.equals(committed)'],
  ['server', 'let evidence be filed against any milestone',
    /if \(chain\.submission\.milestoneIndex !== milestoneIndex\) \{[\s\S]*?\r?\n    \}/, ''],
  ['server', 'read the commitment from a stale cache',
    /await rpc\('getAccountInfo'/, 'await cachedAccountInfo('],
 already rejects every non-http scheme, and any string that
  // passes it either parses to http(s) or throws into the catch and is escaped.
  // No input reaches the inner protocol check with a dangerous protocol, so this
  // mutation is undetectable BY DESIGN. The check stays as defence-in-depth
  // against a future loosening of the regex.
  ['client', 'linkify any scheme, including javascript: (expected MISS, unreachable)',
    /if\(url\.protocol==='http:'\|\|url\.protocol==='https:'\)\{/, 'if(true){'],
  ['client', 'stop escaping markup in the evidence',
    /  return esc\(trimmed\);/, '  return trimmed;'],
  ['client', 'hand the counterparty window.opener',
    /rel="noopener noreferrer nofollow"/, 'rel=""'],
  ['client', 'go back to showing a truncated hash',
    /\+deliveryPanel\(p,sub\)\+deliveryHistory\(p,sub\.evidenceHash\)/, ''],
  ['client', 'invent a delivery when none was recorded',
    /if\(!recorded\)\{/, 'if(false){'],
  ['db', 'key deliveries by milestone, losing the revision history',
    /PRIMARY KEY \(commission, evidence_hash\)/, 'PRIMARY KEY (commission, milestone_index)'],
];

console.log(`clean suite: ${run() ? 'PASS' : 'FAIL'}`);
let missed = 0;
for (const [file, label, find, replace] of cases) {
  const mutated = original[file].replace(find, replace);
  if (mutated === original[file]) { console.log(`SETUP-FAIL  ${label}`); missed++; continue; }
  fs.writeFileSync(files[file], mutated);
  const caught = !run();
  fs.writeFileSync(files[file], original[file]);
  if (!caught) missed++;
  console.log(`${caught ? 'CAUGHT ' : 'MISSED '} ${label}`);
}
restore();
console.log(`\nrestored: ${Object.entries(files).every(([k, p]) => fs.readFileSync(p, 'utf8') === original[k])}`);
console.log(`missed: ${missed}`);
