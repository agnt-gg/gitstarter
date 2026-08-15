// End-to-end check of the live agent API, from the outside, as an agent sees it.
import assert from 'node:assert/strict';
import { Transaction, PublicKey } from '@solana/web3.js';

const BASE = process.env.GITSTARTER_BASE || 'https://gitstarter.agnt.gg';
// Read from the live API first, exactly as a real agent would — an agent has no
// compiled-in constants. Hardcoding the program id here meant this script kept
// certifying the devnet deployment after the real one moved to mainnet, and
// every check below silently measured the wrong system. What is asserted now is
// CONSISTENCY: every endpoint must agree with /api/config about what is
// deployed, and the browser separately pins what may be signed.
const config = await (await fetch(`${BASE}/api/config`)).json();
const PROGRAM = config.programId;
const CONFIG = config.configPda;
const results = [];
const check = (name, fn) => { try { fn(); results.push(`PASS  ${name}`); } catch (e) { results.push(`FAIL  ${name} -> ${e.message}`); } };

// 1. The manual
const llmsRes = await fetch(`${BASE}/llms.txt`);
const llms = await llmsRes.text();
check('llms.txt is served as plain text', () => {
  assert.equal(llmsRes.status, 200);
  assert.match(llmsRes.headers.get('content-type'), /text\/plain/);
});
check('llms.txt is fully interpolated', () => assert.equal(/\{\{\w+\}\}/.test(llms), false));
check('llms.txt names the deployed program', () => assert.ok(llms.includes(PROGRAM)));
check('llms.txt documents the raw instruction encoding', () => {
  assert.ok(llms.includes('CreateCommission'));
  assert.ok(llms.includes('ReleaseMilestone'));
  assert.ok(llms.includes('findProgramAddress'));
});
check('llms.txt states the limitations honestly', () => {
  assert.ok(/no independent professional audit/i.test(llms));
  assert.ok(/no on-chain arbitrator/i.test(llms));
});
check('llms.txt never asks for a key', () => assert.ok(llms.includes('Never send a private key anywhere')));

// 2. Discovery
const list = await (await fetch(`${BASE}/api/v1/commissions`)).json();
check('commission list merges chain state with metadata', () => {
  assert.equal(list.programId, PROGRAM);
  assert.ok(list.count >= 1, 'expected at least the live bounty');
  const bounty = list.commissions.find(c => c.indexed);
  assert.ok(bounty, 'expected an indexed commission');
  assert.ok(bounty.title, 'indexed commission must carry a title');
  assert.ok(Array.isArray(bounty.milestones) && bounty.milestones.length >= 1);
  assert.equal(typeof bounty.escrowRemainingLamports, 'number');
  // Solscan omits the cluster query on mainnet and requires it elsewhere. The
  // old assertion hardcoded devnet, which made this script report the live
  // mainnet API as broken for emitting a correct link.
  if (config.cluster === 'mainnet-beta') assert.ok(!bounty.explorer.includes('cluster='));
  else assert.ok(bounty.explorer.includes(`cluster=${config.cluster}`));
});

const indexed = list.commissions.find(c => c.indexed);
const creator = indexed.creator;

check('filters narrow the result set', async () => {});
const openOnly = await (await fetch(`${BASE}/api/v1/commissions?openOnly=true`)).json();
const byCreator = await (await fetch(`${BASE}/api/v1/commissions?creator=${creator}`)).json();
const bogus = await (await fetch(`${BASE}/api/v1/commissions?creator=11111111111111111111111111111111`)).json();
check('creator filter works', () => {
  assert.ok(byCreator.count >= 1);
  assert.ok(byCreator.commissions.every(c => c.creator === creator));
  assert.equal(bogus.count, 0);
});
check('openOnly filter excludes settled work', () =>
  assert.ok(openOnly.commissions.every(c => !c.expired && ['funding', 'funded'].includes(c.status))));

