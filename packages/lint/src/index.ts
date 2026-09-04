import {
  buildGraph,
  buildLinkIndex,
  loadVault,
  noteAudiences,
  noteName,
  resolveLink,
  scanInjection,
  scanPii,
} from "@manent/core";
import { noteBaseSchema, RESERVED_AUDIENCES } from "@manent/spec";
import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

// ajv ships CJS; unwrap the default export under both interop shapes
const Ajv2020 = ((Ajv2020Module as any).default ?? Ajv2020Module) as typeof import("ajv/dist/2020.js").default;
const addFormats = ((addFormatsModule as any).default ?? addFormatsModule) as typeof import("ajv-formats").default;

export type Severity = "error" | "warning" | "info";

export interface Finding {
  rule: string;
  severity: Severity;
  path: string;
  message: string;
}

export interface LintResult {
  findings: Finding[];
  errors: number;
  warnings: number;
  infos: number;
  notes: number;
}

export interface LintOptions {
  /** treat unresolved wikilinks as errors instead of warnings */
  strictLinks?: boolean;
  /**
   * Treat personal data and model-directed text as errors instead of warnings.
   * This is the CI gate: a note that fails it never lands in the shared branch.
   */
  strictContent?: boolean;
  /** the vault's audience labels; any other label (reserved ones aside) is reported */
  audiences?: string[];
}

export async function lintVault(root: string, opts: LintOptions = {}): Promise<LintResult> {
  const notes = await loadVault(root);
  const graph = buildGraph(notes);
  const findings: Finding[] = [];

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(noteBaseSchema);

  const nameCount = new Map<string, number>();
  for (const n of notes) {
    const name = noteName(n);
    nameCount.set(name, (nameCount.get(name) ?? 0) + 1);
  }

  const known = new Set(graph.nodes.keys());
  // stessa risoluzione del grafo: un link scritto come percorso non e rotto
  const linkIndex = buildLinkIndex(notes);
  const inEdges = new Set<string>();
  const outEdges = new Set<string>();
  for (const e of graph.edges) {
    outEdges.add(e.from);
    inEdges.add(e.to);
  }

  const contentSeverity: Severity = opts.strictContent ? "error" : "warning";
  const knownAudiences = opts.audiences ? new Set<string>([...RESERVED_AUDIENCES, ...opts.audiences.map((a) => a.trim().toLowerCase())]) : undefined;

  for (const n of notes) {
    const name = noteName(n);
    const fm = normalizeFrontmatter(n.frontmatter);

    if (n.parseError) {
      findings.push({
        rule: "frontmatter-invalid",
        severity: "error",
        path: n.relPath,
        message: `YAML frontmatter could not be parsed: ${n.parseError} — values containing ": " must be quoted`,
      });
      continue;
    }

    if (Object.keys(fm).length === 0) {
      findings.push({
        rule: "frontmatter-missing",
        severity: "error",
        path: n.relPath,
        message: "note has no YAML frontmatter",
      });
      continue;
    }

    if (!validate(fm)) {
      for (const err of validate.errors ?? []) {
        findings.push({
          rule: "schema",
          severity: "error",
          path: n.relPath,
          message: `${err.instancePath || "/"} ${err.message ?? "invalid"}`,
        });
      }
    }

    // root-level entry points (MEMORY.md, HOME.md) keep uppercase filenames by convention
    const isRootFile = !n.relPath.includes("/");
    const fileSlug = (n.relPath.split("/").pop() ?? "").replace(/\.md$/, "");
    if (!isRootFile && typeof fm.name === "string" && fm.name !== fileSlug) {
      findings.push({
        rule: "name-mismatch",
        severity: "warning",
        path: n.relPath,
        message: `frontmatter name "${fm.name}" != filename "${fileSlug}"`,
      });
    }

    if ((nameCount.get(name) ?? 0) > 1) {
      findings.push({
        rule: "duplicate-name",
        severity: "error",
        path: n.relPath,
        message: `canonical name "${name}" used by multiple notes`,
      });
    }

    for (const target of n.links) {
      if (!known.has(target) && !resolveLink(linkIndex, target, n.relPath)) {
        findings.push({
          rule: "link-unresolved",
          severity: opts.strictLinks ? "error" : "warning",
          path: n.relPath,
          message: `wikilink [[${target}]] has no target note (may be intentional: a note worth writing)`,
        });
      }
    }

    if (
      fm.type === "feedback" &&
      !(/\*\*Why:\*\*/.test(n.body) && /\*\*How to apply:\*\*/.test(n.body))
    ) {
      findings.push({
        rule: "feedback-body",
        severity: "warning",
        path: n.relPath,
        message: "feedback note should contain **Why:** and **How to apply:** sections",
      });
    }

    if (fm.type === "raw-source" && !/^library\/\d{4}-\d{2}-\d{2}-/.test(n.relPath)) {
      findings.push({
        rule: "raw-source-path",
        severity: "warning",
        path: n.relPath,
        message: "raw-source notes belong in library/YYYY-MM-DD-<slug>.md",
      });
    }

    // The content gate. A vault lives in git, and git history is forever: what
    // this reports is cheaper to fix before the commit than after.
    const pii = scanPii(`${typeof fm.description === "string" ? fm.description : ""}\n${n.body}`);
    if (pii.length > 0) {
      findings.push({
        rule: "pii",
        severity: contentSeverity,
        path: n.relPath,
        message: `personal data in the note: ${pii.map((f) => `${f.count} ${f.kind}`).join(", ")}`,
      });
    }
    const injection = scanInjection(n.body);
    if (injection.length > 0) {
      findings.push({
        rule: "injection",
        severity: contentSeverity,
        path: n.relPath,
        message: `text that reads as an instruction to a model: ${injection.map((f) => `${f.kind} (line ${f.line}: "${f.sample}")`).join("; ")}`,
      });
    }

    if (knownAudiences) {
      for (const a of noteAudiences(n)) {
        if (!knownAudiences.has(a)) {
          findings.push({
            rule: "audience-unknown",
            severity: "warning",
            path: n.relPath,
            message: `audience "${a}" is not one of ${[...knownAudiences].join(", ")} — until fixed, no reader's scope names it`,
          });
        }
      }
    }

    if (
      !inEdges.has(name) &&
      !outEdges.has(name) &&
      fm.type !== "index" &&
      fm.type !== "moc"
    ) {
      findings.push({
        rule: "orphan",
        severity: "info",
        path: n.relPath,
        message: "note has no links in or out",
      });
    }
  }

  const count = (s: Severity) => findings.filter((f) => f.severity === s).length;
  return {
    findings,
    errors: count("error"),
    warnings: count("warning"),
    infos: count("info"),
    notes: notes.length,
  };
}

/** YAML parses unquoted dates as Date objects; the schema wants YYYY-MM-DD strings. */
function normalizeFrontmatter(fm: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) {
    out[k] = v instanceof Date ? v.toISOString().slice(0, 10) : v;
  }
  return out;
}

const ICONS: Record<Severity, string> = { error: "✖", warning: "⚠", info: "ℹ" };

export function formatFindings(res: LintResult): string {
  const lines: string[] = [];
  for (const f of res.findings) {
    lines.push(`${ICONS[f.severity]} [${f.rule}] ${f.path} — ${f.message}`);
  }
  lines.push(
    `${res.notes} notes: ${res.errors} errors, ${res.warnings} warnings, ${res.infos} info`,
  );
  return lines.join("\n");
}
