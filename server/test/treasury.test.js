'use strict';
// The treasury is the only privileged wallet in this protocol that never signs.
//
// That single fact is what lets it be a hardware wallet, a multisig, or a piece
// of paper in a safe: fees are credited to it by the program, and taking them
// out is an ordinary transfer that has nothing to do with the board. If a
// builder ever started asking the treasury to sign — an easy, plausible-looking
// "fix" if a release ever failed — cold storage would quietly stop being
// possible and nobody would notice until a payout was due.
//
// The second fact worth pinning is that admin and treasury are chosen once, at
// InitConfig, and can never be changed. There is no SetTreasury, no SetAdmin and
// no SetFee, so that one transaction is permanent and getting it wrong means
// redeploying the program.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PublicKey } = require('@solana/web3.js');
const escrow = require('../../shared/escrow');

const ROOT = path.join(__dirname, '..', '..');
const PROGRAM = fs.readFileSync(path.join(ROOT, 'program', 'src', 'lib.rs'), 'utf8');

const ctx = {
  programId: '6PFsiUA7sX5j96pzK7zxLbpFpsJXNLkfwQPYyd4UNFTy',
  configPda: 'DXvdV1M6xe7xmt2n5RC8YbqCmsGZrvvnxs8WoVxQmh29',
  treasury: '4F66AtVCpftxwQ8SbcFdXkyCcubvfMhUpHddJ4AtN5HY',
};
const CREATOR = '2B8YDoo4Q3JJZuuGqqqVP86xoahgMsqREr3ScxhGS8C5';
const AGENT = 'BU3KCzcSRDSYkBgMPFJ7Dja1KcDNtFwBv4Q7eoPmyJsm';
const COMMISSION = '2ysH9FtQjpqWDeZERyYvEw8sEvbbXFjviTJCeMnikzJB';

test('the treasury never has to sign to be paid', () => {
  // Both instructions that move a fee. If either marks the treasury as a signer,
  // then collecting fees requires the fee wallet to be online for somebody
  // else's transaction, which is not a thing a cold wallet can do.
  const paying = {
    releaseMilestone: escrow.build.releaseMilestone(ctx, {
      signer: CREATOR, commission: COMMISSION, agent: AGENT, milestoneIndex: 0,
    }),
    refund: escrow.build.refund(ctx, { backer: CREATOR, commission: COMMISSION }),
  };
  for (const [name, built] of Object.entries(paying)) {
    const treasuryKey = built.instruction.keys.find(k => k.pubkey.toBase58() === ctx.treasury);
    assert.ok(treasuryKey, `${name} must actually reference the treasury`);
    assert.equal(treasuryKey.isSigner, false,
      `${name} asks the treasury to sign; it can then never be kept offline`);
    assert.equal(treasuryKey.isWritable, true, 'and it must be writable to receive');
  }
});

test('the program agrees: the treasury is checked, not authenticated', () => {
  // The program validates the treasury by comparing it to the one snapshotted
  // on the commission, rather than by requiring a signature. That is what makes
  // the account substitution safe without the key being present.
  // Both fee paths, counted rather than matched. Release and refund each pay a
  // fee, so each has to pin the account it pays — asserting the pattern merely
  // exists is satisfied by one of them, and the other could be reduced to
  // `if false` without any test noticing.
  const pinned = (PROGRAM.match(/if \*treasury\.key != c\.treasury \{/g) || []).length;
  assert.equal(pinned, 2,
    `${pinned} of the 2 fee paths pin the treasury to the commission that snapshotted it; `
    + 'an unpinned path lets a caller substitute any account and collect the fee themselves');
  assert.equal(
    /let treasury = next_account_info\(ai\)\?;\s*\r?\n\s*assert_signer\(treasury\)/.test(PROGRAM), false,
    'no fee path may require the treasury to sign',
  );
});

test('a fee cannot be redirected onto money already escrowed', () => {
  // The treasury is copied into each commission when it is created, so even an
  // admin who could change the config could not reroute fees on SOL that
  // backers had already committed under the old one.
  assert.match(PROGRAM, /pub treasury: Pubkey,/);
  assert.match(PROGRAM, /Snapshot of the treasury at creation time/);
});

test('admin and treasury are permanent, so InitConfig is irreversible', () => {
  // Worth a test rather than a comment: the absence of these instructions is
  // load-bearing. Adding one later would silently turn a permanent commitment
  // into a revocable one, which is a different product.
  for (const instruction of ['SetTreasury', 'SetAdmin', 'SetFee']) {
    assert.equal(PROGRAM.includes(instruction), false,
      `${instruction} exists, so the config is no longer permanent`);
  }
  // The only thing an admin may do.
  assert.match(PROGRAM, /SetPaused \{ paused: bool \}/);
  assert.match(PROGRAM, /Deliberately CANNOT move\r?\n\s*\/\/\/ escrowed SOL, change the fee, or seize a vault/);
});

test('only the compiled-in initializer can ever create the config', () => {
  // Otherwise the first stranger to notice the deployment becomes the permanent
  // admin and picks where every fee goes.
  assert.match(PROGRAM, /if \*payer\.key != INITIALIZER \{/);
  assert.match(PROGRAM, /#\[cfg\(feature = "mainnet"\)\]\r?\npub const INITIALIZER/,
    'the mainnet initializer must be behind a feature flag so a devnet build cannot be shipped by accident');
});

test('the config decoder reads what the program wrote', () => {
  const b = Buffer.alloc(escrow.CONFIG_ACCOUNT_BYTES);
  b[0] = 1;
  new PublicKey(CREATOR).toBuffer().copy(b, 1);
  new PublicKey(ctx.treasury).toBuffer().copy(b, 33);
  b[65] = 1;
  b[66] = 254;
  assert.deepEqual(escrow.decodeConfig(b),
    { admin: CREATOR, treasury: ctx.treasury, paused: true, bump: 254 });

  // 1 + 32 + 32 + 1 + 1, pinned against the Rust struct so a layout change here
  // cannot silently start reading the treasury out of the wrong bytes.
  assert.match(PROGRAM, /pub const LEN: usize = 1 \+ 32 \+ 32 \+ 1 \+ 1;/);
  assert.equal(escrow.CONFIG_ACCOUNT_BYTES, 67);
  assert.throws(() => escrow.decodeConfig(Buffer.alloc(66)), /Not a config account/);
  // A commission account is 275 bytes and starts with tag 2; refusing it here
  // stops a mis-typed address being read as configuration.
  const wrongTag = Buffer.alloc(escrow.CONFIG_ACCOUNT_BYTES);
  wrongTag[0] = 2;
  assert.throws(() => escrow.decodeConfig(wrongTag), /Not a config account/);
});

test('fee arithmetic matches the program, including the rounding', () => {
  // The status script derives revenue from chain state, so its arithmetic has
  // to be the program's arithmetic: floor at every step, and nothing at all on
  // a refund from a commission nobody ever delivered to.
  assert.equal(escrow.FEE_BASIS_POINTS, 100);
  const fee = gross => Math.floor((gross * escrow.FEE_BASIS_POINTS) / 10_000);
  assert.equal(fee(20_000_000), 200_000);
  assert.equal(fee(99), 0, 'a sub-100-lamport slice rounds the fee to nothing, in the payer\'s favour');
  assert.match(PROGRAM, /Charges the 1% connection fee if any delivery was ever submitted, and\r?\n\s*\/\/\/ nothing at all if none was/);
});
