import { buildGraph, noteName, type Note } from "@manent/core";
import { buildAdjacency } from "@manent/retrieval";

/**
 * Communities in the wikilink graph, and the maps of content that are missing.
 *
 * A vault's folders are one taxonomy, chosen once. Its links are another, made
 * a note at a time by whoever was writing, and it is the honest one: notes that
 * get linked together are the subjects a person actually works on. Finding
 * those groups says where a map of content would earn its place — and, just as
 * useful, where one already exists so nobody writes a second.
 *
 * Two decisions shape the answer:
 *
 * - **Index and MOC notes are not part of the graph.** An index links every
 *   note in the vault by design, and one such star pulls the whole graph into a
 *   single community: measured on a 488-note vault, leaving them in produced
 *   one community of 437 notes and a modularity of 0.000. They come back at the
 *   end, to say whether a community already has a map.
 * - **Louvain, plus the guarantee that motivated Leiden.** Modularity
 *   optimisation with aggregation, then any community whose induced subgraph is
 *   disconnected is split into its components — Louvain can produce those, and
 *   a "community" in two disconnected halves is not a subject. Node order is
 *   fixed and nothing is randomised, so two runs give the same answer: a
 *   suggestion that moves between runs is one nobody can act on.
 */

export interface MapCoverage {
  /** the MOC's name */
  name: string;
  /** how many of the community's members it links */
  links: number;
}

export interface Community {
  id: number;
  /** members, most linked first */
  members: string[];
  size: number;
  /** the notes that hold the group together: highest degree inside it */
  hubs: string[];
  /** maps of content already about it, with how many of its members each links */
  mocs: MapCoverage[];
  /** links with both ends inside, and links leaving it */
  internalEdges: number;
  externalEdges: number;
  /**
   * Open gaps whose best answers landed in this community: questions people
   * asked that this subject failed to answer. Set only when the caller passes
   * the register's numbers, and then it is what orders the report — which
   * suggestion is worth acting on is a question about demand, not about size.
   */
  openGaps?: number;
}

export interface CommunityOptions {
  /** communities smaller than this are not reported: they are not subjects */
  minSize?: number;
  /** name → how many open gaps had this note among their best answers */
  gapWeight?: Map<string, number>;
}

export interface CommunityReport {
  communities: Community[];
  /** modularity of the partition: 0 is no structure, 0.3 and up is real */
  modularity: number;
  /** notes with no links at all, once indexes are out: no community can be inferred */
  isolated: number;
  /** notes and links the clustering actually ran on */
  nodes: number;
  edges: number;
  /** index and MOC notes held out of the graph */
  excluded: number;
}

const MAP_TYPES = new Set(["moc", "index"]);
export const DEFAULT_MIN_SIZE = 4;

/** Symmetric weighted graph; self-loops carry the weight collapsed into a node. */
type WGraph = Map<string, Map<string, number>>;

/** Sum of incident weights; a self-loop counts twice, as everywhere in modularity. */
const degreeOf = (g: WGraph, node: string): number => {
  const row = g.get(node);
  if (!row) return 0;
  let sum = 0;
  for (const w of row.values()) sum += w;
  return sum + (row.get(node) ?? 0);
};

const totalDegree = (g: WGraph): number => {
  let m2 = 0;
  for (const node of g.keys()) m2 += degreeOf(g, node);
  return m2;
};

/** The wikilink graph, with the notes that link everything held out of it. */
function linkGraph(notes: Note[], keep: (name: string) => boolean): WGraph {
  const adjacency = buildAdjacency(buildGraph(notes));
  const g: WGraph = new Map();
  for (const n of notes) if (keep(noteName(n))) g.set(noteName(n), new Map());
  for (const [from, tos] of adjacency) {
    if (!g.has(from)) continue;
    for (const to of tos) {
      if (to === from || !g.has(to)) continue;
      // One link is one edge however many times it was written.
      g.get(from)!.set(to, 1);
      g.get(to)!.set(from, 1);
    }
  }
  return g;
}

/**
 * One Louvain pass: every node starts alone, then each moves to the
 * neighbouring community with the best modularity gain, until nothing moves.
 */
