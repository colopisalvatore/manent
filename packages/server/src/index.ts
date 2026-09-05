// Retrieval lives in @manent/retrieval: one implementation for the server and
// for the eval harness, so what ships is what gets measured.
export { bm25Retriever, hybridRetriever, buildSearchIndex, type Retriever, type Hit } from "@manent/retrieval";
export { loadBrainContext, type BrainContext, type RetrieverName, type LoadContextOptions, type GapsOptions, type ReloadStats } from "./context.js";
export { BRAIN_TOOLS, callTool, findTool, toolsFor, type BrainTool, type ToolResult, type CallContext } from "./tools.js";
export { OWNER, loadAgents, identityForToken, scopeKey, type Identity, type AgentSpec } from "./identity.js";
export {
  GapStore,
  FollowTracker,
  normalizeQuery,
  DEFAULT_GAP_THRESHOLD,
  type GapRow,
  type SearchRow,
  type FeedbackRow,
  type FeedbackVerdict,
  type GapStoreOptions,
} from "./gaps.js";
export { AuditLog, type AuditEntry } from "./audit.js";
export {
  TaskStore,
  TASKS_EXTENSION,
  DEFAULT_TASK_TTL_MS,
  DEFAULT_POLL_INTERVAL_MS,
  type TaskStatus,
  type TaskView,
  type TaskSignal,
  type TaskStoreOptions,
} from "./tasks.js";
export { watchVault, type VaultWatcher, type WatchOptions } from "./watch.js";

// Legacy era — handshake revisions, served by the official SDK.
export {
  LEGACY_VERSIONS,
  buildLegacyServer,
  createBrainServer,
  serveLegacyHttp,
  serveStdio,
} from "./legacy.js";

// Modern era — revision 2026-07-28, implemented natively.
export {
  MODERN_VERSIONS,
  handleModernRequest,
  isModernRequest,
  declaredProtocolVersion,
  type JsonRpcResponse,
} from "./modern.js";

export { serveHttp, type HttpOptions } from "./http.js";
export { verifyAccessToken, subjectOfAccessToken, mintAccessToken, handleOAuth, type OAuthOptions } from "./oauth.js";
