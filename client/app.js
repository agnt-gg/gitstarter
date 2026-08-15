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
const state = { config:null, connection:null, wallet:null, walletName:null, provider:null, session:null, sessionWallet:null, authStatus:'disconnected', connecting:false, metadata:[], projects:[], activity:null, profile:null, profileId:null, myHandle:null, inbox:null, agents:null, filter:'all', label:'all', sort:'newest', theme:localStorage.getItem('gitstarter.theme')||'light',
  // Address of the commission whose dialog is open, so a live update can redraw
  // it; the websocket subscription id; and the newest slot we have proof of, so
  // no read can hand back state older than our own confirmed transaction.
  openProject:null, subscription:null, minContextSlot:0 };
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
  programId:'HYrwoRKRdPDpuwTHAv3BzbdGXtTVrMe6vzBFefX8RiH4',
  configPda:'E7tHZCvZWB6fQLwZA6KCipgJszjPn4ZTzSUdZC1XX4x2',
  treasuryWallet:'6RehrefK9bq2U8dJse96GjGGHm8t6mznxGR1Qj2e1A5P',
  cluster:'mainnet-beta',
  // Every host in RPC_POOL must be listed here so verifyConfig accepts any of
  // them; a hostile server pointing the browser at a fake RPC would be caught
  // by rejecting hosts NOT in this set. Add a pool member here first, or the
  // client refuses to boot.
  rpcHosts:['solana-rpc.publicnode.com','rpc.ankr.com','solana-mainnet.g.alchemy.com','api.mainnet-beta.solana.com']
};

// The failover pool.
//
// Every free Solana RPC will 504, rate-limit, or Cloudflare-timeout eventually.
// A wallet app cannot be one bad node away from broken, so calls rotate through
// this pool: on failure the client bumps the index and the next call tries the
// next endpoint. web3.js caches connections per URL, so keeping four objects
// means four persistent WSS subscriptions kept warm and ready to take over.
//
// Ordered from measurement: publicnode is fastest and CORS-open from most
// regions but 504s intermittently through Cloudflare. Ankr, Alchemy and Solana
// Labs are the fallbacks; some of them 403/429 browser Origin headers, and
// that is exactly the point of having four.
const RPC_POOL=[
  'https://solana-rpc.publicnode.com',
  'https://rpc.ankr.com/solana',
  'https://solana-mainnet.g.alchemy.com/v2/demo',
  'https://api.mainnet-beta.solana.com'
];
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
  funding:{label:'Raising',detail:'Open for pledges',cls:'blue',icon:'circle'}, funded:{label:'Open for work',detail:'Funded — any agent may deliver',cls:'green',icon:'play'}, shipped:{label:'Delivered',detail:'Delivered and paid',cls:'purple',icon:'check'}, refunded:{label:'Closed',detail:'Closed — refundable',cls:'gray',icon:'x'}
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
  // The network key must match the cluster this build is actually on. This was
  // hardcoded `devnet:` from the devnet era, which registered the MAINNET RPC
  // url under the devnet scope — mislabelling every SDK-side lookup even though
  // signing itself was saved by the explicit CAIP chain id below.
  const networkKey=state.config?.cluster==='mainnet-beta'?'mainnet':'devnet';
  const client=await createSolanaClient({dapp:{name:'GitStarter',url:window.location.origin},api:{supportedNetworks:{[networkKey]:state.config.rpcUrl}},analytics:{enabled:false}});
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
  $('dlg').innerHTML=`<div class="dlg-head"><div class="dlg-head-row"><div class="dlg-head-copy"><h1>Connect wallet</h1><div class="sub">Choose a Solana wallet to continue on ${esc(state.config?.cluster||'mainnet-beta')}.</div></div>${closeIcon()}</div></div><div class="dlg-content"><div class="wallet-list">${rows}</div><div class="security-note"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0c.69 0 1.25.56 1.25 1.25V2h1A2.75 2.75 0 0 1 13 4.75v2.086c.916.355 1.5 1.18 1.5 2.164v4.5A2.5 2.5 0 0 1 12 16H4a2.5 2.5 0 0 1-2.5-2.5V9c0-.984.584-1.81 1.5-2.164V4.75A2.75 2.75 0 0 1 5.75 2h1v-.75C6.75.56 7.31 0 8 0Zm-2.25 3.5c-.69 0-1.25.56-1.25 1.25V6.5h7V4.75c0-.69-.56-1.25-1.25-1.25h-4.5ZM4 8a1 1 0 0 0-1 1v4.5A1 1 0 0 0 4 14.5h8a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1H4Z"/></svg><span>GitStarter never sees your recovery phrase or private keys. Your wallet asks for approval before every signature.</span></div></div>`;
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
    // Signing in is the moment somebody has decided to take part. Asking who
    // they are here, once, is a step in that flow rather than an interruption.
    offerNameOnce().catch(()=>{});
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
// Rotate through the RPC pool on failure.
//
// A 504 from Cloudflare comes with retry-after 120, meaning the endpoint is
// asking us NOT to hammer it. The only useful action is to try somewhere else.
// This helper bumps the pool pointer and points state.connection at the next
// member, so every subsequent call — including the next iteration of a polling
// loop — automatically goes to a different endpoint.
function rotateRpcPool(){
  state.connectionIndex=(state.connectionIndex+1)%state.connections.length;
  state.connection=state.connections[state.connectionIndex];
}

// Try each pool member in order until one succeeds, or all fail.
//
// Only transient errors (5xx, 429, timeout, "fetch failed") trigger a rotation.
// Program rejections and other 4xx come from Solana itself, not the RPC, and
// have to be surfaced to the caller as-is.
async function callWithFailover(method,...args){
  const start=state.connectionIndex;
  let lastErr;
  for(let attempt=0;attempt<state.connections.length;attempt++){
    try{return await state.connection[method](...args);}
    catch(e){
      lastErr=e;
      const status=e?.response?.status||e?.status;
      const transient=status>=500||status===429||e?.name==='AbortError'||
        /fetch failed|timeout|504|502|503|Gateway|Failed to fetch|network|ECONN|ETIMEDOUT/i.test(String(e?.message||''));
      if(!transient)throw e;
      rotateRpcPool();
      if(state.connectionIndex===start)throw lastErr;
    }
  }
  throw lastErr;
}

async function send(transaction,onStage=()=>{}){
  const provider=walletProvider(); if(!provider)throw new Error('Connect your wallet first');
  transaction.feePayer=state.wallet;
  transaction.recentBlockhash=(await callWithFailover('getLatestBlockhash','confirmed')).blockhash;

  // Simulate on our own connection first, so a program rejection is reported in
  // our words. A transaction that reaches the wallet and fails there comes back
  // as the wallet's own generic "reverted during simulation", which names
  // neither the cause nor the fix.
  let simulation=null;
  try{simulation=await callWithFailover('simulateTransaction',transaction);}
  catch{/* An RPC hiccup is not a verdict; fall through and let the wallet try. */}
  if(simulation?.value?.err){
    const code=simulation.value.err?.InstructionError?.[1]?.Custom;
    const name=code!=null?escrow.ERRORS[code]:null;
    throw new Error(name?(escrow.ERROR_HELP[name]||`The program rejected this: ${name}.`):`The network rejected this transaction: ${JSON.stringify(simulation.value.err)}`);
  }

  // Wallets that sign and send in one step keep their own network scope aligned
  // with the chain we ask for; wallets that only sign leave submission to us.
  onStage('Approve in your wallet\u2026');
  let sig;
  if(typeof provider.signAndSendTransaction==='function'){
    sig=await provider.signAndSendTransaction(transaction);
  }else{
    const signed=await provider.signTransaction(transaction);
    sig=await callWithFailover('sendRawTransaction',signed.serialize(),{skipPreflight:false,maxRetries:3});
  }
  onStage('Confirming on Solana\u2026');

  // Poll getSignatureStatuses instead of subscribing over WebSocket.
  //
  // publicnode.com's HTTP RPC is fast and CORS-friendly, but its WSS accepts
  // signatureSubscribe connections and NEVER replies — connections just hang
  // for 60 seconds until web3.js gives up. In DevTools that reads as "pending
  // forever", which is the exact symptom that made a claimed handle look
  // broken even though the transaction had already landed on chain.
  //
  // Polling every 1.5s costs one small HTTP call per second, keeps the RPC
  // pool consistent with everything else the client does, and lets us give the
  // user honest progress instead of a spinner that means nothing.
  const deadline=Date.now()+60_000;
  let status=null;
  while(Date.now()<deadline){
    await new Promise(r=>setTimeout(r,1500));
    const res=await callWithFailover('getSignatureStatuses',[sig]);
    status=res.value?.[0];
    if(status?.err)throw new Error(`The network rejected this transaction: ${JSON.stringify(status.err)}`);
    if(status?.confirmationStatus==='confirmed'||status?.confirmationStatus==='finalized')break;
  }
  if(!status?.confirmationStatus){
    throw new Error('The transaction did not confirm within a minute. It may still land \u2014 check your wallet history before retrying, so you do not pay twice.');
  }

  // Remember the slot that confirmed us. Pinning subsequent reads to this slot
  // makes a stale node in the RPC pool say so instead of quietly answering with
  // old state — a pledge could otherwise confirm and still show as unfunded.
  if(status.slot)state.minContextSlot=Math.max(state.minContextSlot||0,status.slot);
  return sig;
}

/// Reads every commission account.
///
/// This scan CANNOT be pinned to a slot: `getProgramAccounts` accepts a
/// `minContextSlot` and silently ignores it, verified against devnet by asking
/// for a slot a hundred thousand ahead of the tip and being answered anyway.
/// So the bulk list may lag by a slot or two, and anything we have just changed
/// ourselves is reconciled separately by `reconcile`, which uses a read that
/// does honour the pin.
async function readCommissionAccounts(){
  return state.connection.getProgramAccounts(new PublicKey(state.config.programId),{
    commitment:'confirmed',
    filters:[{dataSize:escrow.COMMISSION_ACCOUNT_BYTES},{memcmp:{offset:0,bytes:'3'}}],
  });
}

/// Brings one commission up to date, refusing any node older than the slot our
/// own transaction confirmed in.
///
/// `getAccountInfo` does honour `minContextSlot`, so a node that has not caught
/// up errors rather than answering with stale state. That is the whole fix for
/// "I pledged, it confirmed, and the page still said unfunded until I reloaded":
/// the confirmation and the read were being served by different nodes.
async function reconcile(address){
  if(!address||!state.connection)return;
  const key=new PublicKey(address);
  const options=state.minContextSlot
    ?{commitment:'confirmed',minContextSlot:state.minContextSlot}
    :{commitment:'confirmed'};
  for(let attempt=0;attempt<12;attempt++){
    try{
      const info=await state.connection.getAccountInfo(key,options);
      if(info?.data){applyLiveUpdate(address,info.data);return;}
    }catch{/* Behind our slot, or a transient RPC failure. Both mean: ask again. */}
    await sleep(300);
  }
}
/// Best available "when did this appear" for ordering the board.
///
/// Commissions indexed here carry a real timestamp. One created directly on
/// chain carries none — the program stores no creation time — so fall back to
/// the seed, which every client of ours sets to `Date.now()`. A third party is
/// free to pick any seed, so this is only trusted when it actually looks like a
/// recent millisecond timestamp; anything else sorts last rather than pretending
/// to a position it cannot justify.
function listedAt(project){
  if(project.meta?.createdAt)return project.meta.createdAt;
  const plausible=project.seed>1_577_836_800_000&&project.seed<Date.now()+86_400_000;
  return plausible?project.seed:0;
}

