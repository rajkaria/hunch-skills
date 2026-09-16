#!/usr/bin/env bash
#
# HUNCH BAZAAR skill: helpers every wrapper in ../ sources. Never run directly.
#
# This file is where the skill's security invariants (SKILL.md, "Security
# invariants") are enforced for scripts, so no wrapper can skip one:
#
#   1. One origin. Every Bazaar request goes to https://bazaar.playhunch.xyz
#      over https, with no redirect followed. There is no override: a BASE in
#      the environment that names anything else stops the script.
#   2. Signing stays inside Bankr. BANKR_API_KEY goes to
#      https://api.bankr.bot/wallet/sign and nowhere else, read from a 0600
#      header file, never placed on a command line.
#   3. A wallet-proof message is signed only after bz_check_proof_challenge
#      accepts it: Bazaar's fixed 13-line text, for this action, this market,
#      this wallet, and the SHA-256 of exactly the body being sent.
#   4. A bet's x402 challenge is paid only after bz_check_x402_challenge accepts
#      it against ../../x402-registry.json, and the EIP-3009 authorization is
#      built from the pinned values, never copied from the challenge. One
#      authorization per idempotency key: a retry resends the same X-PAYMENT.
#
# Every value a wrapper puts into a JSON body goes through bz_json, so no text
# a user or a post supplied can add, drop or rename a field.
#
# Output: progress goes to stderr, results (JSON) to stdout.
# Requires: bash 3.2+, curl 7.55+, jq 1.6+, and shasum, sha256sum or openssl.

set -euo pipefail

if [ -z "${BZ_LIB_LOADED:-}" ]; then
  BZ_LIB_LOADED=1

  readonly BZ_ORIGIN="https://bazaar.playhunch.xyz"
  readonly BZ_BANKR_API="https://api.bankr.bot"
  readonly BZ_PROOF_DOMAIN_LINE="bazaar.playhunch.xyz asks you to sign a Bazaar action."
  readonly BZ_PROOF_FOOTER_LINE="Free to sign. Sends no transaction. Accepted once, within 5 minutes of Issued At."

  BZ_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  readonly BZ_LIB_DIR
  readonly BZ_REGISTRY="${BZ_LIB_DIR}/../../x402-registry.json"

  bz_die() {
    printf 'bazaar: %s\n' "$*" >&2
    exit 1
  }

  bz_say() {
    printf '\n== %s ==\n' "$*" >&2
  }

  bz_require() {
    local tool
    for tool in "$@"; do
      command -v "$tool" >/dev/null 2>&1 || bz_die "needs ${tool} on PATH"
    done
  }

  bz_require curl jq
  [ -f "$BZ_REGISTRY" ] || bz_die "x402-registry.json is missing next to SKILL.md"

  # Invariant 1: the origin is pinned. A BASE that names another host is refused,
  # never silently ignored, so a mistyped or injected override cannot redirect.
  if [ -n "${BASE:-}" ] && [ "${BASE%/}" != "$BZ_ORIGIN" ]; then
    bz_die "the Bazaar origin is pinned to ${BZ_ORIGIN}; refusing BASE=${BASE}"
  fi

  BZ_TMP="$(mktemp -d "${TMPDIR:-/tmp}/bazaar-skill.XXXXXX")"
  chmod 700 "$BZ_TMP"
  trap 'rm -rf "$BZ_TMP"' EXIT

  BZ_STATUS=""
  BZ_RESPONSE=""
fi

# ── Input rules ──────────────────────────────────────────────────────────────

bz_lower() {
  printf '%s' "$1" | tr 'A-Z' 'a-z'
}

bz_valid_wallet() {
  printf '%s' "$1" | grep -Eq '^0x[0-9a-fA-F]{40}$'
}

# bz_require_wallet NAME VALUE
bz_require_wallet() {
  bz_valid_wallet "$2" || bz_die "$1 must be a 0x wallet address (40 hex characters)"
}

bz_require_market_id() {
  printf '%s' "$1" | grep -Eq '^[A-Za-z0-9_-]{1,128}$' ||
    bz_die "MARKET_ID must be a Bazaar market id or private slug (letters, digits, _ or -)"
}

# bz_require_tweet_id VALUE NAME
bz_require_tweet_id() {
  printf '%s' "$1" | grep -Eq '^[1-9][0-9]{0,19}$' || bz_die "$2 must be a numeric X post id"
}

