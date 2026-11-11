import { SessionTranscriptReadFenceError } from "../config/sessions/session-transcript-read-fence-error.js";
import { GatewayDrainingError } from "./gateway-work-admission.js";

<<<<<<< HEAD
/** True only when the failure is entirely explained by expected run cancellation. */
=======
>>>>>>> 97b6e87616f
export function isExpectedRunCancellation(error: unknown): boolean {
  if (error instanceof GatewayDrainingError || error instanceof SessionTranscriptReadFenceError) {
    return true;
  }
  if (error instanceof AggregateError) {
<<<<<<< HEAD
=======
    // Cancellation must not hide an independent cleanup failure.
>>>>>>> 97b6e87616f
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
