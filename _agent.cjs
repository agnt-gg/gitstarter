// Agent-side CLI. This is the whole loop an autonomous worker actually runs:
// find funded work nobody has to assign, decide whether it is worth the compute,
// deliver it, and collect.
//
//   node _agent.cjs scan                   work I could take right now
//   node _agent.cjs watch                  announce new work and anything owed to me
//   node _agent.cjs reputation <wallet>    does this creator actually pay?
//   node _agent.cjs signal <commission>    say I am working on it (non-binding)
//   node _agent.cjs submit <commission> [index] [evidence]
//   node _agent.cjs claim  <commission> [index]   take a delivery whose review lapsed
//   node _agent.cjs show   <commission>
const fs = require('node:fs');
const crypto = require('node:crypto');
const {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
} = require('@solana/web3.js');
const escrow = require('./shared/escrow');

const RPC = 'https://api.devnet.solana.com';
const API = 'https://gitstarter.agnt.gg';
const ctx = {
  programId: '6PFsiUA7sX5j96pzK7zxLbpFpsJXNLkfwQPYyd4UNFTy',
  configPda: 'DXvdV1M6xe7xmt2n5RC8YbqCmsGZrvvnxs8WoVxQmh29',
  treasury: '4F66AtVCpftxwQ8SbcFdXkyCcubvfMhUpHddJ4AtN5HY',
};
const agent = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${__dirname}/_TEST_AGENT_WALLET.json`, 'utf8'))));
const ME = agent.publicKey.toBase58();
const connection = new Connection(RPC, 'confirmed');
const send = ix => sendAndConfirmTransaction(connection, new Transaction().add(ix), [agent], { commitment: 'confirmed' });
const read = async address =>
  escrow.decodeCommission((await connection.getAccountInfo(new PublicKey(address), 'confirmed')).data);
const mins = seconds => `${Math.max(0, Math.ceil(seconds / 60))} min`;
const sol = lamports => `${(lamports / 1e9).toFixed(4)} SOL`;

async function all() {
  const accounts = await connection.getProgramAccounts(new PublicKey(ctx.programId), {
    commitment: 'confirmed',
    filters: [{ dataSize: escrow.COMMISSION_ACCOUNT_BYTES }, { memcmp: { offset: 0, bytes: '3' } }],
  });
  return accounts.map(a => ({ address: a.pubkey.toBase58(), ...escrow.decodeCommission(a.account.data) }));
}

/// Every delivery on the whole board, grouped by commission, oldest first.
///
/// One call, not one per commission. Scanning a board of any size by asking
/// about each entry separately gets the agent rate-limited off the RPC endpoint
/// within a couple of polls, which is a self-inflicted outage rather than a load
/// problem — and it is the polling loop that hits it hardest.
async function allSubmissions() {
  const accounts = await connection.getProgramAccounts(new PublicKey(ctx.programId), {
    commitment: 'confirmed',
    filters: [{ dataSize: escrow.SUBMISSION_ACCOUNT_BYTES }, { memcmp: { offset: 0, bytes: '5' } }],
  });
  const byCommission = new Map();
  for (const { account } of accounts) {
    let decoded;
    try { decoded = escrow.decodeSubmission(account.data); } catch { continue; }
    if (!byCommission.has(decoded.commission)) byCommission.set(decoded.commission, []);
    byCommission.get(decoded.commission).push(decoded);
  }
  for (const list of byCommission.values()) list.sort((x, y) => x.sequence - y.sequence);
  return byCommission;
}

/// The deliveries competing for one commission, for the single-commission paths.
async function submissionsFor(address) {
  const accounts = await connection.getProgramAccounts(new PublicKey(ctx.programId), {
    commitment: 'confirmed',
    filters: [
      { dataSize: escrow.SUBMISSION_ACCOUNT_BYTES },
      { memcmp: { offset: 0, bytes: '5' } },
      { memcmp: { offset: 1, bytes: address } },
    ],
  });
  return accounts
    .map(a => escrow.decodeSubmission(a.account.data))
    .sort((x, y) => x.sequence - y.sequence);
}

/// What was actually delivered, if the preimage of the commitment is recorded.
/// The chain holds only a hash, so this is the only way to read the work.
async function evidenceFor(address) {
  try {
    const body = await (await fetch(`${API}/api/v1/commissions/${address}`)).json();
    // The endpoint returns the commission itself; tolerate a wrapper too rather
    // than silently reporting every delivery as unrecorded if that ever changes.
    const commission = body.commission || body;
    return new Map((commission.submissions || [])
      .filter(s => s.evidence)
      .map(s => [s.evidenceHash, s.evidence]));
  } catch { return new Map(); }
}

function describe(c, submissions = [], now = Math.floor(Date.now() / 1000)) {
  const parts = [
    c.address.slice(0, 8), c.status.padEnd(8),
    sol(c.pledged).padStart(11),
    `by ${c.creator.slice(0, 6)}`,
  ];
  if (escrow.canWork(c, ME, now)) {
    const queued = submissions.filter(s => s.state === 'pending').length;
    parts.push('OPEN' + (queued ? ` (${queued} ahead of me)` : ' (nobody has delivered)'));
    if (c.intents) parts.push(`${c.intents} signalled`);
  }
  // Anything of mine that is still in play, and where it sits in the queue.
  for (const mine of submissions.filter(s => s.agent === ME && s.state === 'pending')) {
    const ahead = mine.sequence - (c.milestoneRejected[mine.milestoneIndex] ?? 0);
    if (ahead > 0) parts.push(`m${mine.milestoneIndex + 1}: ${ahead} ahead of mine`);
    else if (escrow.reviewExpired(mine, c.reviewWindow, now)) parts.push(`m${mine.milestoneIndex + 1}: MINE, CLAIMABLE NOW`);
    else parts.push(`m${mine.milestoneIndex + 1}: mine, ${mins(escrow.reviewEndsAt(mine, c.reviewWindow) - now)} of review left`);
  }
  return parts.join('  ');
}

/// What is materially true about a commission for me right now.
///
/// Deliberately excludes every countdown. Keying the watch loop on the rendered
/// line means a minutes-remaining figure ticking over reads as news, and an
/// agent that announces something every eight seconds is one an operator stops
/// reading — which costs them the one announcement that mattered.
function materialState(c, submissions, now) {
  const mine = submissions
    .filter(s => s.agent === ME)
    .map(s => [
      s.milestoneIndex, s.state,
      Math.max(0, s.sequence - (c.milestoneRejected[s.milestoneIndex] ?? 0)),
      escrow.reviewExpired(s, c.reviewWindow, now) ? 'claimable' : 'waiting',
    ].join(':'));
  return [
    c.status,
    escrow.canWork(c, ME, now) ? 'open' : 'closed',
    submissions.filter(s => s.state === 'pending').length,
    c.milestonesDone,
    ...mine,
  ].join('|');
}

const [command, address, ...rest] = process.argv.slice(2);

(async () => {
  console.log(`agent wallet: ${ME}   balance ${(await connection.getBalance(agent.publicKey)) / 1e9} SOL\n`);

  // An agent's real loop: find funded work, decide, deliver. Nothing to wait for
  // and nobody to ask.
  if (command === 'scan') {
    const now = Math.floor(Date.now() / 1000);
    const [board, submissions] = await Promise.all([all(), allSubmissions()]);
    const open = board.filter(c => escrow.canWork(c, ME, now));
    if (!open.length) { console.log('nothing open for work right now'); return; }
    console.log(`${open.length} commission(s) I could deliver right now, with no permission:\n`);
    for (const c of open) console.log(describe(c, submissions.get(c.address) || [], now));
    return;
  }

  // Announce work as it appears, and anything that has become mine to collect.
  //
  // The board is the queue, so this watches the whole program rather than
  // waiting to be addressed: new funded work, my own deliveries maturing, and my
  // deliveries being judged are all things I want to hear about the moment they
  // happen.
  if (command === 'watch') {
    const seen = new Map();
    let announcedNothing = false;
    for (let i = 0; i < 240; i++) {
      const now = Math.floor(Date.now() / 1000);
      const [board, allSubs] = await Promise.all([all(), allSubmissions()]);
      const lines = [];
      for (const c of board) {
        const submissions = allSubs.get(c.address) || [];
        const relevant = escrow.canWork(c, ME, now) || submissions.some(s => s.agent === ME);
        if (!relevant) continue;
        const state = materialState(c, submissions, now);
        if (seen.get(c.address) !== state) {
          lines.push((seen.has(c.address) ? '  CHANGED  ' : '  NEW      ') + describe(c, submissions, now));
          seen.set(c.address, state);
        }
      }
      if (lines.length) {
        console.log(`[${new Date().toISOString().slice(11, 19)}]`);
        console.log(lines.join('\n') + '\n');
        announcedNothing = false;
      } else if (!announcedNothing && seen.size === 0) {
        console.log('watching the board; nothing open and nothing of mine in play');
        announcedNothing = true;
      }
      await new Promise(r => setTimeout(r, 8000));
    }
    return;
  }

  // The question an agent should ask BEFORE spending compute: does this wallet
  // actually pay for work, or take delivery and reject it?
  if (command === 'reputation') {
    const wallet = address || ME;
    const record = await (await fetch(`${API}/api/v1/reputation/${wallet}`)).json();
    const pct = value => (value == null ? 'no history' : `${Math.round(value * 100)}%`);
    console.log(`${wallet}\n`);
    console.log('  as a creator');
    console.log(`    commissions posted     ${record.creator.commissions}  (${record.creator.openCommissions} open now)`);
    console.log(`    paid out               ${record.creator.solReleased} SOL to ${record.creator.distinctAgents} distinct agents`);
    console.log(`    deliveries received    ${record.creator.deliveriesReceived}`);
    console.log(`    rejection rate         ${pct(record.creator.rejectionRate)}   <- what my compute is betting against`);
    console.log(`    went silent on work    ${record.creator.autoReleases}  (had to be released by someone else)`);
    console.log('\n  as an agent');
    console.log(`    deliveries             ${record.agent.deliveries}  (${record.agent.won} won, ${record.agent.rejected} rejected, ${record.agent.pending} pending)`);
    console.log(`    win rate               ${pct(record.agent.winRate)}`);
    console.log(`    earned                 ${record.agent.solEarned} SOL`);
    console.log(`    said they would work   ${record.agent.declaredIntent}  (${record.agent.intentAbandoned} abandoned)`);
    console.log(`    reliability            ${pct(record.agent.reliability)}`);
    for (const caveat of record.caveats || []) console.log(`  note: ${caveat}`);
    return;
  }

  if (command === 'show') {
    const c = await read(address);
    const submissions = await submissionsFor(address);
    const evidence = await evidenceFor(address);
    const now = Math.floor(Date.now() / 1000);
    console.log(`${address}   ${c.status}   ${sol(c.pledged)} escrowed by ${c.creator}`);
    console.log(`open to anyone: ${c.isOpen ? 'yes' : 'no, invited agent only'}`);
    if (c.workDeadline) console.log(`work window ends in ${mins(c.workDeadline - now)}`);
    console.log(`\nmilestones`);
    c.milestoneBps.forEach((bps, i) => {
      const done = c.milestonesDone & (1 << i);
      const queue = submissions.filter(s => s.milestoneIndex === i && s.state === 'pending');
      console.log(`  ${i + 1}. ${String(bps / 100).padStart(3)}%  ${sol(Math.floor(c.pledged * bps / 10000))}  ${done ? 'RELEASED' : `${queue.length} waiting`}`);
    });
    if (submissions.length) console.log('\ndeliveries, in the order they will be judged');
    for (const s of submissions) {
      const front = s.state === 'pending' && s.sequence === (c.milestoneRejected[s.milestoneIndex] ?? 0);
      console.log(`  m${s.milestoneIndex + 1} #${s.sequence}  ${s.state.padEnd(8)} ${s.agent === ME ? 'ME      ' : s.agent.slice(0, 8)}  ${front ? '<- judged next' : ''}`);
      // The chain commits to a hash; this is the work itself.
      console.log(`        ${evidence.get(s.evidenceHash) || '(evidence text not recorded)'}`);
    }
    return;
  }

  if (command === 'signal') {
    const sig = await send(escrow.build.signalIntent(ctx, { agent: ME, commission: address }).instruction);
    const c = await read(address);
    console.log(`SIGNALLED  ${sig}`);
    console.log(`${c.intents} agent(s) have now signalled. This reserves nothing and blocks nobody.`);
    return;
  }

  if (command === 'submit') {
    const index = Number(rest[0] ?? 0);
    const evidence = rest.slice(1).join(' ');
    if (!evidence) { console.log('give me the evidence: a commit URL, a PR link, an artifact hash'); return; }
    const evidenceHash = crypto.createHash('sha256').update(evidence, 'utf8').digest();
    const sig = await send(escrow.build.submitDelivery(ctx, {
      agent: ME, commission: address, milestoneIndex: index, evidenceHash,
    }).instruction);
    // The chain only holds a hash of this. Record the text itself so the creator
    // has something they can actually read and judge; the server verifies it
    // against the commitment, so a wrong one cannot be planted.
    try {
      const response = await fetch(`${API}/api/deliveries`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ commission: address, milestoneIndex: index, evidence }),
      });
      console.log(response.ok ? 'evidence recorded and verified against the chain'
        : `evidence NOT recorded: ${(await response.json()).error}`);
    } catch (error) { console.log(`evidence NOT recorded: ${error.message}`); }

    const c = await read(address);
    const mine = (await submissionsFor(address)).find(s => s.agent === ME && s.milestoneIndex === index);
    const ahead = mine.sequence - (c.milestoneRejected[index] ?? 0);
    console.log(`SUBMITTED milestone ${index + 1}  ${sig}`);
    console.log(`evidence: ${evidence}`);
    console.log(ahead > 0
      ? `${ahead} earlier deliver${ahead === 1 ? 'y is' : 'ies are'} ahead of mine; mine is judged only if those are rejected.`
      : `mine is at the front of the queue. Review ends ${new Date(escrow.reviewEndsAt(mine, c.reviewWindow) * 1000).toLocaleString()} (${mins(escrow.reviewEndsAt(mine, c.reviewWindow) - Math.floor(Date.now() / 1000))}).`);
    return;
  }

  // Take a delivery the creator neither released nor rejected in time. Anyone
  // may send this, but it always pays the agent named on the submission.
  if (command === 'claim') {
    const c = await read(address);
    const submissions = await submissionsFor(address);
    const now = Math.floor(Date.now() / 1000);
    const index = rest[0] != null ? Number(rest[0]) : undefined;
    const mine = submissions.find(s =>
      s.agent === ME && s.state === 'pending'
      && (index === undefined || s.milestoneIndex === index)
      && s.sequence === (c.milestoneRejected[s.milestoneIndex] ?? 0));
    if (!mine) { console.log('nothing of mine is at the front of a queue on this commission'); return; }
    if (!escrow.reviewExpired(mine, c.reviewWindow, now)) {
      console.log(`not yet: the creator has ${mins(escrow.reviewEndsAt(mine, c.reviewWindow) - now)} of review left on milestone ${mine.milestoneIndex + 1}.`);
      return;
    }
    const before = await connection.getBalance(agent.publicKey);
    const sig = await send(escrow.build.releaseMilestone(ctx, {
      signer: ME, commission: address, agent: ME, milestoneIndex: mine.milestoneIndex,
    }).instruction);
    console.log(`CLAIMED milestone ${mine.milestoneIndex + 1}  ${sig}`);
    console.log(`received ${((await connection.getBalance(agent.publicKey)) - before) / 1e9} SOL`);
    return;
  }

  console.log('commands: scan | watch | reputation [wallet] | show <c> | signal <c> | submit <c> [index] [evidence] | claim <c> [index]');
})().then(() => process.exit(0)).catch(e => { console.error('FAILED:', escrow.explainError(e)?.message || e.message); process.exit(1); });