/// Turns raw program accounts into the board, newest first.
///
/// THE CHAIN IS THE BOARD: every commission that exists on chain is listed,
/// described or not.
///
/// This used to require a metadata row, which meant a funded bounty was
/// invisible here until its creator's browser had posted a title to our
/// database. On a job board that is exactly backwards — an agent scanning the
/// program finds the work regardless, so hiding it only made this page wrong
/// about what was available. A commission with no description still has real
/// escrow behind it and can still be delivered.
function projectCommissions(accounts,metaByAddress){
  return accounts.map(({pubkey,account})=>{
    const address=typeof pubkey==='string'?pubkey:pubkey.toBase58();
    // A layout we cannot read is skipped, never fatal: one stale account from an
    // earlier version of the program must not blank the whole board.
    try{return {address,...escrow.decodeCommission(account.data),meta:metaByAddress.get(address)};}
    catch{return null;}
  }).filter(Boolean).sort((a,b)=>listedAt(b)-listedAt(a));
}

async function refresh(){
  state.metadata=await api('/api/commissions'); const meta=new Map(state.metadata.map(m=>[m.address,m]));
  state.projects=projectCommissions(await readCommissionAccounts(),meta);
  render();
  // Fire and forget: the board must never wait on a personal view, and this
  // re-renders itself when it lands.
  Promise.all([loadActivity(),loadMyIdentity(),loadInbox()]).then(render).catch(()=>{});
  subscribeToCommissions();
}

// ── live updates ─────────────────────────────────────────────────────────────
//
// One websocket subscription, pushed by the RPC node whenever any commission
// account changes. It costs nothing per update and needs no polling loop, and it
// covers other people's activity too: a backer's pledge or an agent's delivery
// appears without anyone reloading.
function subscribeToCommissions(){
  if(state.subscription!=null||!state.connection)return;
  try{
    state.subscription=state.connection.onProgramAccountChange(
      new PublicKey(state.config.programId),
      ({accountId,accountInfo})=>applyLiveUpdate(accountId.toBase58(),accountInfo.data),
      'confirmed',
      [{dataSize:escrow.COMMISSION_ACCOUNT_BYTES},{memcmp:{offset:0,bytes:'3'}}],
    );
  }catch{/* Without a websocket the app still works; it just needs a reload. */}
}

/// Tells the user something now needs them, even if the tab is not in front.
///
/// A delivery is the case that matters: the review clock starts the moment it
/// lands, silence pays the agent automatically, and until now the only way to
/// find out was to open the right dialog and look. A creator could be handed
/// finished work and never know.
function announce(project,attention){
  const title=project.meta?.title||'A commission';
  showToast(`${title}: ${attention.label}`);
  // A browser notification reaches a backgrounded tab, which a toast cannot.
  // Permission is only ever requested after the user has acted on a commission
  // themselves, never on page load.
  try{
    if(typeof Notification!=='undefined'&&Notification.permission==='granted'&&document.hidden){
      const note=new Notification(title,{body:`${attention.label}\n${attention.detail}`,tag:project.address});
      note.onclick=()=>{window.focus();openProject(project.address);note.close();};
    }
  }catch{/* Notifications are a courtesy, never a dependency. */}
}

/// Asks for notification permission at the only honest moment: right after the
/// user has done something that means they will be waiting on a counterparty.
function offerNotifications(){
  try{
    if(typeof Notification==='undefined'||Notification.permission!=='default')return;
    if(localStorage.getItem('gitstarter.notify.asked'))return;
    localStorage.setItem('gitstarter.notify.asked','1');
    Notification.requestPermission().catch(()=>{});
  }catch{/* Blocked by policy, or unsupported. Neither is an error. */}
}

let pendingRefresh=null;
function applyLiveUpdate(address,data){
  let decoded;
  try{decoded=escrow.decodeCommission(data);}catch{return;}
  const index=state.projects.findIndex(project=>project.address===address);
  if(index===-1){
    // A commission we have not seen before. Its title lives on the server, so
    // this needs a full pass — debounced, in case several arrive together.
    clearTimeout(pendingRefresh);
    pendingRefresh=setTimeout(()=>{refresh().catch(()=>{});},800);
    return;
  }
  // Compare what this wallet owed before and after, so an update is announced
  // only when it actually changes what the user has to do. Re-announcing an
  // unchanged state on every push is how a notification becomes noise.
  //
  // The key includes the label, not just the kind: a second delivery on a
  // different milestone is still `review`, and keying on the category alone
  // would silently swallow it.
  const key=attention=>attention?`${attention.kind}:${attention.label}`:'';
  const before=key(attentionFor(state.projects[index]));
  state.projects[index]={...state.projects[index],...decoded};
  const after=attentionFor(state.projects[index]);
  if(after&&after.urgency==='act'&&key(after)!==before)announce(state.projects[index],after);
  render();
  // Redraw an open dialog so it tracks the chain, but never while the user is
  // typing into it — replacing the markup would discard what they are entering.
  const editing=/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName||'');
  if(state.openProject===address&&!editing)openProject(address);
}
function currentWallet(){return state.wallet?.toBase58();}
function render(){
  document.documentElement.dataset.theme=state.theme; $('themeLabel').textContent=state.theme==='light'?'Dark':'Light';
  const wallet=currentWallet();$('bWallet').textContent=wallet?`${state.walletName||'Wallet'} · ${wallet.slice(0,4)}…${wallet.slice(-4)}`:'Connect wallet';
  $('accountEmpty').style.display=wallet?'none':'block';$('accountCard').classList.toggle('on',!!wallet);
  // The name this wallet actually chose, not an invented one. This used to show
  // a generated alias like "Amber-Badger-x9k2" that existed only in this
  // browser: nobody else ever saw it, so it read as an identity while being the
  // one label on the page that could not be looked up or trusted by anyone.
  if(wallet){$('wAlias').innerHTML=state.myHandle?`<span class="handle" data-profile="${esc(wallet)}">@${esc(state.myHandle)}</span>`:'<span style="color:var(--fg-muted);font-weight:400">Unnamed wallet</span>';$('wAddress').textContent=wallet;const auth=$('wAuth');if(state.authStatus==='authenticated'){auth.className='account-state signed';auth.innerHTML='<span>✓ Signed in to GitStarter</span>';}else if(state.authStatus==='signing'){auth.className='account-state';auth.innerHTML='<span>Waiting for signature…</span>';}else{auth.className='account-state';auth.innerHTML='<span>Wallet connected</span><button class="btn primary" id="bFinishAuth" type="button">Finish sign-in</button>';}}
  const labels=[...new Set(state.projects.flatMap(p=>Array.isArray(p.meta?.labels)?p.meta.labels:[]))].sort();
  // Anything this wallet is holding up, or being held up by. Computed once and
  // reused by the filter, the counter and the empty state.
  const needsYou=state.projects.filter(p=>attentionFor(p));
  const needsAction=needsYou.filter(p=>attentionFor(p).urgency==='act');
  let visible=state.projects.filter(p=>(state.filter==='needs-you'?!!attentionFor(p):(state.filter==='all'||p.status===state.filter))&&(state.label==='all'||p.meta?.labels?.includes(state.label))&&(!($('q').value)||JSON.stringify(p.meta||{}).toLowerCase().includes($('q').value.toLowerCase())));
  visible=[...visible].sort((a,b)=>state.sort==='funding'?b.pledged-a.pledged:state.sort==='deadline'?a.deadline-b.deadline:(b.meta?.createdAt||0)-(a.meta?.createdAt||0));
  $('unav').innerHTML=[['all','Commissions',{label:'Commissions',cls:'',icon:'book'}],...STATUS.map(s=>[s,STATUS_UI[s].label,STATUS_UI[s]])].map(([f,l,ui])=>`<button data-f="${f}" class="${state.filter===f?'on':''}">${ui.icon==='book'?'<span class="status-glyph"><svg viewBox="0 0 16 16"><path d="'+ICON_PATHS.book+'"></path></svg></span>':statusIcon(ui)}${esc(l)} <span class="counter">${f==='all'?state.projects.length:state.projects.filter(p=>p.status===f).length}</span></button>`).join('')
    // Only shown when there is something to show, so it never becomes furniture
    // the eye learns to skip.
    // A personal view, not a filter of the board: it includes work whose
    // on-chain accounts are gone, which no filter over the board could show.
    +(wallet?`<button data-f="activity" class="needs-you ${state.filter==='activity'?'on':''}">My activity${state.activity?.needsYou?.length?` <span class="counter">${state.activity.needsYou.length}</span>`:''}</button>`:'')
    // Your own profile needs its own way in. It was reachable only by clicking
    // somebody's name on a row — which works for looking up a stranger and is
    // useless for the far more common question, "what does my record look like
    // to the people deciding whether to hire me?"
    +(wallet?`<button data-f="profile" data-profile="${esc(wallet)}" class="needs-you ${state.filter==='profile'&&state.profileId===wallet?'on':''}">My profile${state.myHandle?` <span class="counter">@${esc(state.myHandle)}</span>`:''}</button>`:'')
    // A board you can look somebody up on but never find anybody on is a board
    // where only the already-known get hired.
    +`<button data-f="agents" class="needs-you ${state.filter==='agents'?'on':''}">Agents</button>`
    // Only shown when there is something to show, so it never becomes furniture
    // the eye learns to skip.
    +(needsYou.length?`<button data-f="needs-you" class="needs-you ${state.filter==='needs-you'?'on':''}${needsAction.length?' urgent':''}">Needs you <span class="counter">${needsYou.length}</span></button>`:'');
  const openCount=state.projects.filter(p=>p.status!=='shipped'&&p.status!=='refunded').length,closedCount=state.projects.length-openCount;
  const header=`<div class="Box-header"><div class="list-summary"><span>${statusIcon(STATUS_UI.funding)}<b>${openCount} Open</b></span><span>${statusIcon(STATUS_UI.shipped)}${closedCount} Closed</span></div><div class="list-tools"><label class="hint" for="sortSelect" style="margin:0">Sort</label><select class="tool-select" id="sortSelect"><option value="newest" ${state.sort==='newest'?'selected':''}>Newest</option><option value="funding" ${state.sort==='funding'?'selected':''}>Most funded</option><option value="deadline" ${state.sort==='deadline'?'selected':''}>Deadline</option></select></div></div>`;
  const labelBar=labels.length?`<div class="label-filter"><button class="label-button ${state.label==='all'?'on':''}" data-label="all">All labels</button>${labels.map(label=>`<button class="label-button ${state.label===label?'on':''}" data-label="${esc(label)}">${esc(label)}</button>`).join('')}</div>`:'';
  handleEditor();
  // The badge is the product here: it is what makes an unattended review window
  // something you find out about rather than something that happens to you.
  const bell=$('bInbox'),count=$('inboxCount');
  if(bell){
    bell.style.display=state.authStatus==='authenticated'?'':'none';
    const unread=state.inbox?.unread||0;
    count.textContent=unread>9?'9+':String(unread);
    count.classList.toggle('on',unread>0);
  }
  if(state.filter==='agents'){
    $('listBox').innerHTML=`<div class="Box-header"><div class="list-summary"><span><b>Agents</b></span>`
      +`<input class="search" id="agentQ" type="text" placeholder="Search by name or bio\u2026" style="max-width:220px;border-color:var(--border);color:var(--fg)" value="${esc(state.agentQuery||'')}">`
      +`</div></div>`+agentsView();
    // Re-rendering replaced the field the user is typing into, so put them back
    // where they were rather than dropping the caret on every result.
    if(state.agentFocus){
      const input=$('agentQ');
      if(input){input.focus();input.setSelectionRange(input.value.length,input.value.length);}
    }
    return;
  }
  if(state.filter==='profile'){
    $('listBox').innerHTML=`<div class="Box-header"><div class="list-summary"><span><b>Profile</b></span>`
      +`<button class="btn" data-f="all" type="button">Back to the board</button></div></div>`+profileView();
    return;
  }
  if(state.filter==='activity'){
    $('listBox').innerHTML=`<div class="Box-header"><div class="list-summary"><span><b>My activity</b></span></div></div>`+activityView();
    return;
  }
  $('listBox').innerHTML=header+labelBar+(visible.length?visible.map(row).join(''):state.filter==='needs-you'?'<div class="blank"><h3>Nothing is waiting on you</h3><p>Deliveries, contract offers and expiring clocks appear here the moment they happen.</p></div>':'<div class="blank"><h3>No matching commissions</h3><p>Change the active status, label, search, or create the first real commission.</p></div>');
  const total=state.projects.reduce((s,p)=>s+p.pledged,0), escrow=state.projects.reduce((s,p)=>s+Math.max(0,p.pledged-p.released-p.refunded),0);
  $('sPledged').textContent=fmtBase(total); $('sEsc').textContent=fmtBase(escrow); $('sBurn').textContent=fmtBase(state.projects.reduce((s,p)=>s+p.released,0)); $('sRefund').textContent=fmtBase(state.projects.reduce((s,p)=>s+p.refunded,0)); $('sBackers').textContent=state.projects.reduce((s,p)=>s+p.pledgerCount,0);
  $('wBal').textContent=wallet?'refreshing…':'connect wallet'; $('wProj').textContent=wallet?state.projects.filter(p=>p.creator===wallet).length:'—';
  if(wallet)loadBalance();
}
async function loadBalance(){try{const lamports=await state.connection.getBalance(state.wallet);$('wBal').textContent=fmtBase(lamports)+' SOL';}catch{$('wBal').textContent='— SOL';}}
/// What this wallet is part of, on both sides, past and present.
///
/// Kept separate from the board on purpose. The board answers "what work
/// exists" and is the same for everybody; this answers "what am I part of",
/// which is the question somebody actually arrives with and which no amount of
/// filtering the board can produce — because the things you care about include
/// commissions whose on-chain accounts have already been swept away.
/// Your own name, fetched on its own.
///
/// Deliberately not a side effect of loading the activity view: the account card
/// and the profile tab both name you, and both are on screen before anything
/// else is opened. Deriving it from another view's response meant the page
/// could sit there calling you unnamed while you had a name.
async function loadMyIdentity(){
  const wallet=currentWallet();
  if(!wallet){state.myHandle=null;return;}
  try{state.myHandle=(await api(`/api/v1/profile/${wallet}`)).handle||null;}
  catch{/* an unreachable profile must not stop the board rendering */}
}

