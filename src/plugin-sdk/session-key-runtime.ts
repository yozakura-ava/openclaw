/**
<<<<<<< HEAD
 * Runtime SDK subpath for session-key parsing, classification, and transcript identities.
=======
 * Runtime SDK subpath for session-key comparison, classification, and transcript identities.
>>>>>>> 97b6e87616f
 */
export {
  isIncognitoSessionKey,
  resolveAgentIdFromSessionKey,
  type ParsedAgentSessionKey,
} from "../routing/session-key.js";
export {
  isCronRunSessionKey,
  isDreamingNarrativeSessionStoreKey,
} from "../sessions/session-key-utils.js";
export { parseUsageCountedSessionIdFromFileName } from "../config/sessions/transcript-file-names.js";
<<<<<<< HEAD
=======
export { normalizeSessionKeyForComparison } from "../../packages/normalization-core/src/session-key-comparison.js";
>>>>>>> 97b6e87616f
