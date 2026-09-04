import type { Graph, Note } from "@manent/core";

export interface Hit {
  /** canonical note name */
  name: string;
  description: string;
  path: string;
  score: number;
  /** how this hit was produced — useful to explain a ranking */
  via?: string;
  /** set when the note's status demoted it (quarantine, deprecated, archived) */
  status?: string;
}

/**
 * Every ranking strategy implements this. Keeping it narrow is what lets the
 * eval harness compare implementations, and the server swap one for another
 * without touching the tools.
 */
export interface Retriever {
  readonly name: string;
  /**
   * May be synchronous (lexical, graph) or asynchronous (dense models need to
   * embed the query first). Callers await either way.
   */
  search(query: string, k?: number): Hit[] | Promise<Hit[]>;
}

export interface RetrievalInput {
  notes: Note[];
  graph: Graph;
}
