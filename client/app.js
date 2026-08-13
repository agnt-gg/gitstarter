const { Buffer } = require('buffer');
globalThis.Buffer = Buffer;
const web3 = require('@solana/web3.js');
const spl = require('@solana/spl-token');
const { createSolanaClient } = require('@metamask/connect-solana');
const { PublicKey, Transaction, TransactionInstruction, SystemProgram } = web3;
const $ = id => document.getElementById(id);
const TOKEN_PROGRAM = spl.TOKEN_PROGRAM_ID;
const state = { config:null, connection:null, wallet:null, walletName:null, provider:null, session:null, sessionWallet:null, authStatus:'disconnected', connecting:false, metadata:[], projects:[], filter:'all', label:'all', sort:'newest', theme:localStorage.getItem('gitstarter.theme')||'light' };
const WALLETS = [
  {id:'phantom',name:'Phantom',logo:'/wallets/phantom.svg',url:'https://phantom.com/download',provider:()=>window.phantom?.solana},
  {id:'solflare',name:'Solflare',logo:'/wallets/solflare.svg',url:'https://www.solflare.com/download',provider:()=>window.solflare},
  {id:'backpack',name:'Backpack',logo:'/wallets/backpack.png',url:'https://backpack.app/download',provider:()=>window.backpack?.solana},
  {id:'metamask',name:'MetaMask',logo:'/wallets/metamask.svg',url:'https://metamask.io/download/',provider:()=>null,connect:connectMetaMask},
  {id:'coinbase',name:'Coinbase Wallet',logo:'/wallets/coinbase.png',url:'https://www.coinbase.com/wallet/downloads',provider:()=>window.coinbaseSolana},
  {id:'brave',name:'Brave Wallet',logo:'/wallets/brave.png',url:'https://brave.com/wallet/',provider:()=>window.braveSolana},
  {id:'trust',name:'Trust Wallet',logo:'/wallets/trust.svg',url:'https://trustwallet.com/download',provider:()=>window.trustwallet?.solana}
];
const STATUS = ['funding','funded','building','shipped','refunded'];
const STATUS_UI = {
  funding:{label:'Open',detail:'Open for pledges',cls:'blue',icon:'circle'}, funded:{label:'Funded',detail:'Funded — accepting agent',cls:'yellow',icon:'clock'}, building:{label:'In progress',detail:'In progress',cls:'purple',icon:'play'}, shipped:{label:'Delivered',detail:'Delivered',cls:'green',icon:'check'}, refunded:{label:'Closed',detail:'Closed — refundable',cls:'gray',icon:'x'}
};
const ICON_PATHS={circle:'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Z',clock:'M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0Zm0 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM7.25 4a.75.75 0 0 1 1.5 0v3.69l2.03 2.03a.75.75 0 1 1-1.06 1.06l-2.25-2.25A.75.75 0 0 1 7.25 8V4Z',play:'M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16ZM6.5 4.9a.5.5 0 0 1 .76-.43l5 3.1a.5.5 0 0 1 0 .86l-5 3.1A.5.5 0 0 1 6.5 11.1V4.9Z',check:'M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16Zm3.78-9.72-4.25 4.25a.75.75 0 0 1-1.06 0l-2.25-2.25a.75.75 0 0 1 1.06-1.06L7 8.94l3.72-3.72a.75.75 0 1 1 1.06 1.06Z',x:'M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16Zm2.78-10.78a.75.75 0 0 1 0 1.06L9.06 8l1.72 1.72a.75.75 0 1 1-1.06 1.06L8 9.06l-1.72 1.72a.75.75 0 0 1-1.06-1.06L6.94 8 5.22 6.28a.75.75 0 0 1 1.06-1.06L8 6.94l1.72-1.72a.75.75 0 0 1 1.06 0Z',book:'M0 1.75A1.75 1.75 0 0 1 1.75 0h4.5C7.216 0 8 .784 8 1.75v12.5A1.75 1.75 0 0 0 6.25 12.5h-4.5c-.09 0-.18.007-.267.02A2.99 2.99 0 0 1 3 12.126V1.75A.25.25 0 0 0 2.75 1.5h-1a.25.25 0 0 0-.25.25v9.378A3 3 0 0 0 0 13.728V1.75Zm16 0v11.978a3 3 0 0 0-1.5-2.6V1.75a.25.25 0 0 0-.25-.25h-1a.25.25 0 0 0-.25.25v10.376a2.99 2.99 0 0 1 1.517.394 1.75 1.75 0 0 0-.267-.02h-4.5A1.75 1.75 0 0 0 8 14.25V1.75C8 .784 8.784 0 9.75 0h4.5C15.216 0 16 .784 16 1.75Z'};
function statusIcon(ui){return `<span class="status-glyph ${ui.cls}" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="${ICON_PATHS[ui.icon]}"></path></svg></span>`;}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function safeHttpUrl(value){try{const url=new URL(value);return url.protocol==='https:'||url.protocol==='http:'?url.href:null;}catch{return null;}}
function walletAlias(address){const adjectives=['Amber','Bold','Calm','Cobalt','Golden','Keen','Lunar','Nimble','Quiet','Solar','Swift','Violet'];const nouns=['Badger','Builder','Falcon','Fox','Heron','Otter','Panda','Raven','Tiger','Wolf','Wren','Yak'];let hash=2166136261;for(const char of address){hash^=char.charCodeAt(0);hash=Math.imul(hash,16777619);}const value=hash>>>0;return `${adjectives[value%adjectives.length]}-${nouns[(value>>>8)%nouns.length]}-${address.slice(-4)}`;}
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
  options.credentials='same-origin';options.headers={'content-type':'application/json',...(options.headers||{})};
  const r=await fetch(path,options);const body=await r.json();if(!r.ok)throw new Error(body.error||`HTTP ${r.status}`);return body;
}
function installedProvider(wallet){
  const provider=wallet.provider();
  return provider && typeof provider.connect==='function' ? provider : null;
}
function walletProvider(){return state.provider;}
function closeIcon(){return '<button class="closeX" id="bX" type="button" aria-label="Close dialog">×</button>';}
async function connectMetaMask(silent=false){
  const client=await createSolanaClient({dapp:{name:'GitStarter',url:window.location.origin},api:{supportedNetworks:{devnet:state.config.rpcUrl}},analytics:{enabled:false}});
  const wallet=client.getWallet();
  const accounts=silent?wallet.accounts:(await wallet.features['standard:connect'].connect()).accounts;
  const account=accounts?.[0];
  if(!account){if(silent)return null;throw new Error('MetaMask did not return a Solana account');}
  const chain=state.config?.cluster==='mainnet-beta'?'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp':'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
  return {
    publicKey:new PublicKey(account.address),
    async connect(){return {publicKey:new PublicKey(account.address)};},
    async signMessage(message){const [result]=await wallet.features['solana:signMessage'].signMessage({account,message});return result.signature;},
    async signTransaction(transaction){const [result]=await wallet.features['solana:signTransaction'].signTransaction({account,transaction:transaction.serialize({requireAllSignatures:false,verifySignatures:false}),chain});return Transaction.from(result.signedTransaction);}
  };
}
function openWalletModal(){
  const rows=WALLETS.map(wallet=>{
    const installed=wallet.id==='metamask'||!!installedProvider(wallet);
    return `<button class="wallet-option" type="button" data-wallet="${wallet.id}"><span class="wallet-logo"><img src="${wallet.logo}" alt="" width="30" height="30"></span><span class="wallet-copy"><span class="wallet-name">${wallet.name}</span><span class="wallet-state ${installed?'detected':''}">${installed?(wallet.id==='metamask'?'Connect with MetaMask':'Detected in this browser'):'Get wallet'}</span></span><span class="wallet-next" aria-hidden="true">${installed?'›':'↗'}</span></button>`;
  }).join('');
  $('dlg').className='dlg dlg-wallet';
  $('dlg').innerHTML=`<div class="dlg-head"><div class="dlg-head-row"><div class="dlg-head-copy"><h1>Connect wallet</h1><div class="sub">Choose a Solana wallet to continue on ${esc(state.config?.cluster||'devnet')}.</div></div>${closeIcon()}</div></div><div class="dlg-content"><div class="wallet-list">${rows}</div><div class="security-note"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0c.69 0 1.25.56 1.25 1.25V2h1A2.75 2.75 0 0 1 13 4.75v2.086c.916.355 1.5 1.18 1.5 2.164v4.5A2.5 2.5 0 0 1 12 16H4a2.5 2.5 0 0 1-2.5-2.5V9c0-.984.584-1.81 1.5-2.164V4.75A2.75 2.75 0 0 1 5.75 2h1v-.75C6.75.56 7.31 0 8 0Zm-2.25 3.5c-.69 0-1.25.56-1.25 1.25V6.5h7V4.75c0-.69-.56-1.25-1.25-1.25h-4.5ZM4 8a1 1 0 0 0-1 1v4.5A1 1 0 0 0 4 14.5h8a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1H4Z"/></svg><span>GitStarter never sees your recovery phrase or private keys. Your wallet asks for approval before every signature.</span></div></div>`;
  $('overlay').classList.add('on');
}
async function connectWallet(walletId){
  if(state.connecting)return;
  const wallet=WALLETS.find(item=>item.id===walletId);
  if(!wallet)throw new Error('Unsupported wallet');
  state.connecting=true;
  try{
    const provider=wallet.connect?await wallet.connect():installedProvider(wallet);
    if(!provider){window.open(wallet.url,'_blank','noopener,noreferrer');return;}
    const result=wallet.connect?{publicKey:provider.publicKey}:await provider.connect();
    const publicKey=result?.publicKey||provider.publicKey;
    if(!publicKey)throw new Error(`${wallet.name} did not return a wallet address`);
    const address=publicKey.toBase58();
    if(state.sessionWallet&&state.sessionWallet!==address){state.session=null;state.sessionWallet=null;}
    state.provider=provider;state.wallet=publicKey;state.walletName=wallet.name;state.authStatus=state.session?'authenticated':'connected';localStorage.setItem('gitstarter.wallet',wallet.id);
    closeDialog();render();
    if(state.session){await refresh();return;}
    if(wallet.id==='metamask'){showNotice('MetaMask connected. Sign one message to finish your GitStarter account.');return;}
    try{await authenticate();}catch(error){state.authStatus='connected';render();showError(new Error(`Wallet connected. Finish sign-in to create commissions. ${friendlyWalletError(error)}`));return;}
    await refresh();
  }finally{state.connecting=false;}
}
async function authenticate(){
  if(state.authStatus==='signing'||state.session)return;
  if(!state.wallet||!state.provider)throw new Error('Connect a wallet first');
  state.authStatus='signing';render();
  try{
    const wallet=state.wallet.toBase58();const challenge=await api('/api/auth/challenge',{method:'POST',body:JSON.stringify({wallet})});
    if(typeof state.provider.signMessage!=='function')throw new Error('This wallet does not support secure message sign-in');
    const bytes=new TextEncoder().encode(challenge.message);const signed=await state.provider.signMessage(bytes,'utf8');
    const signature=bs58Encode(signed.signature||signed);const result=await api('/api/auth/verify',{method:'POST',body:JSON.stringify({wallet,message:challenge.message,signature})});
    state.session=true;state.sessionWallet=wallet;state.authStatus='authenticated';render();
  }catch(error){state.authStatus='connected';render();throw error;}
}
async function requireSession(){if(!state.wallet){openWalletModal();return false;}if(!state.session)await authenticate();if(!state.provider){openWalletModal();showError(new Error('Your GitStarter session is active. Reattach your wallet to sign transactions.'));return false;}return true;}
async function restoreSession(){
  let session;try{session=await api('/api/auth/session');}catch{return;}
  state.session=true;state.sessionWallet=session.wallet;state.authStatus='authenticated';state.wallet=new PublicKey(session.wallet);
  const walletId=localStorage.getItem('gitstarter.wallet'),wallet=WALLETS.find(item=>item.id===walletId);
  if(wallet){state.walletName=wallet.name;try{let provider;if(wallet.id==='metamask')provider=await connectMetaMask(true);else{provider=installedProvider(wallet);if(provider){const result=await provider.connect({onlyIfTrusted:true});const key=result?.publicKey||provider.publicKey;if(!key||key.toBase58()!==session.wallet)provider=null;}}if(provider)state.provider=provider;}catch{state.provider=null;}}
  render();
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
  const wallet=currentWallet();$('bWallet').textContent=wallet?`${state.walletName||'Wallet'} · ${wallet.slice(0,4)}…${wallet.slice(-4)}`:'Connect wallet';
  $('accountEmpty').style.display=wallet?'none':'block';$('accountCard').classList.toggle('on',!!wallet);
  if(wallet){$('wAlias').textContent=walletAlias(wallet);$('wAddress').textContent=wallet;const auth=$('wAuth');if(state.authStatus==='authenticated'){auth.className='account-state signed';auth.innerHTML='<span>✓ Signed in to GitStarter</span>';}else if(state.authStatus==='signing'){auth.className='account-state';auth.innerHTML='<span>Waiting for signature…</span>';}else{auth.className='account-state';auth.innerHTML='<span>Wallet connected</span><button class="btn" id="bFinishAuth" type="button">Finish sign-in</button>';}}
  const labels=[...new Set(state.projects.flatMap(p=>Array.isArray(p.meta?.labels)?p.meta.labels:[]))].sort();
  let visible=state.projects.filter(p=>(state.filter==='all'||p.status===state.filter)&&(state.label==='all'||p.meta?.labels?.includes(state.label))&&(!($('q').value)||JSON.stringify(p.meta||{}).toLowerCase().includes($('q').value.toLowerCase())));
  visible=[...visible].sort((a,b)=>state.sort==='funding'?b.pledged-a.pledged:state.sort==='deadline'?a.deadline-b.deadline:(b.meta?.createdAt||0)-(a.meta?.createdAt||0));
  $('unav').innerHTML=[['all','Commissions',{label:'Commissions',cls:'',icon:'book'}],...STATUS.map(s=>[s,STATUS_UI[s].label,STATUS_UI[s]])].map(([f,l,ui])=>`<button data-f="${f}" class="${state.filter===f?'on':''}">${ui.icon==='book'?'<span class="status-glyph"><svg viewBox="0 0 16 16"><path d="'+ICON_PATHS.book+'"></path></svg></span>':statusIcon(ui)}${esc(l)} <span class="counter">${f==='all'?state.projects.length:state.projects.filter(p=>p.status===f).length}</span></button>`).join('');
  const openCount=state.projects.filter(p=>p.status!=='shipped'&&p.status!=='refunded').length,closedCount=state.projects.length-openCount;
  const header=`<div class="Box-header"><div class="list-summary"><span>${statusIcon(STATUS_UI.funding)}<b>${openCount} Open</b></span><span>${statusIcon(STATUS_UI.shipped)}${closedCount} Closed</span></div><div class="list-tools"><label class="hint" for="sortSelect" style="margin:0">Sort</label><select class="tool-select" id="sortSelect"><option value="newest" ${state.sort==='newest'?'selected':''}>Newest</option><option value="funding" ${state.sort==='funding'?'selected':''}>Most funded</option><option value="deadline" ${state.sort==='deadline'?'selected':''}>Deadline</option></select></div></div>`;
  const labelBar=labels.length?`<div class="label-filter"><button class="label-button ${state.label==='all'?'on':''}" data-label="all">All labels</button>${labels.map(label=>`<button class="label-button ${state.label===label?'on':''}" data-label="${esc(label)}">${esc(label)}</button>`).join('')}</div>`:'';
  $('listBox').innerHTML=header+labelBar+(visible.length?visible.map(row).join(''):'<div class="blank"><h3>No matching commissions</h3><p>Change the active status, label, search, or create the first real commission.</p></div>');
  const total=state.projects.reduce((s,p)=>s+p.pledged,0), escrow=state.projects.reduce((s,p)=>s+Math.max(0,p.pledged-p.released-p.refunded),0);
  $('sPledged').textContent=fmtBase(total); $('sEsc').textContent=fmtBase(escrow); $('sBurn').textContent=fmtBase(state.projects.reduce((s,p)=>s+p.released,0)); $('sRefund').textContent=fmtBase(state.projects.reduce((s,p)=>s+p.refunded,0)); $('sBackers').textContent=state.projects.reduce((s,p)=>s+p.pledgerCount,0);
  $('wBal').textContent=wallet?'refreshing…':'connect wallet'; $('wProj').textContent=wallet?state.projects.filter(p=>p.creator===wallet).length:'—';
  $('banner').innerHTML=`<div class="flash"><div><b>1% protocol fee</b> on pledges, milestone releases, and refunds. Program <span class="mono">${state.config.programId.slice(0,8)}…</span></div></div>`;
  if(wallet)loadBalance();
}
async function loadBalance(){try{const ata=await spl.getAssociatedTokenAddress(new PublicKey(state.config.tokenMint),state.wallet);const bal=await state.connection.getTokenAccountBalance(ata);$('wBal').textContent=bal.value.uiAmountString+' GIT';}catch{$('wBal').textContent='0 GIT';}}
function row(p){const ui=STATUS_UI[p.status]||STATUS_UI.refunded,m=p.meta||{},percent=p.goal?Math.min(100,p.pledged/p.goal*100):0,labels=Array.isArray(m.labels)?m.labels:[];let cursor=0;const segments=p.milestoneBps.map((bps,index)=>{const start=cursor;cursor+=bps/100;const fill=Math.max(0,Math.min(100,(percent-start)/(bps/100)*100));return `<span class="milestone-segment" style="width:${bps/100}%"><span class="milestone-fill ${ui.cls}" style="display:block;width:${fill}%"></span></span>`;}).join('');return `<div class="Box-row" data-id="${p.address}" style="cursor:pointer"><div class="row-status">${statusIcon(ui)}</div><div class="row-main"><div class="row-title"><span style="color:var(--fg);font-weight:600;font-size:16px">${esc(m.title||'Unindexed commission')}</span><span class="lbl ${ui.cls}">${esc(ui.detail)}</span>${labels.map(label=>`<span class="lbl gray">${esc(label)}</span>`).join('')}</div><div class="row-meta"><span class="mono">${p.address.slice(0,8)}…</span><span>created by ${p.creator.slice(0,6)}…</span><span>·</span><span>${esc(m.license||'metadata pending')}</span><span>·</span><span>${p.milestoneCount} milestones</span></div><div class="milestone-track" aria-label="${percent.toFixed(1)}% funded across ${p.milestoneCount} milestones">${segments}</div></div><div class="row-right"><span class="amt">${fmtBase(p.pledged)} <span class="of">/ ${fmtBase(p.goal)} GIT</span></span><span class="hint">${p.pledgerCount} ${p.pledgerCount===1?'backer':'backers'}</span></div></div>`;}
function closeDialog(){$('overlay').classList.remove('on');$('dlg').className='dlg';$('dlg').innerHTML='';}
function openProject(address){
  const p=state.projects.find(x=>x.address===address);if(!p)return;
  const m=p.meta||{},wallet=currentWallet(),ui=STATUS_UI[p.status]||STATUS_UI.refunded;
  let actions='';
  if(p.status==='funding'&&wallet)actions=`<div class="field"><label for="pledgeAmount">Pledge amount</label><input id="pledgeAmount" type="number" min="0.000001" step="0.000001" placeholder="0.00"><div class="hint">Amount in GIT. Your wallet will confirm the escrow transaction.</div></div><div class="action-row"><button class="btn primary lg" data-action="pledge" data-id="${p.address}">Pledge GIT</button></div>`;
  if(p.status==='funded'&&wallet===p.creator&&!p.hasPendingAgent)actions=`<div class="field"><label for="agentWallet">Agent wallet address</label><input id="agentWallet" type="text" placeholder="Solana address"><div class="hint">The nominated wallet must separately accept the contract.</div></div><div class="action-row"><button class="btn primary" data-action="nominate" data-id="${p.address}">Nominate agent</button></div>`;
  if(p.status==='funded'&&p.hasPendingAgent&&wallet===p.pendingAgent)actions=`<div class="action-row"><button class="btn primary lg" data-action="accept" data-id="${p.address}">Accept contract</button></div>`;
  if(p.status==='funded'&&p.hasPendingAgent&&wallet!==p.pendingAgent)actions=`<p class="hint">Waiting for <span class="mono">${p.pendingAgent}</span> to accept.</p>`;
  if(p.status==='building'&&wallet===p.creator)actions=`<div class="action-row">${p.milestoneBps.map((bps,i)=>`<button class="btn" data-action="release" data-index="${i}" data-id="${p.address}" ${p.milestonesDone&(1<<i)?'disabled':''}>${p.milestonesDone&(1<<i)?'Released':'Release'} milestone ${i+1} · ${bps/100}%</button>`).join('')}</div>`;
  if((p.status==='funding'||p.status==='funded')&&wallet===p.creator)actions+=`<div class="action-row" style="margin-top:12px"><button class="btn danger" data-action="cancel" data-id="${p.address}">Cancel commission</button></div>`;
  if(p.status==='refunded'&&wallet)actions=`<div class="action-row"><button class="btn primary" data-action="refund" data-id="${p.address}">Claim available refund</button></div>`;
  if(!wallet)actions='<p class="hint">Connect a wallet to see the actions available to you.</p>';
  $('dlg').className='dlg';
  $('dlg').innerHTML=`<div class="dlg-head"><div class="dlg-head-row"><div class="dlg-head-copy"><h1>${esc(m.title||'Unindexed commission')} <span class="state ${ui.cls}">${esc(ui.label)}</span></h1><div class="sub mono">${p.address}</div></div>${closeIcon()}</div></div><div class="project-shell"><main class="project-main"><p class="project-description">${esc(m.description||'This on-chain commission has not been indexed yet.')}</p><h2 class="section-title">Settlement</h2><div class="metric-grid"><div class="metric"><b>${fmtBase(p.pledged)} GIT</b><span>Net pledged</span></div><div class="metric"><b>${fmtBase(p.released)} GIT</b><span>Released</span></div><div class="metric"><b>${fmtBase(p.refunded)} GIT</b><span>Refunded</span></div></div><h2 class="section-title">Actions</h2><div class="action-panel">${actions}</div></main><aside class="project-side"><h2 class="section-title">Contract</h2><ul class="fact-list"><li><span>Network</span><b>${esc(state.config.cluster)}</b></li><li><span>Goal</span><b>${fmtBase(p.goal)} GIT</b></li><li><span>Milestones</span><b>${p.milestoneCount}</b></li><li><span>Protocol fee</span><b>1% per value movement</b></li><li><span>Deadline</span><b>${new Date(p.deadline*1000).toLocaleString()}</b></li><li><span>Creator</span><b class="mono">${p.creator}</b></li>${safeHttpUrl(m.repositoryUrl)?`<li><span>Repository</span><b><a href="${esc(safeHttpUrl(m.repositoryUrl))}" target="_blank" rel="noopener noreferrer">Open repository ↗</a></b></li>`:''}</ul></aside></div>`;
  $('overlay').classList.add('on');
}
async function openCreate(){
  if(!await requireSession())return;
  $('dlg').className='dlg dlg-create';
  $('dlg').innerHTML=`<div class="dlg-head"><div class="dlg-head-row"><div class="dlg-head-copy"><h1>Create a commission</h1><div class="sub">Define the work, funding target, and release schedule on Solana ${esc(state.config.cluster)}.</div></div>${closeIcon()}</div></div><div class="form-section"><h2>Commission details</h2><p>Give backers a precise description of what will be delivered.</p><div class="field"><label for="nTitle">Title</label><input id="nTitle" type="text" maxlength="120" placeholder="A concise outcome"></div><div class="field"><label for="nDescription">Description</label><textarea id="nDescription" placeholder="Scope, acceptance criteria, and expected deliverables"></textarea></div><div class="grid2"><div class="field"><label for="nRepo">Repository URL <span class="hint">optional</span></label><input id="nRepo" type="text" placeholder="https://github.com/owner/repo"></div><div class="field"><label for="nLicense">License</label><input id="nLicense" type="text" value="MIT"></div></div><div class="field"><label for="nLabels">Labels <span class="hint">optional</span></label><input id="nLabels" type="text" placeholder="cli, media, typescript"><div class="hint">Comma-separated. Labels become live filters on the commission list.</div></div></div><div class="form-section"><h2>Funding and delivery</h2><p>Funds remain in program-controlled escrow until milestones are released or refunded.</p><div class="grid2"><div class="field"><label for="nGoal">Funding goal (GIT)</label><input id="nGoal" type="number" min="0.000001" step="0.000001" placeholder="1000"></div><div class="field"><label for="nDeadline">Funding deadline</label><input id="nDeadline" type="datetime-local"></div></div><div class="field"><label for="nMilestones">Milestone percentages</label><input id="nMilestones" type="text" value="25,40,20,15"><div class="hint">Comma-separated percentages. They must total 100.</div></div></div><div class="dlg-footer"><span class="hint">Your wallet will confirm the on-chain creation transaction.</span><button class="btn" type="button" id="bX">Cancel</button><button class="btn primary lg" id="doCreate">Create and sign</button></div>`;
  $('overlay').classList.add('on');
}
async function createCommission(){
  const title=$('nTitle').value.trim(), description=$('nDescription').value.trim(), goal=Math.round(Number($('nGoal').value)*1e6), deadline=Math.floor(new Date($('nDeadline').value).getTime()/1000), percentages=$('nMilestones').value.split(',').map(Number);if(!title||!description||!goal||!deadline||percentages.some(x=>!x)||percentages.reduce((a,b)=>a+b,0)!==100)throw new Error('Complete all fields; milestones must sum to 100');
  const seed=Date.now();const program=new PublicKey(state.config.programId),config=new PublicKey(state.config.configPda),mint=new PublicKey(state.config.tokenMint);const [commission]=PublicKey.findProgramAddressSync([Buffer.from('commission'),state.wallet.toBuffer(),writeU64(seed)],program);const [vault]=PublicKey.findProgramAddressSync([Buffer.from('vault'),commission.toBuffer()],program);const count=Buffer.alloc(4);count.writeUInt32LE(percentages.length);const data=Buffer.concat([Buffer.from([1]),writeU64(seed),writeU64(goal),count,...percentages.map(x=>{const b=Buffer.alloc(2);b.writeUInt16LE(x*100);return b;}),writeI64(deadline)]);const ix=new TransactionInstruction({programId:program,keys:[{pubkey:state.wallet,isSigner:true,isWritable:true},{pubkey:config,isSigner:false,isWritable:false},{pubkey:commission,isSigner:false,isWritable:true},{pubkey:vault,isSigner:false,isWritable:true},{pubkey:mint,isSigner:false,isWritable:false},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false},{pubkey:TOKEN_PROGRAM,isSigner:false,isWritable:false}],data});const signature=await send(new Transaction().add(ix));await api('/api/commissions',{method:'POST',body:JSON.stringify({address:commission.toBase58(),txSignature:signature,title,description,repositoryUrl:$('nRepo').value.trim()||null,license:$('nLicense').value.trim()||'MIT',labels:$('nLabels').value.split(',').map(value=>value.trim().toLowerCase()).filter(Boolean).slice(0,8)})});closeDialog();await refresh();}
