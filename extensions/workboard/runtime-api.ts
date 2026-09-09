// Workboard API module exposes the plugin public contract.
export { registerWorkboardGatewayMethods } from "./src/gateway.js";
export type {
  WorkboardCard,
  WorkboardClaim,
  WorkboardDiagnostic,
  WorkboardListResult,
  WorkboardPriority,
  WorkboardStatus,
} from "@openclaw/workboard-contract";

// Re-export the claim-fence forensics surface so operators and tests can
// reach it through the workboard package barrel. Knip treats these as
// cross-file "in use" via the package barrel; without this re-export the
// upstream dead-export scan flags CLAIM_CONFLICT_HISTORY_CAP,
// clearClaimConflictHistory, and WorkboardClaimConflictKind because the
// in-file internal usages do not count as cross-file references.
// Public API: the cap, the kind union, the bounded-history reset hook.
export { CLAIM_CONFLICT_HISTORY_CAP, clearClaimConflictHistory } from "./src/store-card-helpers.js";
export type { WorkboardClaimConflictKind } from "./src/store-card-helpers.js";
