const { Buffer } = require('buffer');
globalThis.Buffer = Buffer;
const web3 = require('@solana/web3.js');
const spl = require('@solana/spl-token');
const { PublicKey, Transaction, TransactionInstruction, SystemProgram } = web3;
const $ = id => document.getElementById(id);
const TOKEN_PROGRAM = spl.TOKEN_PROGRAM_ID;
const state = { config:null, connection:null, wallet:null, provider:null, session:null, metadata:[], projects:[], filter:'all', theme:localStorage.getItem('gitstarter.theme')||'light' };
const WALLETS = [
  {id:'phantom',name:'Phantom',mark:'P',color:'#6e56cf',url:'https://phantom.com/download',provider:()=>window.phantom?.solana},
  {id:'solflare',name:'Solflare',mark:'S',color:'#fc8c1c',url:'https://www.solflare.com/download',provider:()=>window.solflare},
  {id:'backpack',name:'Backpack',mark:'B',color:'#e33e3f',url:'https://backpack.app/download',provider:()=>window.backpack?.solana},
  {id:'coinbase',name:'Coinbase Wallet',mark:'C',color:'#0052ff',url:'https://www.coinbase.com/wallet/downloads',provider:()=>window.coinbaseSolana},
  {id:'brave',name:'Brave Wallet',mark:'🦁',color:'#fb542b',url:'https://brave.com/wallet/',provider:()=>window.braveSolana},
  {id:'trust',name:'Trust Wallet',mark:'T',color:'#3375bb',url:'https://trustwallet.com/download',provider:()=>window.trustwallet?.solana}
];
const STATUS = ['funding','funded','building','shipped','refunded'];
const STATUS_UI = {
  funding:{label:'Open for pledges',cls:'blue'}, funded:{label:'Funded — accepting agent',cls:'yellow'}, building:{label:'In progress',cls:'purple'}, shipped:{label:'Delivered',cls:'green'}, refunded:{label:'Closed — refundable',cls:'gray'}
};
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function fmtBase(n){return (Number(n)/1e6).toLocaleString(undefined,{maximumFractionDigits:6});}
function u64(buffer, offset){return Number(buffer.readBigUInt64LE(offset));}
function i64(buffer, offset){return Number(buffer.readBigInt64LE(offset));}
function writeU64(value){const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(value));return b;}
function writeI64(value){const b=Buffer.alloc(8);b.writeBigInt64LE(BigInt(value));return b;}
function decodeCommission(account){
  const b=Buffer.from(account.data); let o=1;
  const pk=()=>{const p=new PublicKey(b.subarray(o,o+32));o+=32;return p.toBase58();};
  const creator=pk(), mint=pk(), treasury=pk();
  const seed=u64(b,o);o+=8; const goal=u64(b,o);o+=8; const pledged=u64(b,o);o+=8; const released=u64(b,o);o+=8; const refunded=u64(b,o);o+=8;
  const pledgerCount=b.readUInt32LE(o);o+=4; const refundedPledgerCount=b.readUInt32LE(o);o+=4; const agent=pk(), pendingAgent=pk(); const hasPendingAgent=!!b[o++], hasAgent=!!b[o++]; const status=STATUS[b[o++]]||'unknown';
  const milestoneCount=b[o++]; const milestoneBps=[]; for(let i=0;i<8;i++){milestoneBps.push(b.readUInt16LE(o));o+=2;} const milestonesDone=b[o++]; const deadline=i64(b,o);
  return {creator,mint,treasury,seed,goal,pledged,released,refunded,pledgerCount,refundedPledgerCount,agent,pendingAgent,hasPendingAgent,hasAgent,status,milestoneCount,milestoneBps:milestoneBps.slice(0,milestoneCount),milestonesDone,deadline};
}
async function api(path, options={}){
  options.headers={'content-type':'application/json',...(state.session?{authorization:'Bearer '+state.session}:{}),...(options.headers||{})};
  const r=await fetch(path,options); const body=await r.json(); if(!r.ok)throw new Error(body.error||`HTTP ${r.status}`); return body;
}
function installedProvider(wallet){
  const provider=wallet.provider();
  return provider && typeof provider.connect==='function' ? provider : null;
}
function walletProvider(){return state.provider;}
function openWalletModal(){
  const rows=WALLETS.map(wallet=>{
    const installed=!!installedProvider(wallet);
    return `<button class="btn" data-wallet="${wallet.id}" style="width:100%;display:flex;align-items:center;gap:12px;padding:12px;margin-bottom:8px;text-align:left"><span style="display:grid;place-items:center;width:34px;height:34px;border-radius:9px;background:${wallet.color};color:#fff;font-weight:800;font-size:16px">${wallet.mark}</span><span style="display:flex;flex-direction:column;gap:2px"><b>${wallet.name}</b><span class="hint">${installed?'Detected — connect now':'Install wallet'}</span></span><span style="margin-left:auto;color:var(--fg-muted)">${installed?'Connect':'↗'}</span></button>`;
  }).join('');
  $('dlg').innerHTML=`<div class="dlg-head"><h1>Connect a Solana wallet<button class="closeX" id="bX" aria-label="Close">×</button></h1><div class="sub">Choose your wallet. GitStarter never receives your private keys.</div></div><div style="padding:20px;max-width:520px;margin:auto">${rows}<p class="hint" style="text-align:center;margin:16px 0 0">Transactions use Solana ${esc(state.config?.cluster||'devnet')}. Your wallet will ask you to approve every signature.</p></div>`;
  $('overlay').classList.add('on');
}
async function connectWallet(walletId){
  const wallet=WALLETS.find(item=>item.id===walletId);
  if(!wallet)throw new Error('Unsupported wallet');
  const provider=installedProvider(wallet);
  if(!provider){window.open(wallet.url,'_blank','noopener,noreferrer');return;}
  const result=await provider.connect();
  state.provider=provider;
  state.wallet=result?.publicKey||provider.publicKey;
  if(!state.wallet)throw new Error(`${wallet.name} did not return a wallet address`);
  await authenticate(provider);
  closeDialog();
  await refresh();
}
async function authenticate(provider){
  const wallet=state.wallet.toBase58(); const challenge=await api('/api/auth/challenge',{method:'POST',body:JSON.stringify({wallet})});
  if(typeof provider.signMessage!=='function')throw new Error('This wallet does not support secure message sign-in');
  const bytes=new TextEncoder().encode(challenge.message); const signed=await provider.signMessage(bytes,'utf8');
  const signature=bs58Encode(signed.signature||signed); const result=await api('/api/auth/verify',{method:'POST',body:JSON.stringify({wallet,message:challenge.message,signature})});
  state.session=result.token;
}
function bs58Encode(bytes){const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let digits=[0];for(const byte of bytes){let carry=byte;for(let j=0;j<digits.length;j++){carry+=digits[j]<<8;digits[j]=carry%58;carry=(carry/58)|0;}while(carry){digits.push(carry%58);carry=(carry/58)|0;}}let out='';for(let k=0;k<bytes.length&&bytes[k]===0;k++)out+='1';for(let q=digits.length-1;q>=0;q--)out+=alphabet[digits[q]];return out;}
async function send(transaction){
  const provider=walletProvider(); if(!provider)throw new Error('Connect your wallet first'); transaction.feePayer=state.wallet; transaction.recentBlockhash=(await state.connection.getLatestBlockhash('confirmed')).blockhash;
  const signed=await provider.signTransaction(transaction); const sig=await state.connection.sendRawTransaction(signed.serialize(),{skipPreflight:false,maxRetries:3}); await state.connection.confirmTransaction(sig,'confirmed'); return sig;
}
async function refresh(){
  state.metadata=await api('/api/commissions'); const meta=new Map(state.metadata.map(m=>[m.address,m]));
  const accounts=await state.connection.getProgramAccounts(new PublicKey(state.config.programId),{commitment:'confirmed',filters:[{dataSize:240},{memcmp:{offset:0,bytes:'3'}}]});
  state.projects=accounts.map(({pubkey,account})=>({address:pubkey.toBase58(),...decodeCommission(account),meta:meta.get(pubkey.toBase58())})).sort((a,b)=>(b.meta?.createdAt||0)-(a.meta?.createdAt||0)); render();
}
function currentWallet(){return state.wallet?.toBase58();}
function render(){
  document.documentElement.dataset.theme=state.theme; $('themeLabel').textContent=state.theme==='light'?'Dark':'Light';
  const wallet=currentWallet(); $('bWallet').textContent=wallet?wallet.slice(0,4)+'…'+wallet.slice(-4):'Connect wallet';
  const visible=state.projects.filter(p=>(state.filter==='all'||p.status===state.filter)&&(!($('q').value)||JSON.stringify(p.meta||{}).toLowerCase().includes($('q').value.toLowerCase())));
  $('unav').innerHTML=[['all','Commissions'],...STATUS.map(s=>[s,STATUS_UI[s].label])].map(([f,l])=>`<button data-f="${f}" class="${state.filter===f?'on':''}">${esc(l)} <span class="counter">${f==='all'?state.projects.length:state.projects.filter(p=>p.status===f).length}</span></button>`).join('');
  $('listBox').innerHTML='<div class="Box-header"><b>Verified on-chain commissions</b><span class="hint">Solana '+esc(state.config.cluster)+'</span></div>'+(visible.length?visible.map(row).join(''):'<div class="blank"><h3>No commissions yet</h3><p>Connect a wallet and create the first real commission.</p></div>');
  const total=state.projects.reduce((s,p)=>s+p.pledged,0), escrow=state.projects.reduce((s,p)=>s+Math.max(0,p.pledged-p.released-p.refunded),0);
  $('sPledged').textContent=fmtBase(total); $('sEsc').textContent=fmtBase(escrow); $('sBurn').textContent=fmtBase(state.projects.reduce((s,p)=>s+p.released,0)); $('sRefund').textContent=fmtBase(state.projects.reduce((s,p)=>s+p.refunded,0)); $('sBackers').textContent=state.projects.reduce((s,p)=>s+p.pledgerCount,0);
  $('wBal').textContent=wallet?'refreshing…':'connect wallet'; $('wEsc').textContent='on-chain'; $('wProj').textContent=wallet?state.projects.filter(p=>p.creator===wallet).length:'—';
  $('agentList').innerHTML='<p class="hint">Agents are wallet addresses and must co-sign acceptance. No synthetic agent registry is used.</p>';
  $('heat').innerHTML=''; $('banner').innerHTML=`<div class="flash"><div><b>1% protocol fee</b> on pledges, milestone releases, and refunds. Program <span class="mono">${state.config.programId.slice(0,8)}…</span></div></div>`;
  if(wallet)loadBalance();
}
async function loadBalance(){try{const ata=await spl.getAssociatedTokenAddress(new PublicKey(state.config.tokenMint),state.wallet);const bal=await state.connection.getTokenAccountBalance(ata);$('wBal').textContent=bal.value.uiAmountString+' GIT';}catch{$('wBal').textContent='0 GIT';}}
function row(p){const ui=STATUS_UI[p.status]||STATUS_UI.refunded, m=p.meta||{};const percent=p.goal?Math.min(100,p.pledged/p.goal*100):0;return `<div class="Box-row" data-id="${p.address}" style="cursor:pointer"><div class="row-main"><div class="row-title"><a>${esc(m.title||'Unindexed commission')}</a><span class="lbl ${ui.cls}">${esc(ui.label)}</span></div><div class="row-meta"><span class="mono">${p.address.slice(0,8)}…</span><span>created by ${p.creator.slice(0,6)}…</span><span>${esc(m.license||'metadata pending')}</span></div><div style="margin-top:8px;max-width:420px"><div class="prog"><div class="bar ${ui.cls}" style="width:${percent}%"></div></div></div></div><div class="row-right"><span class="amt">${fmtBase(p.pledged)} <span class="of">/ ${fmtBase(p.goal)} GIT</span></span><span class="hint">${p.pledgerCount} backers</span></div></div>`;}
function closeDialog(){$('overlay').classList.remove('on');}
function openProject(address){const p=state.projects.find(x=>x.address===address);if(!p)return;const m=p.meta||{};const wallet=currentWallet();let actions='';if(p.status==='funding'&&wallet)actions=`<div class="field"><label>Amount (GIT)</label><input id="pledgeAmount" type="number" min="0.000001" step="0.000001"></div><button class="btn primary" data-action="pledge" data-id="${p.address}">Pledge</button>`;if(p.status==='funded'&&wallet===p.creator&&!p.hasPendingAgent)actions=`<div class="field"><label>Agent wallet</label><input id="agentWallet"></div><button class="btn primary" data-action="nominate" data-id="${p.address}">Nominate agent</button>`;if(p.status==='funded'&&p.hasPendingAgent&&wallet===p.pendingAgent)actions=`<button class="btn primary" data-action="accept" data-id="${p.address}">Accept contract</button>`;if(p.status==='funded'&&p.hasPendingAgent&&wallet!==p.pendingAgent)actions=`<p class="hint">Waiting for nominated agent <span class="mono">${p.pendingAgent}</span> to accept.</p>`;if(p.status==='building'&&wallet===p.creator)actions=p.milestoneBps.map((_,i)=>`<button class="btn" data-action="release" data-index="${i}" data-id="${p.address}" ${p.milestonesDone&(1<<i)?'disabled':''}>Release milestone ${i+1}</button>`).join(' ');if((p.status==='funding'||p.status==='funded')&&wallet===p.creator)actions+=` <button class="btn danger" data-action="cancel" data-id="${p.address}">Cancel</button>`;if(p.status==='refunded'&&wallet)actions+=` <button class="btn" data-action="refund" data-id="${p.address}">Claim refund</button>`;
  $('dlg').innerHTML=`<div class="dlg-head"><h1>${esc(m.title||p.address)}<button class="closeX" id="bX">×</button></h1><div class="sub mono">${p.address}</div></div><div class="dlg-body"><div><p>${esc(m.description||'This on-chain commission has not been indexed yet.')}</p><h3>Settlement</h3><div class="stat"><b>${fmtBase(p.pledged)}</b> net pledged</div><div class="stat"><b>${fmtBase(p.released)}</b> released</div><div class="stat"><b>${fmtBase(p.refunded)}</b> refunded</div>${actions}</div><aside class="side"><section><h2>Contract</h2><div class="stat"><b>${p.milestoneCount}</b> milestones</div><div class="stat"><b>1%</b> every value movement</div><div class="stat"><b>${new Date(p.deadline*1000).toLocaleString()}</b> deadline</div></section></aside></div>`;$('overlay').classList.add('on');}
