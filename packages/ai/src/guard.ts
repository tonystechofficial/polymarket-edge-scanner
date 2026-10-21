import { aiAnalysisSchema, safeJsonParse, type AiAnalysis, type AiAnalysisParsed } from '@pes/shared';

export type ParseResult = { ok: true; parsed: AiAnalysisParsed } | { ok: false; error: string };

function stripFences(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fence ? fence[1]! : trimmed;
}

/** First balanced `{...}` block of a text, respecting strings. Used when a model wraps its JSON in prose. */
function firstJsonObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function coerceText(text: string): unknown {
  const cleaned = stripFences(text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim());
  const direct = safeJsonParse<unknown>(cleaned);
  if (direct !== undefined) return direct;
  const block = firstJsonObject(cleaned);
  return block === undefined ? undefined : safeJsonParse<unknown>(block);
}

/**
 * Workers AI answers in two shapes: the legacy `{ response }` envelope and the OpenAI-style
 * `{ choices: [{ message: { content } }] }` one (newer models, sometimes with `response: null`).
 * Every plausible location is tried, in order, before giving up.
 */
function candidates(raw: unknown): unknown[] {
  const out: unknown[] = [];
  if (typeof raw === 'object' && raw !== null) {
    const r = raw as Record<string, unknown>;
    if (r.response !== null && r.response !== undefined) out.push(r.response);
    if (Array.isArray(r.choices)) {
      const content = (r.choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content;
      if (content !== null && content !== undefined) out.push(content);
    }
    const result = r.result as { response?: unknown } | undefined;
    if (result && typeof result === 'object' && result.response !== null && result.response !== undefined) out.push(result.response);
  }
  out.push(raw);
  return out;
}

/** Accept any known envelope, a bare object or a JSON string; validate strictly against the schema. */
export function parseAiResponse(raw: unknown): ParseResult {
  if (raw === null || raw === undefined) return { ok: false, error: 'empty response' };
  let lastError = 'no usable content';
  for (const candidate of candidates(raw)) {
    const value = typeof candidate === 'string' ? coerceText(candidate) : candidate;
    if (value === undefined) {
      lastError = 'response is not JSON';
      continue;
    }
    const result = aiAnalysisSchema.safeParse(value);
    if (result.success) return { ok: true, parsed: result.data };
    lastError = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  }
  return { ok: false, error: lastError };
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
