/**
 * Functions injected into the active tab via chrome.scripting.executeScript({ func }).
 *
 * IMPORTANT: each exported function is serialized and run in the page's isolated
 * world, so it must be fully self-contained: no imports, no references to
 * module-level values (type-only imports are fine). State shared between calls
 * lives on globalThis.__receipts (the isolated world persists per tab).
 */
import type { ExtractResult, VerifyResult } from './types';

/** Reads the current selection, splits it into sentences, and pairs each sentence with its cited links. */
export const extractPairs = (): ExtractResult => {
  type Span = { start: number; end: number; textEnd: number };
  type TextSeg = { node: Text; start: number };

  const MAX_PAIRS = 30;
  const BLOCK_SEL =
    'p,li,dd,dt,td,th,blockquote,figcaption,caption,h1,h2,h3,h4,h5,h6,pre,article,section,main,aside,div,body';
  const SKIP_SEL = 'script,style,noscript,template,textarea,.mw-editsection';
  // Wikipedia-style footnote markers: [1], [a], [note 3], [citation needed] ...
  const MARKER_SRC = String.raw`\[(?:\d{1,4}|[a-z]{1,2}|(?:note|nb|n) ?\d{1,4}|[a-z ]{0,30}needed)\]`;
  const MARKER_RE = new RegExp(MARKER_SRC, 'gi');
  const BOUNDARY_RE = new RegExp(String.raw`[.!?]+["'”’»)]*((?:\s*${MARKER_SRC})*)(?=\s|$)`, 'gi');
  const ABBREV_RE =
    /^(?:\p{Lu}|mr|mrs|ms|dr|prof|st|jr|sr|vs|etc|e\.g|i\.e|u\.s|inc|ltd|co|corp|no|fig|approx|ca|al)$/iu;
  const isWikipedia = /(^|\.)wikipedia\.org$/.test(location.hostname);

  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    return { pairs: [], error: 'Select some text on the page first.' };
  }
  const R = sel.getRangeAt(0);

  const blockOf = (n: Node): Element => {
    const el = n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement;
    return el?.closest(BLOCK_SEL) ?? document.body;
  };
  const skipped = (n: Node) => !n.parentElement || !!n.parentElement.closest(SKIP_SEL);

  // --- URL resolution ---------------------------------------------------------
  const toUrl = (href: string): URL | null => {
    try {
      const u = new URL(href, location.href);
      return /^https?:$/.test(u.protocol) ? u : null;
    } catch {
      return null;
    }
  };
  const isWikiHost = (h: string) => h === location.hostname || /wikipedia\.org$|wikimedia\.org$|wikidata\.org$/.test(h);
  const firstExternalIn = (el: Element | null): string | null => {
    if (!el) return null;
    for (const a of Array.from(el.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
      const u = toUrl(a.href);
      if (u && !isWikiHost(u.hostname)) return u.href;
    }
    return null;
  };
  const byFragment = (href: string): Element | null => {
    try {
      return document.getElementById(decodeURIComponent(href.slice(1)));
    } catch {
      return null;
    }
  };
  const resolveCiteNote = (href: string): string | null => {
    const note = byFragment(href);
    if (!note) return null;
    const refText = note.querySelector('.reference-text') ?? note;
    const direct = firstExternalIn(refText);
    if (direct) return direct;
    // Short-form refs ("Smith 2010, p. 5") link to the full citation via #CITEREF…
    for (const a of Array.from(refText.querySelectorAll('a[href^="#"]'))) {
      const target = byFragment(a.getAttribute('href') ?? '');
      const url = firstExternalIn(target?.closest('cite, li') ?? target);
      if (url) return url;
    }
    return null;
  };
  const resolveHref = (a: HTMLAnchorElement): string | null => {
    const raw = a.getAttribute('href') ?? '';
    if (raw.startsWith('#cite_note')) return resolveCiteNote(raw);
    if (raw.startsWith('#')) return null;
    const u = toUrl(a.href);
    if (!u) return null;
    if (isWikipedia) return a.classList.contains('external') ? u.href : null; // wiki-links aren't citations
    if (u.origin + u.pathname === location.origin + location.pathname) return null; // same-page anchor
    return u.href;
  };

  // --- Sentence splitting -----------------------------------------------------
  const splitSentences = (text: string): Span[] => {
    const spans: Span[] = [];
    const push = (start: number, end: number, textEnd: number) => {
      while (start < end && /\s/.test(text[start])) start++;
      while (textEnd > start && /\s/.test(text[textEnd - 1])) textEnd--;
      if (textEnd > start) spans.push({ start, end, textEnd });
    };
    let start = 0;
    let m: RegExpExecArray | null;
    BOUNDARY_RE.lastIndex = 0;
    while ((m = BOUNDARY_RE.exec(text))) {
      const end = m.index + m[0].length;
      const markers = m[1] ?? '';
      const next = text.slice(end).match(/^\s*(\S)/)?.[1];
      if (!markers) {
        // Next sentence should start with a capital/digit/quote; avoids "approx. five".
        if (next && !/[\p{Lu}\p{N}"“'‘([]/u.test(next)) continue;
        // Abbreviations: "Dr. Smith", "J. Doe", "U.S. Army".
        const word = text.slice(start, m.index).match(/([\p{L}.]+)$/u)?.[1] ?? '';
        if (m[0][0] === '.' && ABBREV_RE.test(word)) continue;
      }
      push(start, end, end - markers.length);
      start = end;
    }
    if (start < text.length) push(start, text.length, text.length);
    return spans;
  };

  // --- Collect blocks touched by the selection --------------------------------
  const blocks: Element[] = [];
  const addBlock = (n: Node) => {
    const b = blockOf(n);
    if (!blocks.includes(b)) blocks.push(b);
  };
  const root = R.commonAncestorContainer;
  if (root.nodeType === Node.TEXT_NODE) {
    addBlock(root);
  } else {
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (tw.nextNode()) {
      const t = tw.currentNode;
      if (t.nodeValue?.trim() && !skipped(t) && R.intersectsNode(t)) addBlock(t);
    }
  }

  const g = globalThis as unknown as { __receipts?: { sentences: Range[]; pairSentence: Record<string, number> } };
  const state = { sentences: [] as Range[], pairSentence: {} as Record<string, number> };
  const pairs: ExtractResult['pairs'] = [];
  const seen = new Set<string>();
  let truncated = false;

  for (const block of blocks) {
    // Text of this block only (nested blocks handle their own text).
    const segs: TextSeg[] = [];
    let text = '';
    const tw = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode: n => (!skipped(n) && blockOf(n) === block ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    while (tw.nextNode()) {
      const node = tw.currentNode as Text;
      segs.push({ node, start: text.length });
      text += node.data;
    }
    if (!text.trim()) continue;

    const spans = splitSentences(text);
    if (!spans.length) continue;

    // Selection extent in this block's character space.
    let selS = Infinity;
    let selE = -Infinity;
    for (const s of segs) {
      if (!R.intersectsNode(s.node)) continue;
      const ls = s.node === R.startContainer ? R.startOffset : 0;
      const le = s.node === R.endContainer ? R.endOffset : s.node.length;
      selS = Math.min(selS, s.start + ls);
      selE = Math.max(selE, s.start + le);
    }
    const selected = new Set<number>();
    spans.forEach((sp, i) => {
      const a = Math.max(sp.start, selS);
      const b = Math.min(sp.end, selE);
      if (b > a && text.slice(a, b).trim()) selected.add(i);
    });

    const offsetOf = (el: Element): number => {
      for (const s of segs) {
        if (el.contains(s.node) || el.compareDocumentPosition(s.node) & Node.DOCUMENT_POSITION_FOLLOWING)
          return s.start;
      }
      return text.length;
    };
    const spanIndexAt = (off: number): number => {
      let idx = 0;
      spans.forEach((sp, i) => {
        if (sp.start <= off) idx = i;
      });
      return idx;
    };
    const claimOf = (sp: Span) => text.slice(sp.start, sp.end).replace(MARKER_RE, ' ').replace(/\s+/g, ' ').trim();
    const wordCount = (s: string) => s.split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length;

    const point = (off: number, isEnd: boolean): [Text, number] | null => {
      for (const s of segs) {
        const len = s.node.length;
        if (isEnd ? off > s.start && off <= s.start + len : off >= s.start && off < s.start + len) {
          return [s.node, off - s.start];
        }
      }
      return null;
    };
    const sentenceIdx = new Map<number, number>();
    const sentenceRangeIndex = (i: number): number => {
      const cached = sentenceIdx.get(i);
      if (cached !== undefined) return cached;
      const sp = spans[i];
      const s = point(sp.start, false);
      const e = point(sp.textEnd, true);
      const range = document.createRange();
      if (s && e) {
        range.setStart(s[0], s[1]);
        range.setEnd(e[0], e[1]);
      } else {
        range.selectNodeContents(block);
      }
      state.sentences.push(range);
      sentenceIdx.set(i, state.sentences.length - 1);
      return state.sentences.length - 1;
    };

    const links = Array.from(block.querySelectorAll<HTMLAnchorElement>('a[href]')).filter(
      a => blockOf(a) === block && !skipped(a),
    );
    for (const a of links) {
      const url = resolveHref(a);
      if (!url) continue;
      let target = spanIndexAt(offsetOf(a));
      // If the link's "sentence" is basically just the link (e.g. "Source."), it cites the previous one.
      const own = claimOf(spans[target]).replace((a.textContent ?? '').trim(), '');
      if (target > 0 && wordCount(own) < 3) target--;
      if (!selected.has(target) && !R.intersectsNode(a)) continue;

      const claim = claimOf(spans[target]);
      if (wordCount(claim) < 3) continue;
      const key = `${claim}\u0000${url}`;
      if (seen.has(key)) continue;
      if (pairs.length >= MAX_PAIRS) {
        truncated = true;
        break;
      }
      seen.add(key);
      const id = `c${pairs.length + 1}`;
      pairs.push({ id, claim, url });
      state.pairSentence[id] = sentenceRangeIndex(target);
    }
    if (truncated) break;
  }

  g.__receipts = state;
  if (!pairs.length) {
    return { pairs, error: 'No cited links found in the selection.' };
  }
  return { pairs, truncated };
};

/** Underlines claim sentences on the page (CSS Custom Highlight API) and shows a tooltip on hover. */
export const applyHighlights = (results: VerifyResult[]): number => {
  type Hover = { range: Range; results: VerifyResult[] };
  type State = { sentences: Range[]; pairSentence: Record<string, number>; hover?: Hover[] };
  const g = globalThis as unknown as { __receipts?: State; __receiptsListening?: boolean };
  const st = g.__receipts;
  const reg = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  const HighlightCtor = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (!st || !reg || !HighlightCtor) return 0;

  const COLORS = {
    supported: { name: 'receipts-supported', color: '#16a34a', label: 'Supported' },
    partial: { name: 'receipts-partial', color: '#ca8a04', label: 'Partial' },
    unsupported: { name: 'receipts-bad', color: '#dc2626', label: 'Unsupported' },
    contradicted: { name: 'receipts-bad', color: '#dc2626', label: 'Contradicted' },
    unreachable: { name: 'receipts-unreachable', color: '#6b7280', label: 'Unreachable' },
  } as const;
  const RANK = { contradicted: 0, unsupported: 1, partial: 2, supported: 3, unreachable: 4 } as const;

  if (!document.getElementById('receipts-highlight-style')) {
    const style = document.createElement('style');
    style.id = 'receipts-highlight-style';
    style.textContent = `
      ::highlight(receipts-supported) { text-decoration: underline solid 2px #16a34a; background-color: rgba(22,163,74,.10); }
      ::highlight(receipts-partial) { text-decoration: underline solid 2px #ca8a04; background-color: rgba(202,138,4,.12); }
      ::highlight(receipts-bad) { text-decoration: underline wavy 2px #dc2626; background-color: rgba(220,38,38,.10); }
      ::highlight(receipts-unreachable) { text-decoration: underline dashed 2px #6b7280; background-color: rgba(107,114,128,.10); }
      ::highlight(receipts-flash) { background-color: rgba(59,130,246,.35); }
    `;
    (document.head ?? document.documentElement).appendChild(style);
  }

  const bySentence = new Map<number, VerifyResult[]>();
  for (const r of results) {
    const si = st.pairSentence[r.id];
    if (si === undefined || !st.sentences[si]) continue;
    bySentence.set(si, [...(bySentence.get(si) ?? []), r]);
  }

  const groups: Record<string, Range[]> = {};
  st.hover = [];
  for (const [si, rs] of bySentence) {
    const sorted = [...rs].sort((a, b) => (RANK[a.verdict] ?? 9) - (RANK[b.verdict] ?? 9));
    const name = (COLORS[sorted[0].verdict] ?? COLORS.unreachable).name;
    (groups[name] ??= []).push(st.sentences[si]);
    st.hover.push({ range: st.sentences[si], results: sorted });
  }
  for (const c of Object.values(COLORS)) reg.delete(c.name);
  for (const [name, ranges] of Object.entries(groups)) reg.set(name, new HighlightCtor(...ranges));

  // --- Tooltip (shadow DOM so page CSS can't touch it) ------------------------
  let host = document.getElementById('receipts-tooltip-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'receipts-tooltip-host';
    host.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647;pointer-events:none;display:none;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      .tip { max-width: 360px; background: #111827; color: #f9fafb; font: 13px/1.4 system-ui, sans-serif;
             border-radius: 8px; padding: 10px 12px; box-shadow: 0 8px 24px rgba(0,0,0,.3); }
      .item + .item { margin-top: 10px; padding-top: 10px; border-top: 1px solid #374151; }
      .badge { display: inline-block; font-weight: 600; font-size: 11px; text-transform: uppercase;
               letter-spacing: .04em; padding: 1px 6px; border-radius: 4px; color: #fff; }
      .host { color: #9ca3af; font-size: 11px; margin-left: 6px; }
      .reason { margin-top: 4px; }
      .quote { margin-top: 6px; padding-left: 8px; border-left: 2px solid #4b5563; color: #d1d5db; font-style: italic; }
      .warn { color: #fbbf24; font-size: 11px; margin-top: 4px; }
    </style><div class="tip"></div>`;
    document.documentElement.appendChild(host);
  }

  const show = (h: Hover, x: number, y: number) => {
    const tip = host!.shadowRoot!.querySelector('.tip')!;
    tip.replaceChildren();
    for (const r of h.results) {
      const meta = COLORS[r.verdict] ?? COLORS.unreachable;
      const item = document.createElement('div');
      item.className = 'item';
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.style.background = meta.color;
      badge.textContent = meta.label;
      const src = document.createElement('span');
      src.className = 'host';
      try {
        src.textContent = new URL(r.url).hostname;
      } catch {
        src.textContent = r.url;
      }
      item.append(badge, src);
      if (r.reason) {
        const reason = document.createElement('div');
        reason.className = 'reason';
        reason.textContent = r.reason;
        item.append(reason);
      }
      if (r.quote) {
        const quote = document.createElement('div');
        quote.className = 'quote';
        quote.textContent = `“${r.quote}”`;
        item.append(quote);
        if (!r.quoteVerified) {
          const warn = document.createElement('div');
          warn.className = 'warn';
          warn.textContent = 'Quote not found verbatim in source';
          item.append(warn);
        }
      }
      tip.append(item);
    }
    host!.style.display = 'block';
    const w = host!.offsetWidth;
    const hgt = host!.offsetHeight;
    const left = Math.min(x + 12, window.innerWidth - w - 8);
    const top = y + 18 + hgt > window.innerHeight ? y - hgt - 12 : y + 18;
    host!.style.transform = `translate(${Math.max(8, left)}px, ${Math.max(8, top)}px)`;
  };
  const hide = () => {
    const el = document.getElementById('receipts-tooltip-host');
    if (el) el.style.display = 'none';
  };

  if (!g.__receiptsListening) {
    g.__receiptsListening = true;
    let frame = 0;
    document.addEventListener(
      'mousemove',
      e => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          const hovers = g.__receipts?.hover ?? [];
          const { clientX: x, clientY: y } = e;
          const hit = hovers.find(h =>
            Array.from(h.range.getClientRects()).some(
              r => x >= r.left && x <= r.right && y >= r.top - 2 && y <= r.bottom + 2,
            ),
          );
          if (hit) show(hit, x, y);
          else hide();
        });
      },
      { passive: true },
    );
    window.addEventListener('scroll', hide, { passive: true, capture: true });
  }

  return bySentence.size;
};

/** Removes all highlights and the tooltip. */
export const clearHighlights = (): void => {
  const reg = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  for (const name of [
    'receipts-supported',
    'receipts-partial',
    'receipts-bad',
    'receipts-unreachable',
    'receipts-flash',
  ]) {
    reg?.delete(name);
  }
  const g = globalThis as unknown as { __receipts?: { hover?: unknown[] } };
  if (g.__receipts) g.__receipts.hover = [];
  const host = document.getElementById('receipts-tooltip-host');
  if (host) host.style.display = 'none';
};

/** Scrolls the sentence for a pair into view and briefly flashes it. */
export const scrollToClaim = (id: string): boolean => {
  const g = globalThis as unknown as { __receipts?: { sentences: Range[]; pairSentence: Record<string, number> } };
  const range = g.__receipts?.sentences[g.__receipts.pairSentence[id]];
  if (!range) return false;
  const el = range.startContainer.parentElement;
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const reg = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  const HighlightCtor = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (reg && HighlightCtor) {
    reg.set('receipts-flash', new HighlightCtor(range));
    setTimeout(() => reg.delete('receipts-flash'), 1200);
  }
  return true;
};
