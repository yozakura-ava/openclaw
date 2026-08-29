export class DbosRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbosRuntimeError";
  }
}

export type DbosRequestFailureKind = "timeout" | "transport" | "http";

export class DbosRequestError extends DbosRuntimeError {
  constructor(
    message: string,
    readonly kind: DbosRequestFailureKind,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "DbosRequestError";
  }
}
