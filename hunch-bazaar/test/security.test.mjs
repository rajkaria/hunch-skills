import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMMANDS, createRuntime, loadRegistry, postPaid, payloadSha256, checkX402Challenge, bazaarHttp } from '../scripts/bazaar.mjs';
const wallet = '0x' + '1'.repeat(40), creator = '0x' + '2'.repeat(40);
const signature = '0x' + 'a'.repeat(130);
const epoch = Date.parse('2026-09-18T00:00:00Z');
const response = (status, json) => new Response(JSON.stringify(json), { status });
function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bazaar-security-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = { now: epoch, signatures: [], payments: [], drafts: 0, bodies: [], due: null, failPaid: false, failSign: false };
  const terms = { walletAddress: wallet, scope: { marketId: 'market1' }, outcomeKey: 'yes', amountPerBet: '2.00', maxTotal: '4.00', maxBets: 2, cadence: 'daily', expiresAt: new Date(epoch + 7 * 86400000).toISOString(), ...overrides };
  const rt = createRuntime({ env: { WALLET: wallet, BANKR_API_KEY: 'private-key', BAZAAR_STATE_DIR: dir, BAZAAR_REQUESTING_USER: 'x:123' }, now: () => state.now, log: () => {}, sleep: async () => {}, fetch: async (url, init) => {
    assert.equal(init.redirect, 'manual');
    const body = init.body && JSON.parse(init.body);
    if (url.startsWith('https://api.bankr.bot/')) {
      assert.equal(url, 'https://api.bankr.bot/wallet/sign');
      state.signatures.push(body);
      await new Promise(r => setTimeout(r, 15));
      if (state.failSign) throw new Error('signer response lost');
      return response(200, { signature, signer: wallet });
    }
    assert.equal(init.headers['X-API-Key'], undefined);
    if (url.endsWith('/draft')) {
      state.drafts++;
      return response(200, { valid: true, summaryLine: 'approved terms', confirm: { body: structuredClone(terms), confirmBy: new Date(state.now + 120000).toISOString() } });
    }
    if (url.endsWith('/check')) return response(200, { status: 'due', walletAddress: wallet, bet: state.due });
    if (init.method === 'GET' && url.includes('/markets/')) return response(200, { market: { id: url.split('/').at(-1), createdAt: new Date(epoch + 1000).toISOString(), visibility: 'public', ...state.market }, creator: { wallet: state.creator ?? creator }, impliedOddsPct: { yes: state.odds ?? 30 } });
    if (url.endsWith('/bets')) {
      if (!init.headers['X-PAYMENT']) {
        const p = loadRegistry().signingPolicy.pinned;
        return response(402, { x402Version: 1, accepts: [{ scheme: 'exact', network: p.network, asset: p.asset, payTo: p.payTo, resource: url, maxAmountRequired: String(BigInt(body.amount.split('.')[0]) * 1000000n), extra: { name: p.assetName, version: p.assetVersion } }] });
      }
      state.payments.push(init.headers['X-PAYMENT']);
      if (state.failPaid) throw new Error('paid response lost');
      return response(201, { bet: { id: 'placed' } });
    }
    state.bodies.push(body);
    if (body.proof) return response(201, { standingBet: { id: 'grant1' } });
    const standing = url.endsWith('/standing-bets');
    const revoke = init.method === 'DELETE';
    const action = revoke ? 'revoke_standing_bet' : standing ? 'create_standing_bet' : 'create_market';
    const policy = loadRegistry().signingPolicy.walletProof;
    const intent = revoke ? 'revoke standing bet grant1' : standing ? 'standing bet: approved terms' : 'create market "approved"';
    const issuedAt = new Date(state.now).toISOString(), nonce = 'a'.repeat(32), sha = payloadSha256(body);
    const market = standing ? body.scope.marketId ?? '-' : '-';
    const message = [policy.domainLine, '', `Intent: ${intent}`, `Action: ${action}`, `Market: ${market}`, `Wallet: ${wallet}`, 'Chain ID: 8453', `Payload SHA-256: ${sha}`, `Issued At: ${issuedAt}`, `Nonce: ${nonce}`, `Version: ${policy.version}`, '', policy.footerLine].join('\n');
    return response(401, { error: 'wallet_proof_required', challenge: { scheme: policy.scheme, message, payloadSha256: sha, proof: { issuedAt, nonce } } });
  } });
  return { rt, state, terms, dir };
}
async function approve(f) {
  const preview = await COMMANDS['standing-bet-create'](f.rt, { json: '{}' });
  await COMMANDS['standing-bet-create'](f.rt, { confirm: 'true', 'preview-id': preview.json.previewId });
  f.state.signatures.length = 0;
  return preview;
}
const due = (f, extras = {}) => ({ marketId: 'market1', outcomeKey: 'yes', amount: '2.00', standingBetId: 'grant1', idempotencyKey: `sb:grant1:market1:d:${new Date(f.state.now).toISOString().slice(0,10).replaceAll('-','')}`, ...extras });
const paid = (f, key = 'payment-one', extras = {}) => postPaid(f.rt, { path: '/api/bazaar/v1/markets/market1/bets', marketId: 'market1', amount: '2.00', body: { walletAddress: wallet, amount: '2.00', outcomeKey: 'yes', idempotencyKey: key, ...extras } });

