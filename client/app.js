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
const state = { config:null, connection:null, wallet:null, walletName:null, provider:null, session:null, sessionWallet:null, authStatus:'disconnected', connecting:false, metadata:[], projects:[], filter:'all', label:'all', sort:'newest', theme:localStorage.getItem('gitstarter.theme')||'light',
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
async function send(transaction,onStage=()=>{}){
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
  onStage('Approve in your wallet\u2026');
  let sig;
  if(typeof provider.signAndSendTransaction==='function'){
    sig=await provider.signAndSendTransaction(transaction);
  }else{
    const signed=await provider.signTransaction(transaction);
    sig=await state.connection.sendRawTransaction(signed.serialize(),{skipPreflight:false,maxRetries:3});
  }
  onStage('Confirming on Solana\u2026');
  const confirmation=await state.connection.confirmTransaction(sig,'confirmed');

  // Remember the slot that confirmed us.
  //
  // The public RPC endpoint is a pool of nodes. `confirmTransaction` can be
  // satisfied by one node while the very next read is served by another that has
  // not caught up, which is why a pledge could confirm and still show as
  // unfunded until a manual reload. Pinning subsequent reads to this slot makes
  // a stale node say so instead of quietly answering with old state.
  const slot=confirmation?.context?.slot;
  if(slot)state.minContextSlot=Math.max(state.minContextSlot||0,slot);
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
  if(wallet){$('wAlias').textContent=walletAlias(wallet);$('wAddress').textContent=wallet;const auth=$('wAuth');if(state.authStatus==='authenticated'){auth.className='account-state signed';auth.innerHTML='<span>✓ Signed in to GitStarter</span>';}else if(state.authStatus==='signing'){auth.className='account-state';auth.innerHTML='<span>Waiting for signature…</span>';}else{auth.className='account-state';auth.innerHTML='<span>Wallet connected</span><button class="btn primary" id="bFinishAuth" type="button">Finish sign-in</button>';}}
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
    +(needsYou.length?`<button data-f="needs-you" class="needs-you ${state.filter==='needs-you'?'on':''}${needsAction.length?' urgent':''}">Needs you <span class="counter">${needsYou.length}</span></button>`:'');
  const openCount=state.projects.filter(p=>p.status!=='shipped'&&p.status!=='refunded').length,closedCount=state.projects.length-openCount;
  const header=`<div class="Box-header"><div class="list-summary"><span>${statusIcon(STATUS_UI.funding)}<b>${openCount} Open</b></span><span>${statusIcon(STATUS_UI.shipped)}${closedCount} Closed</span></div><div class="list-tools"><label class="hint" for="sortSelect" style="margin:0">Sort</label><select class="tool-select" id="sortSelect"><option value="newest" ${state.sort==='newest'?'selected':''}>Newest</option><option value="funding" ${state.sort==='funding'?'selected':''}>Most funded</option><option value="deadline" ${state.sort==='deadline'?'selected':''}>Deadline</option></select></div></div>`;
  const labelBar=labels.length?`<div class="label-filter"><button class="label-button ${state.label==='all'?'on':''}" data-label="all">All labels</button>${labels.map(label=>`<button class="label-button ${state.label===label?'on':''}" data-label="${esc(label)}">${esc(label)}</button>`).join('')}</div>`:'';
  $('listBox').innerHTML=header+labelBar+(visible.length?visible.map(row).join(''):state.filter==='needs-you'?'<div class="blank"><h3>Nothing is waiting on you</h3><p>Deliveries, contract offers and expiring clocks appear here the moment they happen.</p></div>':'<div class="blank"><h3>No matching commissions</h3><p>Change the active status, label, search, or create the first real commission.</p></div>');
  const total=state.projects.reduce((s,p)=>s+p.pledged,0), escrow=state.projects.reduce((s,p)=>s+Math.max(0,p.pledged-p.released-p.refunded),0);
  $('sPledged').textContent=fmtBase(total); $('sEsc').textContent=fmtBase(escrow); $('sBurn').textContent=fmtBase(state.projects.reduce((s,p)=>s+p.released,0)); $('sRefund').textContent=fmtBase(state.projects.reduce((s,p)=>s+p.refunded,0)); $('sBackers').textContent=state.projects.reduce((s,p)=>s+p.pledgerCount,0);
  $('wBal').textContent=wallet?'refreshing…':'connect wallet'; $('wProj').textContent=wallet?state.projects.filter(p=>p.creator===wallet).length:'—';
  if(wallet)loadBalance();
}
async function loadBalance(){try{const lamports=await state.connection.getBalance(state.wallet);$('wBal').textContent=fmtBase(lamports)+' SOL';}catch{$('wBal').textContent='— SOL';}}
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
function row(p){const ui=STATUS_UI[p.status]||STATUS_UI.refunded,m=p.meta||{},percent=p.goal?Math.min(100,p.pledged/p.goal*100):0,labels=Array.isArray(m.labels)?m.labels:[];const attention=attentionFor(p);let cursor=0;const segments=p.milestoneBps.map((bps,index)=>{const start=cursor;cursor+=bps/100;const fill=Math.max(0,Math.min(100,(percent-start)/(bps/100)*100));return `<span class="milestone-segment" style="width:${bps/100}%"><span class="milestone-fill ${ui.cls}" style="display:block;width:${fill}%"></span></span>`;}).join('');return `<div class="Box-row" data-id="${p.address}" style="cursor:pointer"><div class="row-status">${statusIcon(ui)}</div><div class="row-main"><div class="row-title"><span style="color:var(--fg);font-weight:600;font-size:16px">${esc(m.title||'Untitled bounty')}</span>${m.title?'':'<span class="lbl gray">no description posted</span>'}<span class="lbl ${ui.cls}">${esc(ui.detail)}</span>${attention?`<span class="lbl attention ${attention.urgency}">${esc(attention.label)}${attention.deadline?` \u00b7 ${timeLeft(attention.deadline)}`:''}</span>`:''}${labels.map(label=>`<span class="lbl gray">${esc(label)}</span>`).join('')}</div><div class="row-meta"><span class="mono">${p.address.slice(0,8)}…</span><span>created by ${p.creator.slice(0,6)}…</span><span>·</span><span>${esc(m.license||'created on chain')}</span><span>·</span><span>${p.milestoneCount} milestones</span></div><div class="milestone-track" aria-label="${percent.toFixed(1)}% funded across ${p.milestoneCount} milestones">${segments}</div></div><div class="row-right"><span class="amt">${fmtBase(p.pledged)} <span class="of">/ ${fmtBase(p.goal)} SOL</span></span><span class="hint">${p.pledgerCount} ${p.pledgerCount===1?'backer':'backers'}</span></div></div>`;}
function closeDialog(){state.openProject=null;$('overlay').classList.remove('on');$('dlg').className='dlg';$('dlg').innerHTML='';}
function openProject(address){
  const p=state.projects.find(x=>x.address===address);if(!p)return;
  state.openProject=address;
  const m=p.meta||{},wallet=currentWallet(),ui=STATUS_UI[p.status]||STATUS_UI.refunded;
  let actions='';
  if(p.status==='funding'&&wallet)actions=`<div class="field"><label for="pledgeAmount">Pledge amount</label><input id="pledgeAmount" type="number" min="0.000001" step="0.000001" placeholder="0.00"><div class="hint">Amount in SOL. Your wallet will confirm the escrow transaction.</div></div><div class="action-row"><button class="btn primary lg" data-action="pledge" data-id="${p.address}">Pledge SOL</button></div>`;
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
  $('dlg').innerHTML=`<div class="dlg-head"><div class="dlg-head-row"><div class="dlg-head-copy"><h1>Create a commission</h1><div class="sub">Define the work, funding target, and release schedule on Solana ${esc(state.config.cluster)}.</div></div>${closeIcon()}</div></div><div class="form-section"><h2>Commission details</h2><p>Give backers a precise description of what will be delivered.</p><div class="field"><label for="nTitle">Title</label><input id="nTitle" type="text" maxlength="120" placeholder="A concise outcome"></div><div class="field"><label for="nDescription">Description</label><textarea id="nDescription" placeholder="Scope, acceptance criteria, and expected deliverables"></textarea></div><div class="grid2"><div class="field"><label for="nRepo">Repository URL <span class="hint">optional</span></label><input id="nRepo" type="text" placeholder="https://github.com/owner/repo"></div><div class="field"><label for="nLicense">License</label><input id="nLicense" type="text" value="MIT"></div></div><div class="field"><label for="nLabels">Labels <span class="hint">optional</span></label><input id="nLabels" type="text" placeholder="cli, media, typescript"><div class="hint">Comma-separated. Labels become live filters on the commission list.</div></div></div><div class="form-section"><h2>Funding and delivery</h2><p>Funds remain in program-controlled escrow until milestones are released or refunded.</p><div class="grid2"><div class="field"><label for="nGoal">Funding goal (SOL)</label><input id="nGoal" type="number" min="0.000001" step="0.000001" placeholder="1000"></div><div class="field"><label for="nDeadline">Funding deadline</label><input id="nDeadline" type="datetime-local" value="${deadlineDefault}" min="${deadlineMin}" max="${deadlineMax}"><div class="hint">Funding must close within ${escrow.MAX_FUNDING_DURATION_SECONDS/86400} days. Defaults to 14 days from now.</div></div></div><div class="grid2"><div class="field"><label for="nDelivery">Work window (days)</label><input id="nDelivery" type="number" min="1" max="30" step="1" value="3"><div class="hint">How long the job stays open for work once it is funded. Any agent may deliver in that time; nobody has to be chosen.</div></div><div class="field"><label for="nReview">Review window (hours)</label><input id="nReview" type="number" min="1" max="336" step="1" value="48"><div class="hint">After a delivery is submitted you have this long to release or reject it. Say nothing and it pays out automatically.</div></div></div><div class="field"><label for="nMilestones">Milestone percentages</label><input id="nMilestones" type="text" value="25,40,20,15"><div class="hint">Comma-separated percentages. They must total 100.</div></div></div><div class="dlg-footer"><span class="hint">Your wallet will confirm the on-chain creation transaction.</span><button class="btn" type="button" id="bX">Cancel</button><button class="btn primary lg" id="doCreate">Create and sign</button></div>`;
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
  let pledges=[],submissions=[];
  try{
    [pledges,submissions]=await Promise.all([
      owned(escrow.PLEDGE_ACCOUNT_BYTES,'4'),
      owned(escrow.SUBMISSION_ACCOUNT_BYTES,'5'),
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
  const transaction=new Transaction().add(built.instruction);
  const allMilestones=(1<<p.milestoneCount)-1;
  const settlesNow=
    (action==='release'&&(p.milestonesDone|(1<<Number(index)))===allMilestones)
    ||(action==='refund'&&p.refundedPledgerCount+1>=p.pledgerCount);
  if(settlesNow)for(const instruction of await cleanupInstructions(address,p))transaction.add(instruction);

  await send(transaction,showProgress);
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
document.addEventListener('click',e=>{const t=e.target.closest('button,[data-id]');if(!t)return;if(t.id==='bWallet')openWalletModal();else if(t.dataset.wallet)connectWallet(t.dataset.wallet).catch(showError);else if(t.id==='bTheme'){state.theme=state.theme==='light'?'dark':'light';localStorage.setItem('gitstarter.theme',state.theme);render();}else if(t.id==='bNew')openCreate().catch(showError);else if(t.id==='bFinishAuth')authenticate().catch(showError);else if(t.id==='bX'||t.id==='overlay')closeDialog();else if(t.id==='doCreate')createCommission().catch(showError);else if(t.dataset.f){state.filter=t.dataset.f;render();}else if(t.dataset.label){state.label=t.dataset.label;render();}else if(t.dataset.action==='pledge')pledge(t.dataset.id).catch(showError);else if(t.dataset.action)simpleAction(t.dataset.action,t.dataset.id,t.dataset.index,t.dataset.agent).catch(showError);else if(t.dataset.id)openProject(t.dataset.id);});
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
