/**
 * Price weights, relative to one uncached input token. They follow the public API
 * price ratios of each vendor's current coding models, so "weighted tokens" track
 * what a request costs far better than a raw token count does. Plans do not
 * publish their meter formula; checkmeter only ever compares the meter with
 * itself (your own baseline), so the absolute scale does not matter.
 */
export const CODEX_WEIGHTS = { input: 1, cacheRead: 0.1, output: 8 };
export const CLAUDE_WEIGHTS = { input: 1, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2, output: 5 };

export function codexWeighted(input: number, cacheRead: number, output: number): number {
  return input * CODEX_WEIGHTS.input + cacheRead * CODEX_WEIGHTS.cacheRead + output * CODEX_WEIGHTS.output;
}

export function claudeWeighted(input: number, cacheRead: number, w5: number, w1h: number, output: number): number {
  const W = CLAUDE_WEIGHTS;
  return input * W.input + cacheRead * W.cacheRead + w5 * W.cacheWrite5m + w1h * W.cacheWrite1h + output * W.output;
}
