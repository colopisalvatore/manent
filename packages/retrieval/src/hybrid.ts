import { noteName, type Note } from "@manent/core";
import { bm25Candidates, buildSearchIndex } from "./bm25.js";
import { reciprocalRankFusion, type RankedList } from "./fusion.js";
import { buildAdjacency, degreeMap, personalizedPageRank } from "./graphrank.js";
import type { Hit, RetrievalInput, Retriever } from "./types.js";

/**
 * Ranking parameters, named and gathered so the eval harness can move one at a
 * time and see what it does. Defaults are the values the harness measured as
 * best on a real 300-note vault; see `packages/eval`.
 */
export interface HybridOptions {
  /** how many lexical candidates enter the pipeline */
  candidateDepth?: number;
  /** how many top lexical hits seed the graph walk */
  seedCount?: number;
  /** multiplier applied to hub notes (index/moc): they match every query */
  hubFactor?: number;
  /** half-life in days for the recency multiplier; 0 disables it */
  recencyHalfLifeDays?: number;
  /** max boost from graph centrality, e.g. 0.15 = up to +15% */
  importanceBoost?: number;
  /** weight of the graph-expansion list inside the fusion */
  graphWeight?: number;
  now?: number;
}

const DEFAULTS: Required<Omit<HybridOptions, "now">> = {
  candidateDepth: 60,
  seedCount: 5,
  hubFactor: 0.4,
  recencyHalfLifeDays: 365,
  importanceBoost: 0.15,
  graphWeight: 0.5,
};

const HUB_TYPES = new Set(["index", "moc"]);

const parseDate = (v: unknown): number | undefined => {
  if (typeof v !== "string") return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
};

/**
 * Lexical retrieval fused with graph expansion, then adjusted by note-level
 * signals (hub penalty, recency, centrality) — the shape used by the
 * Generative Agents memory model: relevance x recency x importance.
 *
 * Why the hub penalty exists: an always-loaded index note contains every topic
 * in the vault, so plain BM25 ranks it near the top for almost any query. It is
 * the least useful answer precisely because it is about everything.
 */
export function hybridRetriever(input: RetrievalInput, options: HybridOptions = {}): Retriever {
  const opts = { ...DEFAULTS, ...options };
  const index = buildSearchIndex(input.notes);
  const adj = buildAdjacency(input.graph);
  const degree = degreeMap(adj);
  const maxDegree = Math.max(1, ...degree.values());

  const byName = new Map<string, Note>();
  for (const n of input.notes) if (!byName.has(noteName(n))) byName.set(noteName(n), n);

  const meta = new Map<string, { description: string; path: string; hub: boolean; updated?: number }>();
  for (const [name, n] of byName) {
    const fm = n.frontmatter;
    meta.set(name, {
      description: String(fm.description ?? ""),
      path: n.relPath,
      hub: HUB_TYPES.has(String(fm.type ?? "")),
      updated: parseDate(fm.updated) ?? parseDate(fm.created),
    });
  }

  const recencyFactor = (updated?: number, now = Date.now()): number => {
    if (!opts.recencyHalfLifeDays || updated === undefined) return 1;
    const ageDays = Math.max(0, (now - updated) / 86_400_000);
    // 1.0 for a note touched today, asymptotically 0.75 for very old ones
    return 0.75 + 0.25 * Math.pow(0.5, ageDays / opts.recencyHalfLifeDays);
  };

  return {
    name: "hybrid",
    search(query, k = 8) {
      const candidates = bm25Candidates(index, query, opts.candidateDepth);
      if (candidates.length === 0) return [];

      const lexical: RankedList = { name: "bm25", items: candidates.map((c) => c.name) };

      const seeds = new Map<string, number>();
      candidates.slice(0, opts.seedCount).forEach((c, i) => seeds.set(c.name, 1 / (i + 1)));
      const ppr = personalizedPageRank(adj, seeds);
      const graphList: RankedList = {
        name: "graph",
        weight: opts.graphWeight,
        items: [...ppr.entries()]
          .filter(([name]) => byName.has(name))
          .sort((a, b) => b[1] - a[1])
          .slice(0, opts.candidateDepth)
          .map(([name]) => name),
      };

      const fused = reciprocalRankFusion([lexical, graphList]);
      const now = opts.now ?? Date.now();

      const scored: Hit[] = [];
      for (const [name, base] of fused) {
        const m = meta.get(name);
        if (!m) continue;
        const importance = 1 + opts.importanceBoost * ((degree.get(name) ?? 0) / maxDegree);
        const score = base * (m.hub ? opts.hubFactor : 1) * recencyFactor(m.updated, now) * importance;
        const via = [
          lexical.items.includes(name) ? "lex" : null,
          graphList.items.includes(name) ? "graph" : null,
          m.hub ? "hub-penalty" : null,
        ]
          .filter(Boolean)
          .join("+");
        scored.push({ name, description: m.description, path: m.path, score, via });
      }

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, k).map((h) => ({ ...h, score: Math.round(h.score * 100_000) / 100_000 }));
    },
  };
}
