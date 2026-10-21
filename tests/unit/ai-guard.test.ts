import { describe, expect, it } from 'vitest';
import { AiBudget, analyzeMarket, buildMessages, estimateNeurons, fallbackAnalysis, parseAiResponse, sanitizeAnalysis } from '@pes/ai';

const valid = {
  summary: 'Market resolves on an official source; nothing in the description settles it today.',
  probability_estimate: null,
  confidence: 'low',
  supporting_evidence: [],
  contradicting_evidence: [],
  sources: [],
  data_freshness: 'unknown',
  recommendation: 'INSUFFICIENT_EVIDENCE',
  resolution_risks: ['Resolves 50-50 if the game is cancelled'],
};

describe('AI response parsing', () => {
  it('accepts the Workers AI envelope with an object response', () => {
    const r = parseAiResponse({ response: valid });
    expect(r.ok).toBe(true);
  });
  it('accepts a JSON string, with or without code fences', () => {
    expect(parseAiResponse({ response: JSON.stringify(valid) }).ok).toBe(true);
    expect(parseAiResponse({ response: '```json\n' + JSON.stringify(valid) + '\n```' }).ok).toBe(true);
  });
  it('rejects malformed or schema-violating output without throwing', () => {
    expect(parseAiResponse({ response: 'not json' }).ok).toBe(false);
    expect(parseAiResponse({ response: { ...valid, probability_estimate: 1.7 } }).ok).toBe(false);
    expect(parseAiResponse({ response: { ...valid, recommendation: 'BUY_NOW' } }).ok).toBe(false);
    expect(parseAiResponse(undefined).ok).toBe(false);
  });
});

describe('AI guard: the model cannot grant itself certainty', () => {
  it('nulls a probability that is not backed by evidence and sources', () => {
    const r = sanitizeAnalysis({ ...valid, probability_estimate: 0.8, confidence: 'high' } as never);
    expect(r.analysis.probability_estimate).toBeNull();
    expect(r.analysis.confidence).toBe('low');
    expect(r.adjustments.length).toBeGreaterThan(0);
  });
  it('keeps a probability when evidence, sources and freshness are all present', () => {
    const r = sanitizeAnalysis({
      ...valid,
      probability_estimate: 0.8,
      confidence: 'medium',
      supporting_evidence: ['Description states the event already occurred on 2026-10-01', 'Resolution source confirms'],
      sources: ['market description'],
      data_freshness: 'recent',
      recommendation: 'REVIEW',
    } as never);
    expect(r.analysis.probability_estimate).toBe(0.8);
    expect(r.adjustments).toHaveLength(0);
  });
  it('forces INSUFFICIENT_EVIDENCE when nothing supports a REVIEW recommendation', () => {
    const r = sanitizeAnalysis({ ...valid, recommendation: 'REVIEW' } as never);
    expect(r.analysis.recommendation).toBe('INSUFFICIENT_EVIDENCE');
  });
  it('provides a safe fallback analysis', () => {
    const f = fallbackAnalysis('quota_exhausted');
    expect(f.probability_estimate).toBeNull();
    expect(f.recommendation).toBe('INSUFFICIENT_EVIDENCE');
    expect(f.summary).toMatch(/quota_exhausted/);
  });
});

describe('AI budget and neuron accounting', () => {
  it('estimates neurons from the published per-token rates', () => {
    expect(estimateNeurons('@cf/meta/llama-3.1-8b-instruct', 1_000_000, 0)).toBeCloseTo(25_608, 6);
    expect(estimateNeurons('@cf/meta/llama-3.1-8b-instruct', 1000, 200)).toBeCloseTo(25.608 + 15.0294, 3);
    expect(estimateNeurons('@cf/unknown/model', 1000, 0)).toBeGreaterThan(estimateNeurons('@cf/meta/llama-3.1-8b-instruct', 1000, 0));
  });
  it('refuses calls beyond the per-run, per-day and neuron limits', () => {
    const b = new AiBudget({ maxCallsPerRun: 1, maxCallsPerDay: 10, maxNeuronsPerDay: 100 }, { calls: 9, neurons: 50 });
    expect(b.canCall().ok).toBe(true);
    b.record(60);
    expect(b.canCall().ok).toBe(false);
    const c = new AiBudget({ maxCallsPerRun: 2, maxCallsPerDay: 10, maxNeuronsPerDay: 1000 }, { calls: 10, neurons: 0 });
    expect(c.canCall().reason).toBe('daily_call_limit');
    const d = new AiBudget({ maxCallsPerRun: 2, maxCallsPerDay: 10, maxNeuronsPerDay: 1000 }, { calls: 0, neurons: 1000 });
    expect(d.canCall().reason).toBe('daily_neuron_limit');
  });
});

describe('analyzeMarket end to end with a stub binding', () => {
  const input = {
    marketId: 'm1',
    question: 'Will X happen by 2026-12-31?',
    description: 'Resolves YES if X is officially announced before 2026-12-31 23:59 ET according to source S.',
    endDate: '2026-12-31T23:59:00Z',
    category: 'politics',
    yesPrice: 0.42,
    liquidity: 10_000,
    now: new Date('2026-10-21T00:00:00Z'),
  };
  it('builds a bounded prompt that forbids trading instructions', () => {
    const msgs = buildMessages({ ...input, description: 'x'.repeat(10_000) });
    expect(msgs[0]?.role).toBe('system');
    expect(msgs[0]?.content).toMatch(/null/);
    expect(msgs.map((m) => m.content).join('').length).toBeLessThan(6_000);
  });
  it('returns a validated analysis and the token usage', async () => {
    const ai = { run: async () => ({ response: valid, usage: { prompt_tokens: 500, completion_tokens: 80 } }) };
    const budget = new AiBudget({ maxCallsPerRun: 1, maxCallsPerDay: 10, maxNeuronsPerDay: 1000 }, { calls: 0, neurons: 0 });
    const r = await analyzeMarket(ai, '@cf/meta/llama-3.1-8b-instruct', input, budget);
    expect(r.status).toBe('ok');
    expect(r.analysis.recommendation).toBe('INSUFFICIENT_EVIDENCE');
    expect(r.usage.inputTokens).toBe(500);
    expect(r.neuronsEstimated).toBeGreaterThan(0);
  });
  it('falls back gracefully on binding errors, invalid output and exhausted budget', async () => {
    const failing = { run: async () => { throw new Error('3040: Workers AI daily limit exceeded'); } };
    const budget = () => new AiBudget({ maxCallsPerRun: 1, maxCallsPerDay: 10, maxNeuronsPerDay: 1000 }, { calls: 0, neurons: 0 });
    const r1 = await analyzeMarket(failing, '@cf/meta/llama-3.1-8b-instruct', input, budget());
    expect(r1.status).toBe('error');
    expect(r1.analysis.recommendation).toBe('INSUFFICIENT_EVIDENCE');
    const garbage = { run: async () => ({ response: 'lol' }) };
    const r2 = await analyzeMarket(garbage, '@cf/meta/llama-3.1-8b-instruct', input, budget());
    expect(r2.status).toBe('invalid');
    const exhausted = new AiBudget({ maxCallsPerRun: 0, maxCallsPerDay: 10, maxNeuronsPerDay: 1000 }, { calls: 0, neurons: 0 });
    let called = false;
    const spy = { run: async () => { called = true; return { response: valid }; } };
    const r3 = await analyzeMarket(spy, '@cf/meta/llama-3.1-8b-instruct', input, exhausted);
    expect(r3.status).toBe('skipped_quota');
    expect(called).toBe(false);
  });
});