# bz_require_https_url NAME VALUE
bz_require_https_url() {
  printf '%s' "$2" | grep -Eq '^https://[^[:space:]]+$' || bz_die "$1 must be one https:// link"
}

bz_require_outcome() {
  printf '%s' "$1" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$' ||
    bz_die "OUTCOME must be one of the market's outcome keys (for example yes or no)"
}

bz_require_creator_ref() {
  printf '%s' "$1" | grep -Eq '^[A-Za-z0-9_@:.-]{1,120}$' ||
    bz_die "CREATOR must be a 0x wallet, an @handle or a creator id"
}

# bz_require_limit VALUE MAX
bz_require_limit() {
  printf '%s' "$1" | grep -Eq '^[1-9][0-9]{0,2}$' && [ "$1" -le "$2" ] ||
    bz_die "LIMIT must be a whole number from 1 to $2"
}

# Code points after trimming, the way the server counts a note.
bz_text_length() {
  jq -rn --arg v "$1" '$v | sub("^\\s+"; "") | sub("\\s+$"; "") | length'
}

# Decimal USDC → integer micros, exactly (no floating point).
bz_usdc_micros() {
  local whole="${1%%.*}" frac=""
  case "$1" in *.*) frac="${1#*.}" ;; esac
  frac="${frac}000000"
  frac="${frac:0:6}"
  printf '%d' "$((10#${whole} * 1000000 + 10#${frac}))"
}

bz_usdc_decimal() {
  printf '%d.%02d' "$(($1 / 1000000))" "$((($1 % 1000000) / 10000))"
}

# A bet amount: decimal USDC, at least the minimum pinned in x402-registry.json.
# Hunch sets no maximum (Bankr's own limits apply and Bankr tells the user). The
# 12-digit whole part only keeps the micros arithmetic inside 64-bit shell
# integers; it is not a betting limit.
bz_require_amount() {
  printf '%s' "$1" | grep -Eq '^[0-9]{1,12}(\.[0-9]{1,6})?$' ||
    bz_die "AMOUNT must be decimal USDC such as 5.00"
  local micros min
  micros="$(bz_usdc_micros "$1")"
  min="$(jq -r '.signingPolicy.limits.minAmountAtomic' "$BZ_REGISTRY")"
  [ "$micros" -ge "$min" ] || bz_die "the minimum bet is $(bz_usdc_decimal "$min") USDC"
}

# A value as a JSON string literal, quotes included, for the JSON heredocs.
bz_json() {
  jq -n --arg v "$1" '$v'
}

bz_uri() {
  jq -rn --arg v "$1" '$v | @uri'
}

# ── HTTP (invariant 1) ───────────────────────────────────────────────────────