async function loadActivity(){
  const wallet=currentWallet();
  if(!wallet){state.activity=null;return;}
  try{
    state.activity=await api(`/api/v1/activity/${wallet}`);
    state.myHandle=state.activity.handles?.[wallet]||null;
  }
  catch(error){console.error(error);state.activity={failed:true};}
}

/// Somebody, as a name and an address together.
///
/// Always both. A handle is a label a wallet put on itself, so showing it alone
/// would let a familiar-looking name stand in for the only thing that actually
/// identifies a counterparty — and the address is what gets paid.
function who(wallet,handles={},{short=true}={}){
  if(!wallet)return '<span class="who">\u2014</span>';
  const handle=handles[wallet];
  const address=short?`${wallet.slice(0,4)}\u2026${wallet.slice(-4)}`:wallet;
  return `<span class="who">`
    +(handle?`<span class="handle" data-profile="${esc(wallet)}">@${esc(handle)}</span>`:'')
    +`<span class="addr mono" data-profile="${esc(wallet)}" title="${esc(wallet)}">${esc(address)}</span></span>`;
}

async function loadProfile(id){
  state.profileId=id; state.profile=null; render();
  try{
    // Identity and reputation are computed separately on purpose: one is what
    // this wallet said about itself, the other is what the chain says about it.
    const [profile,reputation]=await Promise.all([
      api(`/api/v1/profile/${encodeURIComponent(id)}`),
      api(`/api/v1/reputation/${encodeURIComponent(id)}`).catch(()=>null),
    ]);
    state.profile={...profile,reputation};
  }catch(error){state.profile={failed:true,message:error.message};}
  render();
}

function profileView(){
  const p=state.profile;
  if(!p)return '<div class="blank"><h3>Loading\u2026</h3></div>';
  if(p.failed)return `<div class="blank"><h3>No such handle or wallet</h3><p>${esc(p.message||'')}</p></div>`;
  const sol=n=>fmtBase(Math.round((n||0)*LAMPORTS_PER_SOL));
  const rep=p.reputation||{};
  const agent=rep.agent||{}, creator=rep.creator||{};
  const pct=v=>v==null?'\u2014':`${Math.round(v*100)}%`;
  const mine=currentWallet()===p.wallet;

  const head=`<div class="profile-head">`
    +`<h1>${p.handle?`@${esc(p.handle)}`:'Unnamed wallet'}`
    +(mine?'<span class="lbl gray">this is you</span>':'')
    +(mine?'<button class="btn" id="bEditProfile" type="button" style="margin-left:auto">Edit profile</button>':'')+`</h1>`
    +`<div class="addr">${esc(p.wallet)}</div>`
    +(p.bio?`<p class="bio">${esc(p.bio)}</p>`:'')
    +(p.link?`<p class="bio"><a href="${esc(safeHttpUrl(p.link)||'#')}" target="_blank" rel="noopener noreferrer nofollow">${esc(p.link)}</a></p>`:'')
    // Said plainly. A name here is not an endorsement by this service, and
    // somebody deciding whether to trust a stranger with money should know
    // exactly which parts of this page are claims and which are arithmetic.
    +`<p class="profile-caveat">${p.handle?'This name was set by that wallet itself and is not verified by anyone. ':''}`
    +`Everything below is computed from on-chain history and can be recomputed by anyone.</p>`
    +`</div>`;

  const stats=`<div class="activity-totals">`
    +`<div class="metric"><b>${sol(agent.solEarned)} SOL</b><span>Earned from ${agent.won||0} won</span></div>`
    +`<div class="metric"><b>${pct(agent.winRate)}</b><span>Win rate, judged only</span></div>`
    +`<div class="metric"><b>${sol(creator.solReleased)} SOL</b><span>Paid out over ${creator.commissions||0} posted</span></div>`
    +`<div class="metric"><b>${pct(creator.rejectionRate)}</b><span>Refuses delivered work</span></div>`
    +`</div>`;

  const delivered=p.delivered.filter(d=>d.state==='released');
  const open=p.posted.filter(x=>x.openForWork);
  const line=(title,detail,address)=>`<div class="Box-row activity-row" data-id="${esc(address)}" style="cursor:pointer">`
    +`<div class="row-main"><div class="row-title"><span style="color:var(--fg);font-weight:600">${esc(title||'Untitled bounty')}</span></div>`
    +`<div class="row-meta">${detail}</div></div></div>`;

  // On your own profile, the numbers a stranger cannot see: what you have
  // riding on the board right now. Everything below this line is the same view
  // everyone else gets, which is the point — you should be able to read your own
  // record exactly as somebody deciding whether to hire you reads it.
  const a=state.activity;
  const yours=mine&&a&&!a.failed?`<div class="activity-totals">`
    +`<div class="metric"><b>${sol(a.totals.solInEscrow)} SOL</b><span>Escrowed in my bounties</span></div>`
    +`<div class="metric"><b>${a.deliveries.inPlay.length}</b><span>My deliveries awaiting judgement</span></div>`
    +`<div class="metric"><b>${a.posted.open.length}</b><span>My bounties still open</span></div>`
    +`<div class="metric"><b>${a.needsYou.length}</b><span>Waiting on me right now</span></div>`
    +`</div>`
    +(a.needsYou.length?`<div class="activity-section"><h3>Waiting on you <span class="counter">${a.needsYou.length}</span></h3>`
      +a.needsYou.map(item=>activityRow(item,esc(item.attention.detail))).join('')+`</div>`:'')
    :'';

  const publicNote=mine
    ? `<div class="activity-section"><h3>How this reads to everyone else</h3>`
      +`<p class="hint">Everything below is your public record. It is what a creator sees before trusting you with escrow, and what an agent sees before spending compute on your bounty.</p></div>`
    : '';

  // Refusals this wallet handed out that were contested. On the creator's own
  // page, because that is where somebody deciding whether to work for them is
  // actually looking.
  const against=(p.disputesAgainstThem||[]);
  const disputes=against.length?`<div class="activity-section">`
    +`<h3>Contested refusals <span class="counter">${against.length}</span></h3>`
    +`<p class="hint">Work this wallet took delivery of and refused, where the agent disagreed. ${
      against.filter(d=>!d.answered).length?'An unanswered objection is shown as unanswered.':''}</p>`
    +against.map(d=>disputeBlock(d,{canAnswer:mine})).join('')+`</div>`:'';

  return head+stats+yours+publicNote+disputes
    +activitySection('Delivered and paid','',
      delivered.map(d=>line(d.title,`milestone ${d.milestoneNumber} \u00b7 ${sol(d.payoutSol)} SOL \u00b7 ${new Date(d.submittedAt).toLocaleDateString()}`,d.commission)),
      'No completed work yet. That is not a bad signal \u2014 a new wallet has no record, not a poor one.')
    +activitySection('Open for work right now','',
      open.map(x=>line(x.title,`${sol(x.pledgedSol)} SOL escrowed \u00b7 ${x.deliveries} delivered so far`,x.commission)),'')
    +activitySection('Also posted','',
      p.posted.filter(x=>!x.openForWork).map(x=>line(x.title,
        `${x.status} \u00b7 paid ${sol(x.releasedSol)} SOL${x.rejections?` \u00b7 ${x.rejections} refused`:''}`,x.commission)),'')
    +activitySection('Delivered, not paid',
      'Refused, or beaten to it by an earlier delivery.',
      p.delivered.filter(d=>d.state!=='released'&&d.state!=='pending').map(d=>line(d.title,
        `milestone ${d.milestoneNumber} \u00b7 ${d.state==='rejected'?'refused':'somebody delivered first'}`,d.commission)),'');
}

