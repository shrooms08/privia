#!/usr/bin/env bash
# Mint an HS256 JWT for the Canton JSON Ledger API (local/dev only).
#
# Canton 3.x tokens identify a USER, not a party. Party authorization comes
# from the user's rights (actAs/readAs) on the participant; the party you act
# as goes in the request body ("actAs": [...]), not in the token.
#
# The default `dpm sandbox` runs with NO auth: requests work with no
# Authorization header at all, and any Bearer token is accepted/ignored.
# This script exists so the frontend client can be written token-aware from
# day one; against a secured participant, swap SECRET/audience for real values.
#
# Usage: ./scripts/mint-token.sh <user-id> [secret]
#   e.g. ./scripts/mint-token.sh ledger-api-user

USER_ID="${1:?usage: mint-token.sh <user-id> [secret]}"
SECRET="${2:-unsafe-local-secret}"

python3 - "$USER_ID" "$SECRET" <<'EOF'
import base64, hashlib, hmac, json, sys, time

def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()

user_id, secret = sys.argv[1], sys.argv[2]
header = {"alg": "HS256", "typ": "JWT"}
claims = {
    "sub": user_id,                      # ledger user id
    "aud": "https://daml.com/jwt/aud/participant/sandbox",
    "scope": "daml_ledger_api",
    "iss": "local-unsafe-issuer",
    "exp": int(time.time()) + 86400,
}
signing_input = f"{b64url(json.dumps(header).encode())}.{b64url(json.dumps(claims).encode())}"
sig = hmac.new(secret.encode(), signing_input.encode(), hashlib.sha256).digest()
print(f"{signing_input}.{b64url(sig)}")
EOF
