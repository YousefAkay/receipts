import { readFile } from 'node:fs/promises';
import express from 'express';
import cors from 'cors';
import { GoogleGenAI, Type, ThinkingLevel } from '@google/genai';

const PORT = Number(process.env.PORT) || 8787;
const MODEL = 'gemini-3.8-flash';
const FETCH_TIMEOUT_MS = 8000;
const VERDICTS = ['supported', 'partial', 'unsupported', 'contradicted', 'unreachable'];

// ADC auth — no keys in code.
const ai = new GoogleGenAI({ vertexai: true, project: 'goog-hackathon', location: 'global' });

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    verdict: { type: Type.STRING, enum: ['supported', 'partial', 'unsupported', 'contradicted'] },
    quote: { type: Type.STRING },
    reason: { type: Type.STRING },
  },
  required: ['verdict', 'quote', 'reason'],
};

// ---------- source fetching ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// Tags that separate text. Every other tag (a, b, i, span, sup, ...) is removed without
// inserting whitespace, so quotes read cleanly ("Paris, France." not "Paris , France .").
const BLOCK_TAGS =
  'p|div|li|ul|ol|h[1-6]|br|tr|td|th|table|thead|tbody|section|article|blockquote|dd|dt|dl|figcaption|pre|hr';

function htmlToText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|head|nav|footer)\b[\s\S]*?<\/\1\s*>/gi, '\n')
    // Wikipedia citation markers like [12]
    .replace(/<sup\b[^>]*\bclass\s*=\s*["'][^"']*\breference\b[^"']*["'][^>]*>[\s\S]*?<\/sup\s*>/gi, '')
    .replace(new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/[ \t\f\v\r ]+/g, ' ')
    .replace(/ *\n\s*/g, '\n')
    .trim();
}

// ---------- relevance selection ----------

const MAX_CONTEXT_CHARS = 15000;
const STOPWORDS = new Set(
  'the and for are was were has have had with that this from into onto its his her their they them than then also been being which who whom what when where while about after before over under between not but can could would should will may might did does all any each more most other some such only own same very just one two'.split(
    ' ',
  ),
);

function keywords(text) {
  const words = normalize(text).match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(words.filter(w => (w.length >= 3 || /\d/.test(w)) && !STOPWORDS.has(w)));
}

/** Pick the paragraphs that share the most keywords with the claim, up to ~15k chars, in original order. */
function selectRelevant(sourceText, claim) {
  if (sourceText.length <= MAX_CONTEXT_CHARS) return sourceText;
  const claimWords = keywords(claim);
  const paras = sourceText
    .split('\n')
    .map((text, index) => {
      const words = keywords(text);
      let score = 0;
      for (const w of claimWords) if (words.has(w)) score++;
      return { text, index, score };
    })
    .filter(p => p.score > 0);
  if (paras.length === 0) return sourceText.slice(0, MAX_CONTEXT_CHARS);

  paras.sort((a, b) => b.score - a.score || a.index - b.index);
  const picked = [];
  let total = 0;
  for (const p of paras) {
    if (total >= MAX_CONTEXT_CHARS) break;
    const text = p.text.slice(0, MAX_CONTEXT_CHARS - total);
    picked.push({ ...p, text });
    total += text.length + 2;
  }
  return picked
    .sort((a, b) => a.index - b.index)
    .map(p => p.text)
    .join('\n\n');
}

async function fetchSourceText(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; ReceiptsBot/0.1)',
      Accept: 'text/html,text/plain;q=0.9,*/*;q=0.5',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (type && !/text\/|html|xml|json/i.test(type)) throw new Error(`unsupported content-type ${type}`);
  const body = await res.text();
  const text = /html|xml/i.test(type) || /^\s*</.test(body) ? htmlToText(body) : body;
  if (!text.trim()) throw new Error('empty source');
  return text;
}

// ---------- quote verification ----------

