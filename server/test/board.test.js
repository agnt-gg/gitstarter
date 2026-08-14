'use strict';
// The board is the product. If a funded commission is not on it, the work does
// not exist as far as anyone reading this page is concerned.
//
// It was possible to reach exactly that state: the list required a metadata row
// from our own database, so a commission created directly on chain — by a
// script, by another client, by an agent — was silently dropped. Every real
// bounty on devnet disappeared from the site while sitting fully funded on
// chain, which is the worst failure a job board can have.
//
// These tests execute the SHIPPED projection out of client/app.js. An earlier
// suite in this repo asserted against a pasted copy of the implementation and
// stayed green while the real code was broken, so nothing here is allowed to be
// a source-pattern check.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PublicKey } = require('@solana/web3.js');
const escrow = require('../../shared/escrow');

const CLIENT = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'app.js'), 'utf8');

/// Lifts a named function out of the client bundle by matching braces.
function extract(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `could not locate ${name} in client/app.js`);
  let depth = 0, seen = false;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') { depth++; seen = true; }
    else if (source[i] === '}') { depth--; if (seen && depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces reading ${name}`);
}

const { projectCommissions, listedAt } = new Function('escrow', `
  ${extract(CLIENT, 'listedAt')}
  ${extract(CLIENT, 'projectCommissions')}
  return { projectCommissions, listedAt };
`)(escrow);

const CREATOR = new PublicKey('2B8YDoo4Q3JJZuuGqqqVP86xoahgMsqREr3ScxhGS8C5');
const TREASURY = new PublicKey('4F66AtVCpftxwQ8SbcFdXkyCcubvfMhUpHddJ4AtN5HY');

/// A real, byte-accurate funded commission, so the decoder is genuinely
/// exercised rather than stubbed around.
function commissionAccount({ seed = 1, pledged = 20_000_000, status = 1 } = {}) {
  const b = Buffer.alloc(escrow.COMMISSION_ACCOUNT_BYTES);
  b[0] = 2;
  CREATOR.toBuffer().copy(b, 1);
  TREASURY.toBuffer().copy(b, 65);
  b.writeBigUInt64LE(BigInt(seed), 97);
  b.writeBigUInt64LE(20_000_000n, 105);        // goal
  b.writeBigUInt64LE(BigInt(pledged), 113);    // total_pledged
  b.writeUInt32LE(1, 137);                     // pledger_count
  b[178] = status;                             // 1 = funded
  b[179] = 1;                                  // milestone_count
  b.writeUInt16LE(10_000, 180);
  b.writeBigInt64LE(1_900_000_000n, 197);      // deadline
  b.writeBigInt64LE(604_800n, 207);            // work_window
  b.writeBigInt64LE(1_900_000_000n, 215);      // work_deadline
  b.writeBigInt64LE(172_800n, 223);            // review_window
  return { data: b };
}

const address = n => new PublicKey(Buffer.alloc(32, n)).toBase58();

test('a funded commission created on chain is listed even with no description', () => {
  // The exact regression: this is what every bounty on devnet looked like, and
  // the board rendered empty.
  const accounts = [{ pubkey: address(7), account: commissionAccount({ seed: Date.now() }) }];
  const listed = projectCommissions(accounts, new Map());

  assert.equal(listed.length, 1, 'a commission with escrow behind it must never be hidden');
  assert.equal(listed[0].address, address(7));
  assert.equal(listed[0].status, 'funded');
  assert.equal(listed[0].pledged, 20_000_000, 'and it must carry its real on-chain numbers');
  assert.equal(listed[0].meta, undefined, 'undescribed is a state to render, not a reason to drop it');
});

test('description, where we have one, is attached', () => {
  const meta = new Map([[address(7), { title: 'Add a smoke test', createdAt: 1_000 }]]);
  const [listed] = projectCommissions([{ pubkey: address(7), account: commissionAccount() }], meta);
  assert.equal(listed.meta.title, 'Add a smoke test');
});

test('one unreadable account cannot blank the whole board', () => {
  // A commission from an earlier layout, or any account we cannot parse, must
  // cost us that row and nothing else.
  const accounts = [
    { pubkey: address(1), account: { data: Buffer.alloc(316) } }, // the previous layout
    { pubkey: address(2), account: commissionAccount({ seed: 5 }) },
    { pubkey: address(3), account: { data: Buffer.alloc(4) } },
  ];
  const listed = projectCommissions(accounts, new Map());
  assert.equal(listed.length, 1, 'the readable commission still shows');
  assert.equal(listed[0].address, address(2));
});

test('the newest work is at the top, however it got there', () => {
  const now = Date.now();
  const meta = new Map([[address(1), { title: 'indexed', createdAt: now - 1_000 }]]);
  const listed = projectCommissions([
    { pubkey: address(1), account: commissionAccount({ seed: 1 }) },          // indexed, older
    { pubkey: address(2), account: commissionAccount({ seed: now }) },        // on chain, newest
    { pubkey: address(3), account: commissionAccount({ seed: 42 }) },         // no usable time
  ], meta);

  assert.deepEqual(listed.map(p => p.address), [address(2), address(1), address(3)],
    'a bounty posted directly on chain must be able to reach the top of the board');
});

test('an implausible seed is not treated as a timestamp', () => {
  // Seeds are chosen by whoever creates the commission, so a stranger could put
  // themselves permanently at the top by picking a huge number. Only values that
  // actually look like a recent millisecond timestamp are trusted.
  const now = Date.now();
  assert.equal(listedAt({ seed: now }), now, 'our own clients seed with Date.now()');
  assert.equal(listedAt({ seed: 42 }), 0, 'a small seed is not a date');
  assert.equal(listedAt({ seed: Number.MAX_SAFE_INTEGER }), 0, 'nor is a far-future one');
  assert.equal(listedAt({ seed: now + 5 * 86_400_000 }), 0, 'a seed days ahead cannot jump the queue');
  assert.equal(listedAt({ seed: 1, meta: { createdAt: 99 } }), 99, 'a real timestamp always wins');
});