// ── the inbox ─────────────────────────────────────────────────────
//
// The one part of this that has to be visible without opening anything. A
// review window counts down whether or not the page is open, and silence pays
// the agent, so "nobody told me" is a way for a creator to lose money and for an
// agent to leave money sitting unclaimed.

async function loadInbox(){
  if(state.authStatus!=='authenticated'){state.inbox=null;return;}
  try{state.inbox=await api('/api/v1/notifications');}
  catch{/* an inbox that will not load must not stop the board */}
}

function openInbox(){
  const inbox=state.inbox;
  const rows=(inbox?.notifications||[]).map(n=>`<div class="note ${n.read?'':'unread'} ${n.actionable?'act':''}" data-id="${esc(n.commission)}">`
    +`<span class="note-dot"></span><div class="note-body">`
    +`<b>${esc(n.title||'Untitled bounty')}</b>`
    +`<span>${esc(n.body)} \u00b7 ${new Date(n.createdAt).toLocaleString()}</span>`
    +`</div></div>`).join('');
  $('dlg').className='dlg';
  $('dlg').innerHTML=`<div class="dlg-head"><div class="dlg-head-row"><div class="dlg-head-copy">`
    +`<h1>What happened</h1><div class="sub">Anything with a clock or money on it is marked in red.</div>`
    +`</div>${closeIcon()}</div></div>`
    +(rows||'<div class="blank"><h3>Nothing yet</h3><p>You will be told here when work is delivered to you, when a delivery of yours is judged, and when a review window lapses.</p></div>')
    +(inbox?.unread?`<div class="action-row" style="padding:12px 16px"><button class="btn" id="bReadAll" type="button">Mark all as read</button></div>`:'');
  $('overlay').classList.add('on');
  // Reading them is the act of opening this, so clear the badge immediately
  // rather than making it another thing to remember to do.
  if(inbox?.unread)markInboxRead().catch(()=>{});
}

async function markInboxRead(){
  await api('/api/v1/notifications/read',{method:'POST',body:JSON.stringify({})});
  if(state.inbox){state.inbox.unread=0;state.inbox.notifications.forEach(n=>{n.read=true;});}
  render();
}

// ── contesting a refusal ────────────────────────────────────────────

function openDispute(commission,milestoneIndex){
  $('dlg').className='dlg';
  $('dlg').innerHTML=`<div class="dlg-head"><div class="dlg-head-row"><div class="dlg-head-copy">`
    +`<h1>Contest this refusal</h1><div class="sub">Milestone ${Number(milestoneIndex)+1}</div>`
    +`</div>${closeIcon()}</div></div><div class="dlg-content">`
    // Said before they write it, because an agent who expects this to recover
    // the money will be angrier at us than at the refusal.
    +`<p class="profile-caveat">This does not move the escrow and cannot \u2014 money a stranger could freeze by objecting is money no creator would put up. What it does is attach your objection to the creator's public profile, where the next agent deciding whether to work for them will read it.</p>`
    +`<div class="field"><label for="disputeReason">What do you disagree with?</label>`
    +`<textarea id="disputeReason" maxlength="2000" placeholder="Point at the acceptance criteria and what you delivered against them."></textarea></div>`
    +`<div class="action-row"><button class="btn primary" id="doDispute" data-id="${esc(commission)}" data-index="${esc(String(milestoneIndex))}" type="button">Put this on the record</button>`
    +`<button class="btn" id="bX" type="button">Cancel</button></div></div>`;
  $('overlay').classList.add('on');
}

async function submitDispute(commission,milestoneIndex){
  const reason=($('disputeReason')?.value||'').trim();
  if(!reason)throw new Error('Say what you disagree with.');
  await api('/api/v1/disputes',{method:'POST',body:JSON.stringify({commission,milestoneIndex:Number(milestoneIndex),reason})});
  closeDialog();
  showToast('Recorded. It now appears on that creator\u2019s public profile.');
  if(state.filter==='profile')loadProfile(state.profileId).catch(()=>{});
}

function openDisputeReply(commission,milestoneIndex,agent){
  $('dlg').className='dlg';
  $('dlg').innerHTML=`<div class="dlg-head"><div class="dlg-head-row"><div class="dlg-head-copy">`
    +`<h1>Answer this objection</h1><div class="sub">Milestone ${Number(milestoneIndex)+1}</div>`
    +`</div>${closeIcon()}</div></div><div class="dlg-content">`
    +`<p class="profile-caveat">Your answer sits next to their objection on your profile. Saying nothing is also shown, so this is worth answering.</p>`
    +`<div class="field"><label for="disputeResponse">Your answer</label>`
    +`<textarea id="disputeResponse" maxlength="2000" placeholder="Why the delivery did not meet the criteria you posted."></textarea></div>`
    +`<div class="action-row"><button class="btn primary" id="doDisputeReply" data-id="${esc(commission)}" data-index="${esc(String(milestoneIndex))}" data-agent="${esc(agent)}" type="button">Post my answer</button>`
    +`<button class="btn" id="bX" type="button">Cancel</button></div></div>`;
  $('overlay').classList.add('on');
}

async function submitDisputeReply(commission,milestoneIndex,agent){
  const response=($('disputeResponse')?.value||'').trim();
  if(!response)throw new Error('Write your answer.');
  await api('/api/v1/disputes/respond',{method:'POST',body:JSON.stringify({commission,milestoneIndex:Number(milestoneIndex),agent,response})});
  closeDialog();
  showToast('Answered.');
  if(state.filter==='profile')loadProfile(state.profileId).catch(()=>{});
}

// ── the directory ─────────────────────────────────────────────────

async function loadAgents(query=''){
  state.agents=null;render();
  try{state.agents=await api(`/api/v1/agents${query?`?q=${encodeURIComponent(query)}`:''}`);}
  catch(error){state.agents={failed:true,message:error.message};}
  render();
}

function agentsView(){
  const a=state.agents;
  if(!a)return '<div class="blank"><h3>Loading\u2026</h3></div>';
  if(a.failed)return `<div class="blank"><h3>Could not load the directory</h3><p>${esc(a.message||'')}</p></div>`;
  const pct=v=>v==null?'\u2014':`${Math.round(v*100)}%`;
  const rows=a.agents.map((agent,index)=>`<div class="agent-row" data-profile="${esc(agent.wallet)}">`
    +`<span class="agent-rank">${index+1}</span>`
    +`<div class="agent-main">${who(agent.wallet,agent.handle?{[agent.wallet]:agent.handle}:{})}`
    +(agent.bio?`<div class="bio">${esc(agent.bio)}</div>`:'')
    +`<div class="bio">${agent.won} won \u00b7 ${agent.delivered} delivered \u00b7 ${pct(agent.winRate)} win rate \u00b7 ${agent.distinctCreators} distinct creator${agent.distinctCreators===1?'':'s'}</div></div>`
    +`<div class="agent-num"><b>${fmtBase(Math.round(agent.solEarned*LAMPORTS_PER_SOL))} SOL</b>earned</div></div>`).join('');
  return `<div class="activity-section"><h3>Agents who have delivered <span class="counter">${a.agents.length}</span></h3>`
    +`<p class="hint">Ranked by SOL earned, which is the one figure neither side can inflate alone: it took a creator\u2019s escrow and a creator\u2019s release. ${esc(a.caveats?.[1]||'')}</p></div>`
    +(rows||'<div class="blank"><h3>Nobody yet</h3><p>Anyone who delivers on a bounty appears here.</p></div>');
}

/// A dispute, as both sides of it.
function disputeBlock(d,{canAnswer=false}={}){
  return `<div class="dispute">`
    +`<div class="who-said">${esc(d.title||'Untitled bounty')} \u00b7 milestone ${d.milestoneNumber} \u00b7 ${new Date(d.createdAt).toLocaleDateString()}</div>`
    +`<p>${esc(d.reason)}</p>`
    +(d.answered
      ? `<div class="answer"><div class="who-said">The creator answered</div><p>${esc(d.response)}</p></div>`
      : `<div class="answer"><div class="who-said">No answer given.</div>`
        +(canAnswer?`<button class="btn" data-reply="${esc(d.commission)}" data-index="${esc(String(d.milestoneNumber-1))}" data-agent="${esc(d.agent||'')}" type="button" style="margin-top:6px">Answer this</button>`:'')
        +`</div>`)
    +`</div>`;
}

/// The account card's identity line.
///
/// One line, not a form. Choosing a name is a thing you do once when you sign
/// in; leaving a permanent text box in the sidebar made an occasional decision
/// look like a setting that needed attention on every visit.
function handleEditor(){
  const box=$('wHandle');
  if(!box)return;
  if(state.authStatus!=='authenticated'){
    box.innerHTML='<p class="hint">Sign in to choose a public name.</p>';
    return;
  }
  box.innerHTML=state.myHandle
    ? `<div class="handle-current"><span class="handle" data-profile="${esc(currentWallet())}">View my profile</span> \u00b7 <button class="linkish" id="bEditProfile" type="button">Edit</button></div>`
    : `<div class="handle-current"><button class="btn" id="bEditProfile" type="button">Choose your name</button></div>`;
}

/// Choosing, or changing, how you appear to everyone else.
///
/// Opened once automatically after a first sign-in, and from your own profile
/// afterwards. It asks for everything at once because these three fields are one
/// decision — "who am I on this board" — rather than three settings.
function openNameDialog({firstTime=false}={}){
  const current=state.myHandle;
  const p=state.profile&&state.profile.wallet===currentWallet()?state.profile:{};
  $('dlg').className='dlg';
  $('dlg').innerHTML=`<div class="dlg-head"><div class="dlg-head-row"><div class="dlg-head-copy">`
    +`<h1>${firstTime?'Choose your name':'Edit your profile'}</h1>`
    +`<div class="sub">${firstTime
      ? 'This is how creators and agents will see you on the board. You can skip it and stay an address.'
      : 'How you appear to everyone else.'}</div>`
    +`</div>${closeIcon()}</div></div>`
    +`<div class="dlg-content">`
    +`<div class="field"><label for="handleInput">Name</label>`
    +`<input id="handleInput" type="text" maxlength="32" placeholder="e.g. rust-agent" value="${esc(current||'')}">`
    +`<div class="hint">Letters, numbers and hyphens. A name labels your address, it never replaces it \u2014 both are always shown together, and nothing is ever paid to a name.</div></div>`
    +`<div class="field"><label for="bioInput">About you</label>`
    +`<textarea id="bioInput" maxlength="280" placeholder="What you build, or what you are looking for.">${esc(p.bio||'')}</textarea></div>`
    +`<div class="field"><label for="linkInput">Link</label>`
    +`<input id="linkInput" type="text" maxlength="200" placeholder="https://github.com/you" value="${esc(p.link||'')}"></div>`
    // Said before they commit, not after. This is the one irreversible thing on
    // the page, and it is irreversible for their benefit rather than ours.
    +`<p class="profile-caveat">A name is bound to this wallet permanently. Renaming later frees nothing, so nobody can ever pick up a name you built a reputation under and be mistaken for you.</p>`
    +`<div class="action-row" style="margin-top:16px">`
    +`<button class="btn primary" id="doSetHandle" type="button">${current?'Save':'Claim this name'}</button>`
    +`<button class="btn" id="bX" type="button">${firstTime?'Skip for now':'Cancel'}</button></div>`
    +`</div>`;
  $('overlay').classList.add('on');
}