function localMoving(g: WGraph, m2: number): Map<string, string> {
  const community = new Map<string, string>();
  const degree = new Map<string, number>();
  const communityDegree = new Map<string, number>();
  const names = [...g.keys()].sort();
  for (const n of names) {
    const k = degreeOf(g, n);
    community.set(n, n);
    degree.set(n, k);
    communityDegree.set(n, k);
  }
  if (m2 === 0) return community;

  let moved = true;
  let rounds = 0;
  while (moved && rounds++ < 30) {
    moved = false;
    for (const node of names) {
      const own = community.get(node)!;
      const k = degree.get(node)!;
      communityDegree.set(own, communityDegree.get(own)! - k);

      // Weight from this node into each neighbouring community, self excluded.
      const into = new Map<string, number>();
      for (const [nb, w] of g.get(node)!) {
        if (nb === node) continue;
        const c = community.get(nb)!;
        into.set(c, (into.get(c) ?? 0) + w);
      }
      if (!into.has(own)) into.set(own, 0);

      let best = own;
      let bestGain = (into.get(own) ?? 0) - (communityDegree.get(own)! * k) / m2;
      for (const [c, wIn] of [...into].sort((a, b) => a[0].localeCompare(b[0]))) {
        const gain = wIn - ((communityDegree.get(c) ?? 0) * k) / m2;
        if (gain > bestGain + 1e-12) {
          bestGain = gain;
          best = c;
        }
      }
      communityDegree.set(best, (communityDegree.get(best) ?? 0) + k);
      if (best !== own) {
        community.set(node, best);
        moved = true;
      }
    }
  }
  return community;
}

/**
 * Collapses each community into one node. Internal weight becomes a self-loop:
 * dropping it loses the degree the community earned, and the next pass then
 * merges everything into one blob.
 */
function aggregate(g: WGraph, community: Map<string, string>): WGraph {
  const out: WGraph = new Map();
  const row = (c: string) => {
    let r = out.get(c);
    if (!r) out.set(c, (r = new Map()));
    return r;
  };
  for (const c of new Set(community.values())) row(c);
  for (const [a, edges] of g) {
    const ca = community.get(a)!;
    for (const [b, w] of edges) {
      const cb = community.get(b)!;
      if (ca === cb) {
        // Every internal edge is seen from both ends; a self-loop holds it once.
        row(ca).set(ca, (row(ca).get(ca) ?? 0) + (a === b ? w : w / 2));
      } else {
        row(ca).set(cb, (row(ca).get(cb) ?? 0) + w);
      }
    }
  }
  return out;
}

/** Leiden's guarantee, applied after the fact: a community is one connected piece. */
function splitDisconnected(g: WGraph, members: string[]): string[][] {
  const inside = new Set(members);
  const seen = new Set<string>();
  const parts: string[][] = [];
  for (const start of members) {
    if (seen.has(start)) continue;
    const part: string[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length > 0) {
      const cur = stack.pop()!;
      part.push(cur);
      for (const nb of g.get(cur)!.keys()) {
        if (inside.has(nb) && !seen.has(nb)) {
          seen.add(nb);
          stack.push(nb);
        }
      }
    }
    parts.push(part.sort());
  }
  return parts;
}

function modularityOf(g: WGraph, membership: Map<string, number>, m2: number): number {
  if (m2 === 0) return 0;
  const inner = new Map<number, number>();
  const total = new Map<number, number>();
  for (const node of g.keys()) {
    const c = membership.get(node);
    if (c === undefined) continue;
    total.set(c, (total.get(c) ?? 0) + degreeOf(g, node));
    for (const [nb, w] of g.get(node)!) if (membership.get(nb) === c) inner.set(c, (inner.get(c) ?? 0) + w);
  }
  let q = 0;
  for (const [c, tot] of total) q += (inner.get(c) ?? 0) / m2 - (tot / m2) ** 2;
  return q;
}

