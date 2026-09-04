import { noteName, type Note } from "@manent/core";
import type { Hit, Retriever } from "./types.js";

/**
 * `status` consumed by the ranker.
 *
 * A note in quarantine — written by an agent with nobody reading over its
 * shoulder — or one marked deprecated must not compete on equal terms with a
 * verified note. The field has been in the spec since v0.1; this is where it
 * starts to matter. Demotion is multiplicative on the ranker's own score, so
 * it works the same on a BM25 score and on an RRF mass, and a demoted note
 * still surfaces when nothing better exists.
 */
export const DEFAULT_STATUS_WEIGHTS: Record<string, number> = {
  quarantine: 0.5,
  deprecated: 0.5,
  archived: 0.25,
};

export function statusAware(inner: Retriever, notes: Note[], weights: Record<string, number> = DEFAULT_STATUS_WEIGHTS): Retriever {
  const demoted = new Map<string, { status: string; weight: number }>();
  for (const n of notes) {
    const status = typeof n.frontmatter.status === "string" ? n.frontmatter.status : undefined;
    if (status && weights[status] !== undefined && weights[status] < 1) demoted.set(noteName(n), { status, weight: weights[status] });
  }
  // Nothing to demote: the wrapper costs nothing and changes nothing.
  if (demoted.size === 0) return inner;

  return {
    name: inner.name,
    async search(query, k = 8) {
      // Look past k so a demoted note that fell out of the top can be replaced.
      const depth = Math.min(Math.max(k * 3, 20), 100);
      const hits = await inner.search(query, depth);
      const out: Hit[] = hits.map((h) => {
        const d = demoted.get(h.name);
        return d ? { ...h, score: h.score * d.weight, status: d.status } : h;
      });
      out.sort((a, b) => b.score - a.score);
      return out.slice(0, k);
    },
  };
}
