'use strict';
// The README and llms.txt now carry the API contract: instruction discriminants,
// account offsets, error codes, endpoint names. Documentation that drifts from
// the code is worse than no documentation, because a reader who trusts it builds
// a transaction that gets rejected — or worse, one that does something other
// than what they intended. These tests fail when the docs and the source
// disagree, so drift is caught at commit time rather than by an agent at 3am.

process.env.DATABASE_PATH = require('node:path').join(require('node:os').tmpdir(), `gitstarter-docs-${process.pid}.sqlite`);
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const escrow = require('../../shared/escrow');

const ROOT = path.join(__dirname, '..', '..');

/// The builder table in server.js is the source of truth for what
/// POST /api/v1/tx/{action} accepts.
function transactionActions(source) {
  const block = /const TX_BUILDERS = \{([\s\S]*?)\n\};/.exec(source);
  assert.ok(block, 'could not locate TX_BUILDERS');
  return Object.fromEntries([...block[1].matchAll(/^  '?([a-z-]+)'?: async body/gm)].map(m => [m[1], true]));
}
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const LLMS = fs.readFileSync(path.join(ROOT, 'server', 'llms.template.txt'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
const TX_ACTIONS = transactionActions(SERVER);
const DOCS = { README, 'llms.txt': LLMS };

/// Returns the body rows of the markdown table whose header contains `heading`.
/// Matching tables by their header rather than by row shape keeps the error
/// table, the instruction table and the account layout from being confused for
/// one another — they all look like `| number | word | ...`.
function tableRows(doc, heading) {
  const lines = doc.split('\n');
  const start = lines.findIndex(line => line.startsWith('|') && line.includes(heading));
  assert.notEqual(start, -1, `could not find a table headed "${heading}"`);
  const rows = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    rows.push(line.split('|').slice(1, -1).map(cell => cell.trim()));
  }
  assert.ok(rows.length, `table "${heading}" has no rows`);
  return rows;
}

test('every documented endpoint is actually registered', () => {
  const registered = [...SERVER.matchAll(/app\.(get|post)\('([^']+)'/g)].map(m => m[2]);

  // Read the paths out of the docs rather than restating them here: a hardcoded
  // list would still pass if someone mistyped a path in the README, which is
  // exactly the failure this test exists to catch.
  const documented = new Set();
  for (const doc of Object.values(DOCS)) {
    for (const [, route] of doc.matchAll(/`(?:GET|POST) (\/[\w/.:-]+)`/g)) documented.add(route);
    for (const [, route] of doc.matchAll(/\/api\/v1\/tx\/([a-z-]+)/g)) documented.add(`/api/v1/tx/${route}`);
  }
  assert.ok(documented.size >= 10, `expected the docs to describe the API surface, found ${documented.size}`);

  const txActions = new Set(Object.keys(TX_ACTIONS));
  for (const route of documented) {
    // Concrete transaction paths resolve to the one parameterised route.
    const action = /^\/api\/v1\/tx\/([a-z-]+)$/.exec(route);
    if (action) {
      assert.ok(txActions.has(action[1]), `docs describe /api/v1/tx/${action[1]}, which is not a builder`);
      continue;
    }
    // A documented `/api/v1/commissions/<address>` resolves to `:address`.
    const concrete = route.replace(/\/api\/v1\/commissions\/[^/]+$/, '/api/v1/commissions/:address');
    assert.ok(registered.includes(concrete),
      `the docs describe ${route}, which the server does not serve`);
  }

  // And every route the server exposes is documented somewhere.
  for (const route of registered) {
    if (route === '/api') continue; // the catch-all 404
    assert.ok(documented.has(route) || route === '/api/v1/tx/:action',
      `the server serves ${route} but no document mentions it`);
  }
});

test('every documented transaction action exists, and none is undocumented', () => {
  const actions = Object.keys(TX_ACTIONS);
  assert.ok(actions.length >= 8, `expected the full builder set, found ${actions.length}`);

  for (const action of actions) {
    for (const [name, doc] of Object.entries(DOCS)) {
      assert.ok(doc.includes(`\`${action}\``) || doc.includes(`/api/v1/tx/${action}`),
        `${name} does not document the ${action} action`);
    }
  }
});

test('every documented query filter is actually implemented', () => {
  const implemented = new Set([...SERVER.matchAll(/req\.query\.(\w+)/g)].map(m => m[1]));
  for (const param of ['wallet', 'status', 'label', 'creator', 'agent', 'indexed', 'openOnly', 'actionable']) {
    assert.ok(implemented.has(param), `docs promise ?${param}= but the server never reads it`);
  }
});

test('documented error codes match the program', () => {
  for (const [code, name] of Object.entries(escrow.ERRORS)) {
    for (const [docName, doc] of Object.entries(DOCS)) {
      assert.ok(new RegExp(`\\|\\s*${code}\\s*\\|\\s*${name}\\s*\\|`).test(doc),
        `${docName} is missing error ${code} (${name})`);
    }
  }
  // And nothing invented: every code in the docs exists in the program.
  for (const [docName, doc] of Object.entries(DOCS)) {
    for (const [code, name] of tableRows(doc, 'Dec')) {
      assert.equal(escrow.ERRORS[code], name, `${docName} claims error ${code} is ${name}`);
    }
  }
});

test('documented instruction discriminants match the program', () => {
  // The README table reads "| 4 | ReleaseMilestone | ...".
  const camel = name => name.charAt(0).toLowerCase() + name.slice(1);
  for (const [docName, doc] of Object.entries(DOCS)) {
    const rows = tableRows(doc, 'Instruction');
    for (const [discriminant, name] of rows) {
      assert.equal(escrow.IX[camel(name)], Number(discriminant),
        `${docName} says ${name} is ${discriminant}, program says ${escrow.IX[camel(name)]}`);
    }
    // llms.txt omits the admin-only instructions on purpose; the README is the
    // complete reference and must list every one.
    if (docName !== 'README') continue;
    assert.equal(rows.length, Object.keys(escrow.IX).length,
      'the README instruction table must list every instruction, and no others');
    for (const [name, discriminant] of Object.entries(escrow.IX)) {
      assert.ok(rows.some(([d, n]) => Number(d) === discriminant && camel(n) === name),
        `README omits instruction ${name} (${discriminant})`);
    }
  }
});

test('documented constants match the program', () => {
  for (const [name, doc] of Object.entries(DOCS)) {
    assert.ok(doc.includes(String(escrow.VAULT_RENT_LAMPORTS)),
      `${name} must state the real vault rent reserve`);
    assert.ok(doc.includes(String(escrow.COMMISSION_ACCOUNT_BYTES)),
      `${name} must state the real account size`);
    assert.ok(doc.includes(String(escrow.BPS_DENOMINATOR)),
      `${name} must state the real basis-point denominator`);
    // Every stated ceiling must agree with the program. Merely finding "180"
    // somewhere is not enough: the docs say it more than once, so one of them
    // could drift while the other keeps a substring check happy.
    const days = escrow.MAX_COMMISSION_DURATION_SECONDS / 86_400;
    const stated = [...doc.matchAll(/(?:at most|exceeds?|cannot exceed|may not exceed)\s+\**(\d+) days/gi)];
    assert.ok(stated.length, `${name} must state the deadline ceiling`);
    for (const [, value] of stated) {
      assert.equal(Number(value), days, `${name} states a ${value}-day ceiling; the program enforces ${days}`);
    }
  }
  assert.equal(escrow.MAX_COMMISSION_DURATION_SECONDS, 180 * 86_400);
  assert.equal(escrow.FEE_BASIS_POINTS, 100);
  assert.equal(escrow.MAX_MILESTONES, 8);
});

test('the documented account layout matches the decoder', () => {
  // Build an account with a known value at each documented offset and confirm
  // the decoder reads it back. A wrong offset in the README would otherwise
  // silently mislead anyone parsing accounts themselves.
  const offsets = tableRows(README, 'Offset')
    .map(([offset, size, field]) => ({ offset: Number(offset), size: Number(size), field }));
  assert.ok(offsets.length >= 20, `expected the full layout table, found ${offsets.length}`);

  const total = offsets.reduce((sum, f) => sum + f.size, 0);
  assert.equal(total, escrow.COMMISSION_ACCOUNT_BYTES,
    'the documented field sizes must add up to the real account size');

  let expectedOffset = 0;
  for (const field of offsets) {
    assert.equal(field.offset, expectedOffset,
      `${field.field} is documented at ${field.offset} but follows a field ending at ${expectedOffset}`);
    expectedOffset += field.size;
  }

  const b = Buffer.alloc(escrow.COMMISSION_ACCOUNT_BYTES);
  b[0] = 2;
  b.writeBigUInt64LE(1234n, 105);  // goal
  b.writeBigUInt64LE(999n, 113);   // total_pledged
  b.writeUInt32LE(7, 137);         // pledger_count
  b[211] = 3;                      // status -> shipped
  b[212] = 1;                      // milestone_count
  b.writeUInt16LE(10_000, 213);
  b.writeBigInt64LE(1_900_000_000n, 230);
  const decoded = escrow.decodeCommission(b);
  assert.equal(decoded.goal, 1234, 'goal must live at the documented offset 105');
  assert.equal(decoded.pledged, 999, 'total_pledged must live at the documented offset 113');
  assert.equal(decoded.pledgerCount, 7, 'pledger_count must live at the documented offset 137');
  assert.equal(decoded.status, 'shipped', 'status must live at the documented offset 211');
  assert.equal(decoded.deadline, 1_900_000_000, 'deadline must live at the documented offset 230');
});

test('documented PDA seeds match the derivation', () => {
  // Real addresses from the live devnet bounty.
  const PROGRAM = '6PFsiUA7sX5j96pzK7zxLbpFpsJXNLkfwQPYyd4UNFTy';
  const COMMISSION = 'J2DtKVrZj6hxHejkHQhBcKWWz2HHJAhDcCDUwbcKkChQ';
  assert.equal(escrow.vaultPda(PROGRAM, COMMISSION).toBase58(),
    '319sBtryomPyakD9FCSrbFbZxx8V1BcodeEgw9n4M8fe',
    'the documented "vault" seed must derive the address that exists on chain');
  for (const [name, doc] of Object.entries(DOCS)) {
    assert.ok(doc.includes('["commission", creator(32), seed(u64 LE)]'), `${name} must document the commission seed`);
    assert.ok(doc.includes('["vault", commission(32)]'), `${name} must document the vault seed`);
    assert.ok(doc.includes('["pledge", commission(32), backer(32)]'), `${name} must document the pledge seed`);
  }
});

test('documented addresses agree with the server configuration', () => {
  const config = {
    programId: /PROGRAM_ID = process\.env\.PROGRAM_ID \|\| '([^']+)'/.exec(SERVER)[1],
    configPda: /CONFIG_PDA = process\.env\.CONFIG_PDA \|\| '([^']+)'/.exec(SERVER)[1],
    treasury: /TREASURY_WALLET = process\.env\.TREASURY_WALLET \|\| '([^']+)'/.exec(SERVER)[1],
  };
  for (const [key, address] of Object.entries(config)) {
    assert.ok(README.includes(address), `README must state the real ${key} (${address})`);
  }
});

test('the docs never instruct anyone to hand over a key', () => {
  for (const [name, doc] of Object.entries(DOCS)) {
    for (const forbidden of ['"privateKey"', '"secretKey"', '"mnemonic"', '"seedPhrase"']) {
      assert.equal(doc.includes(forbidden), false, `${name} must never ask for ${forbidden}`);
    }
    assert.ok(/never send a private key|never holds a key|no [\w ]{0,40}asks for a private key/i.test(doc),
      `${name} must state plainly that no key is ever required`);
  }
});

test('the docs disclose the limitations that affect money', () => {
  for (const [name, doc] of Object.entries(DOCS)) {
    assert.ok(/no (independent )?(on-chain )?arbitrat/i.test(doc), `${name} must disclose the lack of arbitration`);
    assert.ok(/rent is not reclaimable|not reclaimable/i.test(doc), `${name} must disclose unreclaimable rent`);
    assert.ok(/no independent professional audit/i.test(doc), `${name} must disclose the audit status`);
  }
});