export function communities(notes: Note[], opts: CommunityOptions = {}): CommunityReport {
  const minSize = opts.minSize ?? DEFAULT_MIN_SIZE;
  const byName = new Map(notes.map((n) => [noteName(n), n]));
  const isMap = (name: string) => {
    const t = byName.get(name)?.frontmatter.type;
    return typeof t === "string" && MAP_TYPES.has(t);
  };

  const g = linkGraph(notes, (name) => !isMap(name));
  const m2 = totalDegree(g);

  // Louvain: local moving, aggregate, repeat while the partition keeps changing.
  let level = g;
  let mapping = new Map<string, string>([...g.keys()].map((n) => [n, n]));
  for (let pass = 0; pass < 12; pass++) {
    const found = localMoving(level, m2);
    if (new Set(found.values()).size === level.size) break;
    for (const [node, community] of mapping) mapping.set(node, found.get(community) ?? community);
    level = aggregate(level, found);
  }

  const grouped = new Map<string, string[]>();
  for (const [node, community] of mapping) {
    const list = grouped.get(community);
    if (list) list.push(node);
    else grouped.set(community, [node]);
  }

  const parts: string[][] = [];
  for (const members of grouped.values()) for (const piece of splitDisconnected(g, members)) parts.push(piece);
  parts.sort((a, b) => (b.length === a.length ? a[0].localeCompare(b[0]) : b.length - a.length));

  const membership = new Map<string, number>();
  parts.forEach((members, i) => members.forEach((m) => membership.set(m, i)));

  // Which map is about which community. Measured on a real vault: a MOC links
  // a small fraction of a community's members (12 of 45 in the best case), so
  // "covers a third of it" reports nothing. What separates a map of a subject
  // from a general one is where *its own* links land: a MOC belongs to the
  // community holding most of them, provided that is at least a quarter — the
  // vault's personal MOC, whose 22 links are spread over five communities at
  // four apiece, is not a map of any of them.
  const coverage = new Map<number, MapCoverage[]>();
  for (const n of notes) {
    if (n.frontmatter.type !== "moc") continue;
    const perCommunity = new Map<number, number>();
    for (const target of new Set(n.links)) {
      const c = membership.get(target);
      if (c !== undefined) perCommunity.set(c, (perCommunity.get(c) ?? 0) + 1);
    }
    let bestCommunity = -1;
    let bestLinks = 0;
    for (const [c, count] of [...perCommunity].sort((a, b) => a[0] - b[0])) {
      if (count > bestLinks) {
        bestLinks = count;
        bestCommunity = c;
      }
    }
    const totalLinks = new Set(n.links).size;
    if (bestCommunity < 0 || bestLinks < 2 || bestLinks / totalLinks < 0.25) continue;
    const list = coverage.get(bestCommunity);
    const entry = { name: noteName(n), links: bestLinks };
    if (list) list.push(entry);
    else coverage.set(bestCommunity, [entry]);
  }

  let isolated = 0;
  const out: Community[] = [];
  parts.forEach((members, id) => {
    if (members.length === 1 && degreeOf(g, members[0]) === 0) {
      isolated++;
      return;
    }
    if (members.length < minSize) return;

    const inside = new Set(members);
    let internalEdges = 0;
    let externalEdges = 0;
    for (const m of members) {
      for (const [nb, w] of g.get(m)!) {
        if (inside.has(nb)) internalEdges += w;
        else externalEdges += w;
      }
    }
    const byDegree = [...members].sort((a, b) => {
      const da = degreeOf(g, a);
      const db = degreeOf(g, b);
      return db === da ? a.localeCompare(b) : db - da;
    });
    const mocs = (coverage.get(id) ?? []).sort((a, b) => (b.links === a.links ? a.name.localeCompare(b.name) : b.links - a.links));

    const community: Community = {
      id,
      members: byDegree,
      size: members.length,
      hubs: byDegree.slice(0, 3),
      mocs,
      internalEdges: internalEdges / 2,
      externalEdges,
    };
    if (opts.gapWeight) {
      community.openGaps = members.reduce((sum, m) => sum + (opts.gapWeight!.get(m) ?? 0), 0);
    }
    out.push(community);
  });

  // Where a map is missing and people are asking, first.
  out.sort((a, b) => {
    const gap = (b.openGaps ?? 0) - (a.openGaps ?? 0);
    if (gap !== 0) return gap;
    if (a.mocs.length !== b.mocs.length) return a.mocs.length - b.mocs.length;
    return b.size - a.size;
  });

  return {
    communities: out,
    modularity: modularityOf(g, membership, m2),
    isolated,
    nodes: g.size,
    edges: m2 / 2,
    excluded: notes.length - g.size,
  };
}
