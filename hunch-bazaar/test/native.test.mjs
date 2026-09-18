import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNative, encode, decode } from '../scripts/bazaar-native.mjs';
import { loadRegistry, payloadSha256, intentValue } from '../scripts/bazaar.mjs';
const start = Date.parse('2026-09-19T12:00:00Z');
function fixture() {
  const state = { now: start, writes: [], existing: null, corrupt: false, lost: false };
  const identity = { wallet: '0x' + '1'.repeat(40), postId: '1234567890123456789', handle: 'alice' };
  const options = () => ({ env: {}, now: () => state.now, fetch: async (url, init) => {
    assert.ok(url.startsWith('https://bazaar.playhunch.xyz/api/bazaar/'));
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers['X-API-Key'], undefined);
    const response = (status, json) => new Response(JSON.stringify(json), { status });
    if (url.endsWith('/fees')) return response(200, { settlementFeeBps: 200, creatorFee: { bps: 100, optional: false, shareOfFeePct: 50 } });
    if (url.includes('/by-tweet/')) return state.existing ? response(200, state.existing) : response(404, {});
    const body = JSON.parse(init.body);
    if (url.endsWith('/draft')) return response(200, { valid: true, terms: { settlementFeeBps: 200 }, confirm: { body: { ...body, closeAt: new Date(start + 86400000).toISOString() }, confirmBy: new Date(start + 3600000).toISOString() } });
    state.writes.push(body);
    if (body.proof) {
      state.existing = { market: { id: 'market1' }, creator: { wallet: body.walletAddress } };
      if (state.lost) throw new Error('response lost');
      return response(201, state.existing);
    }
    const p = loadRegistry().signingPolicy.walletProof;
    const issuedAt = new Date(state.now).toISOString(), nonce = 'a'.repeat(32), sha = payloadSha256(body);
    const message = [p.domainLine, '', `Intent: create market "${intentValue(body.title)}"`, 'Action: create_market', 'Market: -', `Wallet: ${body.walletAddress}`, 'Chain ID: 8453', `Payload SHA-256: ${state.corrupt ? 'bad' : sha}`, `Issued At: ${issuedAt}`, `Nonce: ${nonce}`, 'Version: 1', '', p.footerLine].join('\n');
    return response(401, { error: 'wallet_proof_required', challenge: { scheme: p.scheme, message, payloadSha256: sha, proof: { issuedAt, nonce } } });
  } });
  return { state, identity, call: (cmd, a) => runNative(cmd, a, options()), preview: async () => ({ ...identity, ...await runNative('preview', { ...identity, data: { title: 'Will it rain?', criteria: 'Official weather report', outcomeKeys: ['yes','no'] } }, options()) }) };
}
test('separate empty-env runtimes preserve exact preview and native message without local files', async () => {
  const f = fixture(), a = await f.preview();
  assert.equal(a.approvedBody.creatorFeeBps, 100);
  const p = await f.call('prepare', a);
  assert.equal(p.signData.payloadType, 'message');
  assert.equal(p.signData.payload, decode(p.signingContext).challenge.message);
  const result = await f.call('submit', { ...a, ...p, signature: '0x' + 'a'.repeat(130) });
  assert.equal(result.status, 201);
  const { proof, ...body } = f.state.writes.at(-1);
  assert.deepEqual(body, a.approvedBody);
  assert.equal((await f.call('prepare', a)).replayed, true);
  assert.equal(f.state.writes.length, 2);
});
test('two users bind their own wallets independently', async () => {
  for (const digit of ['1','2']) {
    const f = fixture(); f.identity.wallet = '0x' + digit.repeat(40);
    const a = await f.preview(); const p = await f.call('prepare', a);
    assert.ok(p.signData.payload.includes(`Wallet: ${f.identity.wallet}`));
  }
});
for (const field of ['wallet','postId','handle']) test(`rejects another ${field}`, async () => {
  const f = fixture(), a = await f.preview();
  a[field] = field === 'wallet' ? '0x' + '2'.repeat(40) : field === 'postId' ? '9999' : 'bob';
  await assert.rejects(f.call('prepare', a), /identity mismatch/); assert.equal(f.state.writes.length, 0);
});
test('tampered market body cannot reuse displayed preview commitment', async () => {
  const f = fixture(), a = await f.preview(), record = decode(a.preview);
  record.body.title = 'Different terms'; a.preview = encode(record);
  await assert.rejects(f.call('prepare', a), /original confirmed preview/);
});
test('expired preview requires new consent', async () => {
  const f = fixture(), a = await f.preview(); f.state.now += 300001;
  await assert.rejects(f.call('prepare', a), /expired/);
});
test('malicious challenge refused before signing and again before submission', async () => {
  const f = fixture(), a = await f.preview(); f.state.corrupt = true;
  await assert.rejects(f.call('prepare', a), /Not signing/);
  f.state.corrupt = false; const p = await f.call('prepare', a), ch = decode(p.signingContext);
  ch.challenge.message = ch.challenge.message.replace('Chain ID: 8453', 'Chain ID: 1');
  await assert.rejects(f.call('submit', { ...a, signingContext: encode(ch), signature: '0x' + 'a'.repeat(130) }), /Not signing/);
});
test('dropped create response reconciles original post without signing again', async () => {
  const f = fixture(), a = await f.preview(), p = await f.call('prepare', a); f.state.lost = true;
  await assert.rejects(f.call('submit', { ...a, ...p, signature: '0x' + 'a'.repeat(130) }), /response lost/);
  assert.equal((await f.call('prepare', a)).replayed, true); assert.equal(f.state.writes.length, 2);
});
test('source post owned by another creator fails closed', async () => {
  const f = fixture(), a = await f.preview(); f.state.existing = { creator: { wallet: '0x' + '2'.repeat(40) } };
  await assert.rejects(f.call('prepare', a), /different creator/);
});
test('draft content cannot override identity or fees', async () => {
  const f = fixture();
  for (const key of ['walletAddress','createdVia','xHandle','sourceTweetId','sourcePost','proof','creatorFeeBps']) await assert.rejects(f.call('preview', { ...f.identity, data: { [key]: 'bad' } }), /Do not supply/);
});
test('shell metacharacters remain data in base64url transport', () => {
  const data = { title: '`touch /tmp/unsafe` $(echo bad)\n\"' };
  assert.match(encode(data), /^[A-Za-z0-9_-]+$/); assert.deepEqual(decode(encode(data)), data);
});
