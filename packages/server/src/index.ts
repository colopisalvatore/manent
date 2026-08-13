// Retrieval lives in @manent/retrieval: one implementation for the server and
// for the eval harness, so what ships is what gets measured.
export { bm25Retriever, hybridRetriever, buildSearchIndex, type Retriever, type Hit } from "@manent/retrieval";
export { loadBrainContext, type BrainContext, type RetrieverName } from "./context.js";
export { BRAIN_TOOLS, findTool, toolsFor, type BrainTool, type ToolResult } from "./tools.js";

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
export { verifyAccessToken, handleOAuth, type OAuthOptions } from "./oauth.js";