function openCreate(){if(!state.wallet)return openWalletModal();$('dlg').innerHTML=`<div class="dlg-head"><h1>New on-chain commission<button class="closeX" id="bX">×</button></h1></div><div class="dlg-body" style="grid-template-columns:1fr"><div><div class="field"><label>Title</label><input id="nTitle"></div><div class="field"><label>Description</label><textarea id="nDescription"></textarea></div><div class="grid2"><div class="field"><label>Goal (GIT)</label><input id="nGoal" type="number" min="0.000001" step="0.000001"></div><div class="field"><label>Deadline</label><input id="nDeadline" type="datetime-local"></div></div><div class="grid2"><div class="field"><label>Repository URL</label><input id="nRepo"></div><div class="field"><label>License</label><input id="nLicense" value="MIT"></div></div><div class="field"><label>Milestone percentages (sum 100)</label><input id="nMilestones" value="25,40,20,15"></div><button class="btn primary" id="doCreate">Create and sign</button></div></div>`;$('overlay').classList.add('on');}
async function createCommission(){
  const title=$('nTitle').value.trim(), description=$('nDescription').value.trim(), goal=Math.round(Number($('nGoal').value)*1e6), deadline=Math.floor(new Date($('nDeadline').value).getTime()/1000), percentages=$('nMilestones').value.split(',').map(Number);if(!title||!description||!goal||!deadline||percentages.some(x=>!x)||percentages.reduce((a,b)=>a+b,0)!==100)throw new Error('Complete all fields; milestones must sum to 100');
  const seed=Date.now();const program=new PublicKey(state.config.programId),config=new PublicKey(state.config.configPda),mint=new PublicKey(state.config.tokenMint);const [commission]=PublicKey.findProgramAddressSync([Buffer.from('commission'),state.wallet.toBuffer(),writeU64(seed)],program);const [vault]=PublicKey.findProgramAddressSync([Buffer.from('vault'),commission.toBuffer()],program);const count=Buffer.alloc(4);count.writeUInt32LE(percentages.length);const data=Buffer.concat([Buffer.from([1]),writeU64(seed),writeU64(goal),count,...percentages.map(x=>{const b=Buffer.alloc(2);b.writeUInt16LE(x*100);return b;}),writeI64(deadline)]);const ix=new TransactionInstruction({programId:program,keys:[{pubkey:state.wallet,isSigner:true,isWritable:true},{pubkey:config,isSigner:false,isWritable:false},{pubkey:commission,isSigner:false,isWritable:true},{pubkey:vault,isSigner:false,isWritable:true},{pubkey:mint,isSigner:false,isWritable:false},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false},{pubkey:TOKEN_PROGRAM,isSigner:false,isWritable:false}],data});const signature=await send(new Transaction().add(ix));await api('/api/commissions',{method:'POST',body:JSON.stringify({address:commission.toBase58(),txSignature:signature,title,description,repositoryUrl:$('nRepo').value.trim()||null,license:$('nLicense').value.trim()||'MIT',labels:[]})});closeDialog();await refresh();}
