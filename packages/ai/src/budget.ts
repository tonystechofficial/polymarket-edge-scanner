import { AI_MODEL_NEURON_RATES, AI_UNKNOWN_MODEL_NEURON_RATE } from '@pes/shared';

/** Neurons for a call, from the published per-million-token rates. Unknown models use the most expensive rate. */
export function estimateNeurons(model: string, inputTokens: number, outputTokens: number): number {
  const rate = AI_MODEL_NEURON_RATES[model] ?? AI_UNKNOWN_MODEL_NEURON_RATE;
  return (Math.max(0, inputTokens) * rate.inputPerMTok + Math.max(0, outputTokens) * rate.outputPerMTok) / 1_000_000;
}

export interface AiBudgetLimits {
  maxCallsPerRun: number;
  maxCallsPerDay: number;
  maxNeuronsPerDay: number;
}

export interface AiUsageToday {
  calls: number;
  neurons: number;
}

export type BudgetVerdict = { ok: true; reason?: undefined } | { ok: false; reason: 'run_call_limit' | 'daily_call_limit' | 'daily_neuron_limit' };

/** Per-invocation guard around the daily Workers AI allowance. Counts before calling, records after. */
export class AiBudget {
  private runCalls = 0;
  private runNeurons = 0;
  constructor(
    readonly limits: AiBudgetLimits,
    readonly usedToday: AiUsageToday,
  ) {}

  canCall(): BudgetVerdict {
    if (this.runCalls >= this.limits.maxCallsPerRun) return { ok: false, reason: 'run_call_limit' };
    if (this.usedToday.calls + this.runCalls >= this.limits.maxCallsPerDay) return { ok: false, reason: 'daily_call_limit' };
    if (this.usedToday.neurons + this.runNeurons >= this.limits.maxNeuronsPerDay) return { ok: false, reason: 'daily_neuron_limit' };
    return { ok: true };
  }

  record(neurons: number): void {
    this.runCalls += 1;
    this.runNeurons += Math.max(0, neurons);
  }

  get consumed(): { calls: number; neurons: number } {
    return { calls: this.runCalls, neurons: this.runNeurons };
  }
}
