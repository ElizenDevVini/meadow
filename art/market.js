// Secondary market page: list, buy, cancel, and update-price for minted
// Meadow art pieces, peer to peer in RWArt. onchain.js exports nothing (it's
// a plain script, not a module), so the EIP-6963 wallet-connect plumbing is
// duplicated here rather than imported. Stays fully dormant -- no RPC calls
// -- until NET.marketReady, same discipline as onchain.js does for NET.ready.
//
// art.js loads as a classic (non-module) script before this module script,
// so its top-level function declarations (drawSpark, fmtUsd, fmtDate,
// initReveal) are already on the global object by the time this file runs,
// and are used directly below rather than reimplemented.
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

// Kept separate from marketAbi (which viem's parseAbi would happily also
// accept these signatures into) so getLogs's `events` list is exactly the
// two events the market page reads, nothing else.
const marketEventsAbi = parseAbi([
  'event Listed(uint256 indexed tokenId, address indexed seller, uint256 price)',
  'event Sold(uint256 indexed tokenId, address indexed seller, address indexed buyer, uint256 price, uint256 fee)',
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

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
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

// mirrors MeadowMarket.buy()'s fee split exactly (fee = price * feeBps / BPS,
// integer division, BPS = 10_000) so the preview never drifts from what the
// contract actually charges
function computeProceeds(priceWei, feeBps) {
  const fee = (priceWei * BigInt(feeBps)) / 10_000n;
  return { fee, proceeds: priceWei - fee };
}

function plateHtml(artist) {
  return `<div class="plate" role="img" aria-label="${artist}, no image available"><span>${artist}</span></div>`;
}

function marketNotLiveNotice() {
  return `<div class="not-live">
    <p>the secondary market isn't live yet. once MeadowMarket deploys, holders can list pieces here.</p>
    <a class="btn btn-outline" href="./">back to the catalog</a>
  </div>`;
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
    return {
      id: w.id,
      slug: w.slug,
      title: w.title,
      artist: c?.artist || '',
      img: c?.img || null,
      worth: c?.last?.price_usd ?? null,
      spark: c?.spark || [],
      stockSymbol: w.stock_symbol,
    };
  });
  return pieces;
}

/* ---------- pure helpers: stats, sorting, activity feed ----------
   No DOM access in this block -- see scratchpad/market-helpers.test.mjs
   (thrown away after use) for the node harness that exercised these against
   mock listings/logs. */

function computeMarketStats(listed, soldLogs) {
  const floor = listed.length ? listed.reduce((min, l) => (l.price < min ? l.price : min), listed[0].price) : null;
  const volume = soldLogs.reduce((sum, s) => sum + s.args.price, 0n);
  const lastSale = soldLogs.reduce((latest, s) => {
    if (!latest) return s;
    if (s.blockNumber !== latest.blockNumber) return s.blockNumber > latest.blockNumber ? s : latest;
    return Number(s.logIndex) > Number(latest.logIndex) ? s : latest;
  }, null);
  return {
    floor,
    listedCount: listed.length,
    volume,
    salesCount: soldLogs.length,
    lastSalePrice: lastSale ? lastSale.args.price : null,
  };
}

// tokenId (Number) -> highest blockNumber (BigInt) any Listed event for it
// landed in. Only meaningful for tokens that are still validly listed today
// (isListingValid already filters out cancelled/stale/resold ones upstream).
function latestListedBlockByToken(listedLogs) {
  const map = new Map();
  for (const log of listedLogs) {
    const id = Number(log.args.tokenId);
    const bn = log.blockNumber;
    const cur = map.get(id);
    if (cur == null || bn > cur) map.set(id, bn);
  }
  return map;
}

function sortListings(listed, key, recentBlockById) {
  const arr = listed.slice();
  if (key === 'price-asc') return arr.sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0));
  if (key === 'price-desc') return arr.sort((a, b) => (a.price < b.price ? 1 : a.price > b.price ? -1 : 0));
  // 'recent': newest Listed block first; a listing with no matching event
  // (shouldn't normally happen, since every valid listing came from a list()
  // call) sorts last rather than crashing the comparator
  return arr.sort((a, b) => {
    const ba = recentBlockById.get(a.id);
    const bb = recentBlockById.get(b.id);
    if (ba == null && bb == null) return 0;
    if (ba == null) return 1;
    if (bb == null) return -1;
    return ba < bb ? 1 : ba > bb ? -1 : 0;
  });
}

