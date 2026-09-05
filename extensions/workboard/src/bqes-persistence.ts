import {
  deriveIdempotencyKey,
  stableJson,
  requireNonEmpty,
  normalizeRepositoryRelativeManifest,
  parseApprovedVerificationCommand,
} from "@openclaw/execution-contract";
import {
  openNodeSqliteDatabase,
  runSqliteImmediateTransactionSync,
} from "openclaw/plugin-sdk/sqlite-runtime";
import type {
  BqesAdmission,
  BqesAdmissionInput,
  BqesCompletionEvidence,
  BqesDbosReceipt,
} from "./bqes-types.js";

export type BqesRow = Record<string, unknown>;
type SqliteDatabase = ReturnType<typeof openNodeSqliteDatabase>;

export function bqesJson(value: unknown): string {
  return JSON.stringify(value);
}

function parseBqesValue(value: unknown): unknown {
  return typeof value === "string" && value.length > 0 ? JSON.parse(value) : undefined;
}

export function bqesText(row: BqesRow, key: string): string {
  return requireNonEmpty(row[key], `BQES ${key}`);
}

export function bqesNumber(row: BqesRow, key: string): number {
  const value = row[key];
  const result = typeof value === "bigint" ? Number(value) : value;
  if (typeof result !== "number" || !Number.isFinite(result)) {
    throw new Error(`BQES ${key} is invalid.`);
  }
  return result;
}

export function transaction<T>(db: SqliteDatabase, fn: () => T): T {
  return runSqliteImmediateTransactionSync(db, fn, {
    databaseLabel: "workboard-bqes",
    operationLabel: "workboard.bqes.write",
    maxHoldMs: 5_000,
  });
}

export function normalizeInput(input: BqesAdmissionInput): BqesAdmissionInput {
  const identity = {
    cardId: requireNonEmpty(input.cardId, "BQES cardId"),
    queue: requireNonEmpty(input.queue, "BQES queue"),
    runId: requireNonEmpty(input.runId, "BQES runId"),
  };
  const normalized: BqesAdmissionInput = {
    ...identity,
    attemptId: requireNonEmpty(input.attemptId, "BQES attemptId"),
    idempotencyKey: requireNonEmpty(input.idempotencyKey, "BQES idempotencyKey"),
    sourceIdentity: requireNonEmpty(input.sourceIdentity, "BQES sourceIdentity"),
    artifactIdentity: requireNonEmpty(input.artifactIdentity, "BQES artifactIdentity"),
    ownerEpoch: requireNonEmpty(input.ownerEpoch, "BQES ownerEpoch"),
    allowedFiles: normalizeRepositoryRelativeManifest(input.allowedFiles, "BQES allowed files"),
    targetFiles: normalizeRepositoryRelativeManifest(
      input.targetFiles ?? input.allowedFiles,
      "BQES target files",
    ),
    acceptanceCriteria: Array.isArray(input.acceptanceCriteria)
      ? input.acceptanceCriteria.map((entry) => requireNonEmpty(entry, "BQES acceptance criterion"))
      : [],
    verificationCommand: parseApprovedVerificationCommand(input.verificationCommand).command,
    ...(typeof input.artifactPath === "string" && input.artifactPath.trim()
      ? { artifactPath: input.artifactPath.trim() }
      : {}),
    ...(typeof input.buildArtifactPath === "string" && input.buildArtifactPath.trim()
      ? { buildArtifactPath: input.buildArtifactPath.trim() }
      : {}),
    ...(Array.isArray(input.documentedExemptPaths)
      ? {
          documentedExemptPaths: normalizeRepositoryRelativeManifest(
            input.documentedExemptPaths,
            "BQES documented exemptions",
          ),
        }
      : {}),
    ...(input.now === undefined ? {} : { now: input.now }),
  };
  if (normalized.acceptanceCriteria.length === 0) {
    throw new Error("BQES acceptanceCriteria is required.");
  }
  const allowed = new Set(normalized.allowedFiles);
  if (normalized.targetFiles?.some((entry) => !allowed.has(entry))) {
    throw new Error("BQES target files must be contained in allowed files.");
  }
  const expectedKey = deriveIdempotencyKey(identity);
  if (normalized.idempotencyKey !== expectedKey) {
    throw new Error("BQES idempotency key does not match card, queue, and run identity.");
  }
  return normalized;
}

