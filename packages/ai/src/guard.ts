import { aiAnalysisSchema, safeJsonParse, type AiAnalysis, type AiAnalysisParsed } from '@pes/shared';

export type ParseResult = { ok: true; parsed: AiAnalysisParsed } | { ok: false; error: string };

function stripFences(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fence ? fence[1]! : trimmed;
}

/** Accept the Workers AI envelope (`{ response }`), a bare object or a JSON string; validate strictly. */
export function parseAiResponse(raw: unknown): ParseResult {
  if (raw === null || raw === undefined) return { ok: false, error: 'empty response' };
  let candidate: unknown = raw;
  if (typeof raw === 'object' && raw !== null && 'response' in raw) candidate = (raw as { response: unknown }).response;
  if (typeof candidate === 'string') {
    const parsed = safeJsonParse<unknown>(stripFences(candidate));
    if (parsed === undefined) return { ok: false, error: 'response is not JSON' };
    candidate = parsed;
  }
  const result = aiAnalysisSchema.safeParse(candidate);
  if (!result.success) return { ok: false, error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  return { ok: true, parsed: result.data };
}

/**
 * Enforce the epistemic rules the prompt states. The model may not grant itself certainty:
 * a probability needs evidence, a source and fresh data; a REVIEW needs evidence; an AVOID
 * needs a stated risk. Every adjustment is recorded so the dashboard can show it.
 */
export function sanitizeAnalysis(parsed: AiAnalysisParsed): { analysis: AiAnalysis; adjustments: string[] } {
  const adjustments: string[] = [];
  const a: AiAnalysis = {
    summary: parsed.summary,
    probability_estimate: parsed.probability_estimate,
    confidence: parsed.confidence,
    supporting_evidence: parsed.supporting_evidence,
    contradicting_evidence: parsed.contradicting_evidence,
    sources: parsed.sources,
    data_freshness: parsed.data_freshness,
    recommendation: parsed.recommendation,
    resolution_risks: parsed.resolution_risks,
  };
  const hasEvidence = a.supporting_evidence.length > 0 || a.contradicting_evidence.length > 0;
  const wellSupported = a.supporting_evidence.length >= 2 && a.sources.length >= 1 && a.data_freshness !== 'unknown';

  if (a.confidence === 'high' && (a.sources.length === 0 || a.supporting_evidence.length < 2)) {
    a.confidence = 'low';
    adjustments.push('confidence_downgraded:unsupported_high');
  }
  if (a.probability_estimate !== null && (!wellSupported || a.confidence === 'low')) {
    a.probability_estimate = null;
    adjustments.push('probability_removed:unsupported');
  }
  if (a.recommendation === 'REVIEW' && !(hasEvidence && a.sources.length >= 1)) {
    a.recommendation = 'INSUFFICIENT_EVIDENCE';
    adjustments.push('recommendation_downgraded:review_without_evidence');
  }
  if (a.recommendation === 'AVOID' && a.resolution_risks.length === 0 && a.contradicting_evidence.length === 0) {
    a.recommendation = 'INSUFFICIENT_EVIDENCE';
    adjustments.push('recommendation_downgraded:avoid_without_risk');
  }
  return { analysis: a, adjustments };
}

export function fallbackAnalysis(reason: string): AiAnalysis {
  return {
    summary: `AI analysis unavailable (${reason}). The scanner continues without it.`,
    probability_estimate: null,
    confidence: 'low',
    supporting_evidence: [],
    contradicting_evidence: [],
    sources: [],
    data_freshness: 'unknown',
    recommendation: 'INSUFFICIENT_EVIDENCE',
    resolution_risks: [],
  };
}
