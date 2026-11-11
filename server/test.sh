#!/usr/bin/env bash
# Smoke test for POST /verify. Start the server first: (cd server && pnpm start)
set -euo pipefail

curl -sS -X POST "${HOST:-http://localhost:8787}/verify" \
  -H 'Content-Type: application/json' \
  -d '{
    "pairs": [
      {
        "id": "c1",
        "claim": "The Eiffel Tower is a wrought-iron lattice tower on the Champ de Mars in Paris.",
        "url": "https://en.wikipedia.org/wiki/Eiffel_Tower"
      },
      {
        "id": "c2",
        "claim": "The Eiffel Tower is made of steel and was completed in 1925.",
        "url": "https://en.wikipedia.org/wiki/Eiffel_Tower"
      },
      {
        "id": "c3",
        "claim": "This source does not exist.",
        "url": "https://receipts-test.invalid/nope"
      }
    ]
  }' | (command -v jq >/dev/null && jq . || cat)
echo
