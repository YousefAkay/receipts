# Receipts: "Does the source actually say that?"
Chrome extension (MV3, React/Vite/TS, pnpm, Turborepo). User selects text with links → "Check receipts" →
backend fetches each cited URL → Gemini on Vertex AI judges whether the source supports the claim →
sentences on the page get colored underlines + tooltips; side panel lists results.

## Layout
- server/        Node + Express backend (Yousef). Port 8787.
- pages/side-panel/src, pages/content/  Extension UI + selection capture + highlighting (teammate).

## API contract
POST http://localhost:8787/verify
req:  { "pairs": [ { "id": "c1", "claim": "sentence text", "url": "https://..." } ] }
res:  { "results": [ { "id": "c1", "claim": "", "url": "",
        "verdict": "supported|partial|unsupported|contradicted|unreachable",
        "quote": "exact sentence from source", "reason": "1 sentence", "quoteVerified": true } ] }

## Backend rules
- @google/genai with { vertexai: true, project: "goog-hackathon", location: "global" }, ADC auth (no keys in code).
- Model gemini-3.8-flash, responseMimeType application/json + responseSchema, thinking set low.
- Backend fetches sources (not the extension). Strip HTML to text, truncate ~40k chars.
- Validate quote: normalize whitespace/quotes/case, check it's a substring of source text.
  If not verified: quoteVerified=false and downgrade "supported" → "partial".
- Fetch failure/timeout (8s) → verdict "unreachable". Process pairs in parallel. Never return invalid JSON.

## Extension rules
- Wikipedia citations: resolve href "#cite_note-…" to the first external link in that reference.
- Claim = sentence containing or immediately preceding the link.
- Colors: green supported, yellow partial, red unsupported/contradicted, grey unreachable.

## Working rules
- Thinnest end-to-end slice first, polish after.
- Never commit secrets. Don't start/stop dev servers unless asked.
- No Claude/AI attribution in commits (no Co-Authored-By lines, no "Generated with" text).