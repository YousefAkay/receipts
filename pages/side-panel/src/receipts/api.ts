import type { ClaimPair, VerifyResponse, VerifyResult } from './types';

// Flip to false once the backend on :8787 is up.
const USE_MOCK = true;
const VERIFY_URL = 'http://localhost:8787/verify';

// Hardcoded mock response matching the API contract. The mock is cycled over
// the real pairs (id/claim/url are copied from the pair) so highlights land on
// actual sentences on the page.
const MOCK_RESPONSE: VerifyResponse = {
  results: [
    {
      id: 'c1',
      claim: '',
      url: '',
      verdict: 'supported',
      quote: 'The source states this figure directly in its second paragraph.',
      reason: 'The source explicitly states the claim with the same numbers.',
      quoteVerified: true,
    },
    {
      id: 'c2',
      claim: '',
      url: '',
      verdict: 'partial',
      quote: 'Early estimates suggested a range, though final numbers were not published.',
      reason: 'The source supports the general point but not the specific figure cited.',
      quoteVerified: false,
    },
    {
      id: 'c3',
      claim: '',
      url: '',
      verdict: 'contradicted',
      quote: 'The project was completed two years later than originally planned.',
      reason: 'The source gives a different date than the one claimed.',
      quoteVerified: true,
    },
    {
      id: 'c4',
      claim: '',
      url: '',
      verdict: 'unsupported',
      quote: '',
      reason: 'The source discusses the topic but never mentions this claim.',
      quoteVerified: false,
    },
    {
      id: 'c5',
      claim: '',
      url: '',
      verdict: 'unreachable',
      quote: '',
      reason: 'The source could not be fetched within 8 seconds.',
      quoteVerified: false,
    },
  ],
};

const mockVerify = async (pairs: ClaimPair[]): Promise<VerifyResponse> => {
  await new Promise(resolve => setTimeout(resolve, 500));
  const templates = MOCK_RESPONSE.results;
  return {
    results: pairs.map(
      (p, i): VerifyResult => ({ ...templates[i % templates.length], id: p.id, claim: p.claim, url: p.url }),
    ),
  };
};

const verifyPairs = async (pairs: ClaimPair[]): Promise<VerifyResponse> => {
  if (USE_MOCK) return mockVerify(pairs);
  const res = await fetch(VERIFY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairs }),
  });
  if (!res.ok) throw new Error(`Backend returned ${res.status}`);
  return (await res.json()) as VerifyResponse;
};

export { USE_MOCK, VERIFY_URL, verifyPairs };
