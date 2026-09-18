#!/usr/bin/env node
// HUNCH BAZAAR skill v3: every call the skill makes, in one dependency-free
// Node script (Node 18+: global fetch and node:crypto).
//
//   node scripts/bazaar.mjs <command> [--flag value ...]
//
// Results (the server's JSON, `replyText` included) go to stdout; progress and
// refusals go to stderr. Exit 0 on success, 1 when the script refuses before
// sending anything, 2 when Bazaar refuses (its JSON is printed).
//
// This file is where the skill's security invariants (SKILL.md, "Security
// invariants") are enforced for scripts, so no command can skip one:
//
//   1. One origin. Every Bazaar request goes to https://bazaar.playhunch.xyz over
//      https, to a path under /api/bazaar/, with no redirect followed. Nothing in
//      the environment or a response can change it.
//   2. Signing stays inside Bankr. HUNCH_BANKR_API_KEY goes to
//      https://api.bankr.bot/wallet/sign and nowhere else, and a signature is used
//      only when Bankr reports it came from WALLET.
//   3. A wallet-proof message is signed only after checkProofChallenge accepts it:
//      Bazaar's fixed 13-line text, for this action, this market, this wallet, the
//      exact intent the user asked for, and the SHA-256 of exactly the body sent.
//   4. A bet's x402 challenge is paid only after checkX402Challenge accepts it
//      against ../x402-registry.json, and the EIP-3009 authorization is built from
//      the pinned values, never copied from the challenge. One authorization per
//      idempotency key: a rerun resends the same X-PAYMENT.
//
// Bodies are built as objects and serialized once, so no text a user or a post
// supplied can add, drop or rename a field.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ORIGIN = "https://bazaar.playhunch.xyz";
export const BANKR_API = "https://api.bankr.bot";
export const SKILL_NAME = "hunch-bazaar";
export const SKILL_VERSION = "3.1.0";

const PROOF_DOMAIN_LINE = "bazaar.playhunch.xyz asks you to sign a Bazaar action.";
const PROOF_FOOTER_LINE =
  "Free to sign. Sends no transaction. Accepted once, within 5 minutes of Issued At.";

const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;
const MARKET_REF_RE = /^[A-Za-z0-9_-]{1,128}$/;
const TWEET_ID_RE = /^[1-9][0-9]{0,19}$/;
const OUTCOME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;
const CREATOR_REF_RE = /^[A-Za-z0-9_@:.-]{1,120}$/;
const AMOUNT_RE = /^[0-9]{1,12}(\.[0-9]{1,6})?$/;
const IDEMPOTENCY_RE = /^[A-Za-z0-9_:.-]{8,128}$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;
const UUIDISH_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** A refusal the script makes before or instead of sending something. */
export class BazaarSkillError extends Error {
  constructor(message) {
    super(message);
    this.name = "BazaarSkillError";
  }
}

const fail = (message) => {
  throw new BazaarSkillError(message);
};

// ── The pinned registry ──────────────────────────────────────────────────────

export function loadRegistry() {
  const here = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(readFileSync(join(here, "..", "x402-registry.json"), "utf8"));
}

// ── Canonical JSON and the payload hash (the server's own algorithm) ─────────

/** Keys sorted by UTF-16 code unit, no whitespace, undefined members dropped. */
export function canonicalJson(value) {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonical JSON cannot represent a non-finite number");
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
      }
      const members = Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
      return `{${members.join(",")}}`;
    }
    default:
      throw new TypeError(`canonical JSON cannot represent a ${typeof value}`);
  }
}

/** The SHA-256 a wallet proof signs: the body without its proof member, canonical, hex. */
export function payloadSha256(body) {
  const { proof: _proof, ...rest } = body ?? {};
  return createHash("sha256").update(canonicalJson(rest), "utf8").digest("hex");
}

// ── Money, exactly ───────────────────────────────────────────────────────────

