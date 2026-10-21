import type { CalibrationSample, ProbabilityEstimate } from '@pes/shared';

export interface CalibrationParams {
  /** Width of the price bins, e.g. 0.05 groups 0.30-0.35. */
  binWidth: number;
  /** Minimum resolved samples in the bin before an estimate is produced. */
  minSamples: number;
  /** Day edges of the time-to-resolution buckets. */
  horizonEdgesDays: number[];
  /** z for the Wilson interval (1.96 = 95%). */
  z: number;
}

export const DEFAULT_CALIBRATION_PARAMS: CalibrationParams = {
  binWidth: 0.05,
  minSamples: 30,
  horizonEdgesDays: [1, 7, 30],
  z: 1.96,
};

export function horizonBucket(daysToEnd: number, edges: number[]): number {
  let bucket = 0;
  for (const edge of edges) {
    if (daysToEnd >= edge) bucket += 1;
    else break;
  }
  return bucket;
}

export function priceBin(price: number, binWidth: number): number {
  const bins = Math.round(1 / binWidth);
  return Math.min(bins - 1, Math.max(0, Math.floor(price / binWidth + 1e-9)));
}

export function wilsonInterval(successes: number, n: number, z: number): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 1 };
  const phat = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (phat + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

export type CalibrationEstimate = { ok: true; estimate: ProbabilityEstimate } | { ok: false; reason: 'INSUFFICIENT_EVIDENCE'; n: number; detail: string };

/**
 * Empirical estimate: how often did markets that traded at a similar price, with a similar
 * time to resolution, actually resolve YES? The market's own price is never the answer; only
 * the resolved history of comparable markets is. With too few samples the honest output is
 * INSUFFICIENT_EVIDENCE.
 */
export function estimateFromCalibration(samples: readonly CalibrationSample[], price: number, daysToEnd: number, params: CalibrationParams): CalibrationEstimate {
  const bin = priceBin(price, params.binWidth);
  const horizon = horizonBucket(daysToEnd, params.horizonEdgesDays);
  const matching = samples.filter((s) => priceBin(s.price, params.binWidth) === bin && horizonBucket(s.daysToEnd, params.horizonEdgesDays) === horizon);
  const n = matching.length;
  const lo = bin * params.binWidth;
  const hi = lo + params.binWidth;
  if (n < params.minSamples) {
    return { ok: false, reason: 'INSUFFICIENT_EVIDENCE', n, detail: `${n} resolved markets in price bin [${lo.toFixed(2)}, ${hi.toFixed(2)}) and horizon bucket ${horizon}; ${params.minSamples} required` };
  }
  const successes = matching.reduce((s, m) => s + m.outcome, 0);
  const p = successes / n;
  const ci = wilsonInterval(successes, n, params.z);
  return {
    ok: true,
    estimate: {
      p,
      ciLow: ci.low,
      ciHigh: ci.high,
      n,
      source: 'empirical_calibration',
      explanation: `${n} resolved markets priced in [${lo.toFixed(2)}, ${hi.toFixed(2)}) in horizon bucket ${horizon} resolved YES ${(p * 100).toFixed(1)}% of the time (95% CI ${(ci.low * 100).toFixed(1)}-${(ci.high * 100).toFixed(1)}%).`,
    },
  };
}

export function brierScore(predictions: readonly number[], outcomes: readonly (0 | 1)[]): number {
  if (predictions.length === 0) return NaN;
  let sum = 0;
  for (let i = 0; i < predictions.length; i++) sum += (predictions[i]! - outcomes[i]!) ** 2;
  return sum / predictions.length;
}

export function logLoss(predictions: readonly number[], outcomes: readonly (0 | 1)[], eps = 1e-6): number {
  if (predictions.length === 0) return NaN;
  let sum = 0;
  for (let i = 0; i < predictions.length; i++) {
    const p = Math.min(1 - eps, Math.max(eps, predictions[i]!));
    sum += outcomes[i] === 1 ? -Math.log(p) : -Math.log(1 - p);
  }
  return sum / predictions.length;
}

export interface ReliabilityBin {
  binLow: number;
  binHigh: number;
  n: number;
  meanPrediction: number | null;
  observedRate: number | null;
}

export function reliabilityTable(predictions: readonly number[], outcomes: readonly (0 | 1)[], binWidth: number): ReliabilityBin[] {
  const bins = Math.round(1 / binWidth);
  const acc = Array.from({ length: bins }, () => ({ n: 0, sumP: 0, sumY: 0 }));
  for (let i = 0; i < predictions.length; i++) {
    const b = priceBin(predictions[i]!, binWidth);
    acc[b]!.n += 1;
    acc[b]!.sumP += predictions[i]!;
    acc[b]!.sumY += outcomes[i]!;
  }
  return acc.map((a, i) => ({
    binLow: Number((i * binWidth).toFixed(6)),
    binHigh: Number(((i + 1) * binWidth).toFixed(6)),
    n: a.n,
    meanPrediction: a.n ? a.sumP / a.n : null,
    observedRate: a.n ? a.sumY / a.n : null,
  }));
}

export interface ScoreSummary {
  n: number;
  brier: number;
  logLoss: number;
}

export interface BaselineComparison {
  /** The experimental estimator, scored only where it produced a forecast. */
  model: ScoreSummary;
  /** Reference: the market price taken as a forecast. */
  marketImplied: ScoreSummary;
  /** Reference: a constant 0.5. */
  uniform: ScoreSummary;
}

function summarize(preds: number[], outs: (0 | 1)[]): ScoreSummary {
  return { n: preds.length, brier: brierScore(preds, outs), logLoss: logLoss(preds, outs) };
}

/** Score the model against reference strategies on the same resolved samples. Abstentions (null) are excluded from the model's score, never replaced. */
export function compareWithBaselines(samples: readonly CalibrationSample[], modelPredictions: readonly (number | null)[]): BaselineComparison {
  const outcomes = samples.map((s) => s.outcome);
  const modelPreds: number[] = [];
  const modelOuts: (0 | 1)[] = [];
  samples.forEach((s, i) => {
    const p = modelPredictions[i];
    if (typeof p === 'number' && Number.isFinite(p)) {
      modelPreds.push(p);
      modelOuts.push(s.outcome);
    }
  });
  return {
    model: summarize(modelPreds, modelOuts),
    marketImplied: summarize(samples.map((s) => s.price), outcomes),
    uniform: summarize(samples.map(() => 0.5), outcomes),
  };
}