function buildActivityFeed(listedLogs, soldLogs, piecesById, limit = 20) {
  const rows = [
    ...listedLogs.map(l => ({ kind: 'listed', tokenId: l.args.tokenId, price: l.args.price, blockNumber: l.blockNumber, logIndex: l.logIndex, txHash: l.transactionHash })),
    ...soldLogs.map(s => ({ kind: 'sold', tokenId: s.args.tokenId, price: s.args.price, blockNumber: s.blockNumber, logIndex: s.logIndex, txHash: s.transactionHash })),
  ];
  rows.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? 1 : -1;
    return Number(b.logIndex) - Number(a.logIndex);
  });
  return rows.slice(0, limit).map(r => ({
    ...r,
    title: piecesById.get(Number(r.tokenId))?.title || `piece #${r.tokenId}`,
  }));
}

/* ---------- market stats bar ---------- */

// eventsError is set when getLogs failed but listingsMany/feeBps still
// succeeded (see renderMarket) -- floor/listed/fee stay real, volume/last
// sale fall back to "unavailable" instead of misreporting zero
function renderMarketStats(root, stats, feeBps, eventsError) {
  const feePct = Number(feeBps) / 100;
  const floorText = stats.floor != null ? `${fmtAmount(stats.floor)} RWArt` : 'n/a';
  const volumeText = eventsError
    ? 'unavailable'
    : stats.salesCount > 0
      ? `${fmtAmount(stats.volume)} RWArt across ${stats.salesCount} sale${stats.salesCount === 1 ? '' : 's'}`
      : 'no sales yet';
  const lastSaleText = eventsError ? 'unavailable' : (stats.lastSalePrice != null ? `${fmtAmount(stats.lastSalePrice)} RWArt` : 'n/a');
  root.innerHTML = `
    <p class="stats-line">floor <strong>${floorText}</strong> · listed <strong>${stats.listedCount}</strong> · fee <strong>${feePct}%</strong></p>
    <p class="stats-line">volume <strong>${volumeText}</strong> · last sale <strong>${lastSaleText}</strong></p>
    ${eventsError ? `<p class="market-error">could not read sale history. ${shortMessage(eventsError, 'try again shortly')}</p>` : ''}
  `;
}

/* ---------- for sale ---------- */

let forSaleSort = 'recent';
let forSaleArtist = '';