async function saveHandle(){
  const handle=($('handleInput')?.value||'').trim();
  if(!handle)throw new Error('Enter a name first.');
  const bio=($('bioInput')?.value||'').trim(),link=($('linkInput')?.value||'').trim();

  // The claim goes on chain first, because the chain is what makes the name
  // yours. This service only records the bio that sits beside it — if it
  // disappeared tomorrow, the name would still be yours and anybody could prove
  // it by reading the program.
  //
  // Skipped when the name is unchanged, so editing a bio does not ask for a
  // signature or a second rent payment.
  if(handle.toLowerCase()!==(state.myHandle||'').toLowerCase()){
    const built=escrow.build.claimHandle(ESCROW_CTX,{wallet:state.wallet,handle});
    const existing=await callWithFailover('getAccountInfo',built.claim,'confirmed');
    if(existing){
      const held=escrow.decodeHandleClaim(existing.data);
      if(held.wallet!==currentWallet()){
        throw new Error(`@${built.handle} belongs to another wallet. Names are permanent, so that `
          +'nobody can pick up a name you built a reputation under.');
      }
    }else{
      showProgress('Claiming the name on chain\u2026 this is permanent.');
      await send(new Transaction().add(built.instruction),showProgress);
    }
  }

  const saved=await api('/api/v1/handle',{method:'POST',body:JSON.stringify({handle,bio,link})});
  state.myHandle=saved.handle;
  closeDialog();
  showToast(`You are now @${saved.handle}. This name is yours permanently.`);
  // Both the board and your own profile now say something different about you.
  if(state.filter==='profile')loadProfile(currentWallet()).catch(()=>{});
  else render();
  refresh().catch(()=>{});
}

/// Offers the name dialog once, the first time a wallet signs in without one.
///
/// Remembered per wallet so declining is respected: being asked the same
/// question on every visit is how a prompt becomes something people learn to
/// dismiss without reading.
async function offerNameOnce(){
  const wallet=currentWallet();
  if(!wallet||state.authStatus!=='authenticated')return;
  await loadMyIdentity();
  const key=`gitstarter.named.${wallet}`;
  if(state.myHandle||localStorage.getItem(key))return render();
  localStorage.setItem(key,'asked');
  openNameDialog({firstTime:true});
}

/// One line in the activity view. Clicking it opens the same dialog the board
/// opens, so there is exactly one place where a commission is acted on.
function activityRow(item,detail){
  const ui=STATUS_UI[item.status]||STATUS_UI.refunded;
  return `<div class="Box-row activity-row" data-id="${item.address}" style="cursor:pointer">`
    +`<div class="row-status">${statusIcon(ui)}</div>`
    +`<div class="row-main"><div class="row-title">`
    +`<span style="color:var(--fg);font-weight:600">${esc(item.title||'Untitled bounty')}</span>`
    +`<span class="lbl ${ui.cls}">${esc(ui.label)}</span>`
    +(item.attention&&item.attention.urgency==='act'
      ?`<span class="lbl attention act">${esc(item.attention.label)}</span>`:'')
    +`</div><div class="row-meta">${detail}</div></div>`
    +`<div class="row-right"><b>${fmtBase(Math.round(item.pledgedSol*LAMPORTS_PER_SOL))} SOL</b></div></div>`;
}

function activitySection(title,note,rows,empty){
  if(!rows.length)return empty?`<div class="activity-section"><h3>${esc(title)}</h3><p class="hint">${esc(empty)}</p></div>`:'';
  return `<div class="activity-section"><h3>${esc(title)} <span class="counter">${rows.length}</span></h3>`
    +(note?`<p class="hint">${esc(note)}</p>`:'')+rows.join('')+'</div>';
}

function activityView(){
  const wallet=currentWallet();
  if(!wallet)return '<div class="blank"><h3>Connect a wallet</h3><p>Your activity is everything this wallet posted, delivered, or said it would work on.</p></div>';
  const a=state.activity;
  if(!a)return '<div class="blank"><h3>Loading your activity\u2026</h3></div>';
  if(a.failed)return '<div class="blank"><h3>Could not load your activity</h3><p>The board above still works. Try again in a moment.</p></div>';

  const sol=n=>fmtBase(Math.round(n*LAMPORTS_PER_SOL));
  const t=a.totals;
  // Decided from the lists that are about to be rendered, not from the totals.
  // A counter that disagreed with its own array would hide real work behind an
  // "you have nothing" screen, which is the worst possible way to be wrong here.
  const nothing=![a.needsYou,a.posted.open,a.posted.finished,
    a.deliveries.inPlay,a.deliveries.won,a.deliveries.lost,
    a.signalled.working,a.signalled.settled].some(list=>list.length);
  if(nothing)return '<div class="blank"><h3>Nothing here yet</h3><p>Post a commission, or deliver work on one from the board. Anything you take part in shows up here, on either side.</p></div>';

  // Money first, because it is the summary a person is actually looking for.
  const totals=`<div class="activity-totals">`
    +`<div class="metric"><b>${sol(t.solEarned)} SOL</b><span>Earned from ${t.deliveriesWon} won</span></div>`
    +`<div class="metric"><b>${sol(t.solPaidOut)} SOL</b><span>Paid out over ${t.postedCount} posted</span></div>`
    +`<div class="metric"><b>${sol(t.solInEscrow)} SOL</b><span>Still in my escrow</span></div>`
    +`<div class="metric"><b>${t.winRate==null?'\u2014':Math.round(t.winRate*100)+'%'}</b><span>Win rate, judged only</span></div>`
    +`</div>`;

  const deadline=item=>item.workDeadline?` \u00b7 work window ends ${new Date(item.workDeadline).toLocaleDateString()}`:'';
  const progress=item=>`${item.milestonesReleased}/${item.milestones} milestones released`;

  return totals
    +activitySection('Needs you now',
      'A clock or money is riding on each of these, whichever side you are on.',
      a.needsYou.map(item=>activityRow(item,esc(item.attention.detail))),'')

    +activitySection('Posted by me \u00b7 open','',
      a.posted.open.map(item=>activityRow(item,
        `${progress(item)} \u00b7 ${item.competition.deliveries} deliver${item.competition.deliveries===1?'y':'ies'}, ${item.competition.waiting} waiting on me \u00b7 ${item.competition.agentsSignalled} signalled${deadline(item)}`)),
      'Nothing open. Anything you post appears here until it ships.')

    +activitySection('My deliveries \u00b7 in play',
      'Judged oldest first, so position 0 is next.',
      a.deliveries.inPlay.map(item=>activityRow(item,
        `milestone ${item.milestoneNumber} \u00b7 ${item.queuePosition===0?'judged next':`${item.queuePosition} ahead of mine`} \u00b7 worth ${sol(item.payoutSol)} SOL`)),'')

    +activitySection('Won',
      'Kept after settlement, when the on-chain accounts are already gone.',
      a.deliveries.won.map(item=>activityRow(item,
        `milestone ${item.milestoneNumber} \u00b7 paid ${sol(item.payoutSol)} SOL`)),'')

    +activitySection('Delivered but not paid',
      'Refused, or beaten to it by somebody who delivered earlier. Being beaten is the ordinary cost of an open board, not a mark against you.',
      a.deliveries.lost.map(item=>activityRow(item,
        `milestone ${item.milestoneNumber} \u00b7 ${item.state==='rejected'
          // Only a refusal can be contested. Being beaten to a milestone is
          // nobody's fault and there is nothing to answer for.
          ? `the creator refused this \u00b7 <button class="linkish" data-dispute="${esc(item.address)}" data-index="${esc(String(item.milestoneIndex))}" type="button">contest it</button>`
          : 'somebody ahead of me won it'}`)),'')

    +activitySection('Said I would work on it',
      'Signalling reserves nothing. It only means something because not following through is visible.',
      a.signalled.working.map(item=>activityRow(item,
        `signalled ${new Date(item.signalledAt).toLocaleDateString()}${deadline(item)} \u00b7 ${item.competition.deliveries} already delivered`)),'')

    +activitySection('Past commitments','',
      a.signalled.settled.map(item=>activityRow(item,
        item.outcome==='honoured'?'signalled, and delivered'
        :item.outcome==='withdrawn'?'stood down on the record'
        :'signalled, then never delivered')),'')

    +activitySection('Posted by me \u00b7 finished','',
      a.posted.finished.map(item=>activityRow(item,
        `${item.status==='shipped'?'shipped':'closed'} \u00b7 paid ${sol(item.releasedSol)} SOL${item.rejections?` \u00b7 ${item.rejections} refused`:''}`)),'');
}

/// Formats a deadline as the time left, because "2h left" is actionable and an
/// absolute timestamp in another timezone is not.
function timeLeft(unix){
  const seconds=unix-Math.floor(Date.now()/1000);
  if(seconds<=0)return'now';
  if(seconds<3600)return`${Math.ceil(seconds/60)}m left`;
  if(seconds<86400)return`${Math.floor(seconds/3600)}h left`;
  return`${Math.floor(seconds/86400)}d left`;
}
function submissionsOf(p){return p.meta?.submissions||[];}
function attentionFor(p){return escrow.pendingAttention(p,currentWallet(),{submissions:submissionsOf(p)});}

/// Renders a piece of evidence as a link when it is safely one, and as plain
/// text otherwise.
///
/// Only http and https are ever linkified. The text is chosen by a counterparty
/// and shown to the person judging their work, so a `javascript:` URL here
/// would be a stored-XSS delivery mechanism aimed squarely at the wallet holder
/// with the money.
function evidenceHtml(text){
  const trimmed=text.trim();
  if(/^https?:\/\/\S+$/i.test(trimmed)){
    try{
      const url=new URL(trimmed);
      if(url.protocol==='http:'||url.protocol==='https:'){
        return `<a href="${esc(url.href)}" target="_blank" rel="noopener noreferrer nofollow">${esc(url.href)}</a>`;
      }
    }catch{/* Not a URL after all; fall through and show it as text. */}
  }
  return esc(trimmed);
}

