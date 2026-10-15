import { SessionTranscriptReadFenceError } from "../config/sessions/session-transcript-read-fence.js";
import { GatewayDrainingError } from "./gateway-work-admission.js";

/** True only when the failure is entirely explained by expected run cancellation. */
export function isExpectedRunCancellation(error: unknown): boolean {
  if (error instanceof GatewayDrainingError || error instanceof SessionTranscriptReadFenceError) {
    return true;
  }
  if (error instanceof AggregateError) {
    return (
      error.errors.length > 0 &&
      error.errors.every(isExpectedRunCancellation) &&
      (error.cause === undefined || isExpectedRunCancellation(error.cause))
    );
  }
  return (
    error instanceof Error && error.cause !== undefined && isExpectedRunCancellation(error.cause)
  );
}
