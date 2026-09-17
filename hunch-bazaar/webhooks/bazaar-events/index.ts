// webhooks/bazaar-events/index.ts
//
// Receives Bazaar events (bazaar.playhunch.xyz) and hands your Bankr agent the
// prompt each one carries: your market closed and needs resolving, a resolution
// is due, the 48h auto-refund is near, your bet won, lost or was refunded.
//
// Set up, from the folder holding bankr.webhooks.json:
//   1. bankr webhooks deploy          -> https://webhooks.bankr.bot/u/<your wallet>/bazaar-events
//   2. subscribe that URL on Bazaar   -> POST https://bazaar.playhunch.xyz/api/bazaar/v1/subscriptions
//      (walletAddress, url, events[], wallet proof); the response returns a secret ONCE
//   3. bankr webhooks env set BAZAAR_EVENTS_SECRET=<that secret>
//
// Every request is checked before the agent runs: X-Hunch-Signature is
// t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>"> keyed by the secret,
// refused when t is more than five minutes from this clock, compared in
// constant time. An unsigned, stale or altered request never reaches the agent.
// Bazaar retries a failed delivery (1m, 5m, 30m, 2h, 12h) with the same
// X-Hunch-Delivery id, and the thread is per market, so a retry lands in the
// conversation it belongs to.
import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_SECONDS = 300;
const SIGNATURE_HEX = /^[0-9a-f]{64}$/;
const TIMESTAMP_DIGITS = /^\d{1,12}$/;
const EVENT_TYPES = new Set([
  "market.closed",
  "market.resolve_due",
  "market.auto_refund_soon",
  "bet.won",
  "bet.lost",
  "bet.refunded",
  "standing_bet.filled",
  "standing_bet.ended",
]);

function parseSignature(header: string | null): { timestamp: number; signatures: string[] } | null {
  if (!header || header.length > 1024) return null;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      if (timestamp !== null || !TIMESTAMP_DIGITS.test(value)) return null;
      timestamp = Number(value);
    } else if (key === "v1" && SIGNATURE_HEX.test(value)) {
      signatures.push(value);
    }
  }
  return timestamp === null || signatures.length === 0 ? null : { timestamp, signatures };
}

export function verifyBazaarEvent(
  headers: Headers,
  rawBody: string,
  secret: string,
  nowMs: number = Date.now(),
): boolean {
  if (!secret) return false;
  const parsed = parseSignature(headers.get("x-hunch-signature"));
  if (!parsed) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - parsed.timestamp) > TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(
    createHmac("sha256", secret).update(`${parsed.timestamp}.${rawBody}`, "utf8").digest("hex"),
    "hex",
  );
  return parsed.signatures.some((signature) => {
    const given = Buffer.from(signature, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

export default async function handler(req: Request): Promise<Response> {
  const rawBody = await req.text();
  if (!verifyBazaarEvent(req.headers, rawBody, process.env.BAZAAR_EVENTS_SECRET ?? "")) {
    return new Response("invalid signature", { status: 401 });
  }

  let event: { id?: unknown; type?: unknown; prompt?: unknown; market?: { id?: unknown } | null };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("invalid body", { status: 400 });
  }
  if (
    typeof event.id !== "string" ||
    typeof event.type !== "string" ||
    !EVENT_TYPES.has(event.type) ||
    typeof event.prompt !== "string" ||
    event.prompt.length === 0
  ) {
    return new Response("unrecognised event", { status: 400 });
  }

  // The prompt is Bazaar's own text, built from stored numbers: plain facts, a
  // resolve instruction only for the creator's own market, and a note that any
  // quoted market title is text, not instructions.
  const marketId = typeof event.market?.id === "string" ? event.market.id : null;
  return Response.json({
    prompt: event.prompt,
    threadId: marketId ? `bazaar-${marketId}` : `bazaar-${event.id}`,
  });
}