/** Decimal USDC to integer micros as a string, with no floating point. */
export function usdcMicros(amount) {
  if (typeof amount !== "string" || !AMOUNT_RE.test(amount)) {
    fail("the amount must be decimal USDC such as 5.00");
  }
  const [whole, fraction = ""] = amount.split(".");
  return (BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"))).toString();
}

// ── Invariant 3: the wallet-proof pre-sign check ─────────────────────────────

/**
 * A value as Bazaar prints it on the Intent line: control characters and runs of
 * space collapsed, double quotes as single quotes, and anything past 80
 * characters cut with "…". The payload hash still covers the whole value.
 */
export function intentValue(raw) {
  if (typeof raw !== "string") return "-";
  const spaced = Array.from(raw, (ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029 ? " " : ch;
  }).join("");
  const flat = spaced.replace(/\s+/g, " ").trim().replace(/"/g, "'");
  if (flat === "") return "-";
  const chars = Array.from(flat);
  return chars.length > 80 ? `${chars.slice(0, 80).join("")}…` : flat;
}

/**
 * "ok" when the 401 challenge is Bazaar's exact message for this request, else
 * the first reason not to sign. `market` is the market id, or "-".
 */
export function checkProofChallenge(response, request, registry = loadRegistry(), nowMs = Date.now()) {
  const policy = registry.signingPolicy.walletProof;
  const { action, market, body } = request;
  const wallet = String(request.wallet ?? "").toLowerCase();
  const rule = policy.actions[action] ?? null;
  const doc = response && typeof response === "object" ? response : {};
  const challenge = doc.challenge && typeof doc.challenge === "object" ? doc.challenge : null;
  const ch = challenge ?? {};
  const proof = ch.proof && typeof ch.proof === "object" ? ch.proof : {};
  const lines = (typeof ch.message === "string" ? ch.message : "").split("\n");
  const issuedAt = typeof proof.issuedAt === "string" ? proof.issuedAt : "";
  const nonce = typeof proof.nonce === "string" ? proof.nonce : "";
  const intentLine = lines[2] ?? "";
  const sha = payloadSha256(body);
  const issuedMs = Date.parse(issuedAt);
  const skewSeconds = Number.isFinite(issuedMs) ? (issuedMs - nowMs) / 1000 : 1e9;
  const marketRule = rule?.market ?? "";

  const intentOk =
    typeof request.intent === "string" && request.intent !== ""
      ? intentLine === `Intent: ${request.intent}`
      : rule && typeof rule.intent === "string"
        ? intentLine === `Intent: ${rule.intent}`
        : intentLine.startsWith(`Intent: ${rule?.intentPrefix ?? "(no intent rule for this action)"}`);

  const checks = [
    [rule !== null, `the skill never signs the action ${action}`],
    [challenge !== null, "the 401 carries no challenge"],
    [ch.scheme === policy.scheme, "the challenge is not an eip191-personal-sign message"],
    [lines.length === policy.lineCount, "the message is not the 13-line Bazaar template"],
    [lines[0] === PROOF_DOMAIN_LINE && lines[0] === policy.domainLine, "the first line is not the Bazaar domain line"],
    [lines[1] === "" && lines[11] === "", "the blank lines are not where the template has them"],
    [intentLine.startsWith("Intent: "), "there is no Intent line"],
    [intentOk, "the Intent line is not what the user asked for"],
    [lines[3] === `Action: ${action}`, `the Action line is not ${action}`],
    [
      marketRule === "-" ? market === "-" : marketRule === "id" ? market !== "-" : typeof market === "string",
      "the market does not fit the action",
    ],
    [lines[4] === `Market: ${market}`, `the Market line is not ${market}`],
    [lines[5] === `Wallet: ${wallet}`, "the Wallet line is not your wallet"],
    [lines[6] === `Chain ID: ${policy.chainId}`, "the Chain ID is not 8453"],
    [lines[7] === `Payload SHA-256: ${sha}`, "the message signs a different body than the one being sent"],
    [(ch.payloadSha256 ?? sha) === sha, "payloadSha256 is not the body being sent"],
    [/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(issuedAt), "Issued At is not ISO-8601 UTC"],
    [lines[8] === `Issued At: ${issuedAt}`, "the Issued At line does not match the challenge"],
    [Math.abs(skewSeconds) <= policy.windowSeconds, "Issued At is more than 5 minutes from now"],
    [/^[A-Za-z0-9_-]{16,128}$/.test(nonce), "the nonce is malformed"],
    [lines[9] === `Nonce: ${nonce}`, "the Nonce line does not match the challenge"],
    [lines[10] === `Version: ${policy.version}`, "the Version is not 1"],
    [lines[12] === PROOF_FOOTER_LINE && lines[12] === policy.footerLine, "the last line is not the Bazaar free-to-sign line"],
  ];
  const failed = checks.find(([ok]) => ok !== true);
  return failed ? failed[1] : "ok";
}

// ── Invariant 4: the x402 pre-sign check ─────────────────────────────────────

/**
 * "ok" when the 402 challenge matches the pinned registry for exactly this market
 * and this user-approved stake (atomic USDC), else the first reason not to pay.
 */
export function checkX402Challenge(response, request, registry = loadRegistry()) {
  const policy = registry.signingPolicy;
  const doc = response && typeof response === "object" ? response : {};
  const accepts = doc.accepts;
  const a = Array.isArray(accepts) && accepts[0] && typeof accepts[0] === "object" ? accepts[0] : {};
  const extra = a.extra && typeof a.extra === "object" ? a.extra : {};
  const resource = policy.pinned.resourceTemplate.replace(
    "{marketId}",
    encodeURIComponent(request.marketId),
  );
  const amountRequired = a.maxAmountRequired === undefined ? "" : String(a.maxAmountRequired);
  const isInteger = /^[0-9]+$/.test(amountRequired);

  const checks = [
    [doc.x402Version === 1, "x402Version is not 1"],
    [Array.isArray(accepts) && accepts.length === 1, "accepts is empty or ambiguous"],
    [
      [a.scheme, a.network, a.maxAmountRequired, a.resource, a.payTo, a.asset].every((v) => typeof v === "string"),
      "a required challenge field is missing",
    ],
    [a.scheme === policy.requireScheme, "the scheme is not exact"],
    [a.network === policy.pinned.network, "the network is not base"],
    [String(a.asset ?? "").toLowerCase() === policy.pinned.asset.toLowerCase(), "the asset is not Base USDC"],
    [String(a.payTo ?? "").toLowerCase() === policy.pinned.payTo.toLowerCase(), "payTo is not the pinned settlement address"],
    [String(a.resource ?? "").startsWith(policy.pinned.resourcePrefix), "the resource is outside the pinned prefix"],
    [a.resource === resource, "the resource is not the bet endpoint of this market"],
    [
      extra.name === policy.pinned.assetName && extra.version === policy.pinned.assetVersion,
      "the USDC signing domain is not the pinned one",
    ],
    [isInteger, "maxAmountRequired is not an integer"],
    [isInteger && BigInt(amountRequired) >= BigInt(policy.limits.minAmountAtomic), "the amount is below the minimum bet"],
    [amountRequired === request.amountAtomic, "the amount is not the stake the user approved"],
  ];
  const failed = checks.find(([ok]) => ok !== true);
  return failed ? failed[1] : "ok";
}

// ── The runtime: HTTP, signing, state ────────────────────────────────────────

/**
 * Everything the commands touch outside this file, injectable for tests:
 * `fetch`, the environment (HUNCH_BANKR_API_KEY, BAZAAR_STATE_DIR), the clock
 * and where progress goes.
 */
export function createRuntime(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
  const registry = options.registry ?? loadRegistry();
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  return { env, fetch: fetchImpl, now, log, registry, sleep, identity: options.identity ?? null };
}

/** Invariant 1: one origin, one path prefix, https only, no redirect followed. */
export async function bazaarHttp(rt, method, path, { body, headers = {} } = {}) {
  if (typeof path !== "string" || !path.startsWith("/api/bazaar/")) {
    fail(`refusing a request outside ${ORIGIN}/api/bazaar/: ${path}`);
  }
  if (path.includes("://") || /\s/.test(path) || path.includes("..")) {
    fail(`refusing a path that could leave ${ORIGIN}: ${path}`);
  }
  let response;
  try {
    response = await rt.fetch(`${ORIGIN}${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "manual",
      signal: AbortSignal.timeout(90_000),
    });
  } catch (error) {
    fail(`could not reach ${ORIGIN} (${method} ${path}): ${error?.message ?? error}`);
  }
  if (response.status >= 300 && response.status < 400) {
    fail(`refusing the redirect ${ORIGIN} answered for ${method} ${path}`);
  }
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

function bankrKey(rt) {
  const key = rt.env.HUNCH_BANKR_API_KEY ?? rt.env.BANKR_API_KEY;
  if (!key) fail("HUNCH_BANKR_API_KEY is not set; add a Wallet API write key in Bankr Terminal Settings > Env Vars");
  return key;
}

/** Bind every write to the wallet authenticated by the Bankr API key. */
export async function authenticateBankrWallet(rt) {
  const key = bankrKey(rt);
  let response;
  try {
    response = await rt.fetch(`${BANKR_API}/wallet/me`, {
      method: "GET",
      headers: { "X-API-Key": key },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    fail(`could not verify the Bankr wallet: ${error?.message ?? error}`);
  }
  if (response.status !== 200) fail(`Bankr /wallet/me answered ${response.status}; check HUNCH_BANKR_API_KEY Wallet API access`);
  let json;
  try { json = await response.json(); } catch { fail("Bankr /wallet/me did not return JSON"); }
  const wallets = [...new Set((Array.isArray(json?.wallets) ? json.wallets : [])
    .filter((item) => item?.chain === "evm" && WALLET_RE.test(item.address))
    .map((item) => item.address.toLowerCase()))];
  if (wallets.length !== 1) fail("Bankr /wallet/me must return exactly one EVM wallet");
  const wallet = wallets[0];
  if (rt.env.WALLET && String(rt.env.WALLET).toLowerCase() !== wallet) fail("wallet mismatch: WALLET is not the Bankr API-key wallet");
  rt.identity = { wallet, user: `bankr:${wallet}` };
  return rt.identity;
}

function requireWalletEnv(rt) {
  const wallet = String(rt.identity?.wallet ?? rt.env.WALLET ?? "");
  if (!WALLET_RE.test(wallet)) fail("WALLET must be the requesting user's own Bankr wallet (0x + 40 hex)");
  return wallet.toLowerCase();
}

/** Invariant 2: sign through the Bankr Wallet API, as WALLET and nobody else. */
export async function bankrSign(rt, request, wallet) {
  const key = bankrKey(rt);
  let response;
  try {
    response = await rt.fetch(`${BANKR_API}/wallet/sign`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-API-Key": key },
      body: JSON.stringify(request),
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    fail(`could not reach the Bankr Wallet API: ${error?.message ?? error}`);
  }
  const text = await response.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = {};
  }
  if (response.status !== 200) {
    fail(`Bankr /wallet/sign answered ${response.status}: ${JSON.stringify({ error: json.error, message: json.message })}`);
  }
  const signature = typeof json.signature === "string" ? json.signature : "";
  if (!/^0x([0-9a-fA-F]{2}){65,}$/.test(signature)) fail("Bankr returned no usable signature");
  const signer = typeof json.signer === "string" ? json.signer.toLowerCase() : "";
  if (signer && signer !== wallet) {
    fail(`Bankr signed with ${signer}, not WALLET ${wallet}; refusing to use it`);
  }
  return signature;
}

/**
 * A signed write: send without a proof, check the 401 challenge (invariant 3),
 * sign it, resend the same body plus the proof. A proof that expired or lost a
 * nonce race gets ONE fresh challenge; nothing loops.
 */
export async function postSigned(rt, { action, market, path, body, intent, method = "POST" }) {
  const wallet = requireWalletEnv(rt);
  if (String(body.walletAddress ?? "").toLowerCase() !== wallet) fail("the body's walletAddress is not WALLET");
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const first = await bazaarHttp(rt, method, path, { body });
    if (first.status !== 401 || first.json?.error !== "wallet_proof_required") return first;
    const verdict = checkProofChallenge(
      first.json,
      { action, market, wallet, body, intent },
      rt.registry,
      rt.now(),
    );
    if (verdict !== "ok") fail(`not signing: ${verdict}`);
    const signature = await bankrSign(
      rt,
      { signatureType: "personal_sign", message: first.json.challenge.message },
      wallet,
    );
    const signed = {
      ...body,
      proof: {
        signature,
        issuedAt: first.json.challenge.proof.issuedAt,
        nonce: first.json.challenge.proof.nonce,
      },
    };
    const second = await bazaarHttp(rt, method, path, { body: signed });
    const code = second.json?.error;
    if (second.status === 401 && (code === "wallet_proof_expired" || code === "wallet_proof_replayed") && attempt < 2) {
      rt.log(`${code}: signing one fresh challenge`);
      continue;
    }
    return second;
  }
  fail("unreachable");
}

function stateDir(rt) {
  const dir = rt.env.BAZAAR_STATE_DIR || join(homedir(), ".bazaar-skill");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// State must live on one durable local filesystem shared by all wallet runners.
// Locks are never stolen: a crashed process requires operator reconciliation.
const digest = (value) => createHash("sha256").update(canonicalJson(value)).digest("hex");
function statePath(rt, kind, key) { return join(stateDir(rt), `${kind}-${digest(key)}.json`); }
function readState(path) { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null; }
function saveState(path, value) {
  const tmp = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  const dir = openSync(dirname(path), "r");
  try { fsyncSync(dir); } finally { closeSync(dir); }
}
async function locked(path, fn) {
  const lock = `${path}.lock`;
  let acquired = false;
  for (let n = 0; n < 100; n++) {
    try { mkdirSync(lock, { mode: 0o700 }); acquired = true; break; }
    catch (e) { if (e.code !== "EEXIST") throw e; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!acquired) fail("state is locked by another run; retry later; never delete locks without reconciliation");
  try { return await fn(); } finally { rmSync(lock, { recursive: true }); }
}
function owner(rt) {
  const user = rt.identity?.user ?? rt.env.BAZAAR_REQUESTING_USER;
  if (typeof user !== "string" || !/^[A-Za-z0-9_:@.-]{1,160}$/.test(user))
    fail("BAZAAR_REQUESTING_USER must be the authenticated requesting user's stable id");
  return { wallet: requireWalletEnv(rt), user };
}
function validateGrant(body, now) {
  const scope = body.scope;
  if (!scope || Object.keys(scope).length !== 1 ||
      !(typeof scope.marketId === "string" && MARKET_REF_RE.test(scope.marketId) ||
        typeof scope.creator === "string" && WALLET_RE.test(scope.creator))) fail("invalid standing scope");
  const amount = BigInt(usdcMicros(body.amountPerBet));
  if (amount < 500000n || BigInt(usdcMicros(body.maxTotal)) < amount ||
      !Number.isInteger(body.maxBets) || body.maxBets < 1 || body.maxBets > 100 ||
      typeof body.outcomeKey !== "string" || !OUTCOME_RE.test(body.outcomeKey) ||
      !["once_per_market", "daily"].includes(body.cadence) ||
      (body.cadence === "daily" && !scope.marketId) ||
      !(Date.parse(body.expiresAt) > now && Date.parse(body.expiresAt) <= now + 30 * 86400000))
    fail("invalid standing limits or expiry");
  if (body.trigger != null) {
    if (typeof body.trigger !== "object" || Array.isArray(body.trigger)) fail("invalid trigger");
    for (const [key, value] of Object.entries(body.trigger)) {
      if (!["oddsBelowPct", "oddsAbovePct"].includes(key) || !Number.isInteger(value) || value < 1 || value > 99)
        fail("invalid trigger");
    }
  }
}
async function previewCreate(rt, f, standing = false) {
  const binding = owner(rt);
  const kind = standing ? "standing-bets" : "markets";
  if (f.confirm !== "true") {
    const preview = await bazaarHttp(rt, "POST", `/api/bazaar/v1/${kind}/draft`, {
      body: { ...jsonFlag(f), walletAddress: binding.wallet },
    });
    if (preview.status !== 200 || preview.json?.valid !== true) return preview;
    const body = preview.json.confirm?.body;
    if (!body || body.walletAddress?.toLowerCase() !== binding.wallet || body.proof) fail("invalid preview wallet/body");
    if (standing) validateGrant(body, rt.now());
    const expiry = Math.min(rt.now() + 300000, standing ? Date.parse(body.expiresAt) : Date.parse(preview.json.confirm.confirmBy));
    if (!(expiry > rt.now())) fail("preview expired; request a fresh preview");
    const id = randomBytes(24).toString("hex");
    const record = { binding, kind, body, hash: payloadSha256(body), expiry, summary: preview.json.summaryLine, createdAt: rt.now() };
    saveState(statePath(rt, "preview", id), record);
    return { ...preview, json: { ...preview.json, previewId: id, approvedBody: body, approvedBodySha256: record.hash, previewExpiresAt: new Date(expiry).toISOString() } };
  }
  const id = need(f, "preview-id", /^[a-f0-9]{48}$/, "--confirm requires the --preview-id shown to this same user");
  if (f.json) fail("confirm uses only the retained --preview-id; new terms require a new preview");
  const path = statePath(rt, "preview", id);
  return locked(path, async () => {
    const kept = readState(path);
    if (!kept || canonicalJson(kept.binding) !== canonicalJson(binding) || kept.kind !== kind) fail("unknown preview or requesting user/wallet mismatch");
    if (kept.result) return kept.result;
    if (kept.pending) fail("confirmation outcome uncertain; reconcile before creating another grant/market");
    if (!(kept.expiry > rt.now()) || payloadSha256(kept.body) !== kept.hash) fail("preview expired or changed; display a fresh preview and confirm again");
    if (standing) validateGrant(kept.body, rt.now());
    saveState(path, { ...kept, pending: true });
    const result = await postSigned(rt, {
      action: standing ? "create_standing_bet" : "create_market",
      market: standing ? kept.body.scope.marketId ?? "-" : "-",
      path: `/api/bazaar/v1/${kind}`, body: kept.body,
      ...(standing ? { intent: `standing bet: ${kept.summary}` } : {}),
    });
    if (standing && result.status >= 200 && result.status < 300) {
      const grantId = result.json?.standingBet?.id;
      if (typeof grantId !== "string" || !UUIDISH_RE.test(grantId)) fail("missing grant id; reconcile confirmation");
      const grantPath = statePath(rt, "grant", [binding.wallet, grantId]);
      await locked(grantPath, async () => {
        if (readState(grantPath)) fail("grant id already exists; refusing to reset its budget");
        saveState(grantPath, { binding, body: kept.body, createdAt: rt.now(), reservations: {}, revoked: false });
      });
    }
    saveState(path, { ...kept, pending: true, result });
    return result;
  });
}
async function withGrant(rt, body, marketId, amount, fn) {
  const binding = owner(rt);
  const path = statePath(rt, "grant", [binding.wallet, body.standingBetId]);
  return locked(path, async () => {
    const kept = readState(path);
    if (!kept || canonicalJson(kept.binding) !== canonicalJson(binding)) fail("unknown locally approved grant or owner mismatch");
    const g = kept.body;
    if (kept.revoked || !(Date.parse(g.expiresAt) > rt.now())) fail("standing grant revoked or expired");
    if (body.outcomeKey !== g.outcomeKey || usdcMicros(amount) !== usdcMicros(g.amountPerBet)) fail("standing amount/outcome mismatch");
    const period = g.cadence === "daily" ? `d:${new Date(rt.now()).toISOString().slice(0,10).replaceAll("-", "")}` : "m";
    if (body.idempotencyKey !== `sb:${body.standingBetId}:${marketId}:${period}`) fail("standing idempotency key mismatch");
    if (g.scope.marketId && g.scope.marketId !== marketId) fail("standing market out of scope");
    const card = await bazaarHttp(rt, "GET", `/api/bazaar/v1/markets/${encodeURIComponent(marketId)}`);
    const market = card.json?.market;
    if (card.status !== 200 || market?.id !== marketId) fail("cannot verify standing market");
    if (g.scope.creator && (card.json.creator?.wallet?.toLowerCase() !== g.scope.creator.toLowerCase() ||
        !(Date.parse(market.createdAt) > kept.createdAt) || market.visibility !== "public")) fail("standing creator scope mismatch");
    if (g.trigger) {
      const odds = card.json.impliedOddsPct?.[g.outcomeKey];
      if (typeof odds !== "number" || !Number.isFinite(odds) ||
          (g.trigger.oddsBelowPct != null && !(odds < g.trigger.oddsBelowPct)) ||
          (g.trigger.oddsAbovePct != null && !(odds > g.trigger.oddsAbovePct))) fail("standing trigger not met");
    }
    const key = body.idempotencyKey;
    if (!kept.reservations[key]) {
      const reservations = Object.values(kept.reservations);
      const spent = reservations.reduce((sum, v) => sum + BigInt(v), 0n);
      if (reservations.length >= g.maxBets || spent + BigInt(usdcMicros(amount)) > BigInt(usdcMicros(g.maxTotal))) fail("standing budget exhausted");
      kept.reservations[key] = usdcMicros(amount);
      saveState(path, kept); // Conservatively retained even on uncertain/failing payments.
    }
    return fn(() => {
      if (!(Date.parse(g.expiresAt) > rt.now())) fail("standing grant expired before signing");
    });
  });
}

/** Invariant 4: one EIP-3009 authorization from pinned values, signed through Bankr. */
export async function signStake(rt, wallet, amountAtomic) {
  const pinned = rt.registry.signingPolicy.pinned;
  const nowSeconds = Math.floor(rt.now() / 1000);
  const validAfter = nowSeconds - 60;
  const validBefore = nowSeconds + rt.registry.signingPolicy.limits.maxValiditySeconds;
  const nonce = `0x${randomBytes(32).toString("hex")}`;
  const message = {
    from: wallet,
    to: pinned.payTo.toLowerCase(),
    value: amountAtomic,
    validAfter: String(validAfter),
    validBefore: String(validBefore),
    nonce,
  };
  const signature = await bankrSign(
    rt,
    {
      signatureType: "eth_signTypedData_v4",
      typedData: {
        domain: { name: pinned.assetName, version: pinned.assetVersion, chainId: pinned.chainId, verifyingContract: pinned.asset },
        types: {
          TransferWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        primaryType: "TransferWithAuthorization",
        message,
      },
    },
    wallet,
  );
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    fail("Bazaar bets need a 65-byte wallet signature; this wallet signed with a longer (smart-account) one");
  }
  const payment = {
    x402Version: 1,
    scheme: "exact",
    network: "base",
    payload: {
      signature,
      authorization: { ...message, validAfter, validBefore },
    },
  };
  return Buffer.from(JSON.stringify(payment), "utf8").toString("base64");
}

/**
 * A paid bet: send without payment, check the 402 (invariant 4), sign ONE
 * authorization and resend. The signed payment is kept (0600) under the bet's
 * wallet/idempotency key permanently, so a rerun resends the SAME X-PAYMENT
 * instead of signing a second one.
 */
export async function postPaid(rt, request) {
  const { body, marketId, amount, path } = request;
  if (path !== `/api/bazaar/v1/markets/${marketId}/bets` || usdcMicros(body.amount) !== usdcMicros(amount)) fail("payment body/path mismatch");
  const pay = () => postPaidLocked(rt, request);
  return body.standingBetId ? withGrant(rt, body, marketId, amount, (guard) => postPaidLocked(rt, { ...request, guard })) : pay();
}
async function postPaidLocked(rt, { path, body, marketId, amount, guard = () => {} }) {
  const wallet = requireWalletEnv(rt);
  if (String(body.walletAddress ?? "").toLowerCase() !== wallet) fail("the body's walletAddress is not WALLET");
  const amountAtomic = usdcMicros(amount);
  const idem = String(body.idempotencyKey ?? "");
  if (!IDEMPOTENCY_RE.test(idem)) fail("the idempotency key must be 8-128 of A-Z a-z 0-9 _ : . -");
  const saved = statePath(rt, "payment", [wallet, idem]);
  const betKey = digest({ path, body, amountAtomic });
  return locked(saved, async () => {
  const legacy = join(stateDir(rt), `x402-${idem.replace(/[:.]/g, "_")}.json`);
  if (existsSync(legacy)) fail("legacy payment state exists; reconcile its authorization before any upgraded retry");
  let header;
  if (existsSync(saved)) {
    const kept = JSON.parse(readFileSync(saved, "utf8"));
    if (kept.bet !== betKey) fail(`idempotency key ${idem} already paid for a different bet; use a new key for a new bet`);
    if (kept.result) return kept.result;
    if (!kept.header) fail("payment signing outcome uncertain; reconcile saved intent; never sign a new authorization");
    header = kept.header;
    rt.log(`resending the payment already signed for ${idem} (never a second signature)`);
  } else {
    const first = await bazaarHttp(rt, "POST", path, { body });
    if (first.status !== 402) {
      if (first.status >= 200 && first.status < 300) saveState(saved, { bet: betKey, result: first });
      return first;
    }
    const verdict = checkX402Challenge(first.json, { marketId, amountAtomic }, rt.registry);
    if (verdict !== "ok") fail(`not paying: ${verdict}`);
    guard();
    saveState(saved, { bet: betKey, pending: true });
    header = await signStake(rt, wallet, amountAtomic);
    saveState(saved, { bet: betKey, header });
  }

  let paid = await bazaarHttp(rt, "POST", path, { body, headers: { "X-PAYMENT": header } });
  const code = paid.json?.error;
  if ((paid.status === 503 && code === "settlement_failed") || (paid.status === 409 && code === "payment_replayed")) {
    rt.log(`${code}: resending the SAME payment once`);
    await rt.sleep(5_000);
    paid = await bazaarHttp(rt, "POST", path, { body, headers: { "X-PAYMENT": header } });
  }
  if (paid.status === 200 || paid.status === 201) saveState(saved, { bet: betKey, header, result: paid });
  return paid;
  });
}

// ── Argument rules ───────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) fail(`unexpected argument: ${token}`);
    const name = token.slice(2);
    const next = rest[i + 1];
    const value = next === undefined || next.startsWith("--") ? "true" : next;
    if (value !== "true" || next === "true") i += 1;
    if (name === "evidence") {
      flags.evidence = [...(flags.evidence ?? []), value];
    } else {
      flags[name] = value;
    }
  }
  return { command, flags };
}

const need = (flags, name, rule, message) => {
  const value = flags[name];
  if (typeof value !== "string" || value === "true" || (rule && !rule.test(value))) {
    fail(message ?? `--${name} is required`);
  }
  return value;
};

const wallet = (flags, name = "wallet") =>
  need(flags, name, WALLET_RE, `--${name} must be a 0x wallet address (40 hex characters)`).toLowerCase();
const marketRef = (flags) =>
  need(flags, "id", MARKET_REF_RE, "--id must be a Bazaar market id or private slug (letters, digits, _ or -)");
const creatorRef = (flags) =>
  need(flags, "creator", CREATOR_REF_RE, "--creator must be a 0x wallet, an @handle or a creator id");
const q = (value) => encodeURIComponent(value);

function jsonFlag(flags, name = "json") {
  const raw = need(flags, name, null, `--${name} must be a JSON object`);
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail(`--${name} is not valid JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`--${name} must be a JSON object`);
  return value;
}

function noteText(flags, name, min, max) {
  const raw = need(flags, name, null, `--${name} is required`);
  const length = Array.from(raw.trim()).length;
  if (length < min) fail(`--${name} needs at least ${min} characters`);
  if (length > max) fail(`--${name} may be at most ${max} characters`);
  return raw;
}

// ── Commands ─────────────────────────────────────────────────────────────────

const get = (rt, path) => bazaarHttp(rt, "GET", path);

/**
 * Every command: name → (rt, flags) → { status, json, text }. A result with
 * `refused` is Bazaar declining what was asked (an invalid preview under
 * `--confirm`): its JSON is printed and the exit code is 2.
 */
export const COMMANDS = {
  // Reads.
  fees: (rt) => get(rt, "/api/bazaar/v1/fees"),
  "getting-started": (rt) => get(rt, "/api/bazaar/v1/getting-started"),
  "skill-version": (rt) => get(rt, `/api/bazaar/v1/skill?name=${SKILL_NAME}&version=${SKILL_VERSION}`),
  lookup: (rt, f) => {
    const ref = need(f, "ref", /^\S{1,512}$/, "--ref must be a Bazaar link, a market id or a private slug");
    return get(rt, `/api/bazaar/v1/markets/lookup?ref=${q(ref)}${f.wallet ? `&wallet=${wallet(f)}` : ""}`);
  },
  market: (rt, f) => get(rt, `/api/bazaar/v1/markets/${q(marketRef(f))}${f.wallet ? `?wallet=${wallet(f)}` : ""}`),
  "by-tweet": (rt, f) => get(rt, `/api/bazaar/v1/markets/by-tweet/${need(f, "id", TWEET_ID_RE, "--id must be a numeric X post id")}`),
  "by-post": (rt, f) => {
    const platform = need(f, "platform", /^(x|farcaster|telegram)$/, "--platform must be x, farcaster or telegram");
    const id = need(f, "id", /^[A-Za-z0-9:x_-]{1,80}$/, "--id must be the post id");
    return get(rt, `/api/bazaar/v1/markets/by-post?platform=${platform}&id=${q(id)}`);
  },
  quote: (rt, f) => {
    const outcome = need(f, "outcome", OUTCOME_RE, "--outcome must be one of the market's outcome keys");
    const amount = need(f, "amount", AMOUNT_RE, "--amount must be decimal USDC such as 5.00");
    return get(rt, `/api/bazaar/v1/markets/${q(marketRef(f))}/quote?outcome=${q(outcome)}&amount=${amount}`);
  },
  markets: (rt, f) => {
    const params = new URLSearchParams();
    if (f.sort) params.set("sort", need(f, "sort", /^(trending|newest|closing_soon|resolving_soon|resolved_recently)$/, "--sort is not a Bazaar sort"));
    if (f.q) params.set("q", need(f, "q", /^.{1,120}$/, "--q must be 1-120 characters"));
    if (f.creator) params.set("creator", creatorRef(f));
    if (f.following) params.set("following", wallet(f, "following"));
    if (f.state) params.set("state", need(f, "state", /^(open|closed|resolved|voided)$/, "--state is not a market state"));
    if (f.category) params.set("category", need(f, "category", /^[A-Za-z0-9 -]{2,40}$/, "--category must be 2-40 letters, digits, spaces or hyphens"));
    if (f.limit) params.set("limit", need(f, "limit", /^[1-9][0-9]?$|^100$/, "--limit must be 1-100"));
    const query = params.toString();
    return get(rt, `/api/bazaar/v1/markets${query ? `?${query}` : ""}`);
  },
  creator: (rt, f) => get(rt, `/api/bazaar/v1/creators/${q(creatorRef(f))}?markets=${f.markets ? need(f, "markets", /^[0-9]{1,2}$/) : "5"}`),
  "to-resolve": (rt, f) => get(rt, `/api/bazaar/v1/creators/${q(creatorRef(f))}/to-resolve`),
  positions: (rt, f) => get(rt, `/api/bazaar/v1/positions?wallet=${wallet(f)}`),
  results: (rt, f) => get(rt, `/api/bazaar/v1/markets/${q(marketRef(f))}/results`),
  receipt: (rt, f) => get(rt, `/api/bazaar/v1/markets/${q(marketRef(f))}/receipt?wallet=${wallet(f)}`),
  status: (rt, f) => get(rt, `/api/bazaar/v1/register?wallet=${wallet(f)}`),
  earnings: (rt, f) => get(rt, `/api/bazaar/v1/earnings?wallet=${wallet(f)}`),
  boards: (rt, f) => {
    const board = f.board ? need(f, "board", /^(weekly|alltime|rising)$/, "--board must be weekly, alltime or rising") : "weekly";
    const limit = f.limit ? need(f, "limit", /^([1-9]|[1-4][0-9]|50)$/, "--limit must be 1-50") : "10";
    return get(rt, `/api/bazaar/boards?board=${board}&limit=${limit}`);
  },
  "follow-status": (rt, f) => get(rt, `/api/bazaar/v1/creators/${q(creatorRef(f))}/follow?wallet=${wallet(f)}`),
  "standing-bets": (rt, f) => get(rt, `/api/bazaar/v1/standing-bets?wallet=${wallet(f)}`),
  "standing-bet": (rt, f) => get(rt, `/api/bazaar/v1/standing-bets/${q(need(f, "id", UUIDISH_RE, "--id must be a standing bet id"))}`),
  "standing-bet-check": (rt, f) => get(rt, `/api/bazaar/v1/standing-bets/${q(need(f, "id", UUIDISH_RE, "--id must be a standing bet id"))}/check`),
  subscriptions: (rt, f) => get(rt, `/api/bazaar/v1/subscriptions?wallet=${wallet(f)}`),

  // Previews: nothing is written, no proof.
  draft: (rt, f) => previewCreate(rt, { ...f, confirm: undefined }),
  "standing-bet-draft": (rt, f) => previewCreate(rt, { ...f, confirm: undefined }, true),
  create: (rt, f) => previewCreate(rt, f),
  resolve: (rt, f) => {
    const id = marketRef(f);
    const outcome = need(f, "outcome", OUTCOME_RE, "--outcome must be one of the market's outcome keys");
    const evidence = (f.evidence ?? []).map((url) => {
      if (!/^https:\/\/\S+$/.test(url)) fail("--evidence must be one https:// link");
      return { url };
    });
    const body = {
      walletAddress: requireWalletEnv(rt),
      outcome,
      note: f.note ? noteText(f, "note", 1, 2000) : `Resolved ${outcome.toUpperCase()} by the creator.`,
      evidence,
    };
    return postSigned(rt, { action: "resolve_market", market: id, path: `/api/bazaar/v1/markets/${id}/resolve`, body, intent: `resolve as "${intentValue(outcome)}"` });
  },
  void: (rt, f) => {
    const id = marketRef(f);
    const body = { walletAddress: requireWalletEnv(rt), note: noteText(f, "note", 10, 500) };
    return postSigned(rt, { action: "void_market", market: id, path: `/api/bazaar/v1/markets/${id}/void`, body });
  },
  register: (rt, f) => {
    const label = need(f, "label", /^[A-Za-z0-9 _.-]{2,40}$/, "--label must be 2-40 letters, digits, spaces, _ . or -");
    const body = {
      walletAddress: requireWalletEnv(rt),
      label,
      operatorContact: f.contact ? need(f, "contact", /^\S{3,200}$/, "--contact must be an email, a URL or a handle") : "bankr",
    };
    return postSigned(rt, { action: "register_agent", market: "-", path: "/api/bazaar/v1/register", body });
  },
  claim: (rt) =>
    postSigned(rt, { action: "claim_earnings", market: "-", path: "/api/bazaar/v1/earnings", body: { walletAddress: requireWalletEnv(rt) } }),
  "share-link": (rt, f) => {
    const id = marketRef(f);
    return postSigned(rt, { action: "register_ref_link", market: id, path: "/api/bazaar/v1/ref/register", body: { walletAddress: requireWalletEnv(rt), marketId: id } });
  },
  follow: async (rt, f) => followWrite(rt, f, "follow_creator", "POST"),
  unfollow: async (rt, f) => followWrite(rt, f, "unfollow_creator", "DELETE"),
  report: (rt, f) => {
    const id = marketRef(f);
    const reason = need(f, "reason", /^(illegal|harm|sexual|hate|impersonation|spam|other|outcome)$/, "--reason must be illegal, harm, sexual, hate, impersonation, spam, other or outcome");
    const body = { walletAddress: requireWalletEnv(rt), reason, ...(f.note ? { note: noteText(f, "note", 1, 1000) } : {}) };
    return postSigned(rt, { action: "report_market", market: id, path: `/api/bazaar/v1/markets/${id}/report`, body, intent: `report as "${intentValue(reason)}"` });
  },
  "standing-bet-create": (rt, f) => previewCreate(rt, f, true),
  "standing-bet-revoke": async (rt, f) => {
    const id = need(f, "id", UUIDISH_RE, "--id must be a standing bet id");
    const binding = owner(rt);
    const path = statePath(rt, "grant", [binding.wallet, id]);
    return locked(path, async () => {
      const kept = readState(path);
      if (kept && canonicalJson(kept.binding) !== canonicalJson(binding)) fail("grant owner mismatch");
      saveState(path, { ...kept, binding, revoked: true }); // Stop locally even if DELETE fails.
      return postSigned(rt, {
        action: "revoke_standing_bet", market: "-", method: "DELETE",
        path: `/api/bazaar/v1/standing-bets/${id}`,
        body: { walletAddress: binding.wallet, standingBetId: id },
        intent: `revoke standing bet ${intentValue(id)}`,
      });
    });
  },
  subscribe: (rt, f) => {
    const walletAddress = requireWalletEnv(rt);
    const url = need(f, "url", /^https:\/\/webhooks\.bankr\.bot\/u\/0x[0-9a-fA-F]{40}\/[A-Za-z0-9_-]{1,64}$/, "--url must be your Bankr webhook: https://webhooks.bankr.bot/u/<your wallet>/<name>");
    if (url.split("/")[4].toLowerCase() !== walletAddress) fail("--url must be a webhook of WALLET, not another wallet");
    const events = need(f, "events", /^[a-z_.]+(,[a-z_.]+)*$/, "--events must be a comma list such as market.closed,bet.won").split(",");
    return postSigned(rt, { action: "subscribe_events", market: "-", path: "/api/bazaar/v1/subscriptions", body: { walletAddress, url, events }, intent: `send Bazaar events to ${intentValue(url)}` });
  },
  unsubscribe: (rt, f) => {
    const id = need(f, "id", UUIDISH_RE, "--id must be a subscription id");
    return postSigned(rt, {
      action: "unsubscribe_events",
      market: "-",
      method: "DELETE",
      path: `/api/bazaar/v1/subscriptions/${id}`,
      body: { walletAddress: requireWalletEnv(rt), subscriptionId: id },
      intent: `stop Bazaar events ${intentValue(id)}`,
    });
  },

  // Money: the stake is paid over x402.
  bet: (rt, f) => {
    const id = marketRef(f);
    const outcome = need(f, "outcome", OUTCOME_RE, "--outcome must be one of the market's outcome keys");
    const amount = need(f, "amount", AMOUNT_RE, "--amount must be decimal USDC such as 5.00");
    if (BigInt(usdcMicros(amount)) < BigInt(rt.registry.signingPolicy.limits.minAmountAtomic)) {
      fail("the minimum bet is 0.50 USDC");
    }
    const body = {
      walletAddress: requireWalletEnv(rt),
      outcomeKey: outcome,
      amount,
      idempotencyKey: need(f, "idempotency-key", IDEMPOTENCY_RE, "--idempotency-key must be 8-128 of A-Z a-z 0-9 _ : . -"),
      ...(f["ref-code"] ? { refCode: need(f, "ref-code", /^[A-Za-z0-9]{1,64}$/, "--ref-code must be letters and digits") } : {}),
      ...(f["standing-bet"] ? { standingBetId: need(f, "standing-bet", UUIDISH_RE, "--standing-bet must be a standing bet id") } : {}),
    };
    return postPaid(rt, { path: `/api/bazaar/v1/markets/${id}/bets`, body, marketId: id, amount });
  },
  /**
   * For an automation: check a standing bet, and when a bet is due place exactly
   * the bet the check handed back. Not due answers the check itself.
   */
  "standing-bet-run": async (rt, f) => {
    const id = need(f, "id", UUIDISH_RE, "--id must be a standing bet id");
    const walletAddress = requireWalletEnv(rt);
    const checked = await get(rt, `/api/bazaar/v1/standing-bets/${q(id)}/check`);
    if (checked.status !== 200 || checked.json?.status !== "due" || !checked.json.bet) return checked;
    const due = checked.json.bet;
    if (String(checked.json.walletAddress ?? "").toLowerCase() !== walletAddress) {
      fail("this standing bet belongs to another wallet; only its own wallet pays its bets");
    }
    if (!MARKET_REF_RE.test(due.marketId) || !OUTCOME_RE.test(due.outcomeKey) || !AMOUNT_RE.test(due.amount) || due.standingBetId !== id) {
      fail("the check handed back a bet this script will not place");
    }
    return postPaid(rt, {
      path: `/api/bazaar/v1/markets/${due.marketId}/bets`,
      body: {
        walletAddress,
        outcomeKey: due.outcomeKey,
        amount: due.amount,
        idempotencyKey: due.idempotencyKey,
        standingBetId: id,
      },
      marketId: due.marketId,
      amount: due.amount,
    });
  },
};

/** follow / unfollow: the creator the path names, as the Intent line prints it. */
async function followWrite(rt, f, action, method) {
  const walletAddress = requireWalletEnv(rt);
  const ref = creatorRef(f);
  const known = await get(rt, `/api/bazaar/v1/creators/${q(ref)}/follow?wallet=${walletAddress}`);
  if (known.status !== 200) return known;
  const subject = known.json.creator.wallet ?? known.json.creator.creatorId;
  return postSigned(rt, {
    action,
    market: "-",
    method,
    path: `/api/bazaar/v1/creators/${q(ref)}/follow`,
    body: { walletAddress },
    intent: `${action === "follow_creator" ? "follow" : "unfollow"} ${intentValue(subject)}`,
  });
}

const AUTH_COMMANDS = new Set([
  "draft", "standing-bet-draft", "create", "resolve", "void", "register",
  "claim", "share-link", "follow", "unfollow", "report", "standing-bet-create",
  "standing-bet-revoke", "subscribe", "unsubscribe", "bet", "standing-bet-run",
]);

export const USAGE = `usage: node scripts/bazaar.mjs <command> [--flag value ...]
reads:    fees | getting-started | skill-version | lookup --ref | market --id [--wallet]
          by-tweet --id | by-post --platform --id | quote --id --outcome --amount
          markets [--sort --q --creator --following --state --category --limit]
          creator --creator [--markets] | to-resolve --creator | positions --wallet
          results --id | receipt --id --wallet | status --wallet | earnings --wallet
          boards [--board --limit] | follow-status --creator --wallet
          standing-bets --wallet | standing-bet --id | standing-bet-check --id
          subscriptions --wallet
previews: draft --json | standing-bet-draft --json
writes (HUNCH_BANKR_API_KEY): create --json | create --preview-id --confirm | resolve --id --outcome [--note --evidence]
          void --id --note | register --label [--contact] | claim | share-link --id
          follow --creator | unfollow --creator | report --id --reason [--note]
          standing-bet-create --json | create --preview-id --confirm | standing-bet-revoke --id
          subscribe --url --events | unsubscribe --id
money:    bet --id --outcome --amount --idempotency-key [--ref-code --standing-bet]
          standing-bet-run --id`;

/** Runs one command. Returns the exit code; writes the result JSON to `out`. */
export async function run(argv, options = {}) {
  const rt = createRuntime(options);
  const out = options.out ?? ((text) => process.stdout.write(`${text}\n`));
  let parsed;
  try {
    parsed = parseArgs(argv);
    const command = COMMANDS[parsed.command];
    if (!command) {
      rt.log(USAGE);
      return 1;
    }
    if (AUTH_COMMANDS.has(parsed.command)) await authenticateBankrWallet(rt);
    const result = await command(rt, parsed.flags);
    out(result.json !== null ? JSON.stringify(result.json, null, 2) : result.text);
    if (result.refused) {
      rt.log(`bazaar: ${result.refused}`);
      return 2;
    }
    if (result.status >= 200 && result.status < 300) return 0;
    rt.log(`bazaar: HTTP ${result.status}`);
    return 2;
  } catch (error) {
    if (error instanceof BazaarSkillError) {
      rt.log(`bazaar: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