function normalize(s) {
  return String(s)
    .normalize('NFKC')
    .replace(/[‘’‚‛′`]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isQuoteInSource(quote, sourceText) {
  const q = normalize(quote);
  return q.length > 0 && normalize(sourceText).includes(q);
}

// ---------- judging ----------

function buildPrompt(claim, sourceText) {
  return `You are a fact-checker. Decide whether the SOURCE supports the CLAIM.

Verdicts:
- "supported": the source clearly states what the claim says.
- "partial": the source supports some of the claim, or supports it only loosely/with different specifics.
- "unsupported": the source does not address the claim.
- "contradicted": the source states something incompatible with the claim.

Return:
- verdict
- quote: ONE sentence copied EXACTLY, character for character, from the SOURCE that is most relevant to the claim. Do not paraphrase, fix typos, or join sentences. Empty string only if nothing is relevant.
- reason: one short sentence explaining the verdict.

CLAIM:
${claim}

SOURCE:
"""
${sourceText}
"""`;
}

async function judge(claim, sourceText) {
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: buildPrompt(claim, sourceText),
    config: {
      responseMimeType: 'application/json',
      responseSchema,
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      temperature: 0,
    },
  });
  const parsed = JSON.parse(response.text ?? '');
  return {
    verdict: VERDICTS.includes(parsed.verdict) ? parsed.verdict : 'unsupported',
    quote: typeof parsed.quote === 'string' ? parsed.quote : '',
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
  };
}

async function verifyPair(pair) {
  const id = String(pair?.id ?? '');
  const claim = String(pair?.claim ?? '');
  const url = String(pair?.url ?? '');
  const base = { id, claim, url };

  let sourceText;
  try {
    sourceText = await fetchSourceText(url);
  } catch (err) {
    return { ...base, verdict: 'unreachable', quote: '', reason: `Could not fetch source (${err.message}).`, quoteVerified: false };
  }

  try {
    const { verdict: rawVerdict, quote, reason } = await judge(claim, selectRelevant(sourceText, claim));
    const quoteVerified = isQuoteInSource(quote, sourceText);
    const verdict = !quoteVerified && rawVerdict === 'supported' ? 'partial' : rawVerdict;
    return { ...base, verdict, quote, reason, quoteVerified };
  } catch (err) {
    console.error(`[verify] judge failed for ${id}:`, err);
    // Never show a false red because the checker itself failed.
    return { ...base, verdict: 'unreachable', quote: '', reason: `Checker error: ${err.message}`, quoteVerified: false };
  }
}

// ---------- cache ----------

// In-memory, keyed by claim+url, so re-checks return instantly with identical results.
// Stores the in-flight promise so concurrent duplicates share one check. Unreachable
// results (timeouts, checker errors) are evicted so a transient failure isn't frozen in.
const cache = new Map();

function verifyCached(pair) {
  const claim = String(pair?.claim ?? '');
  const url = String(pair?.url ?? '');
  const key = `${claim}\u0000${url}`;
  let entry = cache.get(key);
  if (entry) {
    console.log(`[verify] cache hit: ${url} | ${claim.slice(0, 60)}`);
  } else {
    entry = verifyPair({ claim, url }).then(result => {
      if (result.verdict === 'unreachable') cache.delete(key);
      return result;
    });
    cache.set(key, entry);
  }
  return entry.then(result => ({ ...result, id: String(pair?.id ?? '') }));
}

async function prewarm() {
  const file = new URL('./demo-pairs.json', import.meta.url);
  try {
    const { pairs } = JSON.parse(await readFile(file, 'utf8'));
    const results = await Promise.all(pairs.map(verifyCached));
    for (const r of results) console.log(`[prewarm] ${r.id}: ${r.verdict}`);
  } catch (err) {
    console.error('[prewarm] failed:', err.message);
  }
}

// ---------- server ----------

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(new URL('./public', import.meta.url).pathname)); // demo.html
app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/verify', async (req, res) => {
  const pairs = req.body?.pairs;
  if (!Array.isArray(pairs)) {
    return res.status(400).json({ results: [], error: 'Body must be { "pairs": [...] }' });
  }
  const results = await Promise.all(pairs.map(verifyCached));
  res.json({ results });
});

// Malformed JSON bodies etc. — always answer with JSON.
app.use((err, _req, res, _next) => {
  console.error('[server] error:', err);
  res.status(err.status || 500).json({ results: [], error: err.message || 'Internal error' });
});

app.listen(PORT, () => {
  console.log(`Receipts server listening on http://localhost:${PORT}`);
  prewarm();
});
