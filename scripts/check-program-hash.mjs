// Compares the hash published in README.md against the program that is actually
// deployed right now.
//
// The program is upgradeable, so its hash changes with every upgrade. A number
// hardcoded in documentation therefore drifts silently, and a reader who runs
// the verification command gets a mismatch and reasonably concludes the program
// has been tampered with. This turns that into one command.
//
// It reimplements solana-verify's "program hash" — sha256 of the executable with
// trailing zero padding stripped — so it needs neither Docker nor the Rust
// toolchain. Anyone can audit this deployment with Node alone.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Connection, PublicKey } from '@solana/web3.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RPC = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const PROGRAM = process.env.PROGRAM_ID || '6PFsiUA7sX5j96pzK7zxLbpFpsJXNLkfwQPYyd4UNFTy';

/// ProgramData layout: 4-byte tag, 8-byte slot, 1-byte option, 32-byte authority.
const PROGRAM_DATA_HEADER = 45;

export async function liveProgramHash(rpcUrl = RPC, programId = PROGRAM) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const program = await connection.getAccountInfo(new PublicKey(programId), 'confirmed');
  if (!program) throw new Error(`No account at ${programId} on ${rpcUrl}`);
  if (!program.executable) throw new Error(`${programId} is not an executable program`);

  const programDataAddress = new PublicKey(program.data.subarray(4, 36));
  const programData = await connection.getAccountInfo(programDataAddress, 'confirmed');
  if (!programData) throw new Error(`ProgramData ${programDataAddress.toBase58()} is missing`);

  const slot = Number(programData.data.readBigUInt64LE(4));
  const authority = programData.data[12]
    ? new PublicKey(programData.data.subarray(13, 45)).toBase58()
    : null; // null means the upgrade authority was burned

  const payload = programData.data.subarray(PROGRAM_DATA_HEADER);
  let end = payload.length;
  while (end > 0 && payload[end - 1] === 0) end--;
  const executable = payload.subarray(0, end);

  return {
    programId,
    programData: programDataAddress.toBase58(),
    lastDeployedSlot: slot,
    upgradeAuthority: authority,
    executableBytes: executable.length,
    allocatedBytes: payload.length,
    hash: crypto.createHash('sha256').update(executable).digest('hex'),
    hasSecurityTxt: executable.includes(Buffer.from('BEGIN SECURITY.TXT V1')),
  };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`
  || process.argv[1].endsWith('check-program-hash.mjs')) {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const publishedHash = /\| Program hash \| `([0-9a-f]{64})` \|/.exec(readme)?.[1];
  const publishedSlot = /\| Deployed in slot \| `(\d+)` \|/.exec(readme)?.[1];

  const live = await liveProgramHash();
  console.log(JSON.stringify(live, null, 2));
  console.log();

  if (!publishedHash) {
    console.log('FAIL  README.md does not publish a program hash');
    process.exit(1);
  }
  if (live.hash !== publishedHash) {
    console.log(`FAIL  README publishes ${publishedHash}`);
    console.log(`      the chain says   ${live.hash}`);
    console.log('      The program was upgraded and the documentation was not.');
    console.log(`      Deployed in slot ${live.lastDeployedSlot}, README says ${publishedSlot ?? 'nothing'}.`);
    process.exit(1);
  }
  if (publishedSlot && Number(publishedSlot) !== live.lastDeployedSlot) {
    console.log(`FAIL  hash matches but README claims slot ${publishedSlot}, chain says ${live.lastDeployedSlot}`);
    process.exit(1);
  }
  if (!live.hasSecurityTxt) {
    console.log('FAIL  the deployed binary does not carry a security.txt section');
    process.exit(1);
  }
  console.log('PASS  the published hash, slot, and security.txt all match the deployed program.');
  process.exit(0);
}
