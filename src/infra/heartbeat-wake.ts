import type { HeartbeatWakeHandler } from "./heartbeat-wake-contracts.js";
import { setSessionEventWakeHandler } from "./session-event-wake.js";

export type {
  HeartbeatRunResult,
  HeartbeatScheduledTask,
  HeartbeatWakeHandler,
  HeartbeatWakeIntent,
  HeartbeatWakeRequest,
  HeartbeatWakeSource,
} from "./heartbeat-wake-contracts.js";
export {
  requestSessionEventWake as requestHeartbeat,
  requestSessionEventWakeAndWait as requestHeartbeatAndWait,
  areSessionEventWakesEnabled as areHeartbeatsEnabled,
  setSessionEventWakesEnabled as setHeartbeatsEnabled,
  getSessionEventWakeAbortSignal as getHeartbeatWakeAbortSignal,
  isRetryableSessionEventWakeReason as isRetryableHeartbeatSkipReason,
  SESSION_EVENT_IDLE_RETRY_MS as HEARTBEAT_IDLE_RETRY_GRACE_MS,
} from "./session-event-wake.js";

// Admission refusal codes live in ./heartbeat-skip-reasons.js so the wake
// scheduler can classify a detail-suffixed reason by token without importing
// this module (this module already re-exports the scheduler). Only the codes
// that consumers actually read from this module are re-exported here; every
// other code is owned by ./heartbeat-skip-reasons.js and imported from there.
export {
  HEARTBEAT_SKIP_CRON_IN_PROGRESS,
  HEARTBEAT_SKIP_MAIN_LANE_BUSY,
} from "./heartbeat-skip-reasons.js";

/** Legacy admission token; retained because post-admission dispatch still emits it. */
export const HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT = "requests-in-flight";
export const HEARTBEAT_SKIP_NO_PENDING_EVENT = "no-pending-event";
export const HEARTBEAT_SKIP_PREEMPTED = "preempted";
export const HEARTBEAT_SKIP_CHANNEL_NOT_READY = "channel-not-ready";

// Shipped SDK callers retain their one-argument handler.
export function setHeartbeatWakeHandler(next: HeartbeatWakeHandler | null): () => void {
  return setSessionEventWakeHandler(next ? (wake) => next(wake) : null);
}