async function pledge(address){const p=state.projects.find(x=>x.address===address),amount=Math.round(Number($('pledgeAmount').value)*1e6);if(!amount)throw new Error('Enter a pledge amount');const program=new PublicKey(state.config.programId),commission=new PublicKey(address),mint=new PublicKey(state.config.tokenMint),config=new PublicKey(state.config.configPda);const [vault]=PublicKey.findProgramAddressSync([Buffer.from('vault'),commission.toBuffer()],program),[pledgePda]=PublicKey.findProgramAddressSync([Buffer.from('pledge'),commission.toBuffer(),state.wallet.toBuffer()],program);const source=await spl.getAssociatedTokenAddress(mint,state.wallet),treasury=await spl.getAssociatedTokenAddress(mint,new PublicKey(state.config.treasuryWallet));const keys=[{pubkey:state.wallet,isSigner:true,isWritable:true},{pubkey:config,isSigner:false,isWritable:false},{pubkey:commission,isSigner:false,isWritable:true},{pubkey:pledgePda,isSigner:false,isWritable:true},{pubkey:vault,isSigner:false,isWritable:true},{pubkey:source,isSigner:false,isWritable:true},{pubkey:treasury,isSigner:false,isWritable:true},{pubkey:mint,isSigner:false,isWritable:false},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false},{pubkey:TOKEN_PROGRAM,isSigner:false,isWritable:false}];await send(new Transaction().add(new TransactionInstruction({programId:program,keys,data:Buffer.concat([Buffer.from([2]),writeU64(amount)])})));closeDialog();await refresh();}
async function simpleAction(action,address,index){const p=state.projects.find(x=>x.address===address),program=new PublicKey(state.config.programId),commission=new PublicKey(address),mint=new PublicKey(state.config.tokenMint),[vault]=PublicKey.findProgramAddressSync([Buffer.from('vault'),commission.toBuffer()],program),treasury=await spl.getAssociatedTokenAddress(mint,new PublicKey(state.config.treasuryWallet));let ix;if(action==='nominate'){const nominated=new PublicKey($('agentWallet').value.trim());ix=new TransactionInstruction({programId:program,keys:[{pubkey:state.wallet,isSigner:true,isWritable:false},{pubkey:commission,isSigner:false,isWritable:true},{pubkey:nominated,isSigner:false,isWritable:false}],data:Buffer.from([3])});}else if(action==='accept')ix=new TransactionInstruction({programId:program,keys:[{pubkey:state.wallet,isSigner:true,isWritable:false},{pubkey:commission,isSigner:false,isWritable:true}],data:Buffer.from([8])});else if(action==='cancel')ix=new TransactionInstruction({programId:program,keys:[{pubkey:state.wallet,isSigner:true,isWritable:false},{pubkey:commission,isSigner:false,isWritable:true}],data:Buffer.from([6])});else if(action==='release'){const agentToken=await spl.getAssociatedTokenAddress(mint,new PublicKey(p.agent));ix=new TransactionInstruction({programId:program,keys:[{pubkey:state.wallet,isSigner:true,isWritable:false},{pubkey:commission,isSigner:false,isWritable:true},{pubkey:vault,isSigner:false,isWritable:true},{pubkey:agentToken,isSigner:false,isWritable:true},{pubkey:treasury,isSigner:false,isWritable:true},{pubkey:mint,isSigner:false,isWritable:false},{pubkey:TOKEN_PROGRAM,isSigner:false,isWritable:false}],data:Buffer.from([4,Number(index)])});}else if(action==='refund'){const [pledgePda]=PublicKey.findProgramAddressSync([Buffer.from('pledge'),commission.toBuffer(),state.wallet.toBuffer()],program),dest=await spl.getAssociatedTokenAddress(mint,state.wallet);ix=new TransactionInstruction({programId:program,keys:[{pubkey:state.wallet,isSigner:true,isWritable:false},{pubkey:commission,isSigner:false,isWritable:true},{pubkey:pledgePda,isSigner:false,isWritable:true},{pubkey:vault,isSigner:false,isWritable:true},{pubkey:dest,isSigner:false,isWritable:true},{pubkey:treasury,isSigner:false,isWritable:true},{pubkey:mint,isSigner:false,isWritable:false},{pubkey:TOKEN_PROGRAM,isSigner:false,isWritable:false}],data:Buffer.from([5])});}await send(new Transaction().add(ix));closeDialog();await refresh();}
function friendlyWalletError(error){const message=error?.message||String(error);if(/already pending|wallet_requestPermissions/i.test(message))return 'A MetaMask request is already open. Complete it in the extension, then select Finish sign-in.';if(error?.code===4001||/user rejected/i.test(message))return 'The wallet request was cancelled.';return message;}
function showToast(message){const t=$('toast');t.textContent=message;t.classList.add('on');setTimeout(()=>t.classList.remove('on'),6000);}
function showNotice(message){showToast(message);}
function showError(error){console.error(error);showToast(friendlyWalletError(error));}
document.addEventListener('click',e=>{const t=e.target.closest('button,[data-id]');if(!t)return;if(t.id==='bWallet')openWalletModal();else if(t.dataset.wallet)connectWallet(t.dataset.wallet).catch(showError);else if(t.id==='bTheme'){state.theme=state.theme==='light'?'dark':'light';localStorage.setItem('gitstarter.theme',state.theme);render();}else if(t.id==='bNew')openCreate().catch(showError);else if(t.id==='bFinishAuth')authenticate().catch(showError);else if(t.id==='bX'||t.id==='overlay')closeDialog();else if(t.id==='doCreate')createCommission().catch(showError);else if(t.dataset.f){state.filter=t.dataset.f;render();}else if(t.dataset.label){state.label=t.dataset.label;render();}else if(t.dataset.action==='pledge')pledge(t.dataset.id).catch(showError);else if(t.dataset.action)simpleAction(t.dataset.action,t.dataset.id,t.dataset.index).catch(showError);else if(t.dataset.id)openProject(t.dataset.id);});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&$('overlay').classList.contains('on'))closeDialog();});
$('q').addEventListener('input',render);
document.addEventListener('change',event=>{if(event.target.id==='sortSelect'){state.sort=event.target.value;render();}});
(async()=>{try{state.config=await api('/api/config');state.connection=new web3.Connection(state.config.rpcUrl,'confirmed');await refresh();await restoreSession();}catch(e){showError(e);}})();
