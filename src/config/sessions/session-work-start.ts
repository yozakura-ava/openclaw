import {
  assertProviderReviewAcknowledgment,
  type ProviderReviewAcknowledgment,
} from "../../sessions/provider-review.js";
import {
  resolveIncognitoSessionExpiresAt,
  isIncognitoSessionKey,
} from "../../shared/incognito-session-key.js";
import type { InternalSessionEntry } from "./types.js";

type SessionWorkStartEntry = Pick<
  InternalSessionEntry,
  | "archivedAt"
  | "createdAt"
  | "incognito"
  | "initializationPending"
  | "mainRestartRecovery"
  | "modelSelectionLocked"
  | "sessionId"
  | "pendingProjectGitUrl"
  | "pendingWorktree"
  | "providerReview"
  | "lifecycleRevision"
> &
  Partial<Pick<InternalSessionEntry, "updatedAt">>;

type SessionWorkStartOptions = {
  /** Already-accepted transcript/delivery results settle without dispatching new model work. */
  purpose?: "accepted-result-settlement";
  allowRestartTombstoneReplacement?: boolean;
  expectedSessionId?: string;
  /** Only workspace preparers and lifecycle cancellation may enter pending sessions. */
  allowPendingWorkspace?: true;
  providerReviewAcknowledgment?: ProviderReviewAcknowledgment;
  runId?: string;
};

export function isRestartRecoveryTombstone(
  entry: SessionWorkStartEntry | null | undefined,
): boolean {
  return entry?.mainRestartRecovery?.tombstone !== undefined;
}

/** Stable Gateway error detail for stale session lifecycle requests. */
export const SESSION_LIFECYCLE_CHANGED_ERROR_REASON = "session-changed";

type SessionWorkStartBlockReason =
  | "deleted"
  | "changed"
  | "expired"
  | "initialization_pending"
  | "provider_review"
  | "restart_tombstone"
  | "archived"
  | "workspace_pending";

<<<<<<< HEAD
=======
export class SessionWorkStartError extends Error {
  override name = "SessionWorkStartError";

  constructor(
    readonly reason: SessionWorkStartBlockReason,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

>>>>>>> 97b6e87616f
/** One work-start policy supplies both user errors and recovery disposition. */
export function resolveSessionWorkStartBlock(
  sessionKey: string,
  entry: SessionWorkStartEntry | null | undefined,
  options?: SessionWorkStartOptions,
<<<<<<< HEAD
): { reason: SessionWorkStartBlockReason; message: string; retryable: boolean } | undefined {
  if (options?.expectedSessionId && !entry) {
    return block("deleted", `Session "${sessionKey}" was deleted while starting work. Retry.`);
  }
  if (options?.expectedSessionId && entry?.sessionId !== options.expectedSessionId) {
    return block("changed", `Session "${sessionKey}" changed while starting work. Retry.`);
=======
): SessionWorkStartError | undefined {
  if (options?.expectedSessionId && !entry) {
    return new SessionWorkStartError(
      "deleted",
      `Session "${sessionKey}" was deleted while starting work. Retry.`,
    );
  }
  if (options?.expectedSessionId && entry?.sessionId !== options.expectedSessionId) {
    return new SessionWorkStartError(
      "changed",
      `Session "${sessionKey}" changed while starting work. Retry.`,
    );
>>>>>>> 97b6e87616f
  }
  const incognitoExpiresAt = entry ? resolveIncognitoSessionExpiresAt(entry) : undefined;
  if (
    (entry?.incognito || isIncognitoSessionKey(sessionKey)) &&
    incognitoExpiresAt !== undefined &&
    Date.now() >= incognitoExpiresAt
  ) {
<<<<<<< HEAD
    return block(
=======
    return new SessionWorkStartError(
>>>>>>> 97b6e87616f
      "expired",
      `Incognito session "${sessionKey}" expired. Start a new Incognito session.`,
    );
  }
  if (entry?.initializationPending === true) {
<<<<<<< HEAD
    return block(
=======
    return new SessionWorkStartError(
>>>>>>> 97b6e87616f
      "initialization_pending",
      `Session "${sessionKey}" is still initializing. Retry after initialization completes.`,
      true,
    );
  }
  if (entry?.providerReview && options?.purpose !== "accepted-result-settlement") {
    try {
      if (!options?.providerReviewAcknowledgment) {
<<<<<<< HEAD
        return block(
=======
        return new SessionWorkStartError(
>>>>>>> 97b6e87616f
          "provider_review",
          `Session "${sessionKey}" is paused as a precaution. Review the provider findings in chat before continuing.`,
        );
      }
      assertProviderReviewAcknowledgment(options.providerReviewAcknowledgment, {
        sessionKey,
        entry,
        runId: options.runId,
      });
    } catch {
<<<<<<< HEAD
      return block(
=======
      return new SessionWorkStartError(
>>>>>>> 97b6e87616f
        "provider_review",
        `Session "${sessionKey}" provider review changed. Refresh the findings before continuing.`,
      );
    }
  }
  const restartRecoveryTombstone = isRestartRecoveryTombstone(entry);
  if (restartRecoveryTombstone) {
    // Acknowledgment owns continuation of the reviewed conversation, never its replacement.
    if (options?.allowRestartTombstoneReplacement === true && !entry?.providerReview) {
      return undefined;
    }
<<<<<<< HEAD
    return block(
=======
    return new SessionWorkStartError(
>>>>>>> 97b6e87616f
      "restart_tombstone",
      entry?.modelSelectionLocked === true
        ? `Session "${sessionKey}" ended during restart recovery and cannot be replaced while model selection is locked. Open it in WebChat and use Resume in new session.`
        : `Session "${sessionKey}" ended during restart recovery. Use /new or /reset to start a replacement session.`,
    );
  }
  if (entry?.archivedAt !== undefined) {
<<<<<<< HEAD
    return block(
=======
    return new SessionWorkStartError(
>>>>>>> 97b6e87616f
      "archived",
      `Session "${sessionKey}" is archived. Restore it before starting new work.`,
    );
  }
  if (
    !options?.allowPendingWorkspace &&
    (entry?.pendingProjectGitUrl !== undefined || entry?.pendingWorktree !== undefined)
  ) {
<<<<<<< HEAD
    return block(
=======
    return new SessionWorkStartError(
>>>>>>> 97b6e87616f
      "workspace_pending",
      `Session "${sessionKey}" workspace is not ready. Wait for setup to finish or retry in chat.`,
      true,
    );
  }
  return undefined;
}

<<<<<<< HEAD
function block(reason: SessionWorkStartBlockReason, message: string, retryable = false) {
  return { reason, message, retryable };
}

=======
>>>>>>> 97b6e87616f
export function resolveSessionWorkStartError(
  sessionKey: string,
  entry: SessionWorkStartEntry | null | undefined,
  options?: SessionWorkStartOptions,
): string | undefined {
  return resolveSessionWorkStartBlock(sessionKey, entry, options)?.message;
}
