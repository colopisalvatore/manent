import type MiniSearch from "minisearch";
import { buildGraph, loadVault, type Graph, type Note } from "@manent/core";
import { buildSearchIndex, type SearchDoc } from "./search.js";

/** Read-only view of a vault, shared by both protocol adapters. */
export interface BrainContext {
  notes: Note[];
  graph: Graph;
  index: MiniSearch<SearchDoc>;
}

export async function loadBrainContext(root: string): Promise<BrainContext> {
  const notes = await loadVault(root);
  return { notes, graph: buildGraph(notes), index: buildSearchIndex(notes) };
}
