// Agent-side CLI for the devnet test run. Nathan drives the creator in the UI;
// this drives the contracted agent from the terminal, using a real second
// wallet, so the cross-wallet path is exercised exactly as a stranger would.
//
//   node _agent.cjs watch                 poll for anything addressed to me
//   node _agent.cjs accept <commission>   accept a nomination
//   node _agent.cjs submit <commission> [index] [evidence]
//   node _agent.cjs claim  <commission> [index]   release a matured delivery
//   node _agent.cjs show   <commission>
const fs = require('node:fs');
const {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
} = require('@solana/web3.js');
const escrow = require('./shared/escrow');

const RPC = 'https://api.devnet.solana.com';
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

async function all() {
  const accounts = await connection.getProgramAccounts(new PublicKey(ctx.programId), {
    commitment: 'confirmed',
    filters: [{ dataSize: escrow.COMMISSION_ACCOUNT_BYTES }, { memcmp: { offset: 0, bytes: '3' } }],
  });
  return accounts.map(a => ({ address: a.pubkey.toBase58(), ...escrow.decodeCommission(a.account.data) }));
}

function describe(c, now = Math.floor(Date.now() / 1000)) {
  const parts = [
    c.address.slice(0, 8), c.status.padEnd(9),
    `${(c.pledged / 1e9).toFixed(4)} SOL`,
    `by ${c.creator.slice(0, 6)}`,
  ];
  if (c.pendingAgent === ME) parts.push('>>> NOMINATED TO ME');
  if (c.agent === ME) parts.push('>>> I AM THE AGENT');
  if (c.submission) {
    parts.push(escrow.reviewExpired(c, now)
      ? `submission MATURED (claimable by anyone)`
      : `submission under review, ${mins(c.submission.reviewEndsAt - now)} left`);
  }
  if (c.status === 'building' && c.agent === ME && !c.submission) {
    parts.push(`deliver within ${mins(c.deliveryDeadline - now)}`);
  }
  return parts.join('  ');
}

const [command, address, ...rest] = process.argv.slice(2);

(async () => {
  console.log(`agent wallet: ${ME}   balance ${(await connection.getBalance(agent.publicKey)) / 1e9} SOL\n`);

  if (command === 'watch') {
    let lastSeen = '';
    for (let i = 0; i < 240; i++) {
      const now = Math.floor(Date.now() / 1000);
      const mine = (await all()).filter(c => c.pendingAgent === ME || c.agent === ME
        || (c.status === 'funded' && !c.agent && !c.pendingAgent));
      const snapshot = mine.map(c => describe(c, now)).join('\n');
      if (snapshot !== lastSeen) {
        console.log(`[${new Date().toISOString().slice(11, 19)}]`);
        console.log(snapshot || '  (nothing addressed to me yet)');
        console.log();
        lastSeen = snapshot;
      }
      await new Promise(r => setTimeout(r, 8000));
    }
    return;
  }

  if (command === 'show') { console.log(JSON.stringify(await read(address), null, 2)); return; }

  if (command === 'accept') {
    const sig = await send(escrow.build.acceptAgent(ctx, { agent: ME, commission: address }).instruction);
    const c = await read(address);
    console.log(`ACCEPTED  ${sig}`);
    console.log(`status ${c.status}, deliver within ${mins(c.deliveryDeadline - Math.floor(Date.now() / 1000))}`);
    return;
  }

  if (command === 'submit') {
    const index = Number(rest[0] ?? 0);
    const evidence = rest.slice(1).join(' ') || 'https://github.com/agnt-gg/gitstarter/pull/1';
    const evidenceHash = require('node:crypto').createHash('sha256').update(evidence).digest();
    const sig = await send(escrow.build.submitDelivery(ctx, {
      agent: ME, commission: address, milestoneIndex: index, evidenceHash,
    }).instruction);
    // The chain only holds a hash of this. Record the text itself so the creator
    // has something they can actually read and judge; the server verifies it
    // against the commitment, so a wrong one cannot be planted.
    try {
      const response = await fetch('https://gitstarter.agnt.gg/api/deliveries', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ commission: address, milestoneIndex: index, evidence }),
      });
      console.log(response.ok ? 'evidence recorded and verified against the chain'
        : `evidence NOT recorded: ${(await response.json()).error}`);
    } catch (error) { console.log(`evidence NOT recorded: ${error.message}`); }
    const c = await read(address);
    console.log(`SUBMITTED milestone ${index + 1}  ${sig}`);
    console.log(`evidence: ${evidence}`);
    console.log(`review ends ${new Date(c.submission.reviewEndsAt * 1000).toLocaleString()} (${mins(c.submission.reviewEndsAt - Math.floor(Date.now() / 1000))})`);
    console.log('If the creator neither releases nor rejects, anyone can release it after that.');
    return;
  }

  if (command === 'claim') {
    const c = await read(address);
    const index = Number(rest[0] ?? c.submission?.milestoneIndex ?? 0);
    const before = await connection.getBalance(agent.publicKey);
    const sig = await send(escrow.build.releaseMilestone(ctx, {
      creator: ME, commission: address, agent: c.agent, milestoneIndex: index,
    }).instruction);
    console.log(`CLAIMED milestone ${index + 1}  ${sig}`);
    console.log(`received ${((await connection.getBalance(agent.publicKey)) - before) / 1e9} SOL`);
    return;
  }

  console.log('commands: watch | show <c> | accept <c> | submit <c> [index] [evidence] | claim <c> [index]');
})().then(() => process.exit(0)).catch(e => { console.error('FAILED:', escrow.explainError(e)?.message || e.message); process.exit(1); });
