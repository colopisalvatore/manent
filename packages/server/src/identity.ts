import { readFile } from "node:fs/promises";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Who is calling.
 *
 * A vault served to one person needs no identity: the token is the password.
 * A vault that several agents read — a customer-care agent, a coding agent,
 * the owner's own sessions — needs to know which one is asking, because the
 * answer decides what it may see, where it may write, and what the audit line
 * says. The identity is resolved once per request from the credential and
 * travels with the call; nothing downstream trusts a name the caller typed.
 */
export interface Identity {
  /** slug; `owner` for the master token */
  name: string;
  /** the master token: sees everything, may write anywhere the server allows */
  owner: boolean;
  /** audience labels this identity may read; `*` means every note, private ones included */
  read: string[];
  /** vault-relative directory this identity may write into; unset = read-only */
  writeDir?: string;
}

export const OWNER: Identity = Object.freeze({ name: "owner", owner: true, read: ["*"] });

/** One entry of the `--agents` file. */
export interface AgentSpec {
  token: string;
  read?: string[];
  write?: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const LABEL_RE = /^(?:\*|[a-z0-9][a-z0-9_-]*)$/;
const MIN_TOKEN = 16;

/**
 * Loads and validates the agents file:
 *
 *   {
 *     "customer-care": { "token": "<long random>", "read": ["product"], "write": "quarantine/customer-care" },
 *     "coding":        { "token": "<long random>", "read": ["tech", "product"] }
 *   }
 *
 * Every mistake is fatal at startup rather than a surprise at request time: a
 * short token or a misspelt label would otherwise silently widen or narrow
 * what an agent sees.
 */
export async function loadAgents(file: string): Promise<Map<string, Identity & { token: string }>> {
  const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, AgentSpec>;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${file}: expected an object of agents`);
  const out = new Map<string, Identity & { token: string }>();
  const tokens = new Set<string>();
  for (const [name, spec] of Object.entries(raw)) {
    if (!NAME_RE.test(name)) throw new Error(`${file}: agent name "${name}" must be a slug`);
    if (name === OWNER.name) throw new Error(`${file}: "${OWNER.name}" is reserved for the master token`);
    if (typeof spec?.token !== "string" || spec.token.length < MIN_TOKEN) {
      throw new Error(`${file}: agent "${name}" needs a token of at least ${MIN_TOKEN} chars`);
    }
    if (tokens.has(spec.token)) throw new Error(`${file}: agent "${name}" reuses another agent's token`);
    tokens.add(spec.token);
    const read = spec.read ?? [];
    if (!Array.isArray(read) || read.some((l) => typeof l !== "string" || !LABEL_RE.test(l))) {
      throw new Error(`${file}: agent "${name}": read must be a list of audience labels`);
    }
    if (read.includes("private")) {
      throw new Error(`${file}: agent "${name}": "private" cannot be granted — it belongs to the owner alone (use "*")`);
    }
    if (spec.write !== undefined && (typeof spec.write !== "string" || spec.write.trim() === "")) {
      throw new Error(`${file}: agent "${name}": write must be a vault-relative directory`);
    }
    out.set(name, { name, owner: false, read, writeDir: spec.write?.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""), token: spec.token });
  }
  return out;
}

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest();
export const safeEqual = (a: string, b: string) => timingSafeEqual(sha(a), sha(b));

/**
 * Maps a presented static token to an identity: the master token is the owner,
 * an agent token is that agent, anything else is nobody. Comparisons are
 * constant-time; the loop runs over every agent regardless of an early match
 * so timing does not reveal which entry matched.
 */
export function identityForToken(
  masterToken: string,
  agents: ReadonlyMap<string, Identity & { token: string }>,
  presented: string,
): Identity | undefined {
  let found: Identity | undefined = safeEqual(presented, masterToken) ? OWNER : undefined;
  for (const agent of agents.values()) {
    if (safeEqual(presented, agent.token)) found ??= stripToken(agent);
  }
  return found;
}

export const stripToken = (a: Identity & { token: string }): Identity => {
  const { token: _token, ...id } = a;
  return id;
};

/** A stable key for "what this identity can see", used to cache filtered views. */
export const scopeKey = (id: Identity): string => (id.owner ? "*" : [...new Set(id.read)].sort().join(","));
