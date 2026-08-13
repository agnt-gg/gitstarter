import fs from 'node:fs';
import nacl from 'tweetnacl';
import bs58Module from 'bs58';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

const bs58 = bs58Module.default || bs58Module;
const RPC_URL = 'https://api.devnet.solana.com';
const SITE_URL = 'https://gitstarter.agnt.gg';
const PROGRAM_ID = new PublicKey('6PFsiUA7sX5j96pzK7zxLbpFpsJXNLkfwQPYyd4UNFTy');
const CONFIG_PDA = new PublicKey('DXvdV1M6xe7xmt2n5RC8YbqCmsGZrvvnxs8WoVxQmh29');
const keypairPath = process.env.DEPLOYER_KEYPAIR;
if (!keypairPath) throw new Error('DEPLOYER_KEYPAIR is required');

const creator = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, 'utf8'))));
const connection = new Connection(RPC_URL, 'confirmed');
const seed = Date.now();
const goalLamports = 50_000_000;
const deadline = Math.floor(Date.now() / 1000) + (14 * 24 * 60 * 60);

function u64(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
}
function i64(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64LE(BigInt(value));
  return buffer;
}

const [commission] = PublicKey.findProgramAddressSync(
  [Buffer.from('commission'), creator.publicKey.toBuffer(), u64(seed)],
  PROGRAM_ID,
);
const [vault] = PublicKey.findProgramAddressSync([Buffer.from('vault'), commission.toBuffer()], PROGRAM_ID);
const milestoneCount = Buffer.alloc(4);
milestoneCount.writeUInt32LE(1);
const milestone = Buffer.alloc(2);
milestone.writeUInt16LE(10_000);
const instruction = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: creator.publicKey, isSigner: true, isWritable: true },
    { pubkey: CONFIG_PDA, isSigner: false, isWritable: false },
    { pubkey: commission, isSigner: false, isWritable: true },
    { pubkey: vault, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data: Buffer.concat([Buffer.from([1]), u64(seed), u64(goalLamports), milestoneCount, milestone, i64(deadline)]),
});
const txSignature = await sendAndConfirmTransaction(
  connection,
  new Transaction().add(instruction),
  [creator],
  { commitment: 'confirmed' },
);

const challengeResponse = await fetch(`${SITE_URL}/api/auth/challenge`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ wallet: creator.publicKey.toBase58() }),
});
if (!challengeResponse.ok) throw new Error(`Challenge failed: ${await challengeResponse.text()}`);
const challenge = await challengeResponse.json();
const signature = bs58.encode(nacl.sign.detached(Buffer.from(challenge.message), creator.secretKey));
const verifyResponse = await fetch(`${SITE_URL}/api/auth/verify`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ wallet: creator.publicKey.toBase58(), message: challenge.message, signature }),
});
if (!verifyResponse.ok) throw new Error(`Authentication failed: ${await verifyResponse.text()}`);
const cookie = verifyResponse.headers.get('set-cookie')?.split(';')[0];
if (!cookie) throw new Error('Authentication returned no session cookie');

const metadata = {
  address: commission.toBase58(),
  txSignature,
  title: 'Add a one-command production smoke test',
  description: 'Add `npm run smoke:production` to this repository. The command must check the live health endpoint, public config, and homepage markers; print a concise PASS/FAIL summary; exit non-zero on any failed assertion; use only Node.js built-ins; and include deterministic tests for both success and failure paths. Deliverable: a pull request to agnt-gg/gitstarter with the script, package.json command, tests, and a short README usage note.',
  repositoryUrl: 'https://github.com/agnt-gg/gitstarter',
  license: 'MIT',
  labels: ['good-first-bounty', 'javascript', 'testing', 'devops'],
};
const metadataResponse = await fetch(`${SITE_URL}/api/commissions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify(metadata),
});
if (!metadataResponse.ok) throw new Error(`Metadata indexing failed: ${await metadataResponse.text()}`);

console.log(JSON.stringify({
  ok: true,
  address: commission.toBase58(),
  vault: vault.toBase58(),
  creator: creator.publicKey.toBase58(),
  goalSol: goalLamports / 1_000_000_000,
  deadline: new Date(deadline * 1000).toISOString(),
  txSignature,
  metadata: await metadataResponse.json(),
}, null, 2));
connection._rpcWebSocket?.close();
