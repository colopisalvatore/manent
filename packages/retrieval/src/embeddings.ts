/**
 * Local embedding models, loaded through an optional dependency.
 *
 * `@huggingface/transformers` runs ONNX models in plain Node, so a vault gets
 * semantic search with no API key, no network at query time and no note text
 * leaving the machine — the same property that makes the rest of Manent
 * file-first. The dependency is optional: install it only if you want dense
 * retrieval, and `bm25` keeps working without it.
 */

export interface EmbeddingModel {
  readonly id: string;
  readonly dimensions: number;
  /**
   * E5-family models expect asymmetric prefixes ("query:" / "passage:").
   * Passing the wrong one measurably degrades ranking, so the kind is required.
   */
  embed(texts: string[], kind: "query" | "passage"): Promise<Float32Array[]>;
}

export interface LocalModelOptions {
  /** Hugging Face model id. Default is multilingual: vaults are not all English. */
  modelId?: string;
  /** quantization: "q8" keeps the download near 120 MB */
  dtype?: "fp32" | "fp16" | "q8";
  batchSize?: number;
}

export const DEFAULT_MODEL_ID = "Xenova/multilingual-e5-small";

const MISSING_DEP =
  'dense retrieval needs the optional dependency "@huggingface/transformers".\n' +
  "  install it with:  npm install @huggingface/transformers\n" +
  "  or keep using the lexical ranker (--retriever bm25), which needs nothing.";

/** Loads the model once; the first call downloads and caches it under the HF cache dir. */
export async function loadLocalEmbeddingModel(opts: LocalModelOptions = {}): Promise<EmbeddingModel> {
  const modelId = opts.modelId ?? DEFAULT_MODEL_ID;
  const batchSize = opts.batchSize ?? 16;

  let pipeline: unknown;
  try {
    // The specifier is a variable on purpose: an optional dependency must not
    // be a compile-time requirement, and a literal here makes `tsc` demand the
    // package's types — so a build without it (CI, `npm ci --omit=optional`)
    // fails on a dependency the default ranker never loads.
    const specifier: string = "@huggingface/transformers";
    ({ pipeline } = (await import(specifier)) as { pipeline: unknown });
  } catch {
    throw new Error(MISSING_DEP);
  }

  const extractor = await (pipeline as (task: string, model: string, opts: object) => Promise<unknown>)(
    "feature-extraction",
    modelId,
    { dtype: opts.dtype ?? "q8" },
  );
  const run = extractor as (
    texts: string[],
    opts: { pooling: string; normalize: boolean },
  ) => Promise<{ tolist(): number[][] }>;

  let dimensions = 0;

  return {
    id: modelId,
    get dimensions() {
      return dimensions;
    },
    async embed(texts, kind) {
      const prefixed = texts.map((t) => `${kind}: ${t}`);
      const out: Float32Array[] = [];
      for (let i = 0; i < prefixed.length; i += batchSize) {
        const batch = prefixed.slice(i, i + batchSize);
        const res = await run(batch, { pooling: "mean", normalize: true });
        for (const vec of res.tolist()) {
          if (dimensions === 0) dimensions = vec.length;
          out.push(Float32Array.from(vec));
        }
      }
      return out;
    },
  };
}

/** Vectors come back normalized, so the dot product IS the cosine similarity. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}
