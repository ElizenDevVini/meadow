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
  art: '', // MeadowArt -- set after deploy
  token: '', // project token -- set after deploy
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
const stocks = runtime.stocks || active.stocks;

export const NET = Object.freeze({
  ...active,
  rpc,
  walletRpc: runtime.rpcUrl || active.walletRpc,
  art,
  token,
  stocks: Object.freeze(stocks.map(s => Object.freeze({ ...s }))),
  ready: Boolean(art && token),
  activationIssue: art && token ? '' : 'contract addresses pending',
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
