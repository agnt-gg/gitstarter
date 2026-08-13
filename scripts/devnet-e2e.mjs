import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccount, getAssociatedTokenAddress, getAccount, mintTo } from '@solana/spl-token';

const RPC='https://api.devnet.solana.com';
const PROGRAM=new PublicKey('6PFsiUA7sX5j96pzK7zxLbpFpsJXNLkfwQPYyd4UNFTy');
const MINT=new PublicKey('HvdV1cjbBeQzKi4GUKVxXJcZY7TM6KUBG8unNDrDy3hz');
const TREASURY=new PublicKey('4F66AtVCpftxwQ8SbcFdXkyCcubvfMhUpHddJ4AtN5HY');
const CONFIG=new PublicKey('DXvdV1M6xe7xmt2n5RC8YbqCmsGZrvvnxs8WoVxQmh29');
const deployer=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.DEPLOYER_KEYPAIR,'utf8'))));
const connection=new Connection(RPC,{commitment:'confirmed',disableRetryOnRateLimit:false});
const pause=(ms=1500)=>new Promise(resolve=>setTimeout(resolve,ms));
const u64=n=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b};
const i64=n=>{const b=Buffer.alloc(8);b.writeBigInt64LE(BigInt(n));return b};
const send=(ixs,signers)=>sendAndConfirmTransaction(connection,new Transaction().add(...ixs),signers,{commitment:'confirmed'});
async function fund(kp){await send([SystemProgram.transfer({fromPubkey:deployer.publicKey,toPubkey:kp.publicKey,lamports:0.03*LAMPORTS_PER_SOL})],[deployer]);}
async function ata(owner,payer=deployer){const address=await getAssociatedTokenAddress(MINT,owner);if(!await connection.getAccountInfo(address))await createAssociatedTokenAccount(connection,payer,MINT,owner);return address;}
function derive(creator,seed){const [commission]=PublicKey.findProgramAddressSync([Buffer.from('commission'),creator.toBuffer(),u64(seed)],PROGRAM);const [vault]=PublicKey.findProgramAddressSync([Buffer.from('vault'),commission.toBuffer()],PROGRAM);return {commission,vault};}
function createIx(creator,seed,goal,bps,deadline){const {commission,vault}=derive(creator,seed);const len=Buffer.alloc(4);len.writeUInt32LE(bps.length);return {commission,vault,ix:new TransactionInstruction({programId:PROGRAM,keys:[{pubkey:creator,isSigner:true,isWritable:true},{pubkey:CONFIG,isSigner:false,isWritable:false},{pubkey:commission,isSigner:false,isWritable:true},{pubkey:vault,isSigner:false,isWritable:true},{pubkey:MINT,isSigner:false,isWritable:false},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false},{pubkey:TOKEN_PROGRAM_ID,isSigner:false,isWritable:false}],data:Buffer.concat([Buffer.from([1]),u64(seed),u64(goal),len,...bps.map(x=>{const b=Buffer.alloc(2);b.writeUInt16LE(x);return b}),i64(deadline)])})};}
function pledgeIx(backer,commission,vault,source,treasuryToken,amount){const [pledge]=PublicKey.findProgramAddressSync([Buffer.from('pledge'),commission.toBuffer(),backer.toBuffer()],PROGRAM);return {pledge,ix:new TransactionInstruction({programId:PROGRAM,keys:[{pubkey:backer,isSigner:true,isWritable:true},{pubkey:CONFIG,isSigner:false,isWritable:false},{pubkey:commission,isSigner:false,isWritable:true},{pubkey:pledge,isSigner:false,isWritable:true},{pubkey:vault,isSigner:false,isWritable:true},{pubkey:source,isSigner:false,isWritable:true},{pubkey:treasuryToken,isSigner:false,isWritable:true},{pubkey:MINT,isSigner:false,isWritable:false},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false},{pubkey:TOKEN_PROGRAM_ID,isSigner:false,isWritable:false}],data:Buffer.concat([Buffer.from([2]),u64(amount)])})};}
const creator=Keypair.generate(), buyer=Keypair.generate(), agent=Keypair.generate();
await fund(creator); await pause(); await fund(buyer); await pause(); await fund(agent); await pause();
const buyerToken=await ata(buyer.publicKey); await pause(); const agentToken=await ata(agent.publicKey); await pause(); const treasuryToken=await ata(TREASURY); await pause();
await mintTo(connection,deployer,MINT,buyerToken,deployer,2_000_000n); await pause();
const seed=Date.now(), full=createIx(creator.publicKey,seed,990_000,[5000,5000],Math.floor(Date.now()/1000)+86400);
const createSig=await send([full.ix],[creator]);
const p=pledgeIx(buyer.publicKey,full.commission,full.vault,buyerToken,treasuryToken,1_000_000);
const pledgeSig=await send([p.ix],[buyer]);
assert.equal(Number((await getAccount(connection,full.vault)).amount),990_000);
assert.equal(Number((await getAccount(connection,treasuryToken)).amount)>=10_000,true);
const nominateSig=await send([new TransactionInstruction({programId:PROGRAM,keys:[{pubkey:creator.publicKey,isSigner:true,isWritable:false},{pubkey:full.commission,isSigner:false,isWritable:true},{pubkey:agent.publicKey,isSigner:false,isWritable:false}],data:Buffer.from([3])})],[creator]);
let unauthorizedRejected=false;try{await send([new TransactionInstruction({programId:PROGRAM,keys:[{pubkey:buyer.publicKey,isSigner:true,isWritable:false},{pubkey:full.commission,isSigner:false,isWritable:true}],data:Buffer.from([8])})],[buyer]);}catch{unauthorizedRejected=true}assert.equal(unauthorizedRejected,true);
const acceptSig=await send([new TransactionInstruction({programId:PROGRAM,keys:[{pubkey:agent.publicKey,isSigner:true,isWritable:false},{pubkey:full.commission,isSigner:false,isWritable:true}],data:Buffer.from([8])})],[agent]);
const release=(index)=>new TransactionInstruction({programId:PROGRAM,keys:[{pubkey:creator.publicKey,isSigner:true,isWritable:false},{pubkey:full.commission,isSigner:false,isWritable:true},{pubkey:full.vault,isSigner:false,isWritable:true},{pubkey:agentToken,isSigner:false,isWritable:true},{pubkey:treasuryToken,isSigner:false,isWritable:true},{pubkey:MINT,isSigner:false,isWritable:false},{pubkey:TOKEN_PROGRAM_ID,isSigner:false,isWritable:false}],data:Buffer.from([4,index])});
const release1Sig=await send([release(0)],[creator]);const release2Sig=await send([release(1)],[creator]);assert.equal(Number((await getAccount(connection,full.vault)).amount),0);assert.equal(Number((await getAccount(connection,agentToken)).amount),980_100);
const seed2=seed+1, cancelled=createIx(creator.publicKey,seed2,5_000_000,[10000],Math.floor(Date.now()/1000)+86400);const create2Sig=await send([cancelled.ix],[creator]);const p2=pledgeIx(buyer.publicKey,cancelled.commission,cancelled.vault,buyerToken,treasuryToken,1_000_000);const pledge2Sig=await send([p2.ix],[buyer]);const cancelSig=await send([new TransactionInstruction({programId:PROGRAM,keys:[{pubkey:creator.publicKey,isSigner:true,isWritable:false},{pubkey:cancelled.commission,isSigner:false,isWritable:true}],data:Buffer.from([6])})],[creator]);const refundDest=buyerToken;const refundSig=await send([new TransactionInstruction({programId:PROGRAM,keys:[{pubkey:buyer.publicKey,isSigner:true,isWritable:false},{pubkey:cancelled.commission,isSigner:false,isWritable:true},{pubkey:p2.pledge,isSigner:false,isWritable:true},{pubkey:cancelled.vault,isSigner:false,isWritable:true},{pubkey:refundDest,isSigner:false,isWritable:true},{pubkey:treasuryToken,isSigner:false,isWritable:true},{pubkey:MINT,isSigner:false,isWritable:false},{pubkey:TOKEN_PROGRAM_ID,isSigner:false,isWritable:false}],data:Buffer.from([5])})],[buyer]);assert.equal(Number((await getAccount(connection,cancelled.vault)).amount),0);
console.log(JSON.stringify({ok:true,program:PROGRAM.toBase58(),mint:MINT.toBase58(),roles:{creator:creator.publicKey.toBase58(),buyer:buyer.publicKey.toBase58(),agent:agent.publicKey.toBase58()},fundedFlow:{commission:full.commission.toBase58(),createSig,pledgeSig,nominateSig,acceptSig,release1Sig,release2Sig},refundFlow:{commission:cancelled.commission.toBase58(),create2Sig,pledge2Sig,cancelSig,refundSig},assertions:['1% pledge fee','1% release fee','unauthorized agent rejected','final vault zero','cancel/refund vault zero']},null,2));
connection._rpcWebSocket?.close();
process.exit(0);