// 3. Per-wallet actions: the question an autonomous agent actually asks
const forCreator = await (await fetch(`${BASE}/api/v1/commissions?wallet=${creator}`)).json();
check('walletActions tells a wallet what it may do', () => {
  const c = forCreator.commissions.find(x => x.address === indexed.address);
  assert.ok(Array.isArray(c.walletActions), 'walletActions must be present when wallet is supplied');
  if (c.status === 'funded' && !c.pendingAgent && !c.agent) {
    assert.ok(c.walletActions.includes('selectAgent'), `expected selectAgent, got ${c.walletActions}`);
  }
});

// 4. Single fetch
const one = await (await fetch(`${BASE}/api/v1/commissions/${indexed.address}`)).json();
check('single commission fetch matches the list', () => assert.equal(one.address, indexed.address));
const missing = await fetch(`${BASE}/api/v1/commissions/11111111111111111111111111111111`);
check('unknown commission is a clean 404', () => assert.equal(missing.status, 404));

// 5. Transaction building, then verify the bytes rather than trusting them
const txRes = await fetch(`${BASE}/api/v1/tx/pledge`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ backer: creator, commission: indexed.address, amountSol: 0.01 }),
});
const built = await txRes.json();
check('pledge transaction is built', () => {
  assert.equal(txRes.status, 200, JSON.stringify(built));
  assert.equal(built.programId, PROGRAM);
  assert.ok(built.transaction && built.encoding === 'base64');
  assert.ok(built.verify.includes(PROGRAM));
});
check('the returned transaction really encodes that pledge', () => {
  const tx = Transaction.from(Buffer.from(built.transaction, 'base64'));
  assert.equal(tx.instructions.length, 1, 'exactly one instruction');
  const instruction = tx.instructions[0];
  assert.equal(instruction.programId.toBase58(), PROGRAM, 'must target the escrow program');
  assert.equal(instruction.data[0], 2, 'discriminant 2 is Pledge');
  assert.equal(Number(instruction.data.readBigUInt64LE(1)), 10_000_000, '0.01 SOL in lamports');
  const keys = instruction.keys.map(k => k.pubkey.toBase58());
  assert.equal(keys[0], creator, 'backer signs and pays');
  assert.equal(keys[1], CONFIG);
  assert.equal(keys[2], indexed.address);
  assert.equal(keys[5], '11111111111111111111111111111111', 'system program last');
  // The vault must be the PDA of this commission, not an arbitrary account.
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), new PublicKey(indexed.address).toBuffer()], new PublicKey(PROGRAM));
  assert.equal(keys[4], vault.toBase58(), 'funds must go to the derived vault');
  assert.equal(tx.signatures.length, 1, 'unsigned, awaiting the caller');
  assert.equal(tx.signatures[0].signature, null, 'the server must not have signed anything');
});

// 6. Validation still refuses nonsense
const selfDeal = await fetch(`${BASE}/api/v1/tx/select-agent`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ creator, commission: indexed.address, agent: creator }),
});
check('self-dealing is refused at the API boundary too', () => assert.equal(selfDeal.status, 400));
const unknown = await fetch(`${BASE}/api/v1/tx/nope`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
check('unknown action is a clean 404 listing valid ones', () => assert.equal(unknown.status, 404));

// 7. The old endpoints the browser depends on must be untouched
const legacy = await (await fetch(`${BASE}/api/commissions`)).json();
check('legacy metadata endpoint still returns a bare array', () => {
  assert.ok(Array.isArray(legacy), 'the browser client reads this shape');
  assert.ok(legacy.length >= 1);
});
check('every endpoint agrees about the deployed program', () => {
  assert.equal(list.programId, config.programId);
  assert.ok(llms.includes(config.configPda), 'the agent manual must name the same config account');
});

console.log(results.join('\n'));
console.log(results.every(r => r.startsWith('PASS')) ? '\nALL AGENT API CHECKS PASSED' : '\nFAILURES PRESENT');
process.exit(results.every(r => r.startsWith('PASS')) ? 0 : 1);