export function readAdmission(row: BqesRow): BqesAdmission {
  return {
    cardId: bqesText(row, "card_id"),
    queue: bqesText(row, "queue"),
    runId: bqesText(row, "run_id"),
    attemptId: bqesText(row, "attempt_id"),
    idempotencyKey: bqesText(row, "idempotency_key"),
    workflowId: bqesText(row, "workflow_id"),
    // SAFETY: the value was JSON-encoded by the BQES schema and is only used as an optional receipt.
    dbosReceipt: parseBqesValue(row.dbos_receipt) as BqesDbosReceipt | undefined,
    sourceIdentity: bqesText(row, "source_identity"),
    artifactIdentity: bqesText(row, "artifact_identity"),
    ownerEpoch: bqesText(row, "owner_epoch"),
    // SAFETY: admission rows persist bounded string arrays through bqesJson.
    allowedFiles: (parseBqesValue(row.allowed_files) as string[] | undefined) ?? [],
    targetFiles:
      // SAFETY: admission rows persist bounded string arrays through bqesJson.
      (parseBqesValue(row.target_files) as string[] | undefined) ??
      // SAFETY: the legacy fallback uses the same bounded string-array schema.
      (parseBqesValue(row.allowed_files) as string[] | undefined) ??
      [],
    // SAFETY: admission rows persist bounded string arrays through bqesJson.
    acceptanceCriteria: (parseBqesValue(row.acceptance_criteria) as string[] | undefined) ?? [],
    verificationCommand: bqesText(row, "verification_command"),
    ...(typeof row.artifact_path === "string" && row.artifact_path
      ? { artifactPath: row.artifact_path }
      : {}),
    ...(typeof row.build_artifact_path === "string" && row.build_artifact_path
      ? { buildArtifactPath: row.build_artifact_path }
      : {}),
    ...(parseBqesValue(row.documented_exempt_paths)
      ? {
          documentedExemptPaths:
            // SAFETY: documented exemptions are persisted as a bounded string array by the admission writer.
            parseBqesValue(row.documented_exempt_paths) as string[],
        }
      : {}),
    // SAFETY: bqesText reads the state column written from the closed admission-state union.
    state: bqesText(row, "state") as BqesAdmission["state"],
    // SAFETY: evidence is JSON persisted by the BQES completion path and remains optional.
    evidence: parseBqesValue(row.evidence) as BqesCompletionEvidence | undefined,
    createdAt: bqesNumber(row, "created_at"),
    updatedAt: bqesNumber(row, "updated_at"),
    now: bqesNumber(row, "created_at"),
  };
}

export function sameAdmission(left: BqesAdmission, input: BqesAdmissionInput): boolean {
  const immutable = (value: BqesAdmission | BqesAdmissionInput) => ({
    cardId: value.cardId,
    queue: value.queue,
    runId: value.runId,
    attemptId: value.attemptId,
    idempotencyKey: value.idempotencyKey,
    sourceIdentity: value.sourceIdentity,
    artifactIdentity: value.artifactIdentity,
    ownerEpoch: value.ownerEpoch,
    allowedFiles: value.allowedFiles,
    targetFiles: value.targetFiles ?? value.allowedFiles,
    acceptanceCriteria: value.acceptanceCriteria,
    verificationCommand: value.verificationCommand,
    artifactPath: value.artifactPath,
    buildArtifactPath: value.buildArtifactPath,
    documentedExemptPaths: value.documentedExemptPaths,
  });
  return stableJson(immutable(left)) === stableJson(immutable(input));
}

