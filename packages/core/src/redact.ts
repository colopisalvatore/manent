/**
 * Scanning text that is about to be persisted.
 *
 * Two questions, asked before anything is written — to the vault, to the gap
 * register, to an audit line:
 *
 *   1. Does it carry personal data? A vault lives in git, and git history is
 *      forever: deleting the file later does not remove the bytes. So the
 *      check runs *before* storage, never as a cleanup afterwards.
 *   2. Does it look like an instruction aimed at a model? Notes are read by
 *      agents that hold tools. If an outsider's words can become a note, the
 *      brain becomes a prompt-injection vector. Text that reads like "ignore
 *      previous instructions" has no business in a knowledge base.
 *
 * Both scans are heuristic — regular expressions, not a classifier. They are
 * meant to fail closed at the gate (a refused write costs a retry) and to be
 * noisy but useful in lint (a warning a human can dismiss).
 */

export type PiiKind = "email" | "phone" | "iban" | "card" | "fiscal-code";

export interface PiiFinding {
  kind: PiiKind;
  count: number;
}

const digitsOf = (s: string) => s.replace(/\D/g, "");

/** Luhn checksum — separates card numbers from random digit runs of the same length. */
function luhn(raw: string): boolean {
  const d = digitsOf(raw);
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = Number(d[i]);
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

interface PiiPattern {
  kind: PiiKind;
  re: RegExp;
  accept?: (match: string) => boolean;
}

/**
 * Ordered: a match consumed by an earlier pattern is not re-matched by a later
 * one, so a card number is not also reported as a phone number.
 */
const PII_PATTERNS: PiiPattern[] = [
  { kind: "email", re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g },
  { kind: "iban", re: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g },
  // Italian codice fiscale: 6 letters, 2 digits, month letter, 2 digits, letter, 3 digits, letter.
  { kind: "fiscal-code", re: /\b[A-Z]{6}\d{2}[ABCDEHLMPRST]\d{2}[A-Z]\d{3}[A-Z]\b/gi },
  { kind: "card", re: /\b(?:\d[ -]?){12,18}\d\b/g, accept: luhn },
  // International form: +39 333 123 4567, +1 (415) 555-0123.
  { kind: "phone", re: /\+\d{1,3}[ .-]?(?:\(?\d{1,4}\)?[ .-]?){1,3}\d{3,4}/g, accept: (m) => digitsOf(m).length >= 9 && digitsOf(m).length <= 15 },
  // Italian national form: mobiles start with 3, landlines with 0; needs a separator or the bare 10 digits.
  { kind: "phone", re: /(?<![\d/.-])(?:3\d{2}|0\d{1,3})[ .-]?\d{3,4}[ .-]?\d{3,4}(?![\d/.-])/g, accept: (m) => digitsOf(m).length >= 9 && digitsOf(m).length <= 11 },
];

const placeholder = (kind: PiiKind) => `[${kind}]`;

/**
 * Replaces personal data with typed placeholders and reports what was found.
 * `text` comes back unchanged when nothing matched.
 */
export function redactPii(text: string): { text: string; findings: PiiFinding[] } {
  const counts = new Map<PiiKind, number>();
  let out = text;
  for (const p of PII_PATTERNS) {
    p.re.lastIndex = 0;
    out = out.replace(p.re, (m) => {
      if (p.accept && !p.accept(m)) return m;
      counts.set(p.kind, (counts.get(p.kind) ?? 0) + 1);
      return placeholder(p.kind);
    });
  }
  const findings = [...counts].map(([kind, count]) => ({ kind, count }));
  return { text: out, findings };
}

/** The findings alone, for callers that only need to decide. */
export const scanPii = (text: string): PiiFinding[] => redactPii(text).findings;

export interface InjectionFinding {
  kind: string;
  /** 1-based line of the first occurrence */
  line: number;
  /** a short excerpt, so a reviewer can find it without the tool quoting the whole note */
  sample: string;
}

interface InjectionPattern {
  kind: string;
  re: RegExp;
}

/** Zero-width and bidi control characters, built from code points so the source stays readable. */
const INVISIBLE_RE = new RegExp(
  `[${[
    [0x200b, 0x200f],
    [0x202a, 0x202e],
    [0x2060, 0x2064],
    [0xfeff, 0xfeff],
  ]
    .map(([a, b]) => String.fromCharCode(a) + "-" + String.fromCharCode(b))
    .join("")}]`,
);

const INJECTION_PATTERNS: InjectionPattern[] = [
  {
    kind: "override-instructions",
    re: /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+|your\s+)?(?:previous|prior|above|earlier|preceding|system)\s+(?:instructions?|prompts?|rules|guidelines|directions)/i,
  },
  {
    kind: "override-instructions",
    re: /\b(?:ignora|dimentica|trascura)\s+(?:tutte\s+|le\s+|ogni\s+)?(?:le\s+)?(?:istruzioni|regole|indicazioni)\s+(?:precedenti|sopra|di\s+sistema)/i,
  },
  { kind: "role-hijack", re: /\byou\s+are\s+now\s+(?:a|an|the|in)\b|\bnew\s+system\s+prompt\b|\bact\s+as\s+(?:the\s+)?(?:system|developer)\b/i },
  { kind: "conceal-from-user", re: /\b(?:do\s+not|don't|never)\s+(?:tell|show|reveal|mention)\s+(?:this\s+)?(?:to\s+)?the\s+user\b|\bnon\s+dirlo\s+all'utente\b/i },
  { kind: "exfiltrate-prompt", re: /\b(?:reveal|print|repeat|output|show)\s+(?:your\s+|the\s+)?(?:system\s+prompt|hidden\s+instructions|initial\s+instructions)/i },
  { kind: "tool-coercion", re: /\b(?:assistant|ai|model|agent)\s+(?:must|should|has\s+to)\s+(?:now\s+)?(?:call|run|execute|invoke|delete|send)\b/i },
  { kind: "html-comment-directive", re: /<!--[^]*?\b(?:instruction|assistant|ignore|system\s*prompt|do\s+not\s+tell)\b[^]*?-->/i },
  { kind: "active-content", re: /<\s*(?:script|iframe|object|embed)\b|javascript:|data:text\/html/i },
  { kind: "invisible-characters", re: INVISIBLE_RE },
];

/**
 * Finds text that reads as an instruction to a model rather than as knowledge.
 * One finding per pattern kind, anchored to the first line it appears on.
 */
export function scanInjection(text: string): InjectionFinding[] {
  const out: InjectionFinding[] = [];
  const seen = new Set<string>();
  for (const p of INJECTION_PATTERNS) {
    const m = p.re.exec(text);
    if (!m || seen.has(p.kind)) continue;
    seen.add(p.kind);
    const line = text.slice(0, m.index).split("\n").length;
    const sample = m[0].replace(/\s+/g, " ").slice(0, 60);
    out.push({ kind: p.kind, line, sample: p.kind === "invisible-characters" ? "(zero-width / bidi control character)" : sample });
  }
  return out;
}