function marketCardHtml(l, feeBps) {
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
  const { fee, proceeds } = computeProceeds(l.price, feeBps);
  const worthText = l.worth != null ? fmtUsd(l.worth) : 'n/a';
  return `
    <div class="market-card" data-id="${l.id}">
      <a class="title-link" href="work.html?id=${l.slug}">
        <div class="thumb">${thumb}</div>
        <p class="title">${l.title}</p>
        <p class="meta">${l.artist}</p>
      </a>
      <canvas class="spark" width="96" height="24" data-spark="${l.id}"></canvas>
      <p class="price-line">${fmtAmount(l.price)} RWArt</p>
      <p class="worth-line">worth ${worthText} · pays ${l.stockSymbol}</p>
      <p class="fee-line">fee ${fmtAmount(fee)} RWArt · seller receives ${fmtAmount(proceeds)} RWArt</p>
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

// Sort/filter changes re-render from the already-fetched `listed` array --
// no new RPC call, matching how the catalog page's own controls work.
function renderForSale(root, listed, recentBlockById, feeBps) {
  if (!listed.length) {
    root.innerHTML = '<p class="market-empty">nothing listed yet. holders can list a piece from "your pieces" below.</p>';
    return;
  }

  const artists = [...new Set(listed.map(l => l.artist).filter(Boolean))].sort();
  const artistOptions = '<option value="">all artists</option>' +
    artists.map(a => `<option value="${a}"${a === forSaleArtist ? ' selected' : ''}>${a}</option>`).join('');

  root.innerHTML = `
    <div class="controls">
      <label>sort
        <select id="marketSort">
          <option value="recent"${forSaleSort === 'recent' ? ' selected' : ''}>recently listed</option>
          <option value="price-asc"${forSaleSort === 'price-asc' ? ' selected' : ''}>price, low to high</option>
          <option value="price-desc"${forSaleSort === 'price-desc' ? ' selected' : ''}>price, high to low</option>
        </select>
      </label>
      <label>artist
        <select id="marketArtist">${artistOptions}</select>
      </label>
    </div>
    <p class="market-summary" id="marketCount"></p>
    <div class="market-grid" id="marketGrid"></div>
  `;

  const grid = root.querySelector('#marketGrid');
  const count = root.querySelector('#marketCount');

  const paint = () => {
    const filtered = forSaleArtist ? listed.filter(l => l.artist === forSaleArtist) : listed;
    const rows = sortListings(filtered, forSaleSort, recentBlockById);
    count.textContent = `${rows.length} of ${listed.length} listed`;
    if (!rows.length) {
      grid.innerHTML = '<p class="market-empty">no listings match this filter.</p>';
      return;
    }
    grid.innerHTML = rows.map(l => marketCardHtml(l, feeBps)).join('');
    for (const canvas of grid.querySelectorAll('canvas[data-spark]')) {
      const l = rows.find(r => String(r.id) === canvas.dataset.spark);
      if (l?.spark?.length) drawSpark(canvas, l.spark);
    }
    wireBuyButtons(grid, rows);
  };

  root.querySelector('#marketSort').addEventListener('change', e => { forSaleSort = e.target.value; paint(); });
  root.querySelector('#marketArtist').addEventListener('change', e => { forSaleArtist = e.target.value; paint(); });
  paint();
}

/* ---------- activity feed ---------- */

function activityRowHtml(row) {
  const verb = row.kind === 'sold' ? 'sold' : 'listed';
  return `<p class="activity-row">${verb} ${row.title} for ${fmtAmount(row.price)} RWArt · <a href="${txUrl(row.txHash)}" target="_blank" rel="noopener">tx</a></p>`;
}

function renderActivity(root, activity, eventsError) {
  if (eventsError) { root.innerHTML = `<p class="market-error">could not load activity. ${shortMessage(eventsError, 'try again shortly')}</p>`; return; }
  if (!activity.length) { root.innerHTML = '<p class="market-empty">no activity yet.</p>'; return; }
  root.innerHTML = activity.map(activityRowHtml).join('');
}

/* ---------- market stats + for sale + activity: one shared fetch ---------- */

async function renderMarket(statsRoot, forSaleRoot, activityRoot) {
  if (statsRoot) statsRoot.innerHTML = '<p class="market-loading">loading market stats…</p>';
  if (forSaleRoot) forSaleRoot.innerHTML = '<p class="market-loading">checking listings…</p>';
  if (activityRoot) activityRoot.innerHTML = '<p class="market-loading">loading activity…</p>';

  let piecesData, listingsResult, feeBps;
  try {
    piecesData = await loadPieces();
    // Issued together (not awaited one at a time) so chain.js's multicall
    // batching folds these two readContract calls into one request.
    [listingsResult, feeBps] = await Promise.all([
      pub.readContract({
        address: marketAddr, abi: marketAbi, functionName: 'listingsMany', args: [piecesData.map(p => BigInt(p.id))],
      }),
      pub.readContract({ address: marketAddr, abi: marketAbi, functionName: 'feeBps' }),
    ]);
  } catch (err) {
    const msg = `<p class="market-error">could not read the market. ${shortMessage(err, 'try again shortly')}</p>`;
    if (statsRoot) statsRoot.innerHTML = msg;
    if (forSaleRoot) forSaleRoot.innerHTML = msg;
    if (activityRoot) activityRoot.innerHTML = msg;
    return;
  }

  const [sellers, prices, valid] = listingsResult;
  const listed = piecesData
    .map((p, i) => ({ ...p, seller: sellers[i], price: prices[i] }))
    .filter((_, i) => valid[i]);

  // getLogs is a plain eth_getLogs, not part of the multicall batch above,
  // and is read separately so a failure here (e.g. a public RPC refusing a
  // full-history range) degrades stats/activity to "unavailable" instead of
  // blanking the for-sale grid, which already has everything it needs from
  // listingsMany. fromBlock 0n because no market deploy block is known yet
  // -- see the report for what that costs against a real RPC.
  let listedLogs = [], soldLogs = [], eventsError = null;
  try {
    const logs = await pub.getLogs({ address: marketAddr, events: marketEventsAbi, fromBlock: 0n, toBlock: 'latest' });
    listedLogs = logs.filter(l => l.eventName === 'Listed');
    soldLogs = logs.filter(l => l.eventName === 'Sold');
  } catch (err) {
    eventsError = err;
  }

  const stats = computeMarketStats(listed, soldLogs);
  const recentBlockById = latestListedBlockByToken(listedLogs);
  const piecesById = new Map(piecesData.map(p => [p.id, p]));
  const activity = buildActivityFeed(listedLogs, soldLogs, piecesById);

  if (statsRoot) renderMarketStats(statsRoot, stats, feeBps, eventsError);
  if (forSaleRoot) renderForSale(forSaleRoot, listed, recentBlockById, feeBps);
  if (activityRoot) renderActivity(activityRoot, activity, eventsError);
}

/* ---------- your pieces ---------- */

function listingStatusText(listing) {
  if (!listing.seller || listing.seller === ZERO_ADDRESS) return 'not listed';
  if (listing.valid) return `listed at ${fmtAmount(listing.price)} RWArt`;
  return 'listing inactive · re-approve the market to reactivate';
}

function yourPieceRowHtml(p, listing) {
  const isListed = listing.valid && listing.seller.toLowerCase() === account.toLowerCase();
  const worthLine = `<span class="meta piece-worth">worth ${p.worth != null ? fmtUsd(p.worth) : 'n/a'} · pays ${p.stockSymbol}</span>`;
  const controls = isListed
    ? `
      <span class="meta">${listingStatusText(listing)}</span>
      <input class="price-input" type="text" inputmode="decimal" placeholder="new price" data-role="price">
      <span class="proceeds-preview" data-role="proceeds"></span>
      <button class="btn btn-outline update-btn" type="button">update price</button>
      <button class="btn btn-outline cancel-btn" type="button">cancel</button>
    `
    : `
      <span class="meta">${listingStatusText(listing)}</span>
      <input class="price-input" type="text" inputmode="decimal" placeholder="price in RWArt" data-role="price">
      <span class="proceeds-preview" data-role="proceeds"></span>
      <button class="btn btn-dark list-btn" type="button">list</button>
    `;
  return `
    <div class="your-piece-row" data-id="${p.id}">
      <span class="your-piece-title"><a href="work.html?id=${p.slug}">${p.title}</a>${worthLine}</span>
      ${controls}
      <span class="txstate"></span>
    </div>
  `;
}

function wireYourPieceRows(root, approved, feeBps) {
  root.querySelectorAll('.your-piece-row').forEach(row => {
    const input = row.querySelector('[data-role="price"]');
    const preview = row.querySelector('[data-role="proceeds"]');
    input.addEventListener('input', () => {
      const wei = parseAmountToWei(input.value);
      if (!wei) { preview.textContent = ''; return; }
      const { fee, proceeds } = computeProceeds(wei, feeBps);
      preview.textContent = `fee ${fmtAmount(fee)} RWArt · you receive ${fmtAmount(proceeds)} RWArt`;
    });
  });
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
  if (!account) { root.innerHTML = '<p>connect a wallet to see the pieces you own.</p>'; return; }
  root.innerHTML = '<p class="market-loading">checking your pieces…</p>';

  let data;
  try {
    data = await loadPieces();
  } catch (err) {
    root.innerHTML = `<p class="market-error">could not load the catalog. ${shortMessage(err, 'try again shortly')}</p>`;
    return;
  }

  let ownerResults;
  try {
    ownerResults = await pub.multicall({
      contracts: data.map(p => ({ address: artAddr, abi: artAbi, functionName: 'ownerOf', args: [BigInt(p.id)] })),
      allowFailure: true,
    });
  } catch (err) {
    root.innerHTML = `<p class="market-error">could not read your pieces. ${shortMessage(err, 'try again shortly')}</p>`;
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
    root.innerHTML = `<p class="market-error">could not read your listings. ${shortMessage(err, 'try again shortly')}</p>`;
    return;
  }

  const feePct = Number(feeBps) / 100;
  root.innerHTML = `
    <p class="market-reminder">claim your rewards before you sell, earning restarts for the new owner. <a href="./#collection">claim from your collection</a>.</p>
    <p class="market-fee-note">listings pay a ${feePct}% fee to the Safe on sale; you receive the rest.</p>
    ${owned.map((p, i) => yourPieceRowHtml(p, listings[i])).join('')}
  `;
  wireYourPieceRows(root, approved, feeBps);
}

/* ---------- entry ---------- */

const marketStatsBody = document.getElementById('marketStatsBody');
const forSaleBody = document.getElementById('forSaleBody');
const activityBody = document.getElementById('activityBody');
const yourPiecesBody = document.getElementById('yourPiecesBody');

function refreshAll() {
  renderMarket(marketStatsBody, forSaleBody, activityBody);
  if (yourPiecesBody) renderYourPieces(yourPiecesBody);
}

function init() {
  wireWalletButton();
  fetch('data/catalog.json').then(res => res.ok ? res.json() : null).then(renderFooterAttribution).catch(() => {});

  const sections = document.getElementById('marketSections');
  const notice = document.getElementById('marketNotice');
  if (!NET.marketReady) {
    // Dormant: no market reads, no getLogs, nothing below this point runs.
    // wireWalletButton() above still works off NET.ready (art+token), same
    // as onchain.js elsewhere -- connecting a wallet here just has nothing
    // market-specific to do yet.
    if (sections) sections.hidden = true;
    if (notice) {
      const body = notice.querySelector('.panel-body');
      if (body) body.innerHTML = marketNotLiveNotice();
      notice.hidden = false;
    }
    return;
  }

  if (notice) notice.hidden = true;
  onAccountChange = refreshAll;
  refreshAll();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

// Exported for the node harness only (art.js/market.html never import this
// module, so these are inert in the browser) -- lets the harness exercise
// the real implementations instead of a re-typed copy.
export { fmtAmount, parseAmountToWei, computeProceeds, computeMarketStats, latestListedBlockByToken, sortListings, buildActivityFeed };