async function pledge(address){const p=state.projects.find(x=>x.address===address),amount=Math.round(Number($('pledgeAmount').value)*1e6);if(!amount)throw new Error('Enter a pledge amount');const program=new PublicKey(state.config.programId),commission=new PublicKey(address),mint=new PublicKey(state.config.tokenMint),config=new PublicKey(state.config.configPda);const [vault]=PublicKey.findProgramAddressSync([Buffer.from('vault'),commission.toBuffer()],program),[pledgePda]=PublicKey.findProgramAddressSync([Buffer.from('pledge'),commission.toBuffer(),state.wallet.toBuffer()],program);const source=await spl.getAssociatedTokenAddress(mint,state.wallet),treasury=await spl.getAssociatedTokenAddress(mint,new PublicKey(state.config.treasuryWallet));const keys=[{pubkey:state.wallet,isSigner:true,isWritable:true},{pubkey:config,isSigner:false,isWritable:false},{pubkey:commission,isSigner:false,isWritable:true},{pubkey:pledgePda,isSigner:false,isWritable:true},{pubkey:vault,isSigner:false,isWritable:true},{pubkey:source,isSigner:false,isWritable:true},{pubkey:treasury,isSigner:false,isWritable:true},{pubkey:mint,isSigner:false,isWritable:false},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false},{pubkey:TOKEN_PROGRAM,isSigner:false,isWritable:false}];await send(new Transaction().add(new TransactionInstruction({programId:program,keys,data:Buffer.concat([Buffer.from([2]),writeU64(amount)])})));closeDialog();await refresh();}
async function simpleAction(action,address,index){const p=state.projects.find(x=>x.address===address),program=new PublicKey(state.config.programId),commission=new PublicKey(address),mint=new PublicKey(state.config.tokenMint),[vault]=PublicKey.findProgramAddressSync([Buffer.from('vault'),commission.toBuffer()],program),treasury=await spl.getAssociatedTokenAddress(mint,new PublicKey(state.config.treasuryWallet));let ix;if(action==='nominate'){const nominated=new PublicKey($('agentWallet').value.trim());ix=new TransactionInstruction({programId:program,keys:[{pubkey:state.wallet,isSigner:true,isWritable:false},{pubkey:commission,isSigner:false,isWritable:true},{pubkey:nominated,isSigner:false,isWritable:false}],data:Buffer.from([3])});}else if(action==='accept')ix=new TransactionInstruction({programId:program,keys:[{pubkey:state.wallet,isSigner:true,isWritable:false},{pubkey:commission,isSigner:false,isWritable:true}],data:Buffer.from([8])});else if(action==='cancel')ix=new TransactionInstruction({programId:program,keys:[{pubkey:state.wallet,isSigner:true,isWritable:false},{pubkey:commission,isSigner:false,isWritable:true}],data:Buffer.from([6])});else if(action==='release'){const agentToken=await spl.getAssociatedTokenAddress(mint,new PublicKey(p.agent));ix=new TransactionInstruction({programId:program,keys:[{pubkey:state.wallet,isSigner:true,isWritable:false},{pubkey:commission,isSigner:false,isWritable:true},{pubkey:vault,isSigner:false,isWritable:true},{pubkey:agentToken,isSigner:false,isWritable:true},{pubkey:treasury,isSigner:false,isWritable:true},{pubkey:mint,isSigner:false,isWritable:false},{pubkey:TOKEN_PROGRAM,isSigner:false,isWritable:false}],data:Buffer.from([4,Number(index)])});}else if(action==='refund'){const [pledgePda]=PublicKey.findProgramAddressSync([Buffer.from('pledge'),commission.toBuffer(),state.wallet.toBuffer()],program),dest=await spl.getAssociatedTokenAddress(mint,state.wallet);ix=new TransactionInstruction({programId:program,keys:[{pubkey:state.wallet,isSigner:true,isWritable:false},{pubkey:commission,isSigner:false,isWritable:true},{pubkey:pledgePda,isSigner:false,isWritable:true},{pubkey:vault,isSigner:false,isWritable:true},{pubkey:dest,isSigner:false,isWritable:true},{pubkey:treasury,isSigner:false,isWritable:true},{pubkey:mint,isSigner:false,isWritable:false},{pubkey:TOKEN_PROGRAM,isSigner:false,isWritable:false}],data:Buffer.from([5])});}await send(new Transaction().add(ix));closeDialog();await refresh();}
function showError(error){console.error(error);const t=$('toast');t.textContent=error.message||String(error);t.classList.add('on');setTimeout(()=>t.classList.remove('on'),5000);}
document.addEventListener('click',e=>{const t=e.target.closest('button,[data-id]');if(!t)return;if(t.id==='bWallet')openWalletModal();else if(t.dataset.wallet)connectWallet(t.dataset.wallet).catch(showError);else if(t.id==='bTheme'){state.theme=state.theme==='light'?'dark':'light';localStorage.setItem('gitstarter.theme',state.theme);render();}else if(t.id==='bNew')openCreate();else if(t.id==='bX'||t.id==='overlay')closeDialog();else if(t.id==='doCreate')createCommission().catch(showError);else if(t.dataset.f){state.filter=t.dataset.f;render();}else if(t.dataset.action==='pledge')pledge(t.dataset.id).catch(showError);else if(t.dataset.action)simpleAction(t.dataset.action,t.dataset.id,t.dataset.index).catch(showError);else if(t.dataset.id)openProject(t.dataset.id);});
$('q').addEventListener('input',render);
(async()=>{try{state.config=await api('/api/config');state.connection=new web3.Connection(state.config.rpcUrl,'confirmed');await refresh();}catch(e){showError(e);}})();
