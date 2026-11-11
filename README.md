# Receipts

**Does the source actually say that?**

Receipts is a Chrome extension that checks citations. Select text that cites links (an AI answer, an article, a Wikipedia paragraph) and click **Check receipts**. Receipts opens every cited source and tells you whether it really supports the sentence, with the exact quote as evidence.

- 🟢 **Supported**: the source backs the claim
- 🟡 **Partial**: the source backs part of it, or the claim overstates it
- 🔴 **Unsupported / contradicted**: the source doesn't say it, or says the opposite
- ⚪ **Unreachable**: the source couldn't be fetched

Built at the GDG on Campus Polytechnique Montréal × Google hackathon, on the theme *The Browser in the Age of AI*.

## How it works

```
Extension (selection → claim + link pairs)
        │  POST /verify
        ▼
Node backend ── fetches each source, strips HTML, keeps the most relevant paragraphs
        │
        ▼
Gemini on Vertex AI ── returns {verdict, quote, reason} as structured JSON
        │
        ▼
Quote check ── the quote must appear word for word in the source, or the verdict is downgraded
```

The AI's evidence is checked, not trusted: if Gemini returns a quote that isn't in the source, "supported" is downgraded to "partial".

## Run it locally

**Requirements:** Node 22+, pnpm, Chrome, and a Google Cloud project with Vertex AI enabled.

**Backend**
```bash
gcloud auth application-default login
cd server
pnpm install --ignore-workspace
pnpm start   # http://localhost:8787
```

**Extension**
```bash
pnpm install
pnpm dev
```
Then open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select the `dist` folder.

**Demo page:** http://localhost:8787/demo.html

## Stack

Chrome Extension (Manifest V3) · React · TypeScript · Vite · Node/Express · Gemini on Vertex AI (`@google/genai`)

Extension scaffold based on [chrome-extension-boilerplate-react-vite](https://github.com/Jonghakseo/chrome-extension-boilerplate-react-vite) (MIT).
