export interface EdgeInput {
  /** Probability that the side being bought pays out (YES: p, NO: 1 - p). */
  pSide: number;
  /** Executable (volume-weighted) price for the intended size. */
  execPrice: number;
  /** Best displayed price, used only to report slippage. */
  bestPrice: number;
  feePerShare: number;
  safetyMargin: number;
}

export interface EdgeResult {
  grossEdgePerShare: number;
  feePerShare: number;
  slippagePerShare: number;
  netEdgePerShare: number;
  /** Probability at which the trade is exactly break-even after costs and margin. */
  breakEvenP: number;
}

/**
 * Expected value per share of buying one outcome share that pays 1 USDC if it wins:
 *   gross = pSide - execPrice
 *   net   = gross - fee - safetyMargin
 * Slippage is already inside execPrice; it is reported separately for the record.
 */
export function computeEdge(input: EdgeInput): EdgeResult {
  const grossEdgePerShare = input.pSide - input.execPrice;
  const slippagePerShare = Math.max(0, input.execPrice - input.bestPrice);
  const netEdgePerShare = grossEdgePerShare - input.feePerShare - input.safetyMargin;
  return {
    grossEdgePerShare,
    feePerShare: input.feePerShare,
    slippagePerShare,
    netEdgePerShare,
    breakEvenP: input.execPrice + input.feePerShare + input.safetyMargin,
  };
}
