/**
 * Reciprocal Rank Fusion (Cormack et al.): combine ranked lists using only
 * positions, never raw scores. Chosen deliberately — BM25 scores and PageRank
 * masses live on incomparable scales, and any hand-tuned weighting between them
 * would be exactly the guesswork this pipeline exists to avoid.
 */
export const RRF_K = 60;

export interface RankedList {
  name: string;
  items: string[];
  /** optional multiplier on this list's contribution */
  weight?: number;
}

export function reciprocalRankFusion(lists: RankedList[], k = RRF_K): Map<string, number> {
  const fused = new Map<string, number>();
  for (const list of lists) {
    const weight = list.weight ?? 1;
    list.items.forEach((id, i) => {
      fused.set(id, (fused.get(id) ?? 0) + weight / (k + i + 1));
    });
  }
  return fused;
}

/** Which lists contributed a given id, for explainability. */
export function contributions(lists: RankedList[], id: string): string[] {
  return lists.filter((l) => l.items.includes(id)).map((l) => l.name);
}
