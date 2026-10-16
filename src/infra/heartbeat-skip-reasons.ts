/**
 * Machine-stable heartbeat admission skip codes.
 *
 * A recorded skip reason is `<token>` optionally followed by a single space
 * and a detail suffix (`agent=… session=… repair=…`). Operators read the whole
 * string in run records; wake scheduling classifies on the token alone, so the
 * detail suffix never changes retry or idle-grace semantics.
 *
 * Admission emits one token per fence instead of a single `requests-in-flight`
 * token: a refusal must name its own cause from the record alone, without
 * reading the bundle. `requests-in-flight` stays valid because the post-
 * admission dispatch fence in the heartbeat runner still emits it.
 */

/** `main` command lane holds queued work (global, in-memory). */
export const HEARTBEAT_SKIP_MAIN_LANE_BUSY = "main-lane-busy";
/** An active cron job or a busy cron/cron-nested/hook-dispatch lane (global). */
export const HEARTBEAT_SKIP_CRON_IN_PROGRESS = "cron-in-progress";
/** Another reply or embedded run on the same agent owns the turn (in-memory). */
export const HEARTBEAT_SKIP_AGENT_RUN_ACTIVE = "agent-run-active";
/** Main-session recovery row is `blocked` (persisted, restart-invariant). */
export const HEARTBEAT_SKIP_SESSION_RECOVERY_BLOCKED = "session-recovery-blocked";
/** Main-session recovery row is `recoverable` (persisted, restart-invariant). */
export const HEARTBEAT_SKIP_SESSION_RECOVERY_RECOVERABLE = "session-recovery-recoverable";
/** A restart-recovery delivery owned by this gateway generation still owns the row. */
export const HEARTBEAT_SKIP_SESSION_RECOVERY_DELIVERY = "session-recovery-delivery-active";
/** Final-delivery replay is pending inside its 30s deferral window (transient). */
export const HEARTBEAT_SKIP_PENDING_FINAL_DELIVERY = "pending-final-delivery";
/** The exact target session has an active reply or embedded run (in-memory). */
export const HEARTBEAT_SKIP_SESSION_RUN_ACTIVE = "session-run-active";
/** The target session's own command lane holds queued work (in-memory). */
export const HEARTBEAT_SKIP_SESSION_LANE_BUSY = "session-lane-busy";

/** Legacy collapse token; still emitted by the post-admission dispatch fence. */
const LEGACY_WORK_IN_FLIGHT_SKIP_TOKEN = "requests-in-flight";
/** Non-admission token used when an agent turn already owns the reply. */
const ACTIVE_RUN_SKIP_TOKEN = "active-run";

/** Read the machine-stable token from a possibly detail-suffixed reason. */
export function heartbeatSkipReasonToken(reason: string): string {
  const trimmed = reason.trim();
  const separator = trimmed.indexOf(" ");
  return separator === -1 ? trimmed : trimmed.slice(0, separator);
}

/** Join a token with its operator-facing detail suffix. */
export function formatHeartbeatSkipReason(token: string, detail?: string): string {
  const suffix = detail?.trim();
  return suffix && suffix.length > 0 ? `${token} ${suffix}` : token;
}

const WORK_IN_FLIGHT_SKIP_REASON_TOKENS: ReadonlySet<string> = new Set([
  LEGACY_WORK_IN_FLIGHT_SKIP_TOKEN,
  ACTIVE_RUN_SKIP_TOKEN,
  HEARTBEAT_SKIP_MAIN_LANE_BUSY,
  HEARTBEAT_SKIP_AGENT_RUN_ACTIVE,
  HEARTBEAT_SKIP_SESSION_RECOVERY_BLOCKED,
  HEARTBEAT_SKIP_SESSION_RECOVERY_RECOVERABLE,
  HEARTBEAT_SKIP_SESSION_RECOVERY_DELIVERY,
  HEARTBEAT_SKIP_PENDING_FINAL_DELIVERY,
  HEARTBEAT_SKIP_SESSION_RUN_ACTIVE,
  HEARTBEAT_SKIP_SESSION_LANE_BUSY,
]);

/**
 * Busy-class tokens. Cron contention is deliberately separate from the
 * work-in-flight class: a cron refusal retries on the short default delay,
 * while in-flight refusals earn the 60s idle grace.
 */
const BUSY_SKIP_REASON_TOKENS: ReadonlySet<string> = new Set([
  ...WORK_IN_FLIGHT_SKIP_REASON_TOKENS,
  HEARTBEAT_SKIP_CRON_IN_PROGRESS,
]);

/** True when another run or lane already owns this wake (`requests-in-flight` family). */
export function isHeartbeatWorkInFlightSkipReason(reason: string): boolean {
  return WORK_IN_FLIGHT_SKIP_REASON_TOKENS.has(heartbeatSkipReasonToken(reason));
}

/** True for any busy admission refusal, cron contention included. */
export function isHeartbeatBusySkipReason(reason: string): boolean {
  return BUSY_SKIP_REASON_TOKENS.has(heartbeatSkipReasonToken(reason));
}
