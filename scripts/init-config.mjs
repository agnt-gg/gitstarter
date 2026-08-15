import fs from 'node:fs';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';

const rpc = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const programId = new PublicKey(process.env.PROGRAM_ID || '6PFsiUA7sX5j96pzK7zxLbpFpsJXNLkfwQPYyd4UNFTy');
// No default, deliberately.
//
// This is the only irreversible transaction in the system: it fixes the admin to
// whoever signs it and the treasury to whatever is named here, permanently. The
// program has no SetTreasury, no SetAdmin and no SetFee, so a wrong value is
// corrected only by deploying a different program and abandoning this one.
//
// A convenient default meant forgetting one environment variable would silently
// hand every future fee to a disposable devnet key, and the mistake would not
// surface until the first payout.
if (!process.env.TREASURY_WALLET) {
  throw new Error('TREASURY_WALLET is required and has no default: it is permanent once this runs. '
    + 'Name the coldest address you own — the treasury never signs, so nothing is made slower by it '
    + 'being offline.');
}
const treasury = new PublicKey(process.env.TREASURY_WALLET);
const keypairPath = process.env.DEPLOYER_KEYPAIR;
if (!keypairPath) throw new Error('DEPLOYER_KEYPAIR is required');
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, 'utf8'))));
const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], programId);
const data = Buffer.concat([Buffer.from([0]), treasury.toBuffer()]); // Borsh enum variant 0 + Pubkey
const ix = new TransactionInstruction({
  programId,
  keys: [
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: config, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
  ],
  data
});
const connection = new Connection(rpc, 'confirmed');

// Said out loud before it happens, because afterwards there is nothing to say.
console.log('about to make the following permanent:');
console.log(`  program   ${programId.toBase58()}`);
console.log(`  admin     ${payer.publicKey.toBase58()}   (can only pause; can never be changed)`);
console.log(`  treasury  ${treasury.toBase58()}   (receives every fee; can never be changed)`);
if (payer.publicKey.equals(treasury)) {
  console.log('\n  ⚠ the admin and the treasury are the same key. The admin signs to pause;');
  console.log('    the treasury should be offline for years. Consider a separate cold address.');
}

const existing = await connection.getAccountInfo(config);
if (existing) {
  console.log(JSON.stringify({ config: config.toBase58(), alreadyInitialized: true }));
} else {
  const signature = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [payer], { commitment: 'confirmed' });
  console.log(JSON.stringify({ config: config.toBase58(), signature, alreadyInitialized: false }));
}