export function initializeBqesSchema(db: SqliteDatabase, now: () => number): void {
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS bqes_schema_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS bqes_admission_fence (
      id INTEGER PRIMARY KEY CHECK (id = 1), frozen INTEGER NOT NULL, token TEXT, reason TEXT, updated_at INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO bqes_admission_fence (id, frozen, updated_at) VALUES (1, 0, 0);
    CREATE TABLE IF NOT EXISTS bqes_admissions (
      idempotency_key TEXT PRIMARY KEY, card_id TEXT NOT NULL, queue TEXT NOT NULL, run_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL, workflow_id TEXT NOT NULL UNIQUE, source_identity TEXT NOT NULL,
      artifact_identity TEXT NOT NULL, owner_epoch TEXT NOT NULL, allowed_files TEXT NOT NULL,
      acceptance_criteria TEXT NOT NULL, target_files TEXT NOT NULL, verification_command TEXT NOT NULL,
      artifact_path TEXT, build_artifact_path TEXT, state TEXT NOT NULL,
      dbos_receipt TEXT, evidence TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(card_id, run_id, attempt_id)
    );
    CREATE TABLE IF NOT EXISTS bqes_events (
      idempotency_key TEXT NOT NULL REFERENCES bqes_admissions(idempotency_key) ON DELETE CASCADE,
      sequence INTEGER NOT NULL, state TEXT NOT NULL, detail TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY(idempotency_key, sequence)
    );
    CREATE TABLE IF NOT EXISTS bqes_verification_passes (
      idempotency_key TEXT PRIMARY KEY REFERENCES bqes_admissions(idempotency_key) ON DELETE CASCADE,
      proof_hash TEXT NOT NULL,
      verified_at INTEGER NOT NULL,
      reviewer_principal TEXT NOT NULL DEFAULT '',
      reviewer_session TEXT NOT NULL DEFAULT '',
      reviewer_session_issued_at INTEGER,
      reviewer_session_expires_at INTEGER
    );
  `);
  // SAFETY: node:sqlite returns PRAGMA rows with the named table_info columns.
  const admissionColumns = db.prepare("PRAGMA table_info(bqes_admissions)").all() as Array<{
    name?: unknown;
  }>;
  if (!admissionColumns.some((column) => column.name === "dbos_receipt")) {
    db.exec("ALTER TABLE bqes_admissions ADD COLUMN dbos_receipt TEXT");
  }
  if (!admissionColumns.some((column) => column.name === "target_files")) {
    db.exec("ALTER TABLE bqes_admissions ADD COLUMN target_files TEXT NOT NULL DEFAULT '[]'");
    db.exec("UPDATE bqes_admissions SET target_files = allowed_files WHERE target_files = '[]'");
  }
  if (!admissionColumns.some((column) => column.name === "artifact_path")) {
    db.exec("ALTER TABLE bqes_admissions ADD COLUMN artifact_path TEXT");
  }
  if (!admissionColumns.some((column) => column.name === "build_artifact_path")) {
    db.exec("ALTER TABLE bqes_admissions ADD COLUMN build_artifact_path TEXT");
  }
  if (!admissionColumns.some((column) => column.name === "documented_exempt_paths")) {
    db.exec("ALTER TABLE bqes_admissions ADD COLUMN documented_exempt_paths TEXT");
  }
  const verificationColumns = db
    .prepare("PRAGMA table_info(bqes_verification_passes)")
    // SAFETY: node:sqlite returns PRAGMA rows with the optional name column.
    .all() as Array<{ name?: unknown }>;
  if (!verificationColumns.some((column) => column.name === "reviewer_principal")) {
    db.exec(
      "ALTER TABLE bqes_verification_passes ADD COLUMN reviewer_principal TEXT NOT NULL DEFAULT ''",
    );
  }
  if (!verificationColumns.some((column) => column.name === "reviewer_session")) {
    db.exec(
      "ALTER TABLE bqes_verification_passes ADD COLUMN reviewer_session TEXT NOT NULL DEFAULT ''",
    );
  }
  if (!verificationColumns.some((column) => column.name === "reviewer_session_issued_at")) {
    db.exec("ALTER TABLE bqes_verification_passes ADD COLUMN reviewer_session_issued_at INTEGER");
  }
  if (!verificationColumns.some((column) => column.name === "reviewer_session_expires_at")) {
    db.exec("ALTER TABLE bqes_verification_passes ADD COLUMN reviewer_session_expires_at INTEGER");
  }
  db.prepare("INSERT OR IGNORE INTO bqes_schema_migrations (id, applied_at) VALUES (?, ?)").run(
    3,
    now(),
  );
}
