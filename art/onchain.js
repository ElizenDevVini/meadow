// Wallet connect + buy + claim for the Meadow art pages. Loaded by both
// art/index.html (wallet button + your-collection panel) and art/work.html
// (wallet button + per-piece buy/claim panel). Stays fully dormant -- no RPC
// calls, no wallet prompts beyond discovery -- until NET.ready.
import { createWalletClient, custom, parseAbi } from '../vendor/viem.js';
import { chain, walletChain, NET, addressUrl } from '../config.js';
import { pub } from '../chain.js';

const artAbi = parseAbi([
  'function priceOf(uint256 id) view returns (uint256)',
  'function stockOf(uint256 id) view returns (address)',
  'function claimableMany(uint256[] ids) view returns (uint256[] claimableAmounts, uint256[] availableAmounts)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function buy(uint256 id)',
  'function claim(uint256 id)',
  'function claimMany(uint256[] ids)',
]);

const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
]);

const artAddr = NET.art;
const tokenAddr = NET.token;

function short(addr) {
  return addr.slice(0, 6) + '…' + addr.slice(-4);
}

function fmtAmount(wei) {
  if (wei == null) return '0';
  const n = Number(wei) / 1e18;
  if (!isFinite(n)) return 'n/a';
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

// falls back to onchain.json's stock_symbol (not the raw address) so a
// deploy that forgets to fill in NET.stocks still reads the same symbol the
// collection panel shows for the same piece
function symbolForStock(address, fallbackSymbol) {
  const match = NET.stocks.find(s => s.address && s.address.toLowerCase() === address.toLowerCase());
  return match ? match.symbol : fallbackSymbol;
}

function notLiveNotice() {
  return `<div class="not-live">
    <p>not live yet: ${NET.activationIssue}.</p>
    <a class="btn btn-outline" href="${NET.launchpad}" target="_blank" rel="noopener">see the Pons launch</a>
  </div>`;
}

function txUrl(hash) {
  return `${NET.explorer}/tx/${hash}`;
}

function showTxPending(root, hash) {
  const el = root.querySelector('.txstate');
  if (!el) return;
  el.innerHTML = `pending · <a href="${txUrl(hash)}" target="_blank" rel="noopener">${short(hash)}</a>`;
}

function walletErrorCode(err) {
  let current = err;
  for (let i = 0; i < 6 && current; i++) {
    if (typeof current.code === 'number') return current.code;
    current = current.cause;
  }
  return null;
}

function shortMessage(err, fallback) {
  const m = (err?.shortMessage || err?.message || fallback).split('\n')[0];
  return /rejected|denied/i.test(m) ? 'cancelled.' : m.slice(0, 200);
}

/* ---------- EIP-6963 wallet discovery (MetaMask, Phantom, and others) ---------- */

const wallets = new Map(); // rdns -> { info, provider }
let provider = null;
let walletClient = null;
let account = null;
let eventsAttached = false;
let onAccountChange = () => {};

window.addEventListener('eip6963:announceProvider', e => {
  const { info, provider: p } = e.detail;
  wallets.set(info.rdns, { info, provider: p });
});
window.dispatchEvent(new Event('eip6963:requestProvider'));

function discovered() {
  const list = [...wallets.values()];
  if (!list.length && window.ethereum) {
    list.push({ info: { name: window.ethereum.isMetaMask ? 'MetaMask' : 'Browser wallet', rdns: 'injected' }, provider: window.ethereum });
  }
  return list;
}

// re-ask for providers so a late-injecting wallet (Phantom, an in-app
// browser) has a moment to announce before the picker renders
async function collectWallets() {
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  await new Promise(r => setTimeout(r, 300));
  return discovered();
}

function walletClientFor(p) {
  return createWalletClient({ chain, transport: custom(p) });
}

async function ensureWalletChain(wallet) {
  if (await wallet.getChainId() === chain.id) return;
  try {
    await wallet.switchChain({ id: chain.id });
  } catch (err) {
    if (walletErrorCode(err) !== 4902) throw err;
    await wallet.addChain({ chain: walletChain });
    await wallet.switchChain({ id: chain.id });
  }
}

function attachProviderEvents(p) {
  if (eventsAttached || !p.on) return;
  eventsAttached = true;
  p.on('accountsChanged', accs => {
    account = accs[0] || null;
    walletBtn.textContent = account ? short(account) : 'connect wallet';
    onAccountChange();
  });
  p.on('chainChanged', chainIdHex => {
    if (Number(chainIdHex) !== chain.id) {
      account = null;
      walletBtn.textContent = 'switch network';
    } else {
      connect({ prompt: false }).catch(() => {});
    }
    onAccountChange();
  });
  p.on('disconnect', () => disconnect());
}

function disconnect() {
  account = null;
  provider = null;
  walletClient = null;
  walletBtn.textContent = 'connect wallet';
  walletPicker.hidden = true;
  onAccountChange();
}

async function connect({ prompt = true } = {}) {
  if (!NET.ready) return null; // dormant; callers gate on NET.ready before reaching here
  const list = prompt ? await collectWallets() : discovered();
  if (!list.length) {
    walletPicker.innerHTML = '<p class="wp-label">no wallet found. install MetaMask or Phantom.</p>';
    walletPicker.hidden = false;
    return null;
  }
  if (!provider) {
    if (list.length === 1) provider = list[0].provider;
    else if (prompt) { showWalletPicker(list); return null; }
    else return null;
  }
  const wallet = walletClientFor(provider);
  attachProviderEvents(provider);
  const addresses = prompt ? await wallet.requestAddresses() : await wallet.getAddresses();
  const addr = addresses[0];
  if (!addr) return null;
  await ensureWalletChain(wallet);
  walletClient = wallet;
  account = addr;
  walletBtn.textContent = short(addr);
  walletPicker.hidden = true;
  onAccountChange();
  return wallet;
}

/* ---------- nav wallet button + picker ---------- */

const walletBtn = document.getElementById('walletBtn');
const walletPicker = document.getElementById('walletPicker');

function showWalletPicker(list) {
  walletPicker.innerHTML = '<p class="wp-label">choose a wallet</p>' +
    list.map(w => `<button class="wp-pick" type="button" data-rdns="${w.info.rdns}">${w.info.name}</button>`).join('');
  walletPicker.hidden = false;
}

function showAccountMenu() {
  walletPicker.innerHTML = `<p class="wp-addr">${account}</p><button class="wp-disconnect" type="button">disconnect</button>`;
  walletPicker.hidden = false;
}

function wireWalletButton() {
  if (!walletBtn || !walletPicker) return;
  walletBtn.textContent = NET.ready ? 'connect wallet' : 'not live yet';

  walletBtn.addEventListener('click', async e => {
    e.preventDefault();
    if (!NET.ready) {
      walletPicker.innerHTML = notLiveNotice();
      walletPicker.hidden = false;
      return;
    }
    if (account) { showAccountMenu(); return; }
    try {
      await connect({ prompt: true });
    } catch (err) {
      walletPicker.innerHTML = `<p class="wp-label">${walletErrorCode(err) === 4001 ? 'connection cancelled.' : 'wallet connection failed.'}</p>`;
      walletPicker.hidden = false;
    }
  });

  walletPicker.addEventListener('click', async e => {
    const pick = e.target.closest('.wp-pick');
    if (pick) {
      const found = discovered().find(w => w.info.rdns === pick.dataset.rdns);
      walletPicker.hidden = true;
      if (found) {
        provider = found.provider;
        try { await connect({ prompt: true }); }
        catch (err) {
          walletPicker.innerHTML = `<p class="wp-label">${walletErrorCode(err) === 4001 ? 'connection cancelled.' : 'wallet connection failed.'}</p>`;
          walletPicker.hidden = false;
        }
      }
      return;
    }
    if (e.target.closest('.wp-disconnect')) disconnect();
  });

  document.addEventListener('click', e => {
    if (!walletPicker.hidden && !walletPicker.contains(e.target) && e.target !== walletBtn) {
      walletPicker.hidden = true;
    }
  });
}

/* ---------- work page: buy / claim one piece ---------- */

async function ownerOfSafe(id) {
  try {
    return await pub.readContract({ address: artAddr, abi: artAbi, functionName: 'ownerOf', args: [BigInt(id)] });
  } catch {
    return null; // unminted piece (ERC721 reverts on a non-existent token id)
  }
}

async function refreshClaimable(work, root) {
  const el = root.querySelector('#claimAmount');
  if (!el) return;
  try {
    const [claimableAmounts, availableAmounts] = await pub.readContract({
      address: artAddr, abi: artAbi, functionName: 'claimableMany', args: [[BigInt(work.id)]],
    });
    const claimableAmt = claimableAmounts[0];
    const availableAmt = availableAmounts[0];
    el.textContent = availableAmt < claimableAmt
      ? `claimable: ${fmtAmount(claimableAmt)} ${work.stockSymbol} (treasury has ${fmtAmount(availableAmt)} available)`
      : `claimable: ${fmtAmount(claimableAmt)} ${work.stockSymbol}`;
  } catch (err) {
    el.textContent = `could not read the claimable amount. ${shortMessage(err, 'try again shortly')}`;
  }
}

// single claim() for one piece, claimMany() for a batch -- same tx-state
// handling either way, reused by the work page and the collection panel
async function doClaim(ids, root) {
  const state = root.querySelector('.txstate');
  root.querySelectorAll('button').forEach(b => { b.disabled = true; });
  try {
    const wallet = walletClient || await connect({ prompt: true });
    if (!wallet) return false;
    if (state) state.textContent = 'confirm the claim in your wallet…';
    const { request } = ids.length === 1
      ? await pub.simulateContract({ address: artAddr, abi: artAbi, functionName: 'claim', args: [BigInt(ids[0])], account })
      : await pub.simulateContract({ address: artAddr, abi: artAbi, functionName: 'claimMany', args: [ids.map(BigInt)], account });
    const hash = await wallet.writeContract(request);
    showTxPending(root, hash);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error('claim transaction reverted');
    if (state) state.textContent = 'claimed.';
    return true;
  } catch (err) {
    if (state) state.textContent = shortMessage(err, 'claim failed');
    return false;
  } finally {
    root.querySelectorAll('button').forEach(b => { b.disabled = false; });
  }
}

async function doBuy(work, root) {
  const btn = root.querySelector('#buyBtn');
  const state = root.querySelector('.txstate');
  btn.disabled = true;
  try {
    const wallet = walletClient || await connect({ prompt: true });
    if (!wallet) { btn.disabled = false; return; }

    const price = await pub.readContract({ address: artAddr, abi: artAbi, functionName: 'priceOf', args: [BigInt(work.id)] });
    const balance = await pub.readContract({ address: tokenAddr, abi: erc20Abi, functionName: 'balanceOf', args: [account] });
    if (balance < price) {
      state.textContent = 'not enough project tokens in this wallet.';
      btn.disabled = false;
      return;
    }

    const allowance = await pub.readContract({
      address: tokenAddr, abi: erc20Abi, functionName: 'allowance', args: [account, artAddr],
    });
    if (allowance < price) {
      state.textContent = 'step 1 of 2 · approve in your wallet…';
      const approveHash = await wallet.writeContract({
        address: tokenAddr, abi: erc20Abi, functionName: 'approve', args: [artAddr, price], account,
      });
      showTxPending(root, approveHash);
      const approveReceipt = await pub.waitForTransactionReceipt({ hash: approveHash });
      if (approveReceipt.status !== 'success') throw new Error('approval transaction reverted');
    }

    state.textContent = 'confirm the buy in your wallet…';
    const { request } = await pub.simulateContract({
      address: artAddr, abi: artAbi, functionName: 'buy', args: [BigInt(work.id)], account,
    });
    const hash = await wallet.writeContract(request);
    showTxPending(root, hash);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error('buy transaction reverted');
    await renderBuyPanel(work, root);
  } catch (err) {
    btn.disabled = false;
    state.textContent = shortMessage(err, 'buy failed');
  }
}

async function renderBuyPanel(work, root) {
  root.innerHTML = '<p>checking on-chain status…</p>';
  const [owner, stockAddr] = await Promise.all([
    ownerOfSafe(work.id),
    pub.readContract({ address: artAddr, abi: artAbi, functionName: 'stockOf', args: [BigInt(work.id)] }).catch(() => null),
  ]);
  work.stockSymbol = stockAddr ? symbolForStock(stockAddr, work.stock_symbol) : work.stock_symbol;
  const youOwn = owner && account && owner.toLowerCase() === account.toLowerCase();
  const priceText = work.price_tokens.toLocaleString() + ' tokens';

  if (youOwn) {
    root.innerHTML = `
      <p class="own-line">you own this piece.</p>
      <p class="meta">streaming payout: ${work.rate_display}</p>
      <p class="claim-amount" id="claimAmount">checking claimable…</p>
      <button class="btn btn-dark" id="claimBtn" type="button">claim</button>
      <p class="txstate"></p>
    `;
    refreshClaimable(work, root);
    root.querySelector('#claimBtn').addEventListener('click', async () => {
      const ok = await doClaim([work.id], root);
      if (ok) refreshClaimable(work, root);
    });
    return;
  }

  if (owner) {
    const link = addressUrl(owner);
    const ownerText = link
      ? `<a href="${link}" target="_blank" rel="noopener">${short(owner)}</a>`
      : short(owner);
    root.innerHTML = `
      <p class="own-line">sold. owned by ${ownerText}.</p>
      <p class="meta">${priceText} · pays ${work.rate_display}</p>
    `;
    return;
  }

  root.innerHTML = `
    <p class="price-line">${priceText}</p>
    <p class="meta">pays ${work.rate_display}, streamed per second while you hold it</p>
    ${account
      ? '<button class="btn btn-dark" id="buyBtn" type="button">buy</button>'
      : '<button class="btn btn-outline" id="connectBtn" type="button">connect to buy</button>'}
    <p class="txstate"></p>
  `;
  if (account) root.querySelector('#buyBtn').addEventListener('click', () => doBuy(work, root));
  else root.querySelector('#connectBtn').addEventListener('click', () => connect({ prompt: true }).catch(() => {}));
}

async function initWorkPage() {
  const buyPanel = document.getElementById('buyPanel');
  const buyBody = document.getElementById('buyPanelBody');
  if (!buyPanel || !buyBody) return;

  const slug = new URLSearchParams(location.search).get('id');
  let work = null;
  try {
    const res = await fetch('data/onchain.json');
    if (res.ok) {
      const data = await res.json();
      work = slug ? data.works.find(w => w.slug === slug) : null;
    }
  } catch {
    // onchain.json failed to load -- treat as no on-chain data for this piece
  }
  if (!work) { buyPanel.hidden = true; return; }

  if (!NET.ready) {
    buyBody.innerHTML = notLiveNotice();
    return; // no RPC calls while dormant
  }

  renderBuyPanel(work, buyBody);
  onAccountChange = () => renderBuyPanel(work, buyBody);
}

/* ---------- catalog page: your collection ---------- */

let collectionWorks = null;

async function renderCollection(root) {
  if (!account) {
    root.innerHTML = '<p>connect a wallet to see the pieces you own.</p>';
    return;
  }
  root.innerHTML = '<p>checking your collection…</p>';

  const calls = collectionWorks.map(w => ({
    address: artAddr, abi: artAbi, functionName: 'ownerOf', args: [BigInt(w.id)],
  }));
  let results;
  try {
    results = await pub.multicall({ contracts: calls, allowFailure: true });
  } catch (err) {
    root.innerHTML = `<p>could not read the collection. ${shortMessage(err, 'try again shortly')}</p>`;
    return;
  }

  const owned = collectionWorks.filter((w, i) => {
    const r = results[i];
    return r.status === 'success' && r.result && r.result.toLowerCase() === account.toLowerCase();
  });
  if (!owned.length) {
    root.innerHTML = '<p>this wallet does not own any pieces yet.</p>';
    return;
  }

  let claimableAmounts = new Array(owned.length).fill(0n);
  let availableAmounts = new Array(owned.length).fill(0n);
  try {
    [claimableAmounts, availableAmounts] = await pub.readContract({
      address: artAddr, abi: artAbi, functionName: 'claimableMany', args: [owned.map(w => BigInt(w.id))],
    });
  } catch {
    // leave both at 0 -- rows still render, claim buttons still work
  }

  const rows = owned.map((w, i) => {
    const claimLine = availableAmounts[i] < claimableAmounts[i]
      ? `${fmtAmount(claimableAmounts[i])} ${w.stock_symbol} claimable (treasury has ${fmtAmount(availableAmounts[i])} available)`
      : `${fmtAmount(claimableAmounts[i])} ${w.stock_symbol} claimable`;
    return `
    <div class="collection-row">
      <span class="collection-title">${w.title}</span>
      <span class="collection-claim">${claimLine}</span>
      <button class="btn btn-outline collection-claim-btn" type="button" data-id="${w.id}">claim</button>
    </div>
  `;
  }).join('');
  root.innerHTML = `
    ${rows}
    <button class="btn btn-dark" id="claimAllBtn" type="button">claim all</button>
    <p class="txstate"></p>
  `;
  root.querySelectorAll('.collection-claim-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ok = await doClaim([Number(btn.dataset.id)], root);
      if (ok) renderCollection(root);
    });
  });
  root.querySelector('#claimAllBtn').addEventListener('click', async () => {
    const ok = await doClaim(owned.map(w => w.id), root);
    if (ok) renderCollection(root);
  });
}

async function initCollectionPage() {
  const body = document.getElementById('collectionBody');
  if (!body) return;

  if (!NET.ready) {
    body.innerHTML = notLiveNotice();
    return; // no RPC calls while dormant
  }

  try {
    const res = await fetch('data/onchain.json');
    if (res.ok) {
      const data = await res.json();
      collectionWorks = data.works || [];
    }
  } catch {
    collectionWorks = null;
  }
  if (!collectionWorks || !collectionWorks.length) {
    body.innerHTML = '<p>could not load the collection catalog.</p>';
    return;
  }

  renderCollection(body);
  onAccountChange = () => renderCollection(body);
}

/* ---------- entry ---------- */

function init() {
  wireWalletButton();
  const page = document.body.dataset.page;
  if (page === 'work') initWorkPage().catch(() => {});
  else if (page === 'catalog') initCollectionPage().catch(() => {});
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
