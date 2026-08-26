// Secondary market page: list, buy, cancel, and update-price for minted
// Meadow art pieces, peer to peer in RWArt. onchain.js exports nothing (it's
// a plain script, not a module), so the EIP-6963 wallet-connect plumbing is
// duplicated here rather than imported. Stays fully dormant -- no RPC calls
// -- until NET.marketReady, same discipline as onchain.js does for NET.ready.
import { createWalletClient, custom, parseAbi } from '../vendor/viem.js';
import { chain, walletChain, NET, addressUrl } from '../config.js';
import { pub } from '../chain.js';

const marketAbi = parseAbi([
  'function list(uint256 tokenId, uint256 price)',
  'function updatePrice(uint256 tokenId, uint256 price)',
  'function cancel(uint256 tokenId)',
  'function buy(uint256 tokenId)',
  'function listingsMany(uint256[] ids) view returns (address[] sellers, uint256[] prices, bool[] valid)',
  'function feeBps() view returns (uint16)',
]);

const artAbi = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
]);

const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
]);

const artAddr = NET.art;
const tokenAddr = NET.token;
const marketAddr = NET.market;

function short(addr) {
  return addr.slice(0, 6) + '…' + addr.slice(-4);
}

function fmtAmount(wei) {
  if (wei == null) return '0';
  const n = Number(wei) / 1e18;
  if (!isFinite(n)) return 'n/a';
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

// decimal string -> wei bigint, done on strings so it doesn't inherit
// float's rounding error at 18 decimal places
function parseAmountToWei(input) {
  const s = String(input).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  if (frac.length > 18) return null;
  return BigInt(whole) * 10n ** 18n + BigInt(frac.padEnd(18, '0'));
}

function plateHtml(artist) {
  return `<div class="plate" role="img" aria-label="${artist}, no image available"><span>${artist}</span></div>`;
}

function notLiveNotice() {
  return `<div class="not-live">
    <p>not live yet: ${NET.activationIssue}.</p>
    <a class="btn btn-outline" href="${NET.launchpad}" target="_blank" rel="noopener">see the Pons launch</a>
  </div>`;
}

function marketNotLiveNotice() {
  return `<div class="not-live">
    <p>the secondary market isn't live yet. once MeadowMarket deploys, holders can list pieces here.</p>
    <a class="btn btn-outline" href="./">back to the catalog</a>
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

/* ---------- add a token to the connected wallet (EIP-747 wallet_watchAsset) ---------- */

function isMetaMask(w) {
  return w.info.rdns === 'io.metamask' || /metamask/i.test(w.info.name);
}

async function handleWatchAsset(address, symbol, msgEl) {
  if (!account) {
    try {
      if (!await connect({ prompt: true })) return;
    } catch (err) {
      if (msgEl) msgEl.textContent = walletErrorCode(err) === 4001 ? 'connection cancelled.' : 'wallet connection failed.';
      return;
    }
  }
  if (typeof provider?.request !== 'function') {
    if (msgEl) msgEl.textContent = 'this wallet does not support adding tokens.';
    return;
  }
  if (msgEl) msgEl.textContent = 'confirm in your wallet…';
  try {
    const added = await provider.request({
      method: 'wallet_watchAsset',
      params: { type: 'ERC20', options: { address, symbol, decimals: 18 } },
    });
    if (msgEl) msgEl.textContent = added === false ? `${symbol} not added.` : `${symbol} added to wallet.`;
  } catch (err) {
    const code = walletErrorCode(err);
    if (msgEl) msgEl.textContent = code === 4001 ? 'cancelled.'
      : code === 4200 || code === -32601 ? 'this wallet does not support adding tokens.'
      : shortMessage(err, `could not add ${symbol}`);
  }
}

function wireAddTokenButtons(root) {
  root.querySelectorAll('[data-add-token]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const msgEl = btn.nextElementSibling;
      btn.disabled = true;
      await handleWatchAsset(btn.dataset.address, btn.dataset.addToken, msgEl);
      btn.disabled = false;
    });
  });
}

function addTokenRow(address, symbol) {
  return `<p class="addtoken-row"><button class="linklike" type="button" data-add-token="${symbol}" data-address="${address}">add ${symbol} to MetaMask</button> <span class="addtoken-msg"></span></p>`;
}

/* ---------- nav wallet button + picker ---------- */

const walletBtn = document.getElementById('walletBtn');
const walletPicker = document.getElementById('walletPicker');

function showWalletPicker(list) {
  const sorted = [...list].sort((a, b) => isMetaMask(b) - isMetaMask(a));
  walletPicker.innerHTML = '<p class="wp-label">choose a wallet</p>' +
    sorted.map(w => `<button class="wp-pick" type="button" data-rdns="${w.info.rdns}">${w.info.name}${isMetaMask(w) ? ' (MetaMask)' : ''}</button>`).join('');
  walletPicker.hidden = false;
}

function showAccountMenu() {
  walletPicker.innerHTML = `
    <p class="wp-addr">${account}</p>
    ${addTokenRow(tokenAddr, 'RWArt')}
    <button class="wp-disconnect" type="button">disconnect</button>
  `;
  walletPicker.hidden = false;
  wireAddTokenButtons(walletPicker);
}

function wireWalletButton() {
  if (!walletBtn || !walletPicker) return;
  walletBtn.textContent = NET.ready ? 'connect wallet' : 'not live yet';
  if (NET.ready) walletBtn.title = 'Connect MetaMask, Phantom, or another wallet';

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

/* ---------- footer attribution ---------- */

function renderFooterAttribution(catalog) {
  const el = document.getElementById('artFooter');
  if (!el || !catalog?.attribution) return;
  const attr = catalog.attribution;
  el.innerHTML = `<p class="attribution">Records: <a href="${attr.records_url}" target="_blank" rel="noopener">${attr.records}</a>. Images: ${attr.images}. Prices: ${attr.prices}.</p>`;
}

/* ---------- piece catalog (onchain.json + catalog.json, joined by slug) ---------- */

let pieces = null;

async function loadPieces() {
  if (pieces) return pieces;
  const [onchainRes, catalogRes] = await Promise.all([fetch('data/onchain.json'), fetch('data/catalog.json')]);
  if (!onchainRes.ok || !catalogRes.ok) throw new Error('catalog data unavailable');
  const onchain = await onchainRes.json();
  const catalog = await catalogRes.json();
  const catalogById = new Map(catalog.works.map(w => [w.id, w]));
  pieces = onchain.works.map(w => {
    const c = catalogById.get(w.slug);
    return { id: w.id, slug: w.slug, title: w.title, artist: c?.artist || '', img: c?.img || null };
  });
  return pieces;
}

/* ---------- for sale ---------- */

function marketCardHtml(l) {
  const thumb = l.img
    ? `<img src="${l.img.thumb}" alt="${l.title}, by ${l.artist}">`
    : plateHtml(l.artist);
  const sellerLink = addressUrl(l.seller);
  const sellerText = sellerLink
    ? `<a href="${sellerLink}" target="_blank" rel="noopener">${short(l.seller)}</a>`
    : short(l.seller);
  const youOwn = account && l.seller.toLowerCase() === account.toLowerCase();
  const buyControl = youOwn
    ? '<p class="meta">this is your listing</p>'
    : account
      ? `<button class="btn btn-dark buy-btn" type="button" data-id="${l.id}">buy</button>`
      : '<button class="btn btn-outline connect-buy-btn" type="button">connect to buy</button>';
  return `
    <div class="market-card" data-id="${l.id}">
      <a class="title-link" href="work.html?id=${l.slug}">
        <div class="thumb">${thumb}</div>
        <p class="title">${l.title}</p>
        <p class="meta">${l.artist}</p>
      </a>
      <p class="price-line">${fmtAmount(l.price)} RWArt</p>
      <p class="seller">seller ${sellerText}</p>
      ${buyControl}
      <p class="txstate"></p>
    </div>
  `;
}

function wireBuyButtons(root, listed) {
  root.querySelectorAll('.buy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const listing = listed.find(l => String(l.id) === btn.dataset.id);
      doBuy(listing, btn.closest('.market-card'));
    });
  });
  root.querySelectorAll('.connect-buy-btn').forEach(btn => {
    btn.addEventListener('click', () => connect({ prompt: true }).catch(() => {}));
  });
}

async function doBuy(listing, root) {
  const btn = root.querySelector('.buy-btn');
  const state = root.querySelector('.txstate');
  if (btn) btn.disabled = true;
  try {
    const wallet = walletClient || await connect({ prompt: true });
    if (!wallet) { if (btn) btn.disabled = false; return; }
    if (account.toLowerCase() === listing.seller.toLowerCase()) {
      state.textContent = 'you cannot buy your own listing.';
      if (btn) btn.disabled = false;
      return;
    }

    const [balance, allowance] = await Promise.all([
      pub.readContract({ address: tokenAddr, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
      pub.readContract({ address: tokenAddr, abi: erc20Abi, functionName: 'allowance', args: [account, marketAddr] }),
    ]);
    if (balance < listing.price) {
      state.textContent = 'not enough RWArt in this wallet.';
      if (btn) btn.disabled = false;
      return;
    }

    if (allowance < listing.price) {
      state.textContent = 'step 1 of 2 · approve in your wallet…';
      const approveHash = await wallet.writeContract({
        address: tokenAddr, abi: erc20Abi, functionName: 'approve', args: [marketAddr, listing.price], account,
      });
      showTxPending(root, approveHash);
      const approveReceipt = await pub.waitForTransactionReceipt({ hash: approveHash });
      if (approveReceipt.status !== 'success') throw new Error('approval transaction reverted');
    }

    state.textContent = 'confirm the buy in your wallet…';
    const { request } = await pub.simulateContract({
      address: marketAddr, abi: marketAbi, functionName: 'buy', args: [BigInt(listing.id)], account,
    });
    const hash = await wallet.writeContract(request);
    showTxPending(root, hash);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error('buy transaction reverted');
    state.textContent = 'bought.';
    refreshAll();
  } catch (err) {
    if (btn) btn.disabled = false;
    state.textContent = shortMessage(err, 'buy failed');
  }
}

async function renderForSale(root) {
  if (!NET.marketReady) { root.innerHTML = marketNotLiveNotice(); return; }
  root.innerHTML = '<p>checking listings…</p>';

  let listed;
  try {
    const data = await loadPieces();
    const [sellers, prices, valid] = await pub.readContract({
      address: marketAddr, abi: marketAbi, functionName: 'listingsMany', args: [data.map(p => BigInt(p.id))],
    });
    listed = data
      .map((p, i) => ({ ...p, seller: sellers[i], price: prices[i] }))
      .filter((_, i) => valid[i]);
  } catch (err) {
    root.innerHTML = `<p>could not read the listings. ${shortMessage(err, 'try again shortly')}</p>`;
    return;
  }

  if (!listed.length) {
    root.innerHTML = '<p class="market-empty">nothing listed yet. holders can list a piece from "your pieces" below.</p>';
    return;
  }

  const floor = listed.reduce((min, l) => (l.price < min ? l.price : min), listed[0].price);
  root.innerHTML = `
    <p class="market-summary">${listed.length} listed · floor ${fmtAmount(floor)} RWArt</p>
    <div class="market-grid">${listed.map(marketCardHtml).join('')}</div>
  `;
  wireBuyButtons(root, listed);
}

/* ---------- your pieces ---------- */

function yourPieceRowHtml(p, listing) {
  const isListed = listing.valid && listing.seller.toLowerCase() === account.toLowerCase();
  const controls = isListed
    ? `
      <span class="meta">listed at ${fmtAmount(listing.price)} RWArt</span>
      <input class="price-input" type="text" inputmode="decimal" placeholder="new price" data-role="price">
      <button class="btn btn-outline update-btn" type="button">update price</button>
      <button class="btn btn-outline cancel-btn" type="button">cancel</button>
    `
    : `
      <input class="price-input" type="text" inputmode="decimal" placeholder="price in RWArt" data-role="price">
      <button class="btn btn-dark list-btn" type="button">list</button>
    `;
  return `
    <div class="your-piece-row" data-id="${p.id}">
      <span class="your-piece-title"><a href="work.html?id=${p.slug}">${p.title}</a></span>
      ${controls}
      <span class="txstate"></span>
    </div>
  `;
}

function wireYourPieceRows(root, approved) {
  root.querySelectorAll('.list-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = btn.closest('.your-piece-row');
      doList(Number(row.dataset.id), row.querySelector('[data-role="price"]').value, approved, row);
    });
  });
  root.querySelectorAll('.update-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = btn.closest('.your-piece-row');
      doUpdatePrice(Number(row.dataset.id), row.querySelector('[data-role="price"]').value, row);
    });
  });
  root.querySelectorAll('.cancel-btn').forEach(btn => {
    btn.addEventListener('click', () => doCancel(Number(btn.closest('.your-piece-row').dataset.id), btn.closest('.your-piece-row')));
  });
}

async function doList(id, priceInput, approved, root) {
  const state = root.querySelector('.txstate');
  const price = parseAmountToWei(priceInput);
  if (!price) { state.textContent = 'enter a price in RWArt.'; return; }
  root.querySelectorAll('button').forEach(b => { b.disabled = true; });
  try {
    const wallet = walletClient || await connect({ prompt: true });
    if (!wallet) return;

    if (!approved) {
      state.textContent = 'step 1 of 2 · approve the market for your pieces…';
      const approveHash = await wallet.writeContract({
        address: artAddr, abi: artAbi, functionName: 'setApprovalForAll', args: [marketAddr, true], account,
      });
      showTxPending(root, approveHash);
      const approveReceipt = await pub.waitForTransactionReceipt({ hash: approveHash });
      if (approveReceipt.status !== 'success') throw new Error('approval transaction reverted');
    }

    state.textContent = 'confirm the listing in your wallet…';
    const { request } = await pub.simulateContract({
      address: marketAddr, abi: marketAbi, functionName: 'list', args: [BigInt(id), price], account,
    });
    const hash = await wallet.writeContract(request);
    showTxPending(root, hash);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error('list transaction reverted');
    state.textContent = 'listed.';
    refreshAll();
  } catch (err) {
    state.textContent = shortMessage(err, 'listing failed');
  } finally {
    root.querySelectorAll('button').forEach(b => { b.disabled = false; });
  }
}

async function doUpdatePrice(id, priceInput, root) {
  const state = root.querySelector('.txstate');
  const price = parseAmountToWei(priceInput);
  if (!price) { state.textContent = 'enter a price in RWArt.'; return; }
  root.querySelectorAll('button').forEach(b => { b.disabled = true; });
  try {
    const wallet = walletClient || await connect({ prompt: true });
    if (!wallet) return;
    state.textContent = 'confirm the update in your wallet…';
    const { request } = await pub.simulateContract({
      address: marketAddr, abi: marketAbi, functionName: 'updatePrice', args: [BigInt(id), price], account,
    });
    const hash = await wallet.writeContract(request);
    showTxPending(root, hash);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error('update transaction reverted');
    state.textContent = 'updated.';
    refreshAll();
  } catch (err) {
    state.textContent = shortMessage(err, 'update failed');
  } finally {
    root.querySelectorAll('button').forEach(b => { b.disabled = false; });
  }
}

async function doCancel(id, root) {
  const state = root.querySelector('.txstate');
  root.querySelectorAll('button').forEach(b => { b.disabled = true; });
  try {
    const wallet = walletClient || await connect({ prompt: true });
    if (!wallet) return;
    state.textContent = 'confirm the cancel in your wallet…';
    const { request } = await pub.simulateContract({
      address: marketAddr, abi: marketAbi, functionName: 'cancel', args: [BigInt(id)], account,
    });
    const hash = await wallet.writeContract(request);
    showTxPending(root, hash);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error('cancel transaction reverted');
    state.textContent = 'cancelled.';
    refreshAll();
  } catch (err) {
    state.textContent = shortMessage(err, 'cancel failed');
  } finally {
    root.querySelectorAll('button').forEach(b => { b.disabled = false; });
  }
}

async function renderYourPieces(root) {
  if (!NET.marketReady) { root.innerHTML = marketNotLiveNotice(); return; }
  if (!account) { root.innerHTML = '<p>connect a wallet to see the pieces you own.</p>'; return; }
  root.innerHTML = '<p>checking your pieces…</p>';

  let data;
  try {
    data = await loadPieces();
  } catch (err) {
    root.innerHTML = `<p>could not load the catalog. ${shortMessage(err, 'try again shortly')}</p>`;
    return;
  }

  let ownerResults;
  try {
    ownerResults = await pub.multicall({
      contracts: data.map(p => ({ address: artAddr, abi: artAbi, functionName: 'ownerOf', args: [BigInt(p.id)] })),
      allowFailure: true,
    });
  } catch (err) {
    root.innerHTML = `<p>could not read your pieces. ${shortMessage(err, 'try again shortly')}</p>`;
    return;
  }

  const owned = data.filter((p, i) => {
    const r = ownerResults[i];
    return r.status === 'success' && r.result && r.result.toLowerCase() === account.toLowerCase();
  });
  if (!owned.length) {
    root.innerHTML = '<p>this wallet does not own any pieces yet. <a href="./">browse the catalog</a>.</p>';
    return;
  }

  let listings, approved, feeBps;
  try {
    // three separate calls issued together so the client's multicall batching
    // (see chain.js) folds them into one request instead of three round trips
    const [listingsResult, approvedResult, feeBpsResult] = await Promise.all([
      pub.readContract({
        address: marketAddr, abi: marketAbi, functionName: 'listingsMany', args: [owned.map(p => BigInt(p.id))],
      }),
      pub.readContract({ address: artAddr, abi: artAbi, functionName: 'isApprovedForAll', args: [account, marketAddr] }),
      pub.readContract({ address: marketAddr, abi: marketAbi, functionName: 'feeBps' }),
    ]);
    const [sellers, prices, valid] = listingsResult;
    listings = owned.map((p, i) => ({ seller: sellers[i], price: prices[i], valid: valid[i] }));
    approved = approvedResult;
    feeBps = feeBpsResult;
  } catch (err) {
    root.innerHTML = `<p>could not read your listings. ${shortMessage(err, 'try again shortly')}</p>`;
    return;
  }

  const feePct = Number(feeBps) / 100;
  root.innerHTML = `
    <p class="market-reminder">claim your rewards before you sell, earning restarts for the new owner. <a href="./#collection">claim from your collection</a>.</p>
    <p class="market-fee-note">listings pay a ${feePct}% fee to the Safe on sale; you receive the rest.</p>
    ${owned.map((p, i) => yourPieceRowHtml(p, listings[i])).join('')}
  `;
  wireYourPieceRows(root, approved);
}

/* ---------- entry ---------- */

const forSaleBody = document.getElementById('forSaleBody');
const yourPiecesBody = document.getElementById('yourPiecesBody');

function refreshAll() {
  if (forSaleBody) renderForSale(forSaleBody);
  if (yourPiecesBody) renderYourPieces(yourPiecesBody);
}

function init() {
  wireWalletButton();
  fetch('data/catalog.json').then(res => res.ok ? res.json() : null).then(renderFooterAttribution).catch(() => {});
  onAccountChange = refreshAll;
  refreshAll();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
