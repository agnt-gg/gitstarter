'use strict';
// The premise of this project is strangers — human and autonomous — doing paid
// work in a repository they have never seen. CONTRIBUTING.md is their manual,
// and the part most likely to hurt someone if it rots is the scripts table:
// several scripts in scripts/ move real SOL on mainnet by default, and the
// table is what tells a newcomer which ones. So the table is tested against
// the directory listing: a script this table does not name fails the build.

process.env.DATABASE_PATH = require('node:path').join(require('node:os').tmpdir(), `gitstarter-contributing-${process.pid}.sqlite`);
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const CONTRIBUTING = fs.readFileSync(path.join(ROOT, 'CONTRIBUTING.md'), 'utf8');

test('every script in scripts/ is named and classified', () => {
  const scripts = fs.readdirSync(path.join(ROOT, 'scripts')).filter(f => f.endsWith('.mjs'));
  assert.ok(scripts.length >= 20, `expected the full scripts directory, found ${scripts.length}`);
  for (const script of scripts) {
    const row = CONTRIBUTING.split('\n').find(line => line.includes(`\`${script}\``));
    assert.ok(row, `${script} exists but CONTRIBUTING.md does not list it — classify it before it burns someone`);
    assert.match(row, /read-only|devnet|mainnet/i,
      `${script} is listed but not classified as read-only, devnet, or mainnet`);
  }
});

test('the scripts that spend real money are marked as such', () => {
  // These three defaults are the dangerous ones. If their classification ever
  // softens, a contributor "just trying a script" is one enter key away from a
  // mainnet transaction.
  for (const dangerous of ['sweep-deposits.mjs', 'verify-mainnet-cycle.mjs', 'create-multisig.mjs']) {
    const row = CONTRIBUTING.split('\n').find(line => line.includes(`\`${dangerous}\``));
    assert.ok(row && /mainnet/i.test(row), `${dangerous} must be marked as touching mainnet`);
  }
});

test('the path from clone to green tests is stated', () => {
  for (const step of ['npm ci', 'npm test', 'cargo test', 'build:client', 'llms.txt']) {
    assert.ok(CONTRIBUTING.includes(step), `CONTRIBUTING.md must mention ${step}`);
  }
  assert.match(CONTRIBUTING, /18\.19\.1/, 'the production Node version is a fact contributors need');
});

test('the templates that route contributions exist', () => {
  for (const file of ['.github/PULL_REQUEST_TEMPLATE.md', '.github/ISSUE_TEMPLATE/bug_report.md', '.github/ISSUE_TEMPLATE/commission_proposal.md', '.github/workflows/ci.yml']) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} is referenced by the contribution flow and must exist`);
  }
});

test('CI runs the version production actually runs', () => {
  const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /18\.19\.1/,
    'the Node 18 leg is what catches ESM-only dependencies before they take down production');
  assert.match(ci, /build:client/, 'CI must reject a stale committed bundle');
  assert.match(ci, /cargo test/, 'CI must run the program suites');
  assert.equal(/secrets\./.test(ci), false, 'CI must pass on fork PRs, so it may not reference secrets');
});