test('concurrent payments and retries after completion request exactly one authorization', async t => {
  const f = fixture(t);
  await Promise.all([paid(f), paid(f)]);
  await paid(f);
  assert.equal(f.state.signatures.length, 1); assert.equal(f.state.payments.length, 1);
  await assert.rejects(paid(f, 'payment-one', { outcomeKey: 'no' }), /different bet/);
});
test('dropped paid response reuses identical authorization after runtime restart', async t => {
  const f = fixture(t); f.state.failPaid = true;
  await assert.rejects(paid(f), /paid response lost/);
  f.state.failPaid = false; f.rt = createRuntime({ ...f.rt });
  await paid(f); assert.equal(f.state.signatures.length, 1);
  assert.equal(new Set(f.state.payments).size, 1);
});
test('uncertain signer result fails closed instead of signing again', async t => {
  const f = fixture(t); f.state.failSign = true;
  await assert.rejects(paid(f)); f.state.failSign = false;
  await assert.rejects(paid(f), /outcome uncertain/); assert.equal(f.state.signatures.length, 1);
});
test('keys formerly colliding after punctuation replacement remain distinct', async t => {
  const f = fixture(t); await paid(f, 'payment:one'); await paid(f, 'payment.one');
  assert.equal(f.state.signatures.length, 2);
});
for (const command of ['create', 'standing-bet-create']) {
  test(`${command} confirms saved body without redrafting or moving relative deadlines`, async t => {
    const f = fixture(t); const preview = await COMMANDS[command](f.rt, { json: '{"expiresIn":"7d"}' });
    const original = structuredClone(f.terms); f.terms.amountPerBet = '200'; f.terms.maxTotal = '2000'; f.state.now += 60000;
    await COMMANDS[command](f.rt, { confirm: 'true', 'preview-id': preview.json.previewId });
    assert.equal(f.state.drafts, 1);
    assert.deepEqual(f.state.bodies[0], original);
  });
  test(`${command} rejects missing, expired, changed terms and different user/wallet confirmation`, async t => {
    const f = fixture(t); const preview = await COMMANDS[command](f.rt, { json: '{}' });
    const flags = { confirm: 'true', 'preview-id': preview.json.previewId };
    await assert.rejects(COMMANDS[command](f.rt, { confirm: 'true', json: '{}' }));
    await assert.rejects(COMMANDS[command](f.rt, { ...flags, json: '{}' }), /new terms/);
    f.rt.env.BAZAAR_REQUESTING_USER = 'x:other'; await assert.rejects(COMMANDS[command](f.rt, flags), /mismatch/);
    f.rt.env.BAZAAR_REQUESTING_USER = 'x:123'; f.rt.env.WALLET = creator;
    await assert.rejects(COMMANDS[command](f.rt, flags), /mismatch/);
    f.rt.env.WALLET = wallet; f.state.now += 301000;
    await assert.rejects(COMMANDS[command](f.rt, flags), /expired/); assert.equal(f.state.signatures.length, 0);
  });
}
test('unknown grant cannot make the reproduced $200 signing request', async t => {
  const f = fixture(t); f.state.due = due(f, { amount: '200' });
  await assert.rejects(COMMANDS['standing-bet-run'](f.rt, { id: 'grant1' }), /unknown locally/);
  assert.equal(f.state.signatures.length, 0);
});
for (const [name, change] of Object.entries({ amount: { amount: '200' }, outcome: { outcomeKey: 'no' }, market: { marketId: 'market2', idempotencyKey: 'sb:grant1:market2:d:20260918' }, key: { idempotencyKey: 'malicious-key' } })) {
  test(`standing ${name} mismatch refused before signature`, async t => {
    const f = fixture(t); await approve(f); f.state.due = due(f, change);
    await assert.rejects(COMMANDS['standing-bet-run'](f.rt, { id: 'grant1' })); assert.equal(f.state.signatures.length, 0);
  });
}
test('standing budget persists across concurrent runs, days and runtime restarts', async t => {
  const f = fixture(t); await approve(f); f.state.due = due(f);
  await Promise.all([COMMANDS['standing-bet-run'](f.rt, { id: 'grant1' }), COMMANDS['standing-bet-run'](f.rt, { id: 'grant1' })]);
  f.state.now += 86400000; f.state.due = due(f); await COMMANDS['standing-bet-run'](f.rt, { id: 'grant1' });
  f.state.now += 86400000; f.state.due = due(f);
  await assert.rejects(COMMANDS['standing-bet-run'](f.rt, { id: 'grant1' }), /budget exhausted/);
  assert.equal(f.state.signatures.length, 2);
});
test('direct bet --standing-bet cannot bypass local grant guard', async t => {
  const f = fixture(t);
  await assert.rejects(COMMANDS.bet(f.rt, { id: 'market1', outcome: 'yes', amount: '2', 'standing-bet': 'grant1', 'idempotency-key': 'arbitrary-key' }), /unknown locally/);
});
test('expiry and local revocation stop new payments', async t => {
  const f = fixture(t); await approve(f); f.state.due = due(f);
  await COMMANDS['standing-bet-revoke'](f.rt, { id: 'grant1' }); f.state.signatures.length = 0;
  await assert.rejects(COMMANDS['standing-bet-run'](f.rt, { id: 'grant1' }), /revoked/);
  assert.equal(f.state.signatures.length, 0);
  const g = fixture(t); await approve(g); g.state.now += 8 * 86400000; g.state.due = due(g);
  await assert.rejects(COMMANDS['standing-bet-run'](g.rt, { id: 'grant1' }), /expired/);
});
test('creator scope and trigger are independently checked against the market card', async t => {
  const f = fixture(t, { scope: { creator }, cadence: 'once_per_market', trigger: { oddsBelowPct: 40 } });
  await approve(f); f.state.due = due(f, { idempotencyKey: 'sb:grant1:market1:m' });
  f.state.creator = wallet; await assert.rejects(COMMANDS['standing-bet-run'](f.rt, { id: 'grant1' }), /creator scope/);
  f.state.creator = creator; f.state.odds = 50; await assert.rejects(COMMANDS['standing-bet-run'](f.rt, { id: 'grant1' }), /trigger/);
  f.state.odds = 30; await COMMANDS['standing-bet-run'](f.rt, { id: 'grant1' }); assert.equal(f.state.signatures.length, 1);
});
test('payment pin substitutions and redirects are refused', async t => {
  const p = loadRegistry().signingPolicy.pinned;
  const challenge = { x402Version: 1, accepts: [{ scheme: 'exact', network: p.network, asset: p.asset, payTo: p.payTo, resource: 'https://bazaar.playhunch.xyz/api/bazaar/v1/markets/market1/bets', maxAmountRequired: '2000000', extra: { name: p.assetName, version: p.assetVersion } }] };
  for (const field of ['network', 'asset', 'payTo', 'resource', 'maxAmountRequired']) {
    const bad = structuredClone(challenge); bad.accepts[0][field] = 'wrong';
    assert.notEqual(checkX402Challenge(bad, { marketId: 'market1', amountAtomic: '2000000' }), 'ok');
  }
  const f = fixture(t); f.rt.fetch = async () => new Response('', { status: 302 });
  await assert.rejects(bazaarHttp(f.rt, 'GET', '/api/bazaar/v1/fees'), /redirect/);
});

