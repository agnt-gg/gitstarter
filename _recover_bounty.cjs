// The commission account layout changes with this upgrade, so escrow held in a
// pre-upgrade account would be unreachable by the new program. Recover the live
// bounty first: cancel it, then refund. Run BEFORE deploying.
const fs = require('node:fs');
const {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction,
} = require('C:/Users/Studio/AppData/Roaming/AGNT/projects/gitstarter/node_modules/@solana/web3.js');

(async () => {
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.DEPLOYER_KEYPAIR, 'utf8'))));
  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
  const programId = new PublicKey('6PFsiUA7sX5j96pzK7zxLbpFpsJXNLkfwQPYyd4UNFTy');
  const commission = new PublicKey('J2DtKVrZj6hxHejkHQhBcKWWz2HHJAhDcCDUwbcKkChQ');
  const vault = new PublicKey('319sBtryomPyakD9FCSrbFbZxx8V1BcodeEgw9n4M8fe');
  const [pledge] = PublicKey.findProgramAddressSync(
    [Buffer.from('pledge'), commission.toBuffer(), payer.publicKey.toBuffer()], programId);

  const meta = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });
  const send = (ix) => sendAndConfirmTransaction(connection, new Transaction().add(ix), [payer], { commitment: 'confirmed' });
  const pause = () => new Promise(r => setTimeout(r, 2500));

  const before = await connection.getBalance(payer.publicKey);
  const vaultBefore = await connection.getBalance(vault);
  console.log('wallet before  ', before / 1e9, 'SOL');
  console.log('vault before   ', vaultBefore / 1e9, 'SOL');

  try {
    const cancelSig = await send(new TransactionInstruction({
      programId,
      keys: [meta(payer.publicKey, true, false), meta(commission, false, true)],
      data: Buffer.from([6]),
    }));
    console.log('cancelled      ', cancelSig);
  } catch (e) { console.log('cancel skipped :', (e.message || '').slice(0, 90)); }
  await pause();

  try {
    const refundSig = await send(new TransactionInstruction({
      programId,
      keys: [
        meta(payer.publicKey, true, true),
        meta(commission, false, true),
        meta(pledge, false, true),
        meta(vault, false, true),
      ],
      data: Buffer.from([5]),
    }));
    console.log('refunded       ', refundSig);
  } catch (e) { console.log('refund failed  :', (e.message || '').slice(0, 90)); }
  await pause();

  const after = await connection.getBalance(payer.publicKey);
  const vaultAfter = await connection.getBalance(vault);
  console.log('wallet after   ', after / 1e9, 'SOL');
  console.log('vault after    ', vaultAfter / 1e9, 'SOL  (rent reserve only if 0.00089088)');
  console.log('recovered      ', (after - before) / 1e9, 'SOL');
  connection._rpcWebSocket?.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
