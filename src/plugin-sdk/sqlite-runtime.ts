// Narrow SQLite schema, path, and transaction helpers for first-party runtime.

export {
  ensureOpenClawAgentDatabaseSchema,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
export { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
export { ensureOpenClawAgentStandingIntentsSchema } from "../state/openclaw-agent-standing-intents-schema.js";
export {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
export { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
export { prepareSqliteReadOnlyLocationSync } from "../infra/sqlite-readonly-location.js";
export { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
export {
  DEFAULT_SQLITE_WRITER_QUEUE_MAX_DEPTH,
  getSqliteAuthorityWriterQueue,
  runSqliteAuthorityWrite,
  runSqliteAuthorityWriteSync,
  SqliteWriterQueue,
  SqliteWriterQueueError,
  type SqliteWriterQueueOptions,
  type SqliteWriterQueueSnapshot,
} from "../infra/sqlite-writer-queue.js";
export {
  SQLITE_AUTHORITY_LIFECYCLE_STATES,
  SqliteAuthorityLifecycle,
  type SqliteAuthorityLifecycleContext,
  type SqliteAuthorityLifecycleRecord,
  type SqliteAuthorityLifecycleState,
} from "../infra/sqlite-authority-lifecycle.js";
export { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
