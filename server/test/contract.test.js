'use strict';
// The client and the program have to agree about two things a user feels
// immediately: what the error codes mean, and what values are legal.
//
// Both had drifted. The error map was hand-transcribed and had code 1 labelled
// `AlreadyInitialized` when 1 is `NotInitialized`, so a genuine failure could be
// explained as entirely the wrong cause — and the docs test only cross-checked
// the docs against that same wrong map, so both agreed and neither was right.
// Separately, the funding cap was lowered from 180 days to 30 without teaching
// the create form, so an ordinary deadline was accepted by the UI, rejected on
// chain, and surfaced to the user as the wallet's own opaque "reverted during
// simulation. An unknown error occurred."
//
// The Rust program is the only source of truth for both.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const RUST = fs.readFileSync(path.join(ROOT, 'program', 'src', 'lib.rs'), 'utf8');
const CLIENT = fs.readFileSync(path.join(ROOT, 'client', 'app.js'), 'utf8');
const escrow = require('../../shared/escrow');

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `could not locate ${name}`);
  const next = source.slice(start + 1).search(/\n(?:async )?function [A-Za-z]/);
  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
}

test('the JavaScript error map matches the Rust enum exactly', () => {
  const enumBlock = /pub enum EscrowError \{([\s\S]*?)\n\}/.exec(RUST);
  assert.ok(enumBlock, 'could not locate EscrowError');

  const fromRust = {};
  for (const [, name, code] of enumBlock[1].matchAll(/(\w+) = (\d+),/g)) fromRust[code] = name;
  assert.ok(
    Object.keys(fromRust).length >= 30,
    `expected the full enum, parsed only ${Object.keys(fromRust).length}`,
  );

  // The map assumes discriminants reach the client untouched. An offset here
  // would silently shift every code the user is shown.
  assert.match(
    RUST, /ProgramError::Custom\(e as u32\)/,
    'the error map assumes discriminants map to Custom() with no offset',
  );

  assert.deepEqual(
    escrow.ERRORS, fromRust,
    'shared/escrow.js ERRORS must match program/src/lib.rs EscrowError entry for entry',
  );
});

test('every explained error name is a real one', () => {
  // A help string keyed to a name the program never emits is dead text that
  // looks like coverage.
  const names = new Set(Object.values(escrow.ERRORS));
  for (const name of Object.keys(escrow.ERROR_HELP)) {
    assert.ok(names.has(name), `ERROR_HELP explains ${name}, which is not an EscrowError`);
  }
});

test('the create form validates every bound the program enforces', () => {
  const handler = functionBody(CLIENT, 'createCommission');

  // Each pattern asserts the COMPARISON, not that the constant appears
  // somewhere in the function. Matching the bare constant is what let the
  // original bug through a first draft of this very test: deleting the check
  // left `const maxFundingDays = escrow.MAX_FUNDING_DURATION_SECONDS/86400`
  // behind, so the assertion still passed while the guard was gone.
  const required = {
    'the funding deadline ceiling': /deadline\s*>\s*nowUnix\s*\+\s*escrow\.MAX_FUNDING_DURATION_SECONDS/,
    'a deadline already in the past': /deadline\s*<=\s*nowUnix/,
    'the goal floor': /goal\s*<\s*escrow\.BPS_DENOMINATOR/,
    'the milestone count': /percentages\.length\s*>\s*escrow\.MAX_MILESTONES/,
    'the delivery window': /deliveryDays\s*<=\s*escrow\.MAX_DELIVERY_WINDOW_SECONDS/,
    'the review window': /reviewHours\s*<=\s*escrow\.MAX_REVIEW_WINDOW_SECONDS/,
  };
  for (const [bound, pattern] of Object.entries(required)) {
    assert.match(handler, pattern, `createCommission must validate ${bound} before signing`);
  }
});

test('the deadline picker cannot offer a value the program will reject', () => {
  const dialog = functionBody(CLIENT, 'openCreate');
  for (const attribute of ['min', 'max', 'value']) {
    assert.ok(
      new RegExp(`${attribute}=\\\\?"\\$\\{deadline`).test(dialog),
      `the deadline input needs a ${attribute} so an illegal date cannot be entered`,
    );
  }
  assert.ok(
    dialog.includes('MAX_FUNDING_DURATION_SECONDS'),
    'the picker bounds must come from the program constant, not a literal',
  );
});

test('client-side bounds are sourced from the program, never hardcoded', () => {
  // The original bug was exactly this: the cap moved from 180 days to 30 and
  // the form kept its own idea of the rules. Every bound in the comparisons
  // above already has to name an `escrow.` constant, so a literal cannot be
  // substituted without failing. This pins the remaining risk — a stale number
  // written into the user-facing copy.
  const dialog = functionBody(CLIENT, 'openCreate');
  assert.match(
    dialog, /\$\{escrow\.MAX_FUNDING_DURATION_SECONDS\/86400\}\s*days/,
    'the deadline hint must state the cap from the constant, not a typed-in number',
  );
  assert.equal(
    /within 180 days|within 30 days/.test(dialog), false,
    'the deadline hint hardcodes a day count that will silently go stale',
  );
});

test('MetaMask transactions are signed on the chain we asked for', () => {
  // `standard:connect` opens the MetaMask session on MAINNET by default, and
  // `solana:signTransaction` ignores the `chain` argument entirely — it signs
  // against whatever scope the session already holds. Using it meant every
  // devnet transaction was presented to MetaMask as a mainnet one, where this
  // program does not exist, so the wallet rejected it during its own simulation
  // and nothing ever reached the network.
  //
  // `solana:signAndSendTransaction` derives the scope from `chain` and
  // re-scopes the session. It is the only correct path for this wallet.
  const adapter = functionBody(CLIENT, 'connectMetaMask');
  assert.ok(
    adapter.includes("'solana:signAndSendTransaction'"),
    'the MetaMask adapter must sign and send through the chain-aware feature',
  );
  assert.equal(
    adapter.includes("'solana:signTransaction'"), false,
    'solana:signTransaction ignores `chain` and signs on the session scope, which defaults to mainnet',
  );
  // The chain has to actually be handed over, not merely computed. Slice the
  // call by index: a non-greedy regex stops at the first `})`, which here is the
  // nested `serialize({...})`, and would miss the argument entirely.
  const callStart = adapter.indexOf('.signAndSendTransaction({');
  assert.notEqual(callStart, -1, 'could not find the signAndSendTransaction call');
  const callEnd = adapter.indexOf('bs58Encode', callStart);
  assert.notEqual(callEnd, -1, 'the signed result must be encoded and returned');
  assert.match(
    adapter.slice(callStart, callEnd), /\bchain\b/,
    'the chain must be passed to signAndSendTransaction, not merely computed',
  );
});

test('send prefers a wallet that signs and sends, and simulates first', () => {
  const send = functionBody(CLIENT, 'send');
  assert.match(
    send, /typeof provider\.signAndSendTransaction\s*===\s*.function./,
    'send must use a wallet-side sign-and-send path when the wallet offers one',
  );
  assert.match(
    send, /simulateTransaction/,
    'send must simulate on our own connection so a rejection is explained in our words',
  );
  assert.match(
    send, /escrow\.ERRORS\[code\]/,
    'a simulation failure must be mapped to the program error name, not shown raw',
  );
});