test('independent CLI processes share a single durable payment authorization', async t => {
  const { spawn } = await import('node:child_process');
  const f = fixture(t), log = join(f.dir, 'signatures.log');
  const worker = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL('./payment-worker.mjs', import.meta.url).pathname], { env: { ...process.env, TEST_STATE: f.dir, TEST_LOG: log }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; child.stderr.on('data', b => err += b); child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(err)));
  });
  await Promise.all([worker(), worker()]); await worker();
  assert.equal(readFileSync(log, 'utf8'), 'signature\n');
});

test('concurrent distinct standing intents cannot over-reserve total budget', async t => {
  const f = fixture(t, { scope: { creator }, cadence: 'once_per_market', maxTotal: '2.00', maxBets: 10 });
  await approve(f);
  const intent = marketId => postPaid(f.rt, { path: `/api/bazaar/v1/markets/${marketId}/bets`, marketId, amount: '2.00', body: { walletAddress: wallet, amount: '2.00', outcomeKey: 'yes', standingBetId: 'grant1', idempotencyKey: `sb:grant1:${marketId}:m` } });
  const results = await Promise.allSettled([intent('market1'), intent('market2')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.state.signatures.length, 1);
});
test('max bet count is enforced independently of total budget', async t => {
  const f = fixture(t, { maxBets: 1, maxTotal: '100.00' }); await approve(f);
  f.state.due = due(f); await COMMANDS['standing-bet-run'](f.rt, { id: 'grant1' });
  f.state.now += 86400000; f.state.due = due(f);
  await assert.rejects(COMMANDS['standing-bet-run'](f.rt, { id: 'grant1' }), /budget exhausted/);
  assert.equal(f.state.signatures.length, 1);
});
test('failed remote revocation still blocks local automation', async t => {
  const f = fixture(t); await approve(f); f.state.due = due(f);
  const fetch = f.rt.fetch;
  f.rt.fetch = async (url, init) => { if (init.method === 'DELETE') throw new Error('offline'); return fetch(url, init); };
  await assert.rejects(COMMANDS['standing-bet-revoke'](f.rt, { id: 'grant1' }), /offline/);
  await assert.rejects(COMMANDS['standing-bet-run'](f.rt, { id: 'grant1' }), /revoked/);
  assert.equal(f.state.signatures.length, 0);
});
test('grant expiry during the payment challenge is checked again before signing', async t => {
  const f = fixture(t); await approve(f); f.state.due = due(f);
  const fetch = f.rt.fetch;
  f.rt.fetch = async (url, init) => { const result = await fetch(url, init); if (url.endsWith('/bets')) f.state.now += 8 * 86400000; return result; };
  await assert.rejects(COMMANDS['standing-bet-run'](f.rt, { id: 'grant1' }), /expired before signing/);
  assert.equal(f.state.signatures.length, 0);
});
test('legacy in-flight payment is never silently replaced by a fresh authorization', async t => {
  const { writeFileSync } = await import('node:fs');
  const f = fixture(t); writeFileSync(join(f.dir, 'x402-payment-one.json'), '{}');
  await assert.rejects(paid(f), /legacy payment/); assert.equal(f.state.signatures.length, 0);
});
test('preview tampering is rejected and successful confirmations never reset grant budget', async t => {
  const { writeFileSync } = await import('node:fs');
  const f = fixture(t), preview = await approve(f);
  f.state.due = due(f); await COMMANDS['standing-bet-run'](f.rt, { id: 'grant1' });
  const grantFile = readdirSync(f.dir).find(name => name.startsWith('grant-'));
  const before = readFileSync(join(f.dir, grantFile), 'utf8');
  await COMMANDS['standing-bet-create'](f.rt, { confirm: 'true', 'preview-id': preview.json.previewId });
  assert.equal(readFileSync(join(f.dir, grantFile), 'utf8'), before);
  const g = fixture(t); const other = await COMMANDS.create(g.rt, { json: '{}' });
  const path = join(g.dir, readdirSync(g.dir).find(name => name.startsWith('preview-')));
  const saved = JSON.parse(readFileSync(path, 'utf8')); saved.body.maxTotal = '2000'; writeFileSync(path, JSON.stringify(saved));
  await assert.rejects(COMMANDS.create(g.rt, { confirm: 'true', 'preview-id': other.json.previewId }), /changed/);
  assert.equal(g.state.signatures.length, 0);
});
