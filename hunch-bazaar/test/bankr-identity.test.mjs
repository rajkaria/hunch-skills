import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../scripts/bazaar.mjs';

const wallet = `0x${'1'.repeat(40)}`;
const otherWallet = `0x${'2'.repeat(40)}`;
const response = (status, json) => new Response(JSON.stringify(json), { status });

test('a Bankr X create preview uses the API-key wallet without caller-supplied identity', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bazaar-bankr-identity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const output = [];
  const code = await run(['create', '--json', '{}'], {
    env: { HUNCH_BANKR_API_KEY: 'private-key', BAZAAR_STATE_DIR: dir },
    out: line => output.push(JSON.parse(line)),
    log: () => {},
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url === 'https://api.bankr.bot/wallet/me') {
        assert.equal(init.headers['X-API-Key'], 'private-key');
        return response(200, { wallets: [{ chain: 'evm', address: wallet }] });
      }
      assert.equal(url, 'https://bazaar.playhunch.xyz/api/bazaar/v1/markets/draft');
      assert.equal(init.headers['X-API-Key'], undefined);
      assert.equal(JSON.parse(init.body).walletAddress, wallet);
      return response(200, { valid: true, summaryLine: 'approved terms', confirm: {
        body: { walletAddress: wallet, question: 'Will it happen?' },
        confirmBy: new Date(Date.now() + 120000).toISOString(),
      } });
    },
  });
  assert.equal(code, 0);
  assert.match(output[0].previewId, /^[a-f0-9]{48}$/);
  assert.equal(calls.length, 2);
});

test('Bankr identity refuses a supplied wallet that differs from the API-key wallet', async () => {
  const logs = [];
  const code = await run(['create', '--json', '{}'], {
    env: { HUNCH_BANKR_API_KEY: 'private-key', WALLET: otherWallet },
    log: line => logs.push(line),
    fetch: async url => {
      assert.equal(url, 'https://api.bankr.bot/wallet/me');
      return response(200, { wallets: [{ chain: 'evm', address: wallet }] });
    },
  });
  assert.equal(code, 1);
  assert.match(logs.join(' '), /wallet mismatch/i);
});

test('a different authenticated Bankr wallet cannot confirm a saved preview', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bazaar-bankr-owner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = [];
  const fetch = async (url, init) => {
    if (url === 'https://api.bankr.bot/wallet/me') {
      const address = init.headers['X-API-Key'] === 'first-key' ? wallet : otherWallet;
      return response(200, { wallets: [{ chain: 'evm', address }] });
    }
    assert.equal(url, 'https://bazaar.playhunch.xyz/api/bazaar/v1/markets/draft');
    return response(200, { valid: true, summaryLine: 'approved terms', confirm: {
      body: { walletAddress: wallet, question: 'Will it happen?' },
      confirmBy: new Date(Date.now() + 120000).toISOString(),
    } });
  };
  const first = await run(['create', '--json', '{}'], {
    env: { HUNCH_BANKR_API_KEY: 'first-key', BAZAAR_STATE_DIR: dir, BAZAAR_REQUESTING_USER: 'x:forged' },
    fetch, out: line => output.push(JSON.parse(line)), log: () => {},
  });
  assert.equal(first, 0);
  const logs = [];
  const second = await run(['create', '--confirm', '--preview-id', output[0].previewId], {
    env: { HUNCH_BANKR_API_KEY: 'second-key', BAZAAR_STATE_DIR: dir, BAZAAR_REQUESTING_USER: 'x:forged' },
    fetch, log: line => logs.push(line),
  });
  assert.equal(second, 1);
  assert.match(logs.join(' '), /mismatch/);
});

test('Bankr create refuses missing private credential before contacting Bazaar', async () => {
  const logs = [];
  const code = await run(['create', '--json', '{}'], {
    env: {},
    log: line => logs.push(line),
    fetch: async () => { throw new Error('must not fetch'); },
  });
  assert.equal(code, 1);
  assert.match(logs.join(' '), /HUNCH_BANKR_API_KEY/);
});
