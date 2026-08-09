import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { noteName, type Note } from "@manent/core";
import { cosine, type EmbeddingModel } from "./embeddings.js";
import type { Hit, Retriever } from "./types.js";

/**
 * Dense (semantic) retrieval over a vault.
 *
 * This is the piece that answers questions phrased in words the note never
 * uses — the case the eval harness measures as `oblique`, where lexical search
 * scores ~0.10 MRR. Embeddings are cached on disk keyed by content hash, so a
 * restart or a one-note edit costs one embedding, not a full pass.
 */

export const DENSE_CACHE_PATH = ".manent/embeddings.json";

/** Body slice that fits the model's window with room for name and description. */
const BODY_BUDGET = 1400;

export function noteEmbeddingText(n: Note): string {
  const name = noteName(n).replace(/[_-]+/g, " ");
  const description = String(n.frontmatter.description ?? "");
  const body = n.body
    .replace(/```[\s\S]*?```/g, " ") // code blocks carry little retrieval signal
    .replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, BODY_BUDGET);
  return `${name}. ${description} ${body}`.trim();
}

const hashOf = (text: string) => createHash("sha256").update(text).digest("base64url").slice(0, 22);

interface CacheFile {
  model: string;
  dimensions: number;
  entries: Record<string, { hash: string; vec: string }>;
}

const encode = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
const decode = (s: string, dim: number) => {
  const buf = Buffer.from(s, "base64");
  return new Float32Array(buf.buffer, buf.byteOffset, dim);
};

export interface DenseIndex {
  model: EmbeddingModel;
  vectors: Map<string, Float32Array>;
  meta: Map<string, { description: string; path: string }>;
  /** how many notes had to be embedded on this build */
  embedded: number;
  reused: number;
}

export interface BuildDenseOptions {
  /** vault root — the cache lives inside it, next to the notes it describes */
  root: string;
  cachePath?: string;
  onProgress?: (done: number, total: number) => void;
}

export async function buildDenseIndex(
  notes: Note[],
  model: EmbeddingModel,
  opts: BuildDenseOptions,
): Promise<DenseIndex> {
  const cacheFile = join(opts.root, opts.cachePath ?? DENSE_CACHE_PATH);

  let cache: CacheFile | undefined;
  try {
    const parsed = JSON.parse(await readFile(cacheFile, "utf8")) as CacheFile;
    if (parsed.model === model.id) cache = parsed; // a different model invalidates everything
  } catch {
    /* first run, or unreadable cache: rebuild */
  }

  const vectors = new Map<string, Float32Array>();
  const meta = new Map<string, { description: string; path: string }>();
  const pending: Array<{ name: string; text: string; hash: string }> = [];
  const seen = new Set<string>();

  for (const n of notes) {
    const name = noteName(n);
    if (seen.has(name)) continue;
    seen.add(name);
    meta.set(name, { description: String(n.frontmatter.description ?? ""), path: n.relPath });

    const text = noteEmbeddingText(n);
    const hash = hashOf(text);
    const cached = cache?.entries[name];
    if (cached && cached.hash === hash && cache) {
      vectors.set(name, decode(cached.vec, cache.dimensions));
    } else {
      pending.push({ name, text, hash });
    }
  }

  const reused = vectors.size;
  const BATCH = 16;
  for (let i = 0; i < pending.length; i += BATCH) {
    const slice = pending.slice(i, i + BATCH);
    const vecs = await model.embed(
      slice.map((p) => p.text),
      "passage",
    );
    slice.forEach((p, j) => vectors.set(p.name, vecs[j]));
    opts.onProgress?.(Math.min(i + BATCH, pending.length), pending.length);
  }

  if (pending.length > 0) {
    const dimensions = vectors.values().next().value?.length ?? model.dimensions;
    const entries: CacheFile["entries"] = {};
    for (const n of notes) {
      const name = noteName(n);
      const v = vectors.get(name);
      if (!v) continue;
      entries[name] = { hash: hashOf(noteEmbeddingText(n)), vec: encode(v) };
    }
    await mkdir(dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, JSON.stringify({ model: model.id, dimensions, entries }), "utf8");
  }

  return { model, vectors, meta, embedded: pending.length, reused };
}

export function denseRetriever(index: DenseIndex): Retriever {
  return {
    name: "dense",
    async search(query, k = 8) {
      const [qv] = await index.model.embed([query], "query");
      const scored: Hit[] = [];
      for (const [name, vec] of index.vectors) {
        const m = index.meta.get(name);
        if (!m) continue;
        scored.push({
          name,
          description: m.description,
          path: m.path,
          score: cosine(qv, vec),
          via: "dense",
        });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, k).map((h) => ({ ...h, score: Math.round(h.score * 10_000) / 10_000 }));
    },
  };
}
