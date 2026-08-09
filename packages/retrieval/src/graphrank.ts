import type { Graph } from "@manent/core";

/** Undirected adjacency over every edge kind — wikilinks are associative. */
export function buildAdjacency(graph: Graph): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  const add = (a: string, b: string) => {
    const list = adj.get(a);
    if (list) list.push(b);
    else adj.set(a, [b]);
  };
  for (const e of graph.edges) {
    if (!graph.nodes.has(e.from) || !graph.nodes.has(e.to)) continue; // skip dangling targets
    add(e.from, e.to);
    add(e.to, e.from);
  }
  return adj;
}

export interface PprOptions {
  /** probability of following an edge rather than teleporting back to the seeds */
  alpha?: number;
  iterations?: number;
}

/**
 * Personalized PageRank restricted to the seed neighbourhood.
 *
 * This is the step that makes wikilinks pay off: a note that never mentions the
 * query words still surfaces when the notes around it do. Cost is bounded by
 * the seeds' neighbourhood, not the whole vault.
 */
export function personalizedPageRank(
  adj: Map<string, string[]>,
  seeds: Map<string, number>,
  opts: PprOptions = {},
): Map<string, number> {
  const alpha = opts.alpha ?? 0.5;
  const iterations = opts.iterations ?? 12;

  const total = [...seeds.values()].reduce((a, b) => a + b, 0) || 1;
  const teleport = new Map<string, number>();
  for (const [n, w] of seeds) teleport.set(n, w / total);

  let rank = new Map(teleport);
  for (let i = 0; i < iterations; i++) {
    const next = new Map<string, number>();
    for (const [node, r] of rank) {
      const neighbours = adj.get(node);
      if (!neighbours || neighbours.length === 0) continue;
      const share = (alpha * r) / neighbours.length;
      if (share < 1e-6) continue; // prune negligible mass: keeps the walk local
      for (const nb of neighbours) next.set(nb, (next.get(nb) ?? 0) + share);
    }
    for (const [node, t] of teleport) next.set(node, (next.get(node) ?? 0) + (1 - alpha) * t);
    rank = next;
  }
  return rank;
}

/** Node degree, the cheap proxy for "how connected / central is this note". */
export function degreeMap(adj: Map<string, string[]>): Map<string, number> {
  const d = new Map<string, number>();
  for (const [n, list] of adj) d.set(n, list.length);
  return d;
}