/// The delivered work itself.
///
/// The chain commits to a SHA-256 of this and stores nothing else, which left a
/// creator staring at sixteen hex characters and being asked to approve a
/// payment. The text is recorded off chain and only accepted if it hashes to
/// that commitment, so showing it here is safe: it is provably the thing the
/// agent committed to, not something the server made up.
function deliveryPanel(p,sub){
  const recorded=(p.meta?.deliveries||[]).find(d=>d.evidenceHash===sub.evidenceHash);
  if(!recorded){
    return `<div class="evidence pending"><div class="evidence-head">Nothing submitted to review yet</div>`
      +`<p class="hint">The agent committed to a delivery on chain but the content has not been supplied, so there is nothing here to judge. Ask them to re-submit it, or paste the text they sent you \u2014 it will only be accepted if it matches this commitment.</p>`
      +`<div class="evidence-hash mono">${esc(sub.evidenceHash)}</div></div>`;
  }
  return `<div class="evidence"><div class="evidence-head">Delivered for milestone ${sub.milestoneIndex+1}</div>`
    +`<div class="evidence-body">${evidenceHtml(recorded.evidence)}</div>`
    +`<div class="evidence-proof" title="${esc(sub.evidenceHash)}">\u2713 Matches the commitment recorded on chain</div></div>`;
}

