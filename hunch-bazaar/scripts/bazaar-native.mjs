#!/usr/bin/env node
// Stateless bridge for Bankr's authenticated native sign_data tool.
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { canonicalJson, createRuntime, bazaarHttp, checkProofChallenge, intentValue } from './bazaar.mjs';
const hash = x => createHash('sha256').update(canonicalJson(x)).digest('hex');
export const encode = x => Buffer.from(canonicalJson(x)).toString('base64url');
const fail = x => { throw new Error(x); };
export function decode(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s) || s.length > 100000) fail('Invalid base64url input');
  return JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
}
function identity(a) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a.wallet ?? '') || !/^\d{1,30}$/.test(a.postId ?? '') || !/^[A-Za-z0-9_]{1,15}$/.test(a.handle ?? '')) fail('Trusted Bankr wallet, X handle and original mention post ID required');
  return { wallet: a.wallet.toLowerCase(), postId: a.postId, handle: a.handle.toLowerCase() };
}
function readPreview(a, rt) {
  const record = decode(a.preview);
  if (!/^[a-f0-9]{64}$/.test(a.previewId ?? '') || hash(record) !== a.previewId) fail('Preview differs from original confirmed preview ID');
  if (record.version !== 1 || canonicalJson(record.identity) !== canonicalJson(identity(a))) fail('Preview identity mismatch');
  if (!(record.expiresAt > rt.now()) || record.expiresAt > rt.now() + 300000) fail('Preview expired; show a new preview and obtain confirmation');
  if (record.body.walletAddress !== record.identity.wallet || record.body.sourceTweetId !== record.identity.postId || record.body.xHandle !== record.identity.handle || record.body.createdVia !== 'bankr' || record.body.visibility !== 'public' || record.body.proof) fail('Invalid preview identity/body');
  return record;
}
function validateChallenge(challenge, record, rt) {
  const result = checkProofChallenge(challenge, { action: 'create_market', market: '-', wallet: record.identity.wallet, body: record.body, intent: `create market "${intentValue(record.body.title)}"` }, rt.registry, rt.now());
  if (result !== 'ok') fail(`Not signing: ${result}`);
}
async function lookup(record, rt) {
  const result = await bazaarHttp(rt, 'GET', `/api/bazaar/v1/markets/by-tweet/${record.identity.postId}`);
  if (result.status === 404) return null;
  if (result.status !== 200) fail('Could not reconcile original post; stop and retry lookup');
  if (String(result.json?.creator?.walletAddress ?? result.json?.creator?.wallet ?? '').toLowerCase() !== record.identity.wallet) fail('Original post belongs to a different creator');
  return { replayed: true, ...result.json };
}
export async function runNative(command, a, options = {}) {
  const rt = createRuntime(options);
  const who = identity(a);
  if (command === 'preview') {
    const data = a.data ?? {};
    for (const key of ['walletAddress','createdVia','xHandle','sourceTweetId','sourcePost','proof','creatorFeeBps']) if (key in data) fail(`Do not supply identity/proof/fee field ${key} in market data`);
    const fees = await bazaarHttp(rt, 'GET', '/api/bazaar/v1/fees');
    const bps = fees.json?.creatorFee?.bps;
    if (fees.status !== 200 || fees.json.creatorFee.optional !== false || !Number.isInteger(bps) || bps < 0 || bps > fees.json.settlementFeeBps) fail('Unable to verify fixed creator fee');
    const response = await bazaarHttp(rt, 'POST', '/api/bazaar/v1/markets/draft', { body: { ...data, walletAddress: who.wallet, createdVia: 'bankr', xHandle: who.handle, sourceTweetId: who.postId, visibility: 'public' } });
    if (response.status !== 200 || response.json?.valid !== true || !response.json?.confirm?.body) return { status: response.status, ...response.json };
    const body = { ...response.json.confirm.body, creatorFeeBps: bps };
    const record = { version: 1, identity: who, body, terms: response.json.terms, creatorFee: fees.json.creatorFee, expiresAt: Math.min(rt.now() + 300000, Date.parse(response.json.confirm.confirmBy)) };
    const result = { previewId: hash(record), preview: encode(record), approvedBody: body, terms: record.terms, creatorFee: record.creatorFee, expiresAt: new Date(record.expiresAt).toISOString(), replyText: response.json.replyText };
    readPreview({ ...a, ...result }, rt);
    return result;
  }
  const record = readPreview(a, rt);
  if (command === 'lookup') return await lookup(record, rt) ?? { found: false };
  if (command !== 'prepare' && command !== 'submit') fail('Expected preview, prepare, submit or lookup');
  const existing = await lookup(record, rt);
  if (existing) return existing;
  if (command === 'prepare') {
    const response = await bazaarHttp(rt, 'POST', '/api/bazaar/v1/markets', { body: record.body });
    if (response.status !== 401 || response.json?.error !== 'wallet_proof_required') fail(`Expected unsigned challenge; received ${response.status}: ${JSON.stringify(response.json)}`);
    validateChallenge(response.json, record, rt);
    return { signingContext: encode(response.json), signData: { payload: response.json.challenge.message, payloadType: 'message', reason: `Publish the confirmed Hunch Bazaar market, preview ${a.previewId}` } };
  }
  const challenge = decode(a.signingContext);
  validateChallenge(challenge, record, rt);
  if (!/^0x[0-9a-fA-F]+$/.test(a.signature ?? '') || a.signature.length < 132 || a.signature.length % 2 !== 0) fail('Invalid native wallet signature');
  // Server cryptographically verifies the signer against the committed wallet.
  const response = await bazaarHttp(rt, 'POST', '/api/bazaar/v1/markets', { body: { ...record.body, proof: { signature: a.signature, issuedAt: challenge.challenge.proof.issuedAt, nonce: challenge.challenge.proof.nonce } } });
  return { status: response.status, ...response.json };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(JSON.stringify(await runNative(process.argv[2], decode(process.argv[3]))) + '\n'); }
  catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
