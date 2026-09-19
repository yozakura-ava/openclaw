/** Marks a persisted user turn that no longer belongs to the active transcript turn. */
export const SESSION_TRANSCRIPT_DESYNC_ERROR_CODE = "SESSION_TRANSCRIPT_DESYNC" as const;

export class SessionTranscriptDesyncError extends Error {
  readonly code = SESSION_TRANSCRIPT_DESYNC_ERROR_CODE;

  constructor(message: string) {
    super(message);
    this.name = "SessionTranscriptDesyncError";
  }
}

export function isSessionTranscriptDesyncError(
  error: unknown,
): error is SessionTranscriptDesyncError {
  return (
    error instanceof Error && "code" in error && error.code === SESSION_TRANSCRIPT_DESYNC_ERROR_CODE
  );
}
