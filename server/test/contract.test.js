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
