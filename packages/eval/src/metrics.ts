/**
 * Standard ranking metrics. Definitions kept explicit rather than pulled from a
 * library: the whole point of the harness is that anyone can check what the
 * numbers mean.
 */

/** 1 if any expected note appears in the top k. */
export function hitAtK(ranked: string[], expected: string[], k: number): number {
  return ranked.slice(0, k).some((r) => expected.includes(r)) ? 1 : 0;
}

/** Fraction of the expected notes found in the top k. */
export function recallAtK(ranked: string[], expected: string[], k: number): number {
  if (expected.length === 0) return 0;
  const top = ranked.slice(0, k);
  return expected.filter((e) => top.includes(e)).length / expected.length;
}

/** Reciprocal rank of the first expected note (0 if absent). */
export function reciprocalRank(ranked: string[], expected: string[]): number {
  const i = ranked.findIndex((r) => expected.includes(r));
  return i === -1 ? 0 : 1 / (i + 1);
}

/** Normalized discounted cumulative gain, binary relevance. */
export function ndcgAtK(ranked: string[], expected: string[], k: number): number {
  const dcg = ranked
    .slice(0, k)
    .reduce((sum, r, i) => sum + (expected.includes(r) ? 1 / Math.log2(i + 2) : 0), 0);
  const ideal = Array.from({ length: Math.min(expected.length, k) }).reduce<number>(
    (sum, _, i) => sum + 1 / Math.log2(i + 2),
    0,
  );
  return ideal === 0 ? 0 : dcg / ideal;
}

export interface Scorecard {
  queries: number;
  hit1: number;
  hit3: number;
  recall5: number;
  recall10: number;
  mrr: number;
  ndcg10: number;
}

export function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function scorecard(results: Array<{ ranked: string[]; expected: string[] }>): Scorecard {
  return {
    queries: results.length,
    hit1: mean(results.map((r) => hitAtK(r.ranked, r.expected, 1))),
    hit3: mean(results.map((r) => hitAtK(r.ranked, r.expected, 3))),
    recall5: mean(results.map((r) => recallAtK(r.ranked, r.expected, 5))),
    recall10: mean(results.map((r) => recallAtK(r.ranked, r.expected, 10))),
    mrr: mean(results.map((r) => reciprocalRank(r.ranked, r.expected))),
    ndcg10: mean(results.map((r) => ndcgAtK(r.ranked, r.expected, 10))),
  };
}
