const { Buffer } = require('buffer');
globalThis.Buffer = Buffer;
const web3 = require('@solana/web3.js');
const { createSolanaClient } = require('@metamask/connect-solana');
const { PublicKey, Transaction } = web3;
// The same module the server and the agent API build from. Transaction encoding
// duplicated across two codebases is how a client eventually signs something
// subtly different from what everyone believes it signs.
const escrow = require('../shared/escrow');
const $ = id => document.getElementById(id);
const LAMPORTS_PER_SOL = web3.LAMPORTS_PER_SOL;
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
// Everything a transaction is built from is pinned here, in code the user
// downloads, rather than taken from an API response. Without this, whoever can
// answer /api/config — a compromised server, a hostile proxy, a stolen TLS
// session — could hand back their own program id and have the wallet sign a
// transfer of the user's whole balance into it. The server may describe
// commissions; it may not choose what you sign.
const PINNED = {
  programId:'6PFsiUA7sX5j96pzK7zxLbpFpsJXNLkfwQPYyd4UNFTy',
  configPda:'DXvdV1M6xe7xmt2n5RC8YbqCmsGZrvvnxs8WoVxQmh29',
  treasuryWallet:'4F66AtVCpftxwQ8SbcFdXkyCcubvfMhUpHddJ4AtN5HY',
  cluster:'devnet',
  rpcHosts:['api.devnet.solana.com']
};
function verifyConfig(config){
  for(const field of ['programId','configPda','treasuryWallet','cluster']){
    if(config[field]!==PINNED[field])throw new Error(`Refusing to continue: the server reported a ${field} that does not match this build. Do not sign anything.`);
  }
  let host;
  try{host=new URL(config.rpcUrl).host;}catch{throw new Error('Refusing to continue: the server reported an unusable RPC endpoint.');}
  if(!PINNED.rpcHosts.includes(host))throw new Error('Refusing to continue: the server reported an untrusted RPC endpoint. Do not sign anything.');
  return config;
}
const STATUS = escrow.STATUS;
// Built from the pinned constants rather than the server's response, so a
// hostile /api/config cannot influence a single byte of what gets signed.
const ESCROW_CTX = { programId:PINNED.programId, configPda:PINNED.configPda, treasury:PINNED.treasuryWallet };
const STATUS_UI = {
  funding:{label:'Open',detail:'Open for pledges',cls:'blue',icon:'circle'}, funded:{label:'Funded',detail:'Funded — accepting agent',cls:'yellow',icon:'clock'}, building:{label:'In progress',detail:'In progress',cls:'purple',icon:'play'}, shipped:{label:'Delivered',detail:'Delivered',cls:'green',icon:'check'}, refunded:{label:'Closed',detail:'Closed — refundable',cls:'gray',icon:'x'}
};
const ICON_PATHS={circle:'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Z',clock:'M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0Zm0 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM7.25 4a.75.75 0 0 1 1.5 0v3.69l2.03 2.03a.75.75 0 1 1-1.06 1.06l-2.25-2.25A.75.75 0 0 1 7.25 8V4Z',play:'M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16ZM6.5 4.9a.5.5 0 0 1 .76-.43l5 3.1a.5.5 0 0 1 0 .86l-5 3.1A.5.5 0 0 1 6.5 11.1V4.9Z',check:'M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16Zm3.78-9.72-4.25 4.25a.75.75 0 0 1-1.06 0l-2.25-2.25a.75.75 0 0 1 1.06-1.06L7 8.94l3.72-3.72a.75.75 0 1 1 1.06 1.06Z',x:'M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16Zm2.78-10.78a.75.75 0 0 1 0 1.06L9.06 8l1.72 1.72a.75.75 0 1 1-1.06 1.06L8 9.06l-1.72 1.72a.75.75 0 0 1-1.06-1.06L6.94 8 5.22 6.28a.75.75 0 0 1 1.06-1.06L8 6.94l1.72-1.72a.75.75 0 0 1 1.06 0Z',book:'M0 1.75A1.75 1.75 0 0 1 1.75 0h4.5C7.216 0 8 .784 8 1.75v12.5A1.75 1.75 0 0 0 6.25 12.5h-4.5c-.09 0-.18.007-.267.02A2.99 2.99 0 0 1 3 12.126V1.75A.25.25 0 0 0 2.75 1.5h-1a.25.25 0 0 0-.25.25v9.378A3 3 0 0 0 0 13.728V1.75Zm16 0v11.978a3 3 0 0 0-1.5-2.6V1.75a.25.25 0 0 0-.25-.25h-1a.25.25 0 0 0-.25.25v10.376a2.99 2.99 0 0 1 1.517.394 1.75 1.75 0 0 0-.267-.02h-4.5A1.75 1.75 0 0 0 8 14.25V1.75C8 .784 8.784 0 9.75 0h4.5C15.216 0 16 .784 16 1.75Z'};
// Solscan omits the query only on mainnet, so the cluster has to be carried
// explicitly or every devnet link silently resolves against the wrong chain.
function explorerUrl(address){const cluster=state.config?.cluster;return `https://solscan.io/account/${address}${cluster&&cluster!=='mainnet-beta'?`?cluster=${encodeURIComponent(cluster)}`:''}`;}
function statusIcon(ui){return `<span class="status-glyph ${ui.cls}" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="${ICON_PATHS[ui.icon]}"></path></svg></span>`;}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function safeHttpUrl(value){try{const url=new URL(value);return url.protocol==='https:'||url.protocol==='http:'?url.href:null;}catch{return null;}}
function walletAlias(address){const adjectives=['Amber','Bold','Calm','Cobalt','Golden','Keen','Lunar','Nimble','Quiet','Solar','Swift','Violet'];const nouns=['Badger','Builder','Falcon','Fox','Heron','Otter','Panda','Raven','Tiger','Wolf','Wren','Yak'];let hash=2166136261;for(const char of address){hash^=char.charCodeAt(0);hash=Math.imul(hash,16777619);}const value=hash>>>0;return `${adjectives[value%adjectives.length]}-${nouns[(value>>>8)%nouns.length]}-${address.slice(-4)}`;}
function fmtBase(n){return (Number(n)/LAMPORTS_PER_SOL).toLocaleString(undefined,{maximumFractionDigits:9});}
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
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function connectMetaMask(silent=false){
  const client=await createSolanaClient({dapp:{name:'GitStarter',url:window.location.origin},api:{supportedNetworks:{devnet:state.config.rpcUrl}},analytics:{enabled:false}});
  const wallet=client.getWallet();
  let accounts;
  if(silent){
    // The client was constructed milliseconds ago and rehydrates its session
    // over a relay, so `accounts` is usually still empty on the first read.
    // Reading it immediately is why a returning mobile user looked signed in
    // but had no wallet attached. Give the SDK a moment to catch up.
    for(let attempt=0;attempt<12;attempt++){
      accounts=wallet.accounts;
      if(accounts?.length)break;
      await sleep(250);
    }
  }else{
    accounts=(await wallet.features['standard:connect'].connect()).accounts;
  }
  const account=accounts?.[0];
  if(!account){if(silent)return null;throw new Error('MetaMask did not return a Solana account');}
  const chain=state.config?.cluster==='mainnet-beta'?'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp':'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
  return {
    publicKey:new PublicKey(account.address),
    async connect(){return {publicKey:new PublicKey(account.address)};},
    async signMessage(message){const [result]=await wallet.features['solana:signMessage'].signMessage({account,message});return result.signature;},

    // MetaMask must sign AND send, because only that path reads the chain.
    //
    // `standard:connect` opens the session on mainnet by default, and
    // `solana:signTransaction` ignores the `chain` argument entirely — it signs
    // against whatever scope the session already has. Every transaction we built
    // for devnet was therefore handed to MetaMask as a mainnet transaction, where
    // this program does not exist and the blockhash is meaningless, so MetaMask
    // rejected it during its own simulation before anything reached the network.
    //
    // `solana:signAndSendTransaction` derives the scope from `chain` and
    // re-scopes the session to devnet when needed, which is exactly what we want.
    async signAndSendTransaction(transaction){
      const [result]=await wallet.features['solana:signAndSendTransaction'].signAndSendTransaction({
        account,
        transaction:transaction.serialize({requireAllSignatures:false,verifySignatures:false}),
        chain,
      });
      return bs58Encode(result.signature);
    },
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
    // Switching wallets must end the previous session on the server too, not
    // just forget it in this tab.
    if(state.sessionWallet&&state.sessionWallet!==address){try{await api('/api/auth/logout',{method:'POST'});}catch{}state.session=null;state.sessionWallet=null;}
    state.provider=provider;state.wallet=publicKey;state.walletName=wallet.name;state.authStatus=state.session?'authenticated':'connected';localStorage.setItem('gitstarter.wallet',wallet.id);
    closeDialog();render();
    if(state.session){await refresh();return;}
    // Connecting a wallet and signing in are one intention, so they are one tap.
    // MetaMask used to be sent down a manual second step because a signature
    // requested immediately after connecting can collide with its own pending
    // request queue; `authenticate` now retries that specific case instead,
    // which fixes the race rather than making every user pay for it.
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
    const bytes=new TextEncoder().encode(challenge.message);
    // A wallet that is still settling the connection it just approved rejects a
    // signature request as "already pending". That is a timing artefact, not a
    // refusal, so retry briefly before surfacing it. A genuine user rejection
    // carries a different code and is rethrown immediately.
    let signed;
    for(let attempt=0;;attempt++){
      try{signed=await state.provider.signMessage(bytes,'utf8');break;}
      catch(error){
        const pending=/already pending|wallet_requestPermissions|request of type/i.test(error?.message||'');
        if(!pending||attempt>=4)throw error;
        await sleep(400);
      }
    }
    const signature=bs58Encode(signed.signature||signed);const result=await api('/api/auth/verify',{method:'POST',body:JSON.stringify({wallet,message:challenge.message,signature})});
    state.session=true;state.sessionWallet=wallet;state.authStatus='authenticated';render();
  }catch(error){state.authStatus='connected';render();throw error;}
}
/// Reattaches the live wallet object to an existing session without asking the
/// user for anything. The session lives in an HttpOnly cookie and survives for
/// 30 days; the provider is a JavaScript object that dies on every page load.
/// Mobile reloads constantly — every hop out to the wallet app risks the tab
/// being evicted — so a signed-in user arriving with no provider is the normal
/// case, not an error, and must never be met with a modal.
async function reattachProvider(){
  if(state.provider)return true;
  const walletId=localStorage.getItem('gitstarter.wallet');
  const wallet=WALLETS.find(item=>item.id===walletId);
  if(!wallet||!state.sessionWallet)return false;
  try{
    let provider;
    if(wallet.connect)provider=await wallet.connect();
    else{
      provider=installedProvider(wallet);
      if(provider)await provider.connect();
    }
    const key=provider?.publicKey;
    // Refuse a provider for a different account than the session was issued to,
    // rather than silently signing as somebody else.
    if(!key||key.toBase58()!==state.sessionWallet)return false;
    state.provider=provider;state.walletName=wallet.name;render();
    return true;
  }catch{return false;}
}
async function requireSession(){
  if(!state.wallet){openWalletModal();return false;}
  if(!state.session)await authenticate();
  if(!state.provider&&!await reattachProvider()){
    openWalletModal();
    showError(new Error('Reconnect your wallet to sign this transaction. Your GitStarter session is still active.'));
    return false;
  }
  return true;
}
async function restoreSession(){
  let session;try{session=await api('/api/auth/session');}catch{return;}
  state.session=true;state.sessionWallet=session.wallet;state.authStatus='authenticated';state.wallet=new PublicKey(session.wallet);
  const walletId=localStorage.getItem('gitstarter.wallet'),wallet=WALLETS.find(item=>item.id===walletId);
  if(wallet){state.walletName=wallet.name;try{let provider;if(wallet.id==='metamask')provider=await connectMetaMask(true);else{provider=installedProvider(wallet);if(provider){const result=await provider.connect({onlyIfTrusted:true});const key=result?.publicKey||provider.publicKey;if(!key||key.toBase58()!==session.wallet)provider=null;}}if(provider)state.provider=provider;}catch{state.provider=null;}}
  // A silent reattach can legitimately fail on mobile. That is not an error
  // worth showing: the session is intact, and requireSession reattaches on
  // demand the moment the user actually needs to sign something.
  render();
}
function bs58Encode(bytes){const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let digits=[0];for(const byte of bytes){let carry=byte;for(let j=0;j<digits.length;j++){carry+=digits[j]<<8;digits[j]=carry%58;carry=(carry/58)|0;}while(carry){digits.push(carry%58);carry=(carry/58)|0;}}let out='';for(let k=0;k<bytes.length&&bytes[k]===0;k++)out+='1';for(let q=digits.length-1;q>=0;q--)out+=alphabet[digits[q]];return out;}
async function send(transaction){
  const provider=walletProvider(); if(!provider)throw new Error('Connect your wallet first');
  transaction.feePayer=state.wallet;
  transaction.recentBlockhash=(await state.connection.getLatestBlockhash('confirmed')).blockhash;

  // Simulate on our own connection first, so a program rejection is reported in
  // our words. A transaction that reaches the wallet and fails there comes back
  // as the wallet's own generic "reverted during simulation", which names
  // neither the cause nor the fix.
  let simulation=null;
  try{simulation=await state.connection.simulateTransaction(transaction);}
  catch{/* An RPC hiccup is not a verdict; fall through and let the wallet try. */}
  if(simulation?.value?.err){
    const code=simulation.value.err?.InstructionError?.[1]?.Custom;
    const name=code!=null?escrow.ERRORS[code]:null;
    throw new Error(name?(escrow.ERROR_HELP[name]||`The program rejected this: ${name}.`):`The network rejected this transaction: ${JSON.stringify(simulation.value.err)}`);
  }

  // Wallets that sign and send in one step keep their own network scope aligned
  // with the chain we ask for; wallets that only sign leave submission to us.
  if(typeof provider.signAndSendTransaction==='function'){
    const sig=await provider.signAndSendTransaction(transaction);
    await state.connection.confirmTransaction(sig,'confirmed');
    return sig;
  }
  const signed=await provider.signTransaction(transaction);
  const sig=await state.connection.sendRawTransaction(signed.serialize(),{skipPreflight:false,maxRetries:3});
  await state.connection.confirmTransaction(sig,'confirmed');
  return sig;
}
async function refresh(){
  state.metadata=await api('/api/commissions'); const meta=new Map(state.metadata.map(m=>[m.address,m]));
  const accounts=await state.connection.getProgramAccounts(new PublicKey(state.config.programId),{commitment:'confirmed',filters:[{dataSize:escrow.COMMISSION_ACCOUNT_BYTES},{memcmp:{offset:0,bytes:'3'}}]});
  state.projects=accounts.map(({pubkey,account})=>({address:pubkey.toBase58(),...escrow.decodeCommission(account.data),meta:meta.get(pubkey.toBase58())})).filter(project=>project.meta).sort((a,b)=>b.meta.createdAt-a.meta.createdAt); render();
}
function currentWallet(){return state.wallet?.toBase58();}
function render(){
  document.documentElement.dataset.theme=state.theme; $('themeLabel').textContent=state.theme==='light'?'Dark':'Light';
  const wallet=currentWallet();$('bWallet').textContent=wallet?`${state.walletName||'Wallet'} · ${wallet.slice(0,4)}…${wallet.slice(-4)}`:'Connect wallet';
  $('accountEmpty').style.display=wallet?'none':'block';$('accountCard').classList.toggle('on',!!wallet);
  if(wallet){$('wAlias').textContent=walletAlias(wallet);$('wAddress').textContent=wallet;const auth=$('wAuth');if(state.authStatus==='authenticated'){auth.className='account-state signed';auth.innerHTML='<span>✓ Signed in to GitStarter</span>';}else if(state.authStatus==='signing'){auth.className='account-state';auth.innerHTML='<span>Waiting for signature…</span>';}else{auth.className='account-state';auth.innerHTML='<span>Wallet connected</span><button class="btn primary" id="bFinishAuth" type="button">Finish sign-in</button>';}}
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
  if(wallet)loadBalance();
}
async function loadBalance(){try{const lamports=await state.connection.getBalance(state.wallet);$('wBal').textContent=fmtBase(lamports)+' SOL';}catch{$('wBal').textContent='— SOL';}}
function row(p){const ui=STATUS_UI[p.status]||STATUS_UI.refunded,m=p.meta||{},percent=p.goal?Math.min(100,p.pledged/p.goal*100):0,labels=Array.isArray(m.labels)?m.labels:[];let cursor=0;const segments=p.milestoneBps.map((bps,index)=>{const start=cursor;cursor+=bps/100;const fill=Math.max(0,Math.min(100,(percent-start)/(bps/100)*100));return `<span class="milestone-segment" style="width:${bps/100}%"><span class="milestone-fill ${ui.cls}" style="display:block;width:${fill}%"></span></span>`;}).join('');return `<div class="Box-row" data-id="${p.address}" style="cursor:pointer"><div class="row-status">${statusIcon(ui)}</div><div class="row-main"><div class="row-title"><span style="color:var(--fg);font-weight:600;font-size:16px">${esc(m.title||'Unindexed commission')}</span><span class="lbl ${ui.cls}">${esc(ui.detail)}</span>${labels.map(label=>`<span class="lbl gray">${esc(label)}</span>`).join('')}</div><div class="row-meta"><span class="mono">${p.address.slice(0,8)}…</span><span>created by ${p.creator.slice(0,6)}…</span><span>·</span><span>${esc(m.license||'metadata pending')}</span><span>·</span><span>${p.milestoneCount} milestones</span></div><div class="milestone-track" aria-label="${percent.toFixed(1)}% funded across ${p.milestoneCount} milestones">${segments}</div></div><div class="row-right"><span class="amt">${fmtBase(p.pledged)} <span class="of">/ ${fmtBase(p.goal)} SOL</span></span><span class="hint">${p.pledgerCount} ${p.pledgerCount===1?'backer':'backers'}</span></div></div>`;}
function closeDialog(){$('overlay').classList.remove('on');$('dlg').className='dlg';$('dlg').innerHTML='';}
function openProject(address){
  const p=state.projects.find(x=>x.address===address);if(!p)return;
  const m=p.meta||{},wallet=currentWallet(),ui=STATUS_UI[p.status]||STATUS_UI.refunded;
  let actions='';
  if(p.status==='funding'&&wallet)actions=`<div class="field"><label for="pledgeAmount">Pledge amount</label><input id="pledgeAmount" type="number" min="0.000001" step="0.000001" placeholder="0.00"><div class="hint">Amount in SOL. Your wallet will confirm the escrow transaction.</div></div><div class="action-row"><button class="btn primary lg" data-action="pledge" data-id="${p.address}">Pledge SOL</button></div>`;
  if(p.status==='funded'&&wallet===p.creator&&!p.pendingAgent)actions=`<div class="field"><label for="agentWallet">Agent wallet address</label><input id="agentWallet" type="text" placeholder="Solana address"><div class="hint">The nominated wallet must separately accept the contract.</div></div><div class="action-row"><button class="btn primary" data-action="nominate" data-id="${p.address}">Nominate agent</button></div>`;
  if(p.status==='funded'&&p.pendingAgent&&wallet===p.pendingAgent)actions=`<div class="action-row"><button class="btn primary lg" data-action="accept" data-id="${p.address}">Accept contract</button></div>`;
  if(p.status==='funded'&&p.pendingAgent&&wallet!==p.pendingAgent)actions=`<p class="hint">Waiting for <span class="mono">${esc(p.pendingAgent)}</span> to accept.</p>${wallet===p.creator?`<div class="action-row" style="margin-top:12px"><button class="btn" data-action="revoke" data-id="${p.address}">Withdraw nomination</button></div><p class="hint" style="margin-top:8px">Frees the commission so you can nominate someone else. Only possible while the nomination is unaccepted.</p>`:''}`;
  if(p.status==='building'&&wallet===p.creator){
    const sub=p.submission, matured=escrow.reviewExpired(p);
    actions=(sub?`<div class="flash-inline" style="margin-bottom:12px"><b>Delivery submitted</b> for milestone ${sub.milestoneIndex+1} on ${new Date(sub.submittedAt*1000).toLocaleString()}.<br><span class="mono" style="font-size:12px">${esc(sub.evidenceHash.slice(0,16))}…</span><br>${matured?'The review window has passed, so this milestone can now be released by anyone.':`Review ends ${new Date(sub.reviewEndsAt*1000).toLocaleString()} — if you do nothing, it releases automatically.`}</div>`:'')
      +`<div class="action-row">${p.milestoneBps.map((bps,i)=>`<button class="btn ${sub&&sub.milestoneIndex===i?'primary':''}" data-action="release" data-index="${i}" data-id="${p.address}" ${p.milestonesDone&(1<<i)?'disabled':''}>${p.milestonesDone&(1<<i)?'Released':'Release'} milestone ${i+1} · ${bps/100}%</button>`).join('')}</div>`
      +(sub&&!matured?`<div class="action-row" style="margin-top:8px"><button class="btn danger" data-action="reject" data-id="${p.address}">Reject this delivery</button></div><p class="hint" style="margin-top:8px">Rejecting is recorded on chain against your address and stops the automatic release. It also ends this agent's contract and returns the commission to the pool, so you can hire someone else \u2014 including the same agent again. The delivery clock keeps running.<br><br>Because work was delivered, the 1% connection fee now applies however this commission settles. Refusing costs you exactly what approving costs, so decide on the work.</p>`:'')
      +`<p class="hint" style="margin-top:12px">Releasing pays the agent immediately and cannot be undone.${p.submissions?' A delivery has been made, so the 1% connection fee applies whether this settles by release or by refund.':''}</p>`;
  }
  if(p.status==='building'&&wallet===p.agent){
    const sub=p.submission, matured=escrow.reviewExpired(p), overdue=Math.floor(Date.now()/1000)>=p.deliveryDeadline;
    const unreleased=p.milestoneBps.map((_,i)=>i).filter(i=>!(p.milestonesDone&(1<<i)));
    actions=sub
      ? `<div class="flash-inline"><b>Delivery submitted</b> for milestone ${sub.milestoneIndex+1}.<br>${matured?'The review window has passed — this milestone can now be released by anyone, including you.':`Awaiting review until ${new Date(sub.reviewEndsAt*1000).toLocaleString()}. If the creator says nothing, it pays out automatically. If they reject, your contract ends and the commission returns to the pool \u2014 you can be nominated again.`}</div>`
        +(matured?`<div class="action-row" style="margin-top:12px"><button class="btn primary lg" data-action="release" data-index="${sub.milestoneIndex}" data-id="${p.address}">Claim milestone ${sub.milestoneIndex+1}</button></div>`:'')
      : overdue
        ? `<p class="hint">Your delivery window closed on ${new Date(p.deliveryDeadline*1000).toLocaleString()}. The escrow is now refundable to backers.</p>`
        : `<div class="field"><label for="deliveryEvidence">Delivery evidence</label><input id="deliveryEvidence" type="text" placeholder="Commit URL, PR link, or artifact hash"><div class="hint">Only a hash of this is stored on chain, never the text.</div></div><div class="action-row">${unreleased.map(i=>`<button class="btn primary" data-action="submit" data-index="${i}" data-id="${p.address}">Submit milestone ${i+1}</button>`).join('')}</div><p class="hint" style="margin-top:8px">Submitting starts a ${Math.round(p.reviewWindow/3600)}-hour review clock. If the creator neither releases nor rejects before it ends, anyone can release your payment \u2014 including you. Claim within 24 hours of it maturing; after that the escrow reopens to refunds.</p>`;
    actions+=`<div class="action-row" style="margin-top:12px"><button class="btn danger" data-action="cancel" data-id="${p.address}">Return remaining funds and end contract</button></div><p class="hint" style="margin-top:8px">Ends your claim on the ${fmtBase(p.pledged-p.released)} SOL still in escrow. Milestones already released are yours to keep.</p>`;
  }
  if((p.status==='funding'||p.status==='funded')&&wallet===p.creator)actions+=`<div class="action-row" style="margin-top:12px"><button class="btn danger" data-action="cancel" data-id="${p.address}">Cancel commission</button></div>`;
  if(p.status==='refunded'&&wallet)actions=`<div class="action-row"><button class="btn primary" data-action="refund" data-id="${p.address}">Claim available refund</button></div>`;
  if(!wallet)actions='<p class="hint">Connect a wallet to pledge or manage this commission.</p>';
  else if(!actions)actions='<p class="hint">No action is available to this wallet at the current contract stage.</p>';
  $('dlg').className='dlg';
  $('dlg').innerHTML=`<div class="dlg-head"><div class="dlg-head-row"><div class="dlg-head-copy"><h1>${esc(m.title||'Unindexed commission')} <span class="state ${ui.cls}">${esc(ui.label)}</span></h1><div class="sub mono"><a href="${explorerUrl(p.address)}" target="_blank" rel="noopener noreferrer">${p.address} ↗</a></div></div>${closeIcon()}</div></div><div class="project-shell"><main class="project-main"><p class="project-description">${esc(m.description||'This on-chain commission has not been indexed yet.')}</p><h2 class="section-title">Settlement</h2><div class="metric-grid"><div class="metric"><b>${fmtBase(p.pledged)} SOL</b><span>Net pledged</span></div><div class="metric"><b>${fmtBase(p.released)} SOL</b><span>Released</span></div><div class="metric"><b>${fmtBase(p.refunded)} SOL</b><span>Refunded</span></div></div><h2 class="section-title">Actions</h2><div class="action-panel">${actions}</div></main><aside class="project-side"><h2 class="section-title">Contract</h2><ul class="fact-list"><li><span>Network</span><b>${esc(state.config.cluster)}</b></li><li><span>Goal</span><b>${fmtBase(p.goal)} SOL</b></li><li><span>Milestones</span><b>${p.milestoneCount}</b></li><li><span>Protocol fee</span><b>1% once work is delivered · pledges free</b></li><li><span>Escrow program</span><b><a href="${explorerUrl(state.config.programId)}" target="_blank" rel="noopener noreferrer" class="mono">${state.config.programId.slice(0,8)}…${state.config.programId.slice(-4)} ↗</a></b></li><li><span>Deadline</span><b>${new Date(p.deadline*1000).toLocaleString()}</b></li><li><span>Creator</span><b class="mono">${p.creator}</b></li>${safeHttpUrl(m.repositoryUrl)?`<li><span>Repository</span><b><a href="${esc(safeHttpUrl(m.repositoryUrl))}" target="_blank" rel="noopener noreferrer">Open repository ↗</a></b></li>`:''}</ul></aside></div>`;
  $('overlay').classList.add('on');
}
async function openCreate(){
  if(!await requireSession())return;
  // The picker itself is constrained to the window the program will accept, so
  // an illegal deadline cannot be chosen in the first place. A value that only
  // fails on chain surfaces as the wallet's own opaque "reverted during
  // simulation", which tells the user nothing at all.
  const pad=n=>String(n).padStart(2,'0');
  const asLocalInput=date=>`${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const nowMs=Date.now();
  const deadlineDefault=asLocalInput(new Date(nowMs+14*86400000));
  const deadlineMin=asLocalInput(new Date(nowMs+3600000));
  const deadlineMax=asLocalInput(new Date(nowMs+escrow.MAX_FUNDING_DURATION_SECONDS*1000));
  $('dlg').className='dlg dlg-create';
  $('dlg').innerHTML=`<div class="dlg-head"><div class="dlg-head-row"><div class="dlg-head-copy"><h1>Create a commission</h1><div class="sub">Define the work, funding target, and release schedule on Solana ${esc(state.config.cluster)}.</div></div>${closeIcon()}</div></div><div class="form-section"><h2>Commission details</h2><p>Give backers a precise description of what will be delivered.</p><div class="field"><label for="nTitle">Title</label><input id="nTitle" type="text" maxlength="120" placeholder="A concise outcome"></div><div class="field"><label for="nDescription">Description</label><textarea id="nDescription" placeholder="Scope, acceptance criteria, and expected deliverables"></textarea></div><div class="grid2"><div class="field"><label for="nRepo">Repository URL <span class="hint">optional</span></label><input id="nRepo" type="text" placeholder="https://github.com/owner/repo"></div><div class="field"><label for="nLicense">License</label><input id="nLicense" type="text" value="MIT"></div></div><div class="field"><label for="nLabels">Labels <span class="hint">optional</span></label><input id="nLabels" type="text" placeholder="cli, media, typescript"><div class="hint">Comma-separated. Labels become live filters on the commission list.</div></div></div><div class="form-section"><h2>Funding and delivery</h2><p>Funds remain in program-controlled escrow until milestones are released or refunded.</p><div class="grid2"><div class="field"><label for="nGoal">Funding goal (SOL)</label><input id="nGoal" type="number" min="0.000001" step="0.000001" placeholder="1000"></div><div class="field"><label for="nDeadline">Funding deadline</label><input id="nDeadline" type="datetime-local" value="${deadlineDefault}" min="${deadlineMin}" max="${deadlineMax}"><div class="hint">Funding must close within ${escrow.MAX_FUNDING_DURATION_SECONDS/86400} days. Defaults to 14 days from now.</div></div></div><div class="grid2"><div class="field"><label for="nDelivery">Delivery window (days)</label><input id="nDelivery" type="number" min="1" max="30" step="1" value="3"><div class="hint">How long the agent has once they accept. The clock starts at acceptance, not now.</div></div><div class="field"><label for="nReview">Review window (hours)</label><input id="nReview" type="number" min="1" max="336" step="1" value="48"><div class="hint">After a delivery is submitted you have this long to release or reject it. Say nothing and it pays out automatically.</div></div></div><div class="field"><label for="nMilestones">Milestone percentages</label><input id="nMilestones" type="text" value="25,40,20,15"><div class="hint">Comma-separated percentages. They must total 100.</div></div></div><div class="dlg-footer"><span class="hint">Your wallet will confirm the on-chain creation transaction.</span><button class="btn" type="button" id="bX">Cancel</button><button class="btn primary lg" id="doCreate">Create and sign</button></div>`;
  $('overlay').classList.add('on');
}
async function createCommission(){
  const title=$('nTitle').value.trim(),description=$('nDescription').value.trim(),goal=Math.round(Number($('nGoal').value)*LAMPORTS_PER_SOL),deadline=Math.floor(new Date($('nDeadline').value).getTime()/1000),percentages=$('nMilestones').value.split(',').map(Number),deliveryDays=Number($('nDelivery').value||3),reviewHours=Number($('nReview').value||48);if(!title||!description||!goal||!deadline||percentages.some(x=>!x)||percentages.reduce((a,b)=>a+b,0)!==100)throw new Error('Complete all fields; milestones must sum to 100');
  const seed=Date.now();
  // Every bound the program enforces is checked here, in the same terms and from
  // the same constants. Anything that reaches the chain and is rejected there
  // reaches the user as the wallet's generic simulation failure instead of a
  // sentence telling them what to change.
  const nowUnix=Math.floor(Date.now()/1000);
  const maxFundingDays=escrow.MAX_FUNDING_DURATION_SECONDS/86400;
  if(!Number.isFinite(deadline))throw new Error('Choose a funding deadline.');
  if(deadline<=nowUnix)throw new Error('The funding deadline must be in the future.');
  if(deadline>nowUnix+escrow.MAX_FUNDING_DURATION_SECONDS)throw new Error(`Funding must close within ${maxFundingDays} days. Choose an earlier deadline.`);
  if(goal<escrow.BPS_DENOMINATOR)throw new Error(`The funding goal must be at least ${escrow.BPS_DENOMINATOR/LAMPORTS_PER_SOL} SOL.`);
  if(percentages.length>escrow.MAX_MILESTONES)throw new Error(`Use at most ${escrow.MAX_MILESTONES} milestones.`);
  if(!(deliveryDays>=1&&deliveryDays<=escrow.MAX_DELIVERY_WINDOW_SECONDS/86400))throw new Error(`Delivery window must be between 1 and ${escrow.MAX_DELIVERY_WINDOW_SECONDS/86400} days.`);
  if(!(reviewHours>=1&&reviewHours<=escrow.MAX_REVIEW_WINDOW_SECONDS/3600))throw new Error(`Review window must be between 1 and ${escrow.MAX_REVIEW_WINDOW_SECONDS/3600} hours.`);
  const {commission,instruction}=escrow.build.createCommission(ESCROW_CTX,{creator:state.wallet,seed,goalLamports:goal,milestoneBasisPoints:percentages.map(x=>x*100),deadlineUnix:deadline,deliveryWindowSeconds:Math.round(deliveryDays*86400),reviewWindowSeconds:Math.round(reviewHours*3600)});const signature=await send(new Transaction().add(instruction));await api('/api/commissions',{method:'POST',body:JSON.stringify({address:commission.toBase58(),txSignature:signature,title,description,repositoryUrl:$('nRepo').value.trim()||null,license:$('nLicense').value.trim()||'MIT',labels:$('nLabels').value.split(',').map(value=>value.trim().toLowerCase()).filter(Boolean).slice(0,8)})});closeDialog();await refresh();}
async function pledge(address){const amountLamports=Math.round(Number($('pledgeAmount').value)*LAMPORTS_PER_SOL);if(!amountLamports)throw new Error('Enter a pledge amount');const {instruction}=escrow.build.pledge(ESCROW_CTX,{backer:state.wallet,commission:address,amountLamports});await send(new Transaction().add(instruction));closeDialog();await refresh();}
async function simpleAction(action,address,index){
  const p=state.projects.find(x=>x.address===address);let built;
  if(action==='nominate')built=escrow.build.selectAgent(ESCROW_CTX,{creator:state.wallet,commission:address,agent:$('agentWallet').value.trim()});
  else if(action==='revoke')built=escrow.build.revokeAgent(ESCROW_CTX,{creator:state.wallet,commission:address});
  else if(action==='accept')built=escrow.build.acceptAgent(ESCROW_CTX,{agent:state.wallet,commission:address});
  else if(action==='cancel')built=escrow.build.cancel(ESCROW_CTX,{signer:state.wallet,commission:address});
  else if(action==='release')built=escrow.build.releaseMilestone(ESCROW_CTX,{creator:state.wallet,commission:address,agent:p.agent,milestoneIndex:Number(index)});
  else if(action==='refund')built=escrow.build.refund(ESCROW_CTX,{backer:state.wallet,commission:address});
  else if(action==='submit'){
    const evidence=($('deliveryEvidence')?.value||'').trim();
    if(!evidence)throw new Error('Describe what you delivered: a commit URL, a PR link, or an artifact hash.');
    // The chain stores a commitment, never the text itself.
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(evidence));
    built=escrow.build.submitDelivery(ESCROW_CTX,{agent:state.wallet,commission:address,milestoneIndex:Number(index)||0,evidenceHash:Buffer.from(new Uint8Array(digest))});
  }
  else if(action==='reject')built=escrow.build.rejectDelivery(ESCROW_CTX,{creator:state.wallet,commission:address});
  else throw new Error(`Unknown action: ${action}`);
  await send(new Transaction().add(built.instruction));closeDialog();await refresh();}
// Maps EscrowError discriminants to language a user can act on. Anchoring these
// to the numbers the program actually returns keeps a rejected transaction from
// surfacing as an opaque "custom program error: 0x18".
function friendlyWalletError(error){const message=error?.message||String(error);
  const chain=escrow.explainError(error);
  if(chain&&chain.name!=='Unknown')return chain.message;
  if(/already pending|wallet_requestPermissions/i.test(message))return 'A MetaMask request is already open. Complete it in the extension, then select Finish sign-in.';
  if(error?.code===4001||/user rejected|User rejected/i.test(message))return 'The wallet request was cancelled.';
  if(/insufficient lamports|insufficient funds/i.test(message))return 'That wallet does not hold enough SOL for this transaction plus fees.';
  return message;}
function showToast(message){const t=$('toast');t.textContent=message;t.classList.add('on');setTimeout(()=>t.classList.remove('on'),6000);}
function showNotice(message){showToast(message);}
function showError(error){console.error(error);showToast(friendlyWalletError(error));}
document.addEventListener('click',e=>{const t=e.target.closest('button,[data-id]');if(!t)return;if(t.id==='bWallet')openWalletModal();else if(t.dataset.wallet)connectWallet(t.dataset.wallet).catch(showError);else if(t.id==='bTheme'){state.theme=state.theme==='light'?'dark':'light';localStorage.setItem('gitstarter.theme',state.theme);render();}else if(t.id==='bNew')openCreate().catch(showError);else if(t.id==='bFinishAuth')authenticate().catch(showError);else if(t.id==='bX'||t.id==='overlay')closeDialog();else if(t.id==='doCreate')createCommission().catch(showError);else if(t.dataset.f){state.filter=t.dataset.f;render();}else if(t.dataset.label){state.label=t.dataset.label;render();}else if(t.dataset.action==='pledge')pledge(t.dataset.id).catch(showError);else if(t.dataset.action)simpleAction(t.dataset.action,t.dataset.id,t.dataset.index).catch(showError);else if(t.dataset.id)openProject(t.dataset.id);});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&$('overlay').classList.contains('on'))closeDialog();});
$('q').addEventListener('input',render);
document.addEventListener('change',event=>{if(event.target.id==='sortSelect'){state.sort=event.target.value;render();}});
(async()=>{try{
  state.config=verifyConfig(await api('/api/config'));
  state.connection=new web3.Connection(state.config.rpcUrl,'confirmed');
  // Restore the session BEFORE scanning the chain. The scan takes seconds on a
  // phone, and running it first left a returning user looking anonymous for
  // that whole window — long enough to tap New commission and be told to
  // connect a wallet they were already signed in with.
  await restoreSession();
  await refresh();
}catch(e){showError(e);}})();