/// Deliveries already dealt with, so a creator judging milestone three can see
/// what they accepted for milestone one.
function deliveryHistory(p,currentHash){
  const past=(p.meta?.deliveries||[]).filter(d=>d.evidenceHash!==currentHash);
  if(!past.length)return'';
  return `<details class="evidence-history"><summary>Earlier deliveries (${past.length})</summary>`
    +past.map(d=>`<div class="evidence past"><div class="evidence-head">Milestone ${d.milestoneIndex+1} \u00b7 ${new Date(d.submittedAt*1000).toLocaleString()}</div><div class="evidence-body">${evidenceHtml(d.evidence)}</div></div>`).join('')
    +'</details>';
}
function row(p){const ui=STATUS_UI[p.status]||STATUS_UI.refunded,m=p.meta||{},percent=p.goal?Math.min(100,p.pledged/p.goal*100):0,labels=Array.isArray(m.labels)?m.labels:[];const attention=attentionFor(p);let cursor=0;const segments=p.milestoneBps.map((bps,index)=>{const start=cursor;cursor+=bps/100;const fill=Math.max(0,Math.min(100,(percent-start)/(bps/100)*100));return `<span class="milestone-segment" style="width:${bps/100}%"><span class="milestone-fill ${ui.cls}" style="display:block;width:${fill}%"></span></span>`;}).join('');return `<div class="Box-row" data-id="${p.address}" style="cursor:pointer"><div class="row-status">${statusIcon(ui)}</div><div class="row-main"><div class="row-title"><span style="color:var(--fg);font-weight:600;font-size:16px">${esc(m.title||'Untitled bounty')}</span>${m.title?'':'<span class="lbl gray">no description posted</span>'}<span class="lbl ${ui.cls}">${esc(ui.detail)}</span>${attention?`<span class="lbl attention ${attention.urgency}">${esc(attention.label)}${attention.deadline?` \u00b7 ${timeLeft(attention.deadline)}`:''}</span>`:''}${labels.map(label=>`<span class="lbl gray">${esc(label)}</span>`).join('')}</div><div class="row-meta"><span class="mono">${p.address.slice(0,8)}…</span><span>created by ${who(p.creator,m.creatorHandle?{[p.creator]:m.creatorHandle}:{})}</span><span>·</span><span>${esc(m.license||'created on chain')}</span><span>·</span><span>${p.milestoneCount} milestones</span></div><div class="milestone-track" aria-label="${percent.toFixed(1)}% funded across ${p.milestoneCount} milestones">${segments}</div></div><div class="row-right"><span class="amt">${fmtBase(p.pledged)} <span class="of">/ ${fmtBase(p.goal)} SOL</span></span><span class="hint">${p.pledgerCount} ${p.pledgerCount===1?'backer':'backers'}</span></div></div>`;}
function closeDialog(){state.openProject=null;$('overlay').classList.remove('on');$('dlg').className='dlg';$('dlg').innerHTML='';}
function openProject(address){
  const p=state.projects.find(x=>x.address===address);if(!p)return;
  state.openProject=address;
  const m=p.meta||{},wallet=currentWallet(),ui=STATUS_UI[p.status]||STATUS_UI.refunded;
  let actions='';
  if(p.status==='funding'&&wallet)actions=`<div class="field"><label for="pledgeAmount">Pledge amount</label><input id="pledgeAmount" type="number" min="0.000001" step="0.000001" placeholder="0.00"><div class="hint">Amount in SOL. Your wallet will confirm the escrow transaction.</div><div class="hint">This escrow program has not been independently reviewed. One commission holds at most ${escrow.MAX_COMMISSION_LAMPORTS/LAMPORTS_PER_SOL} SOL, so that is the most any single bug could put at risk.</div></div><div class="action-row"><button class="btn primary lg" data-action="pledge" data-id="${p.address}">Pledge SOL</button></div>`;
  // ── the board ─────────────────────────────────────────────────────────
  //
  // A funded commission is workable by anyone. There is no nomination step, no
  // acceptance, and nothing for a creator to decide before work can start.
  const subs=p.meta?.submissions||[];
  const queue=i=>subs.filter(s=>s.milestoneIndex===i&&s.state==='pending').sort((a,b)=>a.sequence-b.sequence);
  const front=i=>escrow.frontOfQueue(p,subs,i);
  const unreleased=p.milestoneBps.map((_,i)=>i).filter(i=>!(p.milestonesDone&(1<<i)));

  if(p.status==='funded'&&escrow.canWork(p,wallet)){
    const mySubs=subs.filter(s=>s.agent===wallet&&s.state==='pending');
    const competition=subs.filter(s=>s.state==='pending').length;
    actions=`<div class="flash-inline" style="margin-bottom:12px"><b>Open for work.</b> Nobody has been assigned and nobody can be. Deliver it and, if the creator judges it good, the escrow is yours.${competition?` <b>${competition}</b> ${competition===1?'delivery is':'deliveries are'} already in the queue ahead of anything you submit now.`:' You would be first in the queue.'}${p.intents?` ${p.intents} ${p.intents===1?'agent has':'agents have'} said they are working on it.`:''}</div>`
      +`<div class="field"><label for="deliveryEvidence">Delivery evidence</label><input id="deliveryEvidence" type="text" placeholder="Commit URL, PR link, or artifact hash"><div class="hint">This is what the creator sees and judges. Only its hash goes on chain; the text itself is recorded alongside and shown to them, and is only accepted if it matches that hash.</div></div>`
      +`<div class="action-row">${unreleased.map(i=>`<button class="btn primary" data-action="submit" data-index="${i}" data-id="${p.address}">Deliver milestone ${i+1} \u00b7 ${p.milestoneBps[i]/100}%</button>`).join('')}</div>`
      +`<p class="hint" style="margin-top:8px">Deliveries are judged oldest first. Submitting starts a ${Math.round(p.reviewWindow/3600)}-hour review clock on yours once it reaches the front; if the creator neither releases nor rejects it, anyone can release your payment \u2014 including you.</p>`
      +(mySubs.length?'':`<div class="action-row" style="margin-top:12px"><button class="btn" data-action="signalIntent" data-id="${p.address}">Signal that you are working on this</button></div><p class="hint" style="margin-top:8px">Non-binding, and it reserves nothing. It tells other agents how crowded this job is, and going quiet afterwards is visible on your record.</p>`);
  }

  // The creator's queue, judged strictly oldest first.
  if(wallet===p.creator&&subs.some(s=>s.state==='pending')){
    const panels=unreleased.map(i=>{
      const waiting=queue(i);
      if(!waiting.length)return'';
      const head=waiting[0];
      const matured=escrow.reviewExpired(head,p.reviewWindow);
      return `<div class="queue"><div class="queue-head">Milestone ${i+1} \u00b7 ${p.milestoneBps[i]/100}% \u00b7 ${waiting.length} ${waiting.length===1?'delivery':'deliveries'} waiting</div>`
        +deliveryPanel(p,head)
        +`<div class="action-row"><button class="btn primary" data-action="release" data-index="${i}" data-agent="${head.agent}" data-id="${p.address}">Accept and pay ${fmtBase(Math.floor(p.pledged*p.milestoneBps[i]/10000*0.99))} SOL</button>`
        +(matured?'':`<button class="btn danger" data-action="reject" data-index="${i}" data-agent="${head.agent}" data-id="${p.address}">Reject and see the next</button>`)
        +`</div>`
        +`<p class="hint" style="margin-top:8px">${matured
          ?'The review window has passed, so anyone can now release this to the agent.'
          :`Review ends ${new Date(escrow.reviewEndsAt(head,p.reviewWindow)*1000).toLocaleString()}. Say nothing and it pays out automatically.`}
          ${waiting.length>1?`Rejecting brings the next of ${waiting.length} forward; you cannot skip past this one.`:''}</p>`
        +(waiting.length>1?`<details class="evidence-history"><summary>The ${waiting.length-1} behind it</summary>${waiting.slice(1).map(s=>`<div class="evidence past"><div class="evidence-head">${esc(s.agent.slice(0,8))}\u2026 \u00b7 ${new Date(s.submittedAt*1000).toLocaleString()}</div><div class="evidence-body">${evidenceHtml((p.meta?.deliveries||[]).find(d=>d.evidenceHash===s.evidenceHash)?.evidence||'(evidence not recorded)')}</div></div>`).join('')}</details>`:'')
        +`</div>`;
    }).join('');
    actions=panels+`<p class="hint" style="margin-top:12px">Accepting pays that agent immediately and cannot be undone. Because work was delivered, the 1% connection fee applies however this settles \u2014 refusing costs exactly what accepting costs, so decide on the work.</p>`;
  }

  // An agent whose delivery has matured can take it themselves.
  if(wallet&&wallet!==p.creator){
    const mine=subs.filter(s=>s.agent===wallet);
    for(const s of mine){
      if(s.state!=='pending')continue;
      const isFront=front(s.milestoneIndex)?.agent===wallet;
      const matured=isFront&&escrow.reviewExpired(s,p.reviewWindow);
      const ahead=s.sequence-(p.milestoneRejected[s.milestoneIndex]||0);
      actions+=`<div class="flash-inline" style="margin-top:12px"><b>Your delivery for milestone ${s.milestoneIndex+1}.</b> ${matured
        ?'The review window has passed \u2014 claim it.'
        :isFront?`Awaiting the creator until ${new Date(escrow.reviewEndsAt(s,p.reviewWindow)*1000).toLocaleString()}. Silence pays you.`
        :`${ahead} ${ahead===1?'delivery is':'deliveries are'} ahead of yours. Yours is judged only if those are rejected.`}</div>`
        +(matured?`<div class="action-row"><button class="btn primary lg" data-action="release" data-index="${s.milestoneIndex}" data-agent="${wallet}" data-id="${p.address}">Claim milestone ${s.milestoneIndex+1}</button></div>`:'');
    }
  }

  if(wallet===p.creator&&['funding','funded'].includes(p.status)){
    actions+=`<div class="field" style="margin-top:16px"><label for="agentWallet">Restrict to one agent <span class="hint">optional</span></label><input id="agentWallet" type="text" placeholder="Solana address, or your own to reopen"><div class="hint">Commissions are open to every agent by default, which is the point. Use this only if you already know who you want.</div></div><div class="action-row"><button class="btn" data-action="invite" data-id="${p.address}">${p.invitedAgent?'Change or clear the invitation':'Restrict this commission'}</button></div>`;
  }
  if(p.status==='funding'&&wallet===p.creator)actions+=`<div class="action-row" style="margin-top:12px"><button class="btn danger" data-action="cancel" data-id="${p.address}">Cancel commission</button></div><p class="hint" style="margin-top:8px">Only while it is still raising. Once funded, agents may already be working on it and the bounty stands.</p>`;
  if(p.status==='refunded'&&wallet)actions=`<div class="action-row"><button class="btn primary" data-action="refund" data-id="${p.address}">Claim available refund</button></div>`;
  // Nothing here about account deposits. They are returned automatically by the
  // transaction that settles the commission — see `cleanupInstructions`.
  if(!wallet)actions='<p class="hint">Connect a wallet to pledge or manage this commission.</p>';
  else if(!actions)actions='<p class="hint">No action is available to this wallet at the current contract stage.</p>';
  $('dlg').className='dlg';
  $('dlg').innerHTML=`<div class="dlg-head"><div class="dlg-head-row"><div class="dlg-head-copy"><h1>${esc(m.title||'Untitled bounty')} <span class="state ${ui.cls}">${esc(ui.label)}</span></h1><div class="sub mono"><a href="${explorerUrl(p.address)}" target="_blank" rel="noopener noreferrer">${p.address} ↗</a></div></div>${closeIcon()}</div></div><div class="project-shell"><main class="project-main"><p class="project-description">${esc(m.description||'This on-chain commission has not been indexed yet.')}</p><h2 class="section-title">Settlement</h2><div class="metric-grid"><div class="metric"><b>${fmtBase(p.pledged)} SOL</b><span>Net pledged</span></div><div class="metric"><b>${fmtBase(p.released)} SOL</b><span>Released</span></div><div class="metric"><b>${fmtBase(p.refunded)} SOL</b><span>Refunded</span></div></div><h2 class="section-title">Actions</h2><div class="action-panel">${actions}</div></main><aside class="project-side"><h2 class="section-title">Contract</h2><ul class="fact-list"><li><span>Network</span><b>${esc(state.config.cluster)}</b></li><li><span>Goal</span><b>${fmtBase(p.goal)} SOL</b></li><li><span>Milestones</span><b>${p.milestoneCount}</b></li><li><span>Protocol fee</span><b>1% once work is delivered · pledges free</b></li><li><span>Escrow program</span><b><a href="${explorerUrl(state.config.programId)}" target="_blank" rel="noopener noreferrer" class="mono">${state.config.programId.slice(0,8)}…${state.config.programId.slice(-4)} ↗</a></b></li><li><span>Deadline</span><b>${new Date(p.deadline*1000).toLocaleString()}</b></li><li><span>Creator</span><b class="mono">${p.creator}</b></li>${safeHttpUrl(m.repositoryUrl)?`<li><span>Repository</span><b><a href="${esc(safeHttpUrl(m.repositoryUrl))}" target="_blank" rel="noopener noreferrer">Open repository ↗</a></b></li>`:''}</ul></aside></div>`;
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
  $('dlg').innerHTML=`<div class="dlg-head"><div class="dlg-head-row"><div class="dlg-head-copy"><h1>Create a commission</h1><div class="sub">Define the work, funding target, and release schedule on Solana ${esc(state.config.cluster)}.</div></div>${closeIcon()}</div></div><div class="form-section"><h2>Commission details</h2><p>Give backers a precise description of what will be delivered.</p><div class="field"><label for="nTitle">Title</label><input id="nTitle" type="text" maxlength="120" placeholder="A concise outcome"></div><div class="field"><label for="nDescription">Description</label><textarea id="nDescription" placeholder="Scope, acceptance criteria, and expected deliverables"></textarea></div><div class="grid2"><div class="field"><label for="nRepo">Repository URL <span class="hint">optional</span></label><input id="nRepo" type="text" placeholder="https://github.com/owner/repo"></div><div class="field"><label for="nLicense">License</label><input id="nLicense" type="text" value="MIT"></div></div><div class="field"><label for="nLabels">Labels <span class="hint">optional</span></label><input id="nLabels" type="text" placeholder="cli, media, typescript"><div class="hint">Comma-separated. Labels become live filters on the commission list.</div></div></div><div class="form-section"><h2>Funding and delivery</h2><p>Funds remain in program-controlled escrow until milestones are released or refunded.</p><div class="grid2"><div class="field"><label for="nGoal">Funding goal (SOL)</label><input id="nGoal" type="number" min="0.000001" max="${escrow.MAX_COMMISSION_LAMPORTS/LAMPORTS_PER_SOL}" step="0.000001" placeholder="1"><div class="hint">At most ${escrow.MAX_COMMISSION_LAMPORTS/LAMPORTS_PER_SOL} SOL per commission. This escrow has not been independently reviewed, so the cap bounds what any single bug could cost. Split larger work across commissions.</div></div><div class="field"><label for="nDeadline">Funding deadline</label><input id="nDeadline" type="datetime-local" value="${deadlineDefault}" min="${deadlineMin}" max="${deadlineMax}"><div class="hint">Funding must close within ${escrow.MAX_FUNDING_DURATION_SECONDS/86400} days. Defaults to 14 days from now.</div></div></div><div class="grid2"><div class="field"><label for="nDelivery">Work window (days)</label><input id="nDelivery" type="number" min="1" max="30" step="1" value="3"><div class="hint">How long the job stays open for work once it is funded. Any agent may deliver in that time; nobody has to be chosen.</div></div><div class="field"><label for="nReview">Review window (hours)</label><input id="nReview" type="number" min="1" max="336" step="1" value="48"><div class="hint">After a delivery is submitted you have this long to release or reject it. Say nothing and it pays out automatically.</div></div></div><div class="field"><label for="nMilestones">Milestone percentages</label><input id="nMilestones" type="text" value="25,40,20,15"><div class="hint">Comma-separated percentages. They must total 100.</div></div></div><div class="dlg-footer"><span class="hint">Your wallet will confirm the on-chain creation transaction.</span><button class="btn" type="button" id="bX">Cancel</button><button class="btn primary lg" id="doCreate">Create and sign</button></div>`;
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
  if(goal>escrow.MAX_COMMISSION_LAMPORTS)throw new Error(`One commission may hold at most ${escrow.MAX_COMMISSION_LAMPORTS/LAMPORTS_PER_SOL} SOL while this escrow is new. Split the work into separate commissions.`);
  if(percentages.length>escrow.MAX_MILESTONES)throw new Error(`Use at most ${escrow.MAX_MILESTONES} milestones.`);
  if(!(deliveryDays>=1&&deliveryDays<=escrow.MAX_WORK_WINDOW_SECONDS/86400))throw new Error(`Work window must be between 1 and ${escrow.MAX_WORK_WINDOW_SECONDS/86400} days.`);
  if(!(reviewHours>=1&&reviewHours<=escrow.MAX_REVIEW_WINDOW_SECONDS/3600))throw new Error(`Review window must be between 1 and ${escrow.MAX_REVIEW_WINDOW_SECONDS/3600} hours.`);
  const {commission,instruction}=escrow.build.createCommission(ESCROW_CTX,{creator:state.wallet,seed,goalLamports:goal,milestoneBasisPoints:percentages.map(x=>x*100),deadlineUnix:deadline,workWindowSeconds:Math.round(deliveryDays*86400),reviewWindowSeconds:Math.round(reviewHours*3600)});const signature=await send(new Transaction().add(instruction),showProgress);
  showProgress('Indexing\u2026');
  await api('/api/commissions',{method:'POST',body:JSON.stringify({address:commission.toBase58(),txSignature:signature,title,description,repositoryUrl:$('nRepo').value.trim()||null,license:$('nLicense').value.trim()||'MIT',labels:$('nLabels').value.split(',').map(value=>value.trim().toLowerCase()).filter(Boolean).slice(0,8)})});
  closeDialog();
  await refresh();
  await reconcile(commission.toBase58());
  hideProgress();
  showToast('Commission created. Pledge to it to open funding.');
}
async function pledge(address){
  const amountLamports=Math.round(Number($('pledgeAmount').value)*LAMPORTS_PER_SOL);
  if(!amountLamports)throw new Error('Enter a pledge amount');
  const before=state.projects.find(x=>x.address===address)?.status;
  const {instruction}=escrow.build.pledge(ESCROW_CTX,{backer:state.wallet,commission:address,amountLamports});
  await send(new Transaction().add(instruction),showProgress);
  closeDialog();
  showProgress('Updating\u2026');
  await refresh();
  await reconcile(address);
  hideProgress();
  const after=state.projects.find(x=>x.address===address);
  showToast(after&&after.status==='funded'&&before!=='funded'
    ?`Pledge confirmed \u2014 goal reached, ${fmtBase(after.pledged)} SOL in escrow.`
    :'Pledge confirmed.');
}
/// Instructions that return the deposits held by accounts this commission no
/// longer needs.
///
/// Solana holds a refundable deposit on every account, so a finished commission
/// leaves real money locked in a vault, a pledge record per backer, and a
/// submission record per delivery. Returning it needs a transaction — but it
/// does not need a NEW one, and it certainly does not need a person to notice.
/// These ride along on the transaction that settles the commission, so the
/// deposits come home as a side effect of finishing the job.
///
/// None of them can misdirect money: each pays only the wallet recorded inside
/// the account being closed, which is why no additional signature is needed.
async function cleanupInstructions(address,commission){
  const program=new PublicKey(state.config.programId);
  // Both records store their commission at offset 1, right after the tag byte.
  const owned=(bytes,tag)=>state.connection.getProgramAccounts(program,{
    commitment:'confirmed',
    filters:[{dataSize:bytes},{memcmp:{offset:0,bytes:tag}},{memcmp:{offset:1,bytes:address}}],
  });
  let pledges=[],submissions=[],intents=[];
  try{
    [pledges,submissions,intents]=await Promise.all([
      owned(escrow.PLEDGE_ACCOUNT_BYTES,'4'),
      owned(escrow.SUBMISSION_ACCOUNT_BYTES,'5'),
      owned(escrow.INTENT_ACCOUNT_BYTES,'6'),
    ]);
  }catch{return [];} // Housekeeping must never be the reason a payment fails.

  const instructions=[escrow.build.closeVault(ESCROW_CTX,{
    signer:state.wallet,commission:address,creator:commission.creator,
  }).instruction];
  for(const {account} of pledges){
    try{
      const {backer}=escrow.decodePledge(account.data);
      instructions.push(escrow.build.closePledge(ESCROW_CTX,{backer,commission:address}).instruction);
    }catch{/* not a record we understand; leave it alone */}
  }
  for(const {account} of submissions){
    try{
      const {agent,milestoneIndex}=escrow.decodeSubmission(account.data);
      instructions.push(escrow.build.closeSubmission(ESCROW_CTX,{agent,commission:address,milestoneIndex}).instruction);
    }catch{/* same */}
  }
  // An intent holds a deposit too. Missing these was how the chore survived a
  // fix that was supposed to remove it: the vault, the pledges and the
  // submissions all came home while every agent who had merely SAID they were
  // working on this kept their money locked in an account nothing would ever
  // close. A declaration is finished the moment the commission is.
  for(const {account} of intents){
    try{
      const {agent}=escrow.decodeIntent(account.data);
      instructions.push(escrow.build.closeIntent(ESCROW_CTX,{agent,commission:address}).instruction);
    }catch{/* same */}
  }
  // A Solana transaction is size-limited, and every account it touches costs 32
  // bytes of it. Cap the tail so a busy commission cannot make its own final
  // payment too large to send; anything left over is closed by the next
  // transaction that touches this commission, or by any passing cranker.
  return instructions.slice(0,8);
}

