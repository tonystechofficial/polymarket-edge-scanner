import { aiAnalysisJsonSchema, type AiAnalysis } from '@pes/shared';
import { AiBudget, estimateNeurons } from './budget.ts';
import { fallbackAnalysis, parseAiResponse, sanitizeAnalysis } from './guard.ts';
import { approxTokens, buildMessages, type AnalysisInput } from './prompt.ts';

/** The subset of the Workers AI binding this package uses. Tests pass a stub. */
export interface AiBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

export type AnalysisStatus = 'ok' | 'invalid' | 'error' | 'skipped_quota';

export interface AnalysisOutcome {
  status: AnalysisStatus;
  analysis: AiAnalysis;
  adjustments: string[];
  usage: { inputTokens: number; outputTokens: number; estimated: boolean };
  neuronsEstimated: number;
  model: string;
  error?: string;
  rawExcerpt?: string;
  /** True when the error says the model itself cannot be used (deprecated, unknown): retrying is pointless. */
  unavailable?: boolean;
}

export function isModelUnavailable(message: string): boolean {
  return /deprecated|no such model|model not found|not supported|5028|5007/i.test(message);
}

function readUsage(raw: unknown): { inputTokens: number; outputTokens: number } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const usage = (raw as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }).usage;
  if (!usage) return null;
  const i = Number(usage.prompt_tokens);
  const o = Number(usage.completion_tokens);
  return Number.isFinite(i) && Number.isFinite(o) ? { inputTokens: i, outputTokens: o } : null;
}

/**
 * One guarded analysis call. The scanner survives every failure mode: quota refused before the
 * call, binding error, or output that does not match the schema. The model never sees secrets,
 * never decides anything about orders, limits or quotas.
 */
export async function analyzeMarket(ai: AiBinding, model: string, input: AnalysisInput, budget: AiBudget, options: { maxTokens?: number; temperature?: number } = {}): Promise<AnalysisOutcome> {
  const verdict = budget.canCall();
  if (!verdict.ok) {
    return { status: 'skipped_quota', analysis: fallbackAnalysis(verdict.reason), adjustments: [], usage: { inputTokens: 0, outputTokens: 0, estimated: true }, neuronsEstimated: 0, model, error: verdict.reason };
  }
  const messages = buildMessages(input);
  const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
  const promptTokens = Math.ceil(promptChars / 4);
  let raw: unknown;
  try {
    raw = await ai.run(model, {
      messages,
      response_format: { type: 'json_schema', json_schema: aiAnalysisJsonSchema },
      max_tokens: options.maxTokens ?? 450,
      temperature: options.temperature ?? 0.1,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A refused call (deprecated model, quota) most likely consumed nothing; the prompt size is still charged to stay conservative.
    const neurons = estimateNeurons(model, promptTokens, 0);
    budget.record(neurons);
    return { status: 'error', analysis: fallbackAnalysis('model_error'), adjustments: [], usage: { inputTokens: promptTokens, outputTokens: 0, estimated: true }, neuronsEstimated: neurons, model, error: message.slice(0, 300), unavailable: isModelUnavailable(message) };
  }

  const usage = readUsage(raw);
  const rawText = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null);
  const tokens = usage ?? { inputTokens: promptTokens, outputTokens: approxTokens(rawText) };
  const neurons = estimateNeurons(model, tokens.inputTokens, tokens.outputTokens);
  budget.record(neurons);

  const parsed = parseAiResponse(raw);
  if (!parsed.ok) {
    return { status: 'invalid', analysis: fallbackAnalysis('invalid_output'), adjustments: [], usage: { ...tokens, estimated: usage === null }, neuronsEstimated: neurons, model, error: parsed.error.slice(0, 300), rawExcerpt: rawText.slice(0, 500) };
  }
  const { analysis, adjustments } = sanitizeAnalysis(parsed.parsed);
  return { status: 'ok', analysis, adjustments, usage: { ...tokens, estimated: usage === null }, neuronsEstimated: neurons, model, rawExcerpt: rawText.slice(0, 500) };
}
