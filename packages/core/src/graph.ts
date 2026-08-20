import { buildLinkIndex, resolveLink } from "./links.js";
import type { Edge, Graph, Note } from "./types.js";
import { noteName } from "./vault.js";

const FRONTMATTER_EDGES = ["provenance", "supersedes", "contradicts"] as const;

export function buildGraph(notes: Note[]): Graph {
  const nodes = new Map<string, Note>();
  for (const n of notes) {
    const name = noteName(n);
    if (!nodes.has(name)) nodes.set(name, n);
  }
  const index = buildLinkIndex(notes);
  const edges: Edge[] = [];
  for (const n of notes) {
    const from = noteName(n);
    for (const to of n.links) {
      // un link scritto come percorso (`[[moc/syf]]`, `[[../relazioni/denise]]`)
      // punta alla stessa nota di quello scritto per nome: stesso arco
      edges.push({ from, to: resolveLink(index, to, n.relPath) ?? to, kind: "wikilink" });
    }
    for (const kind of FRONTMATTER_EDGES) {
      const v = n.frontmatter[kind];
      if (!Array.isArray(v)) continue;
      for (const raw of v) {
        if (typeof raw !== "string") continue;
        edges.push({ from, to: raw.replace(/^\[\[|\]\]$/g, "").trim(), kind });
      }
    }
  }
  return { nodes, edges };
}

/** Undirected neighborhood of a note up to `depth` hops. Excludes the note itself. */
export function neighbors(g: Graph, name: string, depth = 1): Set<string> {
  const seen = new Set<string>([name]);
  let frontier = new Set<string>([name]);
  for (let d = 0; d < depth && frontier.size > 0; d++) {
    const next = new Set<string>();
    for (const e of g.edges) {
      if (frontier.has(e.from) && !seen.has(e.to)) next.add(e.to);
      if (frontier.has(e.to) && !seen.has(e.from)) next.add(e.from);
    }
    for (const n of next) seen.add(n);
    frontier = next;
  }
  seen.delete(name);
  return seen;
}