async function simpleAction(action,address,index,agentArg){
  const p=state.projects.find(x=>x.address===address);let built,submitted=null;
  if(action==='invite')built=escrow.build.inviteAgent(ESCROW_CTX,{creator:state.wallet,commission:address,agent:$('agentWallet').value.trim()||state.wallet});
  else if(action==='signalIntent')built=escrow.build.signalIntent(ESCROW_CTX,{agent:state.wallet,commission:address});
  else if(action==='withdrawIntent')built=escrow.build.withdrawIntent(ESCROW_CTX,{agent:state.wallet,commission:address});
  else if(action==='cancel')built=escrow.build.cancel(ESCROW_CTX,{signer:state.wallet,commission:address});
  // The agent being paid is named on the button, because several may have
  // delivered and only the one at the front of the queue can be released.
  else if(action==='release')built=escrow.build.releaseMilestone(ESCROW_CTX,{signer:state.wallet,commission:address,agent:agentArg,milestoneIndex:Number(index)});
  else if(action==='refund')built=escrow.build.refund(ESCROW_CTX,{backer:state.wallet,commission:address});
  else if(action==='submit'){
    submitted=($('deliveryEvidence')?.value||'').trim();
    if(!submitted)throw new Error('Describe what you delivered: a commit URL, a PR link, or an artifact hash.');
    // The chain stores a commitment, never the text itself.
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(submitted));
    built=escrow.build.submitDelivery(ESCROW_CTX,{agent:state.wallet,commission:address,milestoneIndex:Number(index)||0,evidenceHash:Buffer.from(new Uint8Array(digest))});
  }
  else if(action==='reject')built=escrow.build.rejectDelivery(ESCROW_CTX,{creator:state.wallet,commission:address,agent:agentArg,milestoneIndex:Number(index)});
  else throw new Error(`Unknown action: ${action}`);

  // If this action ends the commission, sweep every finished account's deposit
  // home in the same transaction. The user is signing once either way.
  const allMilestones=(1<<p.milestoneCount)-1;
  const settlesNow=
    (action==='release'&&(p.milestonesDone|(1<<Number(index)))===allMilestones)
    ||(action==='refund'&&p.refundedPledgerCount+1>=p.pledgerCount);
  const cleanup=settlesNow?await cleanupInstructions(address,p):[];

  // Bundling means a failed cleanup would take the PAYMENT down with it — an
  // account closed by somebody else a second earlier is enough to do it. Money
  // must never be blocked by housekeeping, so a failure retries with the payment
  // alone and the deposits are picked up by the next transaction instead.
  const withCleanup=new Transaction().add(built.instruction,...cleanup);
  if(!cleanup.length)await send(withCleanup,showProgress);
  else{
    try{await send(withCleanup,showProgress);}
    catch(error){
      console.error('cleanup failed; sending the payment on its own',error);
      await send(new Transaction().add(built.instruction),showProgress);
    }
  }
  // Record what was delivered, now that the commitment it must match is on
  // chain. Without this the creator is asked to approve a payment against a
  // bare hash, which is not something a person can review.
  if(submitted){
    showProgress('Recording your delivery\u2026');
    try{await api('/api/deliveries',{method:'POST',body:JSON.stringify({commission:address,milestoneIndex:Number(index)||0,evidence:submitted})});}
    catch(error){
      // The delivery itself is on chain and stands regardless; only the
      // human-readable copy failed. Say so rather than implying the work was
      // lost, and leave the text where they can retrieve it.
      console.error(error);
      showToast('Delivery submitted on chain, but the description could not be saved. Send it to the creator directly.');
    }
  }
  closeDialog();
  showProgress('Updating\u2026');
  await refresh();
  await reconcile(address);
  hideProgress();
  // Having just nominated, submitted or rejected, this wallet is now waiting on
  // somebody else. That is the moment a notification is worth something.
  offerNotifications();
  showToast({
    invite:'Commission restricted to one agent. Name yourself to reopen it.',
    signalIntent:'Signalled. This reserves nothing \u2014 deliver to actually compete.',
    withdrawIntent:'Intent withdrawn.',
    submit:'Delivered. It is judged in the order it arrived.',
    reject:'Delivery rejected. The next in the queue is now judgeable.',
    release:'Paid. That agent won the milestone.',
    refund:'Refund complete.',
    cancel:'Commission cancelled. Backers can withdraw.',
  }[action]||'Done.');
}
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
let toastTimer=null;
function showToast(message){
  const t=$('toast');clearTimeout(toastTimer);
  t.className='toast on';t.textContent=message;
  toastTimer=setTimeout(()=>t.classList.remove('on'),6000);
}
/// A toast that stays put, for work already underway. Signing and confirming
/// take seconds and involve leaving the page for a wallet app; without this the
/// screen looks identical to one where the click did nothing.
function showProgress(message){
  const t=$('toast');clearTimeout(toastTimer);
  t.className='toast on busy';
  t.innerHTML=`<span class="spin" aria-hidden="true"></span><span>${esc(message)}</span>`;
}
function hideProgress(){const t=$('toast');if(t.classList.contains('busy')){t.className='toast';}}
function showNotice(message){showToast(message);}
function showError(error){console.error(error);hideProgress();showToast(friendlyWalletError(error));}
document.addEventListener('click',e=>{const t=e.target.closest('button,[data-profile],[data-id]');if(!t)return;
  // Checked before the row, so clicking somebody's name opens who they are
  // rather than the commission the name happens to be sitting inside.
  if(t.dataset.profile){state.filter='profile';loadProfile(t.dataset.profile).catch(showError);return;}
  if(t.id==='bMyProfile'){state.filter='profile';loadProfile(currentWallet()).catch(showError);return;}
  if(t.id==='doSetHandle'){saveHandle().catch(showError);return;}
  if(t.id==='bEditProfile'){openNameDialog();return;}
  if(t.id==='bInbox'){openInbox();return;}
  if(t.id==='bReadAll'){markInboxRead().catch(showError);return;}
  if(t.dataset.dispute){openDispute(t.dataset.dispute,t.dataset.index);return;}
  if(t.id==='doDispute'){submitDispute(t.dataset.id,t.dataset.index).catch(showError);return;}
  if(t.dataset.reply){openDisputeReply(t.dataset.reply,t.dataset.index,t.dataset.agent);return;}
  if(t.id==='doDisputeReply'){submitDisputeReply(t.dataset.id,t.dataset.index,t.dataset.agent).catch(showError);return;}if(t.id==='bWallet')openWalletModal();else if(t.dataset.wallet)connectWallet(t.dataset.wallet).catch(showError);else if(t.id==='bTheme'){state.theme=state.theme==='light'?'dark':'light';localStorage.setItem('gitstarter.theme',state.theme);render();}else if(t.id==='bNew')openCreate().catch(showError);else if(t.id==='bFinishAuth')authenticate().catch(showError);else if(t.id==='bX'||t.id==='overlay')closeDialog();else if(t.id==='doCreate')createCommission().catch(showError);else if(t.dataset.f){state.filter=t.dataset.f;render();if(t.dataset.f==='activity')loadActivity().then(render).catch(()=>{});else if(t.dataset.f==='agents')loadAgents(state.agentQuery||'').catch(()=>{});}else if(t.dataset.label){state.label=t.dataset.label;render();}else if(t.dataset.action==='pledge')pledge(t.dataset.id).catch(showError);else if(t.dataset.action)simpleAction(t.dataset.action,t.dataset.id,t.dataset.index,t.dataset.agent).catch(showError);else if(t.dataset.id)openProject(t.dataset.id);});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&$('overlay').classList.contains('on'))closeDialog();});
$('q').addEventListener('input',render);
// Delegated, because this input is created and destroyed by every render — a
// listener bound to the element itself would survive exactly one keystroke.
let agentSearchTimer=null;
document.addEventListener('input',event=>{
  if(event.target.id!=='agentQ')return;
  state.agentQuery=event.target.value;
  state.agentFocus=true;
  clearTimeout(agentSearchTimer);
  // Debounced: a request per keystroke would rate-limit the searcher out of
  // their own search.
  agentSearchTimer=setTimeout(()=>loadAgents(state.agentQuery).catch(()=>{}),250);
});
document.addEventListener('change',event=>{if(event.target.id==='sortSelect'){state.sort=event.target.value;render();}});
(async()=>{try{
  state.config=verifyConfig(await api('/api/config'));
  // The network name on the page comes from the verified config, never from
  // static text. The footer said "Solana devnet" for a day after the mainnet
  // launch because it was a hardcoded string nobody re-read — rendering it from
  // the same config the transactions use means it cannot lie separately again.
  for(const [id,text] of [['ftMeta',`Solana ${state.config.cluster} \u00b7 native SOL escrow \u00b7 SQLite metadata \u00b7 1% on releases`],['topicNet',`Solana ${state.config.cluster==='mainnet-beta'?'mainnet':state.config.cluster}`]]){
    const el=document.getElementById(id);if(el)el.textContent=text;
  }
  // One Connection per pool member. web3.js caches WSS internally per URL,
  // so this creates four warm sockets ready to take over on failure.
  state.connections=RPC_POOL.map(url=>new web3.Connection(url,'confirmed'));
  state.connectionIndex=0;
  state.connection=state.connections[0];
  // Restore the session BEFORE scanning the chain. The scan takes seconds on a
  // phone, and running it first left a returning user looking anonymous for
  // that whole window — long enough to tap New commission and be told to
  // connect a wallet they were already signed in with.
  await restoreSession();
  await refresh();
}catch(e){showError(e);}})();
