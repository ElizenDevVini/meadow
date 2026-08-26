// Shared read-only client. art/onchain.js drives all wallet + write logic;
// this file just wires up the public client so both the buy panel and the
// collection scan share one batched connection.
import { createPublicClient, custom } from './vendor/viem.js';
import { chain, resilientReadTransport } from './config.js';

export const pub = createPublicClient({
  chain,
  // batches reads issued in the same tick into one RPC call -- helps the
  // collection view, which reads ownerOf for every catalog id
  batch: { multicall: { wait: 16, batchSize: 1024 } },
  transport: resilientReadTransport(custom),
});
