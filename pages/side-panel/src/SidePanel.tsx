import '@src/SidePanel.css';
import { useStorage, withErrorBoundary, withSuspense } from '@extension/shared';
import { exampleThemeStorage } from '@extension/storage';
import { cn, ErrorDisplay, LoadingSpinner } from '@extension/ui';
import { USE_MOCK, verifyPairs } from '@src/receipts/api';
import { applyHighlights, clearHighlights, extractPairs, scrollToClaim } from '@src/receipts/inject';
import { useState } from 'react';
import type { Verdict, VerifyResult } from '@src/receipts/types';

const VERDICTS: Record<Verdict, { label: string; dot: string; border: string }> = {
  supported: { label: 'Supported', dot: 'bg-green-600', border: 'border-l-green-600' },
  partial: { label: 'Partial', dot: 'bg-yellow-500', border: 'border-l-yellow-500' },
  unsupported: { label: 'Unsupported', dot: 'bg-red-600', border: 'border-l-red-600' },
  contradicted: { label: 'Contradicted', dot: 'bg-red-600', border: 'border-l-red-600' },
  unreachable: { label: 'Unreachable', dot: 'bg-gray-400', border: 'border-l-gray-400' },
};

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

type Status =
  | { kind: 'idle' }
  | { kind: 'busy'; msg: string }
  | { kind: 'error'; msg: string }
  | { kind: 'done'; msg: string };

const SidePanel = () => {
  const { isLight } = useStorage(exampleThemeStorage);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [results, setResults] = useState<VerifyResult[]>([]);
  const [tabId, setTabId] = useState<number | null>(null);

  const checkReceipts = async () => {
    try {
      setStatus({ kind: 'busy', msg: 'Reading selection…' });
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('No active tab.');

      if (tabId !== null)
        await chrome.scripting.executeScript({ target: { tabId }, func: clearHighlights }).catch(() => {});
      setResults([]);
      setTabId(tab.id);

      const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractPairs });
      const extracted = injection?.result;
      if (!extracted || extracted.error || !extracted.pairs.length) {
        setStatus({ kind: 'error', msg: extracted?.error ?? 'Could not read the selection.' });
        return;
      }

      setStatus({ kind: 'busy', msg: `Checking ${extracted.pairs.length} citation(s)…` });
      const { results } = await verifyPairs(extracted.pairs);
      setResults(results);

      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: applyHighlights, args: [results] });
      setStatus({
        kind: 'done',
        msg: `${results.length} citation(s) checked${extracted.truncated ? ' (selection truncated)' : ''}${USE_MOCK ? ' · mock data' : ''}`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus({
        kind: 'error',
        msg: /cannot access|cannot be scripted|chrome:\/\//i.test(msg) ? "Can't run on this page." : msg,
      });
    }
  };

  const clear = async () => {
    if (tabId !== null)
      await chrome.scripting.executeScript({ target: { tabId }, func: clearHighlights }).catch(() => {});
    setResults([]);
    setStatus({ kind: 'idle' });
  };

  const focusClaim = (id: string) => {
    if (tabId !== null) void chrome.scripting.executeScript({ target: { tabId }, func: scrollToClaim, args: [id] });
  };

  const busy = status.kind === 'busy';
  const card = isLight ? 'bg-white border-gray-200' : 'bg-gray-900 border-gray-700';
  const muted = isLight ? 'text-gray-500' : 'text-gray-400';

  return (
    <div className={cn('App', isLight ? 'bg-slate-50 text-gray-900' : 'bg-gray-800 text-gray-100')}>
      <header className="mb-3">
        <h1 className="text-lg font-bold">Receipts</h1>
        <p className={cn('text-xs', muted)}>Select text with citations, then check whether the sources back it up.</p>
      </header>

      <div className="mb-3 flex gap-2">
        <button
          onClick={checkReceipts}
          disabled={busy}
          className="flex-1 rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
          {busy ? 'Checking…' : 'Check receipts'}
        </button>
        {results.length > 0 && (
          <button
            onClick={clear}
            className={cn('rounded-md border px-3 py-2 text-sm', isLight ? 'border-gray-300' : 'border-gray-600')}>
            Clear
          </button>
        )}
      </div>

      {status.kind !== 'idle' && (
        <p className={cn('mb-3 text-xs', status.kind === 'error' ? 'text-red-500' : muted)}>{status.msg}</p>
      )}

      <ul className="flex flex-col gap-2">
        {results.map(r => {
          const v = VERDICTS[r.verdict] ?? VERDICTS.unreachable;
          return (
            <li key={r.id}>
              <button
                onClick={() => focusClaim(r.id)}
                className={cn('w-full rounded-md border border-l-4 p-3 text-left text-sm', card, v.border)}>
                <div className="mb-1 flex items-center gap-2">
                  <span className={cn('inline-block h-2 w-2 rounded-full', v.dot)} />
                  <span className="text-xs font-semibold uppercase tracking-wide">{v.label}</span>
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={e => e.stopPropagation()}
                    className={cn('ml-auto truncate text-xs underline', muted)}>
                    {hostOf(r.url)}
                  </a>
                </div>
                <p className="line-clamp-3">{r.claim}</p>
                {r.reason && <p className={cn('mt-1 text-xs', muted)}>{r.reason}</p>}
                {r.quote && (
                  <blockquote
                    className={cn(
                      'mt-2 border-l-2 pl-2 text-xs italic',
                      isLight ? 'border-gray-300' : 'border-gray-600',
                    )}>
                    “{r.quote}”
                    {!r.quoteVerified && (
                      <span className="mt-1 block not-italic text-yellow-600">Quote not found verbatim in source</span>
                    )}
                  </blockquote>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default withErrorBoundary(withSuspense(SidePanel, <LoadingSpinner />), ErrorDisplay);
