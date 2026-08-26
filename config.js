// Live on Robinhood Chain mainnet. A host may override via
// window.MEADOW_RUNTIME = { rpcUrl, artAddress, tokenAddress, stocks }
// before modules load -- used for local/fork testing against anvil.
import { defineChain } from './vendor/viem.js';

export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

const active = {
  key: 'mainnet',
  label: 'robinhood chain',
  chainId: 4663,
  rpc: 'https://rpc.mainnet.chain.robinhood.com',
  walletRpc: 'https://rpc.mainnet.chain.robinhood.com',
  explorer: 'https://robinhoodchain.blockscout.com',
  art: '0x50414b4ea451A9E4ce7212F879F473fa727F8bb0', // MeadowArt (Robinhood Chain)
  token: '0xf2bc01ed47006fbd7dc5c9efd60037e8f516b560', // project token (meadow / RWArt)
  market: '', // MeadowMarket -- unset until deploy; the market page stays dormant until this is filled in
  // Vol. 2 is its own ERC-721 (MeadowArtV2, one piece per wallet on the
  // mint) with its own secondary market. Both unset until deployed: the 30
  // pieces still show in the gallery, buy/claim/list stay dormant.
  art2: '0xf9d6ff6423Af6d21e2F8bC93542630a41FE1303D', // MeadowArtV2 (Vol. 2), deployed 2026-08-26 block 46493057
  market2: '',
  // Only the stocks funded in the treasury Safe. Symbol order matches
  // onchain.json's stock_idx and the deployed contract's constructor argument
  // order. TSLA and MSFT are excluded until funded.
  stocks: [
    { symbol: 'AAPL', address: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9' },
    { symbol: 'NVDA', address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC' },
    { symbol: 'AMZN', address: '0x12f190a9F9d7D37a250758b26824B97CE941bF54' },
  ],
  launchpad: 'https://www.ponsfamily.com/launchpad',
};

export const NETWORKS = { mainnet: active };

const runtime = globalThis.MEADOW_RUNTIME || {};
const rpc = runtime.rpcUrl || active.rpc;
const art = runtime.artAddress || active.art;
const token = runtime.tokenAddress || active.token;
const market = runtime.marketAddress || active.market;
const art2 = runtime.art2Address || active.art2;
const market2 = runtime.market2Address || active.market2;
const stocks = runtime.stocks || active.stocks;

function volume(vol, label, artAddr, marketAddr, suffix, extra) {
  return Object.freeze({
    vol,
    label,
    art: artAddr,
    market: marketAddr,
    catalog: `data/catalog${suffix}.json`,
    onchain: `data/onchain${suffix}.json`,
    ready: Boolean(artAddr && token),
    activationIssue: token ? (artAddr ? '' : `${label} contract pending deploy`) : 'contract addresses pending',
    // the secondary market has its own contract and deploys separately from
    // primary mint/claim, so it gets its own readiness flag
    marketReady: Boolean(marketAddr && artAddr && token),
    ...extra,
  });
}

// One entry per drop, newest first (the gallery groups in this order). Each
// volume is a separate ERC-721 with its own catalog/onchain json pair and
// its own MeadowMarket. art/art.js is a classic script and keeps a matching
// list of the catalog paths.
export const VOLUMES = Object.freeze([
  volume(2, 'Vol. 2', art2, market2, '2', { onePerWallet: true }),
  volume(1, 'Vol. 1', art, market, '', { onePerWallet: false }),
]);

export const NET = Object.freeze({
  ...active,
  rpc,
  walletRpc: runtime.rpcUrl || active.walletRpc,
  art,
  token,
  market,
  art2,
  market2,
  stocks: Object.freeze(stocks.map(s => Object.freeze({ ...s }))),
  ready: VOLUMES.some(v => v.ready),
  activationIssue: token ? (VOLUMES.some(v => v.art) ? '' : 'art contract pending deploy') : 'contract addresses pending',
  marketReady: VOLUMES.some(v => v.marketReady),
});

export function addressUrl(address) {
  return address ? `${NET.explorer}/address/${address}` : null;
}

export const chain = defineChain({
  id: NET.chainId,
  name: NET.label,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [NET.rpc] } },
  blockExplorers: { default: { name: 'Blockscout', url: NET.explorer } },
  contracts: { multicall3: { address: MULTICALL3 } },
});

// what gets registered in the connecting wallet if it doesn't already know
// this chain -- the wallet-facing RPC, kept separate in case a read proxy is
// ever added in front of NET.rpc
export const walletChain = NET.walletRpc && NET.walletRpc !== NET.rpc
  ? { ...chain, rpcUrls: { default: { http: [NET.walletRpc] } } }
  : chain;

// Robinhood Chain's public RPC is read directly (no caching proxy here).
// Kept as a thin wrapper, not a bare fetch, so a proxy can be reintroduced
// later without touching call sites.
export function resilientReadTransport(customTransport) {
  let requestId = 0;

  async function rpc(method, params) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(NET.rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params: params || [] }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`rpc http ${response.status}`);
      const body = await response.json();
      if (body.error) {
        const error = new Error(body.error.message || 'rpc request failed');
        error.code = body.error.code;
        error.data = body.error.data;
        throw error;
      }
      return body.result;
    } finally {
      clearTimeout(timeout);
    }
  }

  return customTransport({
    async request({ method, params }) {
      return rpc(method, params);
    },
  }, { retryCount: 2 });
}