# bz_http METHOD PATH [BODY] [HEADER_FILE]
# Sets BZ_STATUS (the HTTP code) and BZ_RESPONSE (a file holding the body).
bz_http() {
  local method="$1" path="$2" body="${3:-}" header_file="${4:-}"
  case "$path" in
    /api/bazaar/*) ;;
    *) bz_die "refusing a request outside ${BZ_ORIGIN}/api/bazaar/: ${path}" ;;
  esac
  case "$path" in
    *://* | *[[:space:]]*) bz_die "refusing a path that could leave ${BZ_ORIGIN}: ${path}" ;;
  esac

  BZ_RESPONSE="${BZ_TMP}/response-${RANDOM}${RANDOM}.json"
  local -a args
  args=(-sS --proto '=https' --max-redirs 0 --connect-timeout 10 --max-time 90
    -X "$method" -o "$BZ_RESPONSE" -w '%{http_code}' -H 'accept: application/json')
  if [ -n "$body" ]; then
    printf '%s' "$body" >"${BZ_TMP}/request.json"
    args+=(-H 'content-type: application/json' --data-binary "@${BZ_TMP}/request.json")
  fi
  if [ -n "$header_file" ]; then
    args+=(-H "@${header_file}")
  fi
  BZ_STATUS="$(curl "${args[@]}" "${BZ_ORIGIN}${path}")" ||
    bz_die "could not reach ${BZ_ORIGIN} (${method} ${path})"
}

# bz_expect CODE...: stop with the server's own words unless BZ_STATUS is one of them.
bz_expect() {
  local code
  for code in "$@"; do
    [ "$BZ_STATUS" = "$code" ] && return 0
  done
  printf 'bazaar: HTTP %s\n' "$BZ_STATUS" >&2
  jq -c '{error, message}
    + (if has("resetAt") then {resetAt} else {} end)
    + (if has("refund") then {refund} else {} end)
    + (if has("payment") then {payment} else {} end)' "$BZ_RESPONSE" >&2 2>/dev/null ||
    cat "$BZ_RESPONSE" >&2
  exit 2
}

# ── Hashing and randomness ───────────────────────────────────────────────────

bz_sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | cut -d' ' -f1
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum | cut -d' ' -f1
  else
    openssl dgst -sha256 -r | cut -d' ' -f1
  fi
}

# The SHA-256 a wallet proof signs: the body without its proof member, as
# canonical JSON (keys sorted, no whitespace), hex, lowercase.
bz_payload_sha256() {
  printf '%s' "$(printf '%s' "$1" | jq -S -c 'del(.proof)')" | bz_sha256
}

bz_random_hex32() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

# ── Invariant 3: the wallet-proof pre-sign check ─────────────────────────────

# bz_check_proof_challenge RESPONSE_FILE ACTION MARKET WALLET BODY [EXPECTED_INTENT]
# Prints "ok" when the 401 challenge is Bazaar's exact message for this request,
# else the first reason not to sign. MARKET is the market id, or "-".
bz_check_proof_challenge() {
  local file="$1" action="$2" market="$3" wallet body="$5" intent="${6:-}" sha
  wallet="$(bz_lower "$4")"
  sha="$(bz_payload_sha256 "$body")"
  jq -r \
    --slurpfile reg "$BZ_REGISTRY" \
    --arg action "$action" --arg market "$market" --arg wallet "$wallet" \
    --arg sha "$sha" --arg intent "$intent" \
    --arg domain "$BZ_PROOF_DOMAIN_LINE" --arg footer "$BZ_PROOF_FOOTER_LINE" '
    ($reg[0].signingPolicy.walletProof) as $policy
    | ($policy.actions[$action] // null) as $rule
    | (if type == "object" then .challenge else null end) as $c
    | (if ($c | type) == "object" then $c else {} end) as $ch
    | (if ($ch.proof | type) == "object" then $ch.proof else {} end) as $proof
    | ((if ($ch.message | type) == "string" then $ch.message else "" end) | split("\n")) as $l
    | (if ($proof.issuedAt | type) == "string" then $proof.issuedAt else "" end) as $iat
    | (if ($proof.nonce | type) == "string" then $proof.nonce else "" end) as $nonce
    | ($l[2] // "") as $intentLine
    | (try (($iat | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) - now) catch 1000000000) as $skew
    | [
        [$rule != null, "the skill never signs the action " + $action],
        [($c | type) == "object", "the 401 carries no challenge"],
        [$ch.scheme == $policy.scheme, "the challenge is not an eip191-personal-sign message"],
        [($l | length) == $policy.lineCount, "the message is not the 13-line Bazaar template"],
        [($l[0] // "") == $domain, "the first line is not the Bazaar domain line"],
        [($l[1] // "x") == "" and ($l[11] // "x") == "", "the blank lines are not where the template has them"],
        [($intentLine | startswith("Intent: ")), "there is no Intent line"],
        [(if $intent != "" then $intentLine == ("Intent: " + $intent)
          elif (($rule // {}) | has("intent")) then $intentLine == ("Intent: " + $rule.intent)
          else ($intentLine | startswith("Intent: " + (($rule // {}).intentPrefix // "(no intent rule for this action)"))) end),
          "the Intent line is not what the user asked for"],
        [($l[3] // "") == ("Action: " + $action), "the Action line is not " + $action],
        [(if (($rule // {}).market // "") == "-" then $market == "-" else $market != "-" end),
          "the market does not fit the action"],
        [($l[4] // "") == ("Market: " + $market), "the Market line is not " + $market],
        [($l[5] // "") == ("Wallet: " + $wallet), "the Wallet line is not your wallet"],
        [($l[6] // "") == ("Chain ID: " + ($policy.chainId | tostring)), "the Chain ID is not 8453"],
        [($l[7] // "") == ("Payload SHA-256: " + $sha), "the message signs a different body than the one being sent"],
        [(($ch.payloadSha256 // $sha) == $sha), "payloadSha256 is not the body being sent"],
        [($iat | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?Z$")),
          "Issued At is not ISO-8601 UTC"],
        [($l[8] // "") == ("Issued At: " + $iat), "the Issued At line does not match the challenge"],
        [($skew <= $policy.windowSeconds and $skew >= (0 - $policy.windowSeconds)),
          "Issued At is more than 5 minutes from now"],
        [($nonce | test("^[A-Za-z0-9_-]{16,128}$")), "the nonce is malformed"],
        [($l[9] // "") == ("Nonce: " + $nonce), "the Nonce line does not match the challenge"],
        [($l[10] // "") == ("Version: " + $policy.version), "the Version is not 1"],
        [($l[12] // "") == $footer, "the last line is not the Bazaar free-to-sign line"]
      ]
    | map(select(.[0] != true) | .[1])
    | if length == 0 then "ok" else .[0] end
  ' "$file"
}

# ── Invariant 4: the x402 pre-sign check ─────────────────────────────────────

# bz_check_x402_challenge RESPONSE_FILE MARKET_ID AMOUNT_ATOMIC
# Prints "ok" when the 402 challenge matches the pinned registry for exactly this
# market and this user-approved stake, else the first reason not to pay.
bz_check_x402_challenge() {
  jq -r --slurpfile reg "$BZ_REGISTRY" --arg market "$2" --arg amount "$3" '
    ($reg[0].signingPolicy) as $p
    | (if type == "object" then . else {} end) as $doc
    | ($doc.accepts // null) as $acc
    | (if ($acc | type) == "array" and (($acc[0] | type) == "object") then $acc[0] else {} end) as $a
    | (if ($a.extra | type) == "object" then $a.extra else {} end) as $extra
    | ($p.pinned.resourceTemplate | sub("\\{marketId\\}"; ($market | @uri))) as $resource
    | (($a.maxAmountRequired // "") | tostring) as $amountRequired
    | (if ($amountRequired | test("^[0-9]+$")) then ($amountRequired | tonumber) else -1 end) as $n
    | [
        [$doc.x402Version == 1, "x402Version is not 1"],
        [($acc | type) == "array" and ($acc | length) == 1, "accepts is empty or ambiguous"],
        [([$a.scheme, $a.network, $a.maxAmountRequired, $a.resource, $a.payTo, $a.asset] | all(type == "string")),
          "a required challenge field is missing"],
        [$a.scheme == $p.requireScheme, "the scheme is not exact"],
        [$a.network == $p.pinned.network, "the network is not base"],
        [(($a.asset // "") | tostring | ascii_downcase) == ($p.pinned.asset | ascii_downcase),
          "the asset is not Base USDC"],
        [(($a.payTo // "") | tostring | ascii_downcase) == ($p.pinned.payTo | ascii_downcase),
          "payTo is not the pinned settlement address"],
        [(($a.resource // "") | tostring | startswith($p.pinned.resourcePrefix)),
          "the resource is outside the pinned prefix"],
        [($a.resource // "") == $resource, "the resource is not the bet endpoint of this market"],
        [($extra.name // "") == $p.pinned.assetName and ($extra.version // "") == $p.pinned.assetVersion,
          "the USDC signing domain is not the pinned one"],
        [($amountRequired | test("^[0-9]+$")), "maxAmountRequired is not an integer"],
        [$n >= ($p.limits.minAmountAtomic | tonumber), "the amount is below the minimum bet"],
        [$amountRequired == $amount, "the amount is not the stake the user approved"]
      ]
    | map(select(.[0] != true) | .[1])
    | if length == 0 then "ok" else .[0] end
  ' "$1"
}

# ── Invariant 2: signing through the Bankr Wallet API ────────────────────────

bz_bankr_header_file() {
  [ -n "${BANKR_API_KEY:-}" ] ||
    bz_die "BANKR_API_KEY is not set; signing needs a Bankr API key with Wallet API write access"
  local f="${BZ_TMP}/bankr-headers"
  (
    umask 077
    printf 'X-API-Key: %s\n' "$BANKR_API_KEY" >"$f"
  )
  printf '%s' "$f"
}

# bz_bankr_sign REQUEST_FILE: POST it to /wallet/sign and print the signature.
# The signer Bankr reports must be WALLET: a proof or a payment for another
# wallet is never sent.
bz_bankr_sign() {
  local request="$1" headers out status sig signer
  headers="$(bz_bankr_header_file)"
  out="${BZ_TMP}/bankr-sign-${RANDOM}.json"
  status="$(curl -sS --proto '=https' --max-redirs 0 --connect-timeout 10 --max-time 60 \
    -X POST -H 'content-type: application/json' -H "@${headers}" \
    --data-binary "@${request}" -o "$out" -w '%{http_code}' \
    "${BZ_BANKR_API}/wallet/sign")" || bz_die "could not reach the Bankr Wallet API"
  [ "$status" = "200" ] ||
    bz_die "Bankr /wallet/sign answered ${status}: $(jq -c '{error, message}' "$out" 2>/dev/null || echo '(no JSON)')"
  sig="$(jq -r '.signature // empty' "$out")"
  signer="$(bz_lower "$(jq -r '.signer // empty' "$out")")"
  printf '%s' "$sig" | grep -Eq '^0x([0-9a-fA-F]{2}){65,}$' || bz_die "Bankr returned no usable signature"
  if [ -n "$signer" ] && [ "$signer" != "$(bz_lower "$WALLET")" ]; then
    bz_die "Bankr signed with ${signer}, not WALLET $(bz_lower "$WALLET"); refusing to use it"
  fi
  printf '%s' "$sig"
}

# ── A signed write: send, check the challenge, sign, resend ──────────────────

# bz_post_signed ACTION MARKET PATH BODY [EXPECTED_INTENT]
# Sends BODY without a proof. On 401 wallet_proof_required it checks the
# challenge (invariant 3), signs challenge.message with personal_sign and resends
# BODY plus the proof. A proof that expired or lost a nonce race gets ONE fresh
# challenge; nothing loops. Leaves BZ_STATUS and BZ_RESPONSE for the caller.
bz_post_signed() {
  local action="$1" market="$2" path="$3" body="$4" intent="${5:-}"
  local wallet code verdict signature issued nonce signed attempt=1
  wallet="$(bz_lower "$(printf '%s' "$body" | jq -r '.walletAddress // empty')")"
  bz_valid_wallet "$wallet" || bz_die "the request body names no walletAddress"
  [ "$wallet" = "$(bz_lower "${WALLET:-}")" ] || bz_die "the body's walletAddress is not WALLET"

  while :; do
    bz_http POST "$path" "$body"
    [ "$BZ_STATUS" = "401" ] || return 0
    code="$(jq -r '.error // empty' "$BZ_RESPONSE")"
    [ "$code" = "wallet_proof_required" ] || return 0

    verdict="$(bz_check_proof_challenge "$BZ_RESPONSE" "$action" "$market" "$wallet" "$body" "$intent")"
    [ "$verdict" = "ok" ] || bz_die "not signing: ${verdict}"

    jq -c '{signatureType: "personal_sign", message: .challenge.message}' "$BZ_RESPONSE" \
      >"${BZ_TMP}/proof-sign.json"
    signature="$(bz_bankr_sign "${BZ_TMP}/proof-sign.json")"
    issued="$(jq -r '.challenge.proof.issuedAt' "$BZ_RESPONSE")"
    nonce="$(jq -r '.challenge.proof.nonce' "$BZ_RESPONSE")"
    signed="$(printf '%s' "$body" | jq -c --arg s "$signature" --arg i "$issued" --arg n "$nonce" \
      '. + {proof: {signature: $s, issuedAt: $i, nonce: $n}}')"

    bz_http POST "$path" "$signed"
    [ "$BZ_STATUS" = "401" ] || return 0
    code="$(jq -r '.error // empty' "$BZ_RESPONSE")"
    case "$code" in
      wallet_proof_expired | wallet_proof_replayed)
        [ "$attempt" -lt 2 ] || return 0
        attempt=$((attempt + 1))
        ;;
      *) return 0 ;;
    esac
  done
}

# ── A market draft's optional fields ─────────────────────────────────────────

# bz_draft_options BODY: adds the optional draft fields named in the
# environment (X_HANDLE, SOURCE_TWEET_ID, OUTCOMES, CATEGORY, CLOSE_AT,
# RESOLVE_BY), each checked, each added through jq.
bz_draft_options() {
  local body="$1" handle=""
  if [ -n "${X_HANDLE:-}" ]; then
    handle="${X_HANDLE#@}"
    printf '%s' "$handle" | grep -Eq '^[A-Za-z0-9_]{1,15}$' ||
      bz_die "X_HANDLE must be an X handle (1-15 letters, digits or _)"
  fi
  if [ -n "${SOURCE_TWEET_ID:-}" ]; then
    bz_require_tweet_id "$SOURCE_TWEET_ID" SOURCE_TWEET_ID
  fi
  if [ -n "${CLOSE_AT:-}" ]; then
    printf '%s' "$CLOSE_AT" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,3})?)?Z$' ||
      bz_die "CLOSE_AT must be ISO-8601 UTC, for example 2026-09-19T20:00:00Z"
  fi
  if [ -n "${RESOLVE_BY:-}" ]; then
    printf '%s' "$RESOLVE_BY" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,3})?)?Z$' ||
      bz_die "RESOLVE_BY must be ISO-8601 UTC"
  fi
  if [ -n "${CATEGORY:-}" ]; then
    printf '%s' "$CATEGORY" | grep -Eq '^[A-Za-z0-9 -]{2,40}$' || bz_die "CATEGORY must be 2-40 letters, digits, spaces or hyphens"
  fi
  printf '%s' "$body" | jq -c \
    --arg handle "$handle" --arg tweet "${SOURCE_TWEET_ID:-}" --arg outcomes "${OUTCOMES:-}" \
    --arg category "${CATEGORY:-}" --arg closeAt "${CLOSE_AT:-}" --arg resolveBy "${RESOLVE_BY:-}" '
    . + (if $handle != "" then {xHandle: $handle} else {} end)
      + (if $tweet != "" then {sourceTweetId: $tweet} else {} end)
      + (if $outcomes != "" then
          {outcomeKeys: ($outcomes | split(",") | map(sub("^\\s+"; "") | sub("\\s+$"; "")) | map(select(length > 0)))}
         else {} end)
      + (if $category != "" then {category: $category} else {} end)
      + (if $resolveBy != "" then {resolveDeadlineAt: $resolveBy} else {} end)
    | if $closeAt != "" then (del(.closeIn) + {closeAt: $closeAt}) else . end'
}

# bz_confirm_draft DRAFT_FILE: stop unless the preview is valid, confirmed
# (CONFIRM=1) and still inside its confirm window. Prints the confirm body.
bz_confirm_draft() {
  local draft="$1"
  [ "$(jq -r '.valid' "$draft")" = "true" ] || bz_die "the draft has issues (above); nothing was created"
  if [ "${CONFIRM:-}" != "1" ]; then
    bz_say "nothing was created: show this preview, then re-run with CONFIRM=1 to publish exactly it"
    exit 0
  fi
  jq -e '(.confirm.confirmBy | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) > now' "$draft" >/dev/null ||
    bz_die "the close is now too near for this preview; draft again with a later close"
  jq -c '.confirm.body' "$draft"
}

# ── A paid bet: send, check the 402, authorize from pinned values, resend ────

bz_state_dir() {
  local dir="${BAZAAR_STATE_DIR:-${HOME}/.bazaar-skill}"
  (
    umask 077
    mkdir -p "$dir"
  )
  printf '%s' "$dir"
}

bz_payment_header_file() {
  local f="${BZ_TMP}/x-payment-${RANDOM}"
  (
    umask 077
    printf 'X-PAYMENT: %s\n' "$1" >"$f"
  )
  printf '%s' "$f"
}

# bz_sign_stake WALLET AMOUNT_ATOMIC: an EIP-3009 transferWithAuthorization for
# exactly AMOUNT_ATOMIC to the PINNED payTo, valid for at most the pinned window,
# signed through Bankr. Prints the base64 X-PAYMENT value.
bz_sign_stake() {
  local wallet="$1" atomic="$2" now valid_after valid_before nonce sig
  now="$(date -u +%s)"
  valid_after=$((now - 60))
  valid_before=$((now + $(jq -r '.signingPolicy.limits.maxValiditySeconds' "$BZ_REGISTRY")))
  nonce="0x$(bz_random_hex32)"
  jq -n --slurpfile reg "$BZ_REGISTRY" --arg from "$wallet" --arg value "$atomic" \
    --arg nonce "$nonce" --arg va "$valid_after" --arg vb "$valid_before" '
    ($reg[0].signingPolicy.pinned) as $p
    | {
        signatureType: "eth_signTypedData_v4",
        typedData: {
          domain: {name: $p.assetName, version: $p.assetVersion, chainId: $p.chainId, verifyingContract: $p.asset},
          types: {
            TransferWithAuthorization: [
              {name: "from", type: "address"},
              {name: "to", type: "address"},
              {name: "value", type: "uint256"},
              {name: "validAfter", type: "uint256"},
              {name: "validBefore", type: "uint256"},
              {name: "nonce", type: "bytes32"}
            ]
          },
          primaryType: "TransferWithAuthorization",
          message: {from: $from, to: ($p.payTo | ascii_downcase), value: $value,
            validAfter: $va, validBefore: $vb, nonce: $nonce}
        }
      }' >"${BZ_TMP}/stake-sign.json"
  sig="$(bz_bankr_sign "${BZ_TMP}/stake-sign.json")"
  printf '%s' "$sig" | grep -Eq '^0x[0-9a-fA-F]{130}$' ||
    bz_die "Bazaar bets need a 65-byte wallet signature; this wallet signed with a longer (smart-account) one"
  jq -cn --slurpfile reg "$BZ_REGISTRY" --arg sig "$sig" --arg from "$wallet" --arg value "$atomic" \
    --arg nonce "$nonce" --argjson va "$valid_after" --argjson vb "$valid_before" '
    {x402Version: 1, scheme: "exact", network: "base",
     payload: {signature: $sig,
       authorization: {from: $from, to: ($reg[0].signingPolicy.pinned.payTo | ascii_downcase),
         value: $value, validAfter: $va, validBefore: $vb, nonce: $nonce}}}' | base64 | tr -d '\n'
}

# bz_post_paid PATH BODY MARKET_ID AMOUNT_DECIMAL
# Sends the bet without payment. On 402 it checks the challenge (invariant 4),
# signs ONE authorization and resends. The signed payment is kept (0600) under
# the bet's idempotency key until a receipt arrives, so a rerun resends the SAME
# X-PAYMENT instead of signing a second one. Leaves BZ_STATUS and BZ_RESPONSE.
bz_post_paid() {
  local path="$1" body="$2" market="$3" amount="$4"
  local wallet atomic idem outcome saved bet_key header verdict code
  wallet="$(bz_lower "$(printf '%s' "$body" | jq -r '.walletAddress // empty')")"
  [ "$wallet" = "$(bz_lower "${WALLET:-}")" ] || bz_die "the body's walletAddress is not WALLET"
  atomic="$(bz_usdc_micros "$amount")"
  idem="$(printf '%s' "$body" | jq -r '.idempotencyKey // empty')"
  outcome="$(printf '%s' "$body" | jq -r '.outcomeKey // empty')"
  printf '%s' "$idem" | grep -Eq '^[A-Za-z0-9_:.-]{8,128}$' || bz_die "IDEM must be 8-128 of A-Z a-z 0-9 _ : . -"
  saved="$(bz_state_dir)/x402-$(printf '%s' "$idem" | tr ':.' '__').json"
  bet_key="${wallet}|${market}|${outcome}|${atomic}"

  if [ -s "$saved" ]; then
    [ "$(jq -r '.bet' "$saved")" = "$bet_key" ] ||
      bz_die "IDEM ${idem} already paid for a different bet; use a new IDEM for a new bet"
    header="$(jq -r '.header' "$saved")"
    bz_say "resending the payment already signed for ${idem} (never a second signature)"
  else
    bz_http POST "$path" "$body"
    [ "$BZ_STATUS" = "402" ] || return 0
    verdict="$(bz_check_x402_challenge "$BZ_RESPONSE" "$market" "$atomic")"
    [ "$verdict" = "ok" ] || bz_die "not paying: ${verdict}"
    header="$(bz_sign_stake "$wallet" "$atomic")"
    (
      umask 077
      jq -n --arg bet "$bet_key" --arg header "$header" '{bet: $bet, header: $header}' >"$saved"
    )
  fi

  bz_http POST "$path" "$body" "$(bz_payment_header_file "$header")"
  code="$(jq -r '.error // empty' "$BZ_RESPONSE" 2>/dev/null || true)"
  if { [ "$BZ_STATUS" = "503" ] && [ "$code" = "settlement_failed" ]; } ||
    { [ "$BZ_STATUS" = "409" ] && [ "$code" = "payment_replayed" ]; }; then
    bz_say "${code}: resending the SAME payment once"
    sleep 5
    bz_http POST "$path" "$body" "$(bz_payment_header_file "$header")"
  fi
  case "$BZ_STATUS" in
    200 | 201) rm -f "$saved" ;;
  esac
}
