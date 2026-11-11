export type Verdict = 'supported' | 'partial' | 'unsupported' | 'contradicted' | 'unreachable';

export interface ClaimPair {
  id: string;
  claim: string;
  url: string;
}

export interface VerifyRequest {
  pairs: ClaimPair[];
}

export interface VerifyResult {
  id: string;
  claim: string;
  url: string;
  verdict: Verdict;
  quote: string;
  reason: string;
  quoteVerified: boolean;
}

export interface VerifyResponse {
  results: VerifyResult[];
}

export interface ExtractResult {
  pairs: ClaimPair[];
  error?: string;
  truncated?: boolean;
}
