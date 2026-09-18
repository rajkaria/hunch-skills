import { appendFileSync } from 'node:fs';
import { createRuntime, loadRegistry, postPaid } from '../scripts/bazaar.mjs';
const wallet = '0x' + '1'.repeat(40);
const rt = createRuntime({ env: { WALLET: wallet, BANKR_API_KEY: 'test', BAZAAR_STATE_DIR: process.env.TEST_STATE }, log: () => {}, fetch: async (url, options) => {
  if (url === 'https://api.bankr.bot/wallet/sign') {
    appendFileSync(process.env.TEST_LOG, 'signature\n');
    await new Promise(r => setTimeout(r, 150));
    return Response.json({ signature: '0x' + 'a'.repeat(130), signer: wallet });
  }
  if (options.headers['X-PAYMENT']) return Response.json({ bet: 'done' });
  const p = loadRegistry().signingPolicy.pinned;
  return Response.json({ x402Version: 1, accepts: [{ scheme: 'exact', network: p.network, asset: p.asset, payTo: p.payTo, resource: url, maxAmountRequired: '2000000', extra: { name: p.assetName, version: p.assetVersion } }] }, { status: 402 });
} });
await postPaid(rt, { path: '/api/bazaar/v1/markets/market1/bets', marketId: 'market1', amount: '2.00', body: { walletAddress: wallet, outcomeKey: 'yes', amount: '2.00', idempotencyKey: 'same-process-key' } });
