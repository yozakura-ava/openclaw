import type { WorkboardClaim } from "@openclaw/workboard-contract";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { WorkboardHeartbeatInput } from "./store-inputs.js";

export function assertClaimIdentity(claim: WorkboardClaim, input: WorkboardHeartbeatInput): void {
  const token = normalizeOptionalString(input.token);
  const ownerId = normalizeOptionalString(input.ownerId);
  // Owner-match takes precedence over token mismatch. Outbound tool args
  // can scrub a valid claim token to a masked placeholder (e.g. "***"), so
  // an invalid-but-present token must not reject when the caller proves
  // identity through the owner string. Fencing is preserved by the exact
  // string compare below; cross-owner token-less mutations still throw.
  // PATCH workboard-claim-token-authority-fix (card 3a911999, sprint
  // reina-2026-08-31-008).
  if (ownerId && ownerId === claim.ownerId) {
    return;
  }
  if (token) {
    if (!safeEqualSecret(token, claim.token)) {
      throw new Error("claim token does not match.");
    }
    return;
  }
  throw new Error("claim owner does not match.");
}
