import fs from 'node:fs';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';

const rpc = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const programId = new PublicKey(process.env.PROGRAM_ID || '6PFsiUA7sX5j96pzK7zxLbpFpsJXNLkfwQPYyd4UNFTy');
const treasury = new PublicKey(process.env.TREASURY_WALLET || '4F66AtVCpftxwQ8SbcFdXkyCcubvfMhUpHddJ4AtN5HY');
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
const existing = await connection.getAccountInfo(config);
if (existing) {
  console.log(JSON.stringify({ config: config.toBase58(), alreadyInitialized: true }));
} else {
  const signature = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [payer], { commitment: 'confirmed' });
  console.log(JSON.stringify({ config: config.toBase58(), signature, alreadyInitialized: false }));
}
