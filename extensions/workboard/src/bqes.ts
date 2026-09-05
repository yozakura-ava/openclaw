/* oxlint-disable max-lines -- BQES admission, receipt, and replay state machine is intentionally co-located. */
import { randomUUID } from "node:crypto";
// Durable BQES admission and completion authority for Workboard-controlled runs.
// This is intentionally independent from card JSON so a card cannot manufacture
// its own admission or terminal evidence.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  deriveIdempotencyKey,
  deriveWorkflowId,
  stableJson,
  requireNonEmpty,
  normalizeRepositoryRelativeManifest,
  parseApprovedVerificationCommand,
  assertCanonicalControl,
  type AdmissionGate,
  type ExecutionIdentityInput,
} from "@openclaw/execution-contract";
import { runSqliteImmediateTransactionSync } from "openclaw/plugin-sdk/sqlite-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

export type BqesDbosReceipt = {
  workflowId: string;
  idempotencyKey: string;
  cardId: string;
  queue: string;
  runId: string;
  attemptId: string;
  ownerEpoch: string;
  acknowledgedAt: number;
};

export type BqesState = "admitted" | "running" | "completed" | "failed" | "quarantined";
export type BqesOperationState =
  | "admitted"
  | "receipt_persisted"
  | "running"
  | "verification_pending"
  | "verified"
  | "completion_pending"
  | "completed"
  | "failed"
  | "quarantined"
  | "ambiguous"
  | "reconciliation_pending";
export type BqesFailureState =
  | "retryable_transport_failure"
  | "terminal_authority_rejection"
  | "quarantined"
  | "ambiguous_requires_ava"
  | "reconciliation_pending";
export type BqesTerminalOwnership = "reaped" | "externally_handed_off";

export type BqesAdmissionInput = ExecutionIdentityInput & {
  attemptId: string;
  idempotencyKey: string;
  sourceIdentity: string;
  artifactIdentity: string;
  ownerEpoch: string;
  allowedFiles: string[];
  targetFiles?: string[];
  acceptanceCriteria: string[];
  verificationCommand: string;
  artifactPath?: string;
  buildArtifactPath?: string;
  documentedExemptPaths?: string[];
  now?: number;
};

export type BqesCompletionEvidence = {
  sourceIdentity: string;
  artifactIdentity: string;
  ownerEpoch: string;
  verification: { command: string; exitCode: number; outputHash: string };
  verificationProofHash: string;
  delivery: {
    idempotencyKey: string;
    acknowledged: true;
    acknowledgedAt: number;
  };
  ownership: {
    state: BqesTerminalOwnership;
    activeOwnedDescendants: number;
    openDescriptors: number;
    pendingCleanup: number;
  };
  provenance: {
    sourceSha: string;
    artifactDigest: string;
    buildIdentity: string;
  };
};

export type BqesVerificationPass = {
  proofHash: string;
  verifiedAt: number;
  reviewerPrincipal?: string;
  reviewerSession?: string;
  reviewerSessionIssuedAt?: number;
  reviewerSessionExpiresAt?: number;
};

export type BqesReviewer = {
  principal: string;
  session: string;
  issuedAt: number;
  expiresAt: number;
};

export type BqesAdmission = BqesAdmissionInput & {
  workflowId: string;
  dbosReceipt?: BqesDbosReceipt;
  state: BqesState;
  evidence?: BqesCompletionEvidence;
  verificationPass?: BqesVerificationPass;
  createdAt: number;
  updatedAt: number;
};

export type BqesFreezeReceipt = {
  token: string;
  reason: string;
  frozenAt: number;
};
export type ReceiptReconciliation = {
  outcome: "persisted" | "duplicate" | "replayed";
  admission: BqesAdmission;
};

type Row = Record<string, unknown>;

const DEFAULT_DB_PATH = ["plugins", "workboard", "bqes.sqlite"] as const;
const BQES_SCHEMA_VERSION = 3;

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parse(value: unknown): unknown {
  return typeof value === "string" && value.length > 0 ? JSON.parse(value) : undefined;
}

function text(row: Row, key: string): string {
  return requireNonEmpty(row[key], `BQES ${key}`);
}

function number(row: Row, key: string): number {
  const value = row[key];
  const result = typeof value === "bigint" ? Number(value) : value;
  if (typeof result !== "number" || !Number.isFinite(result)) {
    throw new Error(`BQES ${key} is invalid.`);
  }
  return result;
}

function transaction<T>(db: DatabaseSync, fn: () => T): T {
  return runSqliteImmediateTransactionSync(db, fn, {
    databaseLabel: "workboard-bqes",
    operationLabel: "workboard.bqes.write",
    maxHoldMs: 5_000,
  });
}

function normalizeInput(input: BqesAdmissionInput): BqesAdmissionInput {
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

function readAdmission(row: Row): BqesAdmission {
  return {
    cardId: text(row, "card_id"),
    queue: text(row, "queue"),
    runId: text(row, "run_id"),
    attemptId: text(row, "attempt_id"),
    idempotencyKey: text(row, "idempotency_key"),
    workflowId: text(row, "workflow_id"),
    dbosReceipt: parse(row.dbos_receipt) as BqesDbosReceipt | undefined,
    sourceIdentity: text(row, "source_identity"),
    artifactIdentity: text(row, "artifact_identity"),
    ownerEpoch: text(row, "owner_epoch"),
    allowedFiles: (parse(row.allowed_files) as string[] | undefined) ?? [],
    targetFiles:
      (parse(row.target_files) as string[] | undefined) ??
      (parse(row.allowed_files) as string[] | undefined) ??
      [],
    acceptanceCriteria: (parse(row.acceptance_criteria) as string[] | undefined) ?? [],
    verificationCommand: text(row, "verification_command"),
    ...(typeof row.artifact_path === "string" && row.artifact_path
      ? { artifactPath: row.artifact_path }
      : {}),
    ...(typeof row.build_artifact_path === "string" && row.build_artifact_path
      ? { buildArtifactPath: row.build_artifact_path }
      : {}),
    ...(parse(row.documented_exempt_paths)
      ? { documentedExemptPaths: parse(row.documented_exempt_paths) as string[] }
      : {}),
    state: text(row, "state") as BqesState,
    evidence: parse(row.evidence) as BqesCompletionEvidence | undefined,
    createdAt: number(row, "created_at"),
    updatedAt: number(row, "updated_at"),
    now: number(row, "created_at"),
  };
}

function sameAdmission(left: BqesAdmission, input: BqesAdmissionInput): boolean {
  // Receipt, verification, and terminal evidence are authority-owned state.
  // They must not make a legitimate idempotent admission replay conflict.
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

export function resolveBqesDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), ...DEFAULT_DB_PATH);
}

export class BqesAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BqesAdmissionError";
  }
}

export class BqesService implements AdmissionGate {
  readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(options: { dbPath?: string; now?: () => number } = {}) {
    const dbPath = options.dbPath ?? resolveBqesDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    this.now = options.now ?? Date.now;
    this.db.exec(`
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
    const admissionColumns = this.db.prepare("PRAGMA table_info(bqes_admissions)").all() as Array<{
      name?: unknown;
    }>;
    if (!admissionColumns.some((column) => column.name === "dbos_receipt")) {
      this.db.exec("ALTER TABLE bqes_admissions ADD COLUMN dbos_receipt TEXT");
    }
    if (!admissionColumns.some((column) => column.name === "target_files")) {
      this.db.exec(
        "ALTER TABLE bqes_admissions ADD COLUMN target_files TEXT NOT NULL DEFAULT '[]'",
      );
      this.db.exec(
        "UPDATE bqes_admissions SET target_files = allowed_files WHERE target_files = '[]'",
      );
    }
    if (!admissionColumns.some((column) => column.name === "artifact_path")) {
      this.db.exec("ALTER TABLE bqes_admissions ADD COLUMN artifact_path TEXT");
    }
    if (!admissionColumns.some((column) => column.name === "build_artifact_path")) {
      this.db.exec("ALTER TABLE bqes_admissions ADD COLUMN build_artifact_path TEXT");
    }
    if (!admissionColumns.some((column) => column.name === "documented_exempt_paths")) {
      this.db.exec("ALTER TABLE bqes_admissions ADD COLUMN documented_exempt_paths TEXT");
    }
    const verificationColumns = this.db
      .prepare("PRAGMA table_info(bqes_verification_passes)")
      .all() as Array<{ name?: unknown }>;
    if (!verificationColumns.some((column) => column.name === "reviewer_principal")) {
      this.db.exec(
        "ALTER TABLE bqes_verification_passes ADD COLUMN reviewer_principal TEXT NOT NULL DEFAULT ''",
      );
    }
    if (!verificationColumns.some((column) => column.name === "reviewer_session")) {
      this.db.exec(
        "ALTER TABLE bqes_verification_passes ADD COLUMN reviewer_session TEXT NOT NULL DEFAULT ''",
      );
    }
    if (!verificationColumns.some((column) => column.name === "reviewer_session_issued_at")) {
      this.db.exec(
        "ALTER TABLE bqes_verification_passes ADD COLUMN reviewer_session_issued_at INTEGER",
      );
    }
    if (!verificationColumns.some((column) => column.name === "reviewer_session_expires_at")) {
      this.db.exec(
        "ALTER TABLE bqes_verification_passes ADD COLUMN reviewer_session_expires_at INTEGER",
      );
    }
    this.db
      .prepare("INSERT OR IGNORE INTO bqes_schema_migrations (id, applied_at) VALUES (?, ?)")
      .run(BQES_SCHEMA_VERSION, this.now());
  }

  close(): void {
    this.db.close();
  }

  assertAdmissionOpen(): void {
    assertCanonicalControl("admission");
    const row = this.db
      .prepare("SELECT frozen, reason FROM bqes_admission_fence WHERE id = 1")
      .get() as Row;
    if (Number(row.frozen) === 1) {
      const reason = typeof row.reason === "string" ? row.reason : undefined;
      throw new BqesAdmissionError(`admission is frozen${reason ? `: ${reason}` : ""}`);
    }
  }

  freeze(reason: string): BqesFreezeReceipt {
    const normalizedReason = requireNonEmpty(reason, "freeze reason");
    return transaction(this.db, () => {
      const current = this.db
        .prepare("SELECT frozen FROM bqes_admission_fence WHERE id = 1")
        .get() as Row;
      if (Number(current.frozen) === 1) {
        throw new BqesAdmissionError("admission is already frozen");
      }
      const receipt = {
        token: randomUUID(),
        reason: normalizedReason,
        frozenAt: this.now(),
      };
      this.db
        .prepare(
          "UPDATE bqes_admission_fence SET frozen = 1, token = ?, reason = ?, updated_at = ? WHERE id = 1",
        )
        .run(receipt.token, receipt.reason, receipt.frozenAt);
      return receipt;
    });
  }

  unfreeze(token: string): void {
    transaction(this.db, () => {
      const row = this.db
        .prepare("SELECT frozen, token FROM bqes_admission_fence WHERE id = 1")
        .get() as Row;
      if (Number(row.frozen) !== 1) {
        return;
      }
      if (row.token !== token) {
        throw new BqesAdmissionError("freeze token does not match");
      }
      this.db
        .prepare(
          "UPDATE bqes_admission_fence SET frozen = 0, token = NULL, reason = NULL, updated_at = ? WHERE id = 1",
        )
        .run(this.now());
    });
  }

  admissionState(): { frozen: boolean; reason?: string; updatedAt: number } {
    const row = this.db
      .prepare("SELECT frozen, reason, updated_at FROM bqes_admission_fence WHERE id = 1")
      .get() as Row;
    return {
      frozen: Number(row.frozen) === 1,
      ...(typeof row.reason === "string" ? { reason: row.reason } : {}),
      updatedAt: number(row, "updated_at"),
    };
  }

  evaluate(input: Omit<BqesAdmissionInput, "attemptId" | "idempotencyKey" | "now">): void {
    this.assertAdmissionOpen();
    normalizeInput({
      ...input,
      attemptId: "preflight",
      idempotencyKey: deriveIdempotencyKey(input),
    });
  }

  admit(rawInput: BqesAdmissionInput): BqesAdmission {
    this.assertAdmissionOpen();
    const input = normalizeInput(rawInput);
    const workflowId = deriveWorkflowId(input);
    const now = input.now ?? this.now();
    return transaction(this.db, () => {
      const existing = this.db
        .prepare("SELECT * FROM bqes_admissions WHERE idempotency_key = ?")
        .get(input.idempotencyKey) as Row | undefined;
      if (existing) {
        const admission = readAdmission(existing);
        if (!sameAdmission(admission, input)) {
          throw new BqesAdmissionError("conflicting BQES idempotency identity");
        }
        return admission;
      }
      try {
        this.db
          .prepare(
            `INSERT INTO bqes_admissions
          (idempotency_key, card_id, queue, run_id, attempt_id, workflow_id, source_identity, artifact_identity,
           owner_epoch, allowed_files, acceptance_criteria, target_files, verification_command, state, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admitted', ?, ?)`,
          )
          .run(
            input.idempotencyKey,
            input.cardId,
            input.queue,
            input.runId,
            input.attemptId,
            workflowId,
            input.sourceIdentity,
            input.artifactIdentity,
            input.ownerEpoch,
            json(input.allowedFiles),
            json(input.acceptanceCriteria),
            json(input.targetFiles ?? input.allowedFiles),
            input.verificationCommand,
            now,
            now,
          );
        this.db
          .prepare(
            "UPDATE bqes_admissions SET artifact_path = ?, build_artifact_path = ? WHERE idempotency_key = ?",
          )
          .run(input.artifactPath ?? null, input.buildArtifactPath ?? null, input.idempotencyKey);
        this.db
          .prepare(
            "UPDATE bqes_admissions SET documented_exempt_paths = ? WHERE idempotency_key = ?",
          )
          .run(
            input.documentedExemptPaths ? json(input.documentedExemptPaths) : null,
            input.idempotencyKey,
          );
      } catch (error) {
        throw new BqesAdmissionError(
          `BQES admission database error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.db
        .prepare("INSERT INTO bqes_events VALUES (?, 1, 'admitted', 'durable admission', ?)")
        .run(input.idempotencyKey, now);
      return readAdmission(
        this.db
          .prepare("SELECT * FROM bqes_admissions WHERE idempotency_key = ?")
          .get(input.idempotencyKey) as Row,
      );
    });
  }

  get(idempotencyKey: string): BqesAdmission | undefined {
    const row = this.db
      .prepare("SELECT * FROM bqes_admissions WHERE idempotency_key = ?")
      .get(idempotencyKey) as Row | undefined;
    if (!row) {
      return undefined;
    }
    const admission = readAdmission(row);
    const pass = this.db
      .prepare("SELECT * FROM bqes_verification_passes WHERE idempotency_key = ?")
      .get(idempotencyKey) as Row | undefined;
    return pass
      ? {
          ...admission,
          verificationPass: {
            proofHash: text(pass, "proof_hash"),
            verifiedAt: number(pass, "verified_at"),
            ...(typeof pass.reviewer_principal === "string" && pass.reviewer_principal
              ? { reviewerPrincipal: pass.reviewer_principal }
              : {}),
            ...(typeof pass.reviewer_session === "string" && pass.reviewer_session
              ? { reviewerSession: pass.reviewer_session }
              : {}),
            ...(Number.isFinite(Number(pass.reviewer_session_issued_at))
              ? {
                  reviewerSessionIssuedAt: Number(pass.reviewer_session_issued_at),
                }
              : {}),
            ...(Number.isFinite(Number(pass.reviewer_session_expires_at))
              ? {
                  reviewerSessionExpiresAt: Number(pass.reviewer_session_expires_at),
                }
              : {}),
          },
        }
      : admission;
  }

  /**
   * Find the one active admission for a card when Workboard persistence was
   * interrupted after BQES/DBOS admission.  The card's runId is descriptive
   * in this recovery path; BQES remains authoritative for the execution
   * identity.  Ambiguous active admissions fail closed so a reconciler cannot
   * accidentally fail the wrong retry.
   */
  findActiveByCardId(cardId: string, queue?: string): BqesAdmission | undefined {
    const normalizedCardId = requireNonEmpty(cardId, "BQES cardId");
    const normalizedQueue = queue === undefined ? undefined : requireNonEmpty(queue, "BQES queue");
    const rows = this.db
      .prepare(
        `SELECT idempotency_key FROM bqes_admissions
         WHERE card_id = ? AND state IN ('admitted', 'running')
         ${normalizedQueue ? "AND queue = ?" : ""}
         ORDER BY updated_at DESC, created_at DESC, idempotency_key DESC`,
      )
      .all(
        ...(normalizedQueue ? [normalizedCardId, normalizedQueue] : [normalizedCardId]),
      ) as Row[];
    if (rows.length === 0) {
      return undefined;
    }
    if (rows.length > 1) {
      throw new BqesAdmissionError(`ambiguous active BQES admissions for card ${normalizedCardId}`);
    }
    return this.get(text(rows[0]!, "idempotency_key"));
  }

  recordVerification(
    idempotencyKey: string,
    proofHash: string,
    reviewer: BqesReviewer,
  ): BqesVerificationPass {
    const normalizedHash = requireNonEmpty(proofHash, "verification proof hash");
    const principal = requireNonEmpty(reviewer.principal, "reviewer principal");
    const session = requireNonEmpty(reviewer.session, "reviewer session");
    if (
      !Number.isFinite(reviewer.issuedAt) ||
      !Number.isFinite(reviewer.expiresAt) ||
      reviewer.expiresAt <= reviewer.issuedAt
    ) {
      throw new BqesAdmissionError("reviewer session timestamps are invalid");
    }
    return transaction(this.db, () => {
      const current = this.get(idempotencyKey);
      if (!current) {
        throw new BqesAdmissionError("BQES admission not found");
      }
      if (
        current.state !== "running" &&
        !(current.state === "completed" && current.verificationPass)
      ) {
        throw new BqesAdmissionError(`cannot verify BQES ${current.state} admission`);
      }
      if (current.verificationPass) {
        // A replay may be issued by a fresh reviewer session. The trusted
        // evidence is recomputed before this method is called, so replacing
        // the proof hash keeps the latest independent pass durable while
        // preserving idempotent BQES state.
        const verifiedAt = this.now();
        this.db
          .prepare(
            "UPDATE bqes_verification_passes SET proof_hash = ?, verified_at = ?, reviewer_principal = ?, reviewer_session = ?, reviewer_session_issued_at = ?, reviewer_session_expires_at = ? WHERE idempotency_key = ?",
          )
          .run(
            normalizedHash,
            verifiedAt,
            principal,
            session,
            reviewer.issuedAt,
            reviewer.expiresAt,
            idempotencyKey,
          );
        this.addEvent(idempotencyKey, "verified", "independent completion verification replayed");
        return {
          proofHash: normalizedHash,
          verifiedAt,
          reviewerPrincipal: principal,
          reviewerSession: session,
          reviewerSessionIssuedAt: reviewer.issuedAt,
          reviewerSessionExpiresAt: reviewer.expiresAt,
        };
      }
      const verifiedAt = this.now();
      this.db
        .prepare(
          "INSERT INTO bqes_verification_passes (idempotency_key, proof_hash, verified_at, reviewer_principal, reviewer_session, reviewer_session_issued_at, reviewer_session_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          idempotencyKey,
          normalizedHash,
          verifiedAt,
          principal,
          session,
          reviewer.issuedAt,
          reviewer.expiresAt,
        );
      this.addEvent(idempotencyKey, "verified", "independent completion verification passed");
      return {
        proofHash: normalizedHash,
        verifiedAt,
        reviewerPrincipal: principal,
        reviewerSession: session,
        reviewerSessionIssuedAt: reviewer.issuedAt,
        reviewerSessionExpiresAt: reviewer.expiresAt,
      };
    });
  }

  start(idempotencyKey: string, ownerEpoch: string): BqesAdmission {
    const normalizedEpoch = requireNonEmpty(ownerEpoch, "owner epoch");
    return transaction(this.db, () => {
      const current = this.get(idempotencyKey);
      if (!current) {
        throw new BqesAdmissionError("BQES admission not found");
      }
      if (current.ownerEpoch !== normalizedEpoch) {
        throw new BqesAdmissionError("stale BQES owner epoch");
      }
      if (!current.dbosReceipt) {
        throw new BqesAdmissionError("DBOS receipt must be persisted before BQES start");
      }
      if (current.state === "running") {
        return current;
      }
      if (current.state !== "admitted") {
        throw new BqesAdmissionError(`cannot start BQES ${current.state} admission`);
      }
      this.db
        .prepare(
          "UPDATE bqes_admissions SET state = 'running', updated_at = ? WHERE idempotency_key = ?",
        )
        .run(this.now(), idempotencyKey);
      this.addEvent(idempotencyKey, "running", "dispatch acknowledged");
      return this.get(idempotencyKey)!;
    });
  }

  attachDbosReceipt(idempotencyKey: string, receipt: BqesDbosReceipt): BqesAdmission {
    return this.reconcileDbosReceipt(idempotencyKey, receipt).admission;
  }

  reconcileDbosReceipt(idempotencyKey: string, receipt: BqesDbosReceipt): ReceiptReconciliation {
    for (const [key, label] of [
      ["workflowId", "DBOS workflow id"],
      ["idempotencyKey", "DBOS idempotency key"],
      ["cardId", "DBOS card id"],
      ["queue", "DBOS queue"],
      ["runId", "DBOS run id"],
      ["attemptId", "DBOS attempt id"],
      ["ownerEpoch", "DBOS owner epoch"],
    ] as const) {
      requireNonEmpty(receipt[key], label);
    }
    if (!Number.isFinite(receipt.acknowledgedAt) || receipt.acknowledgedAt <= 0) {
      throw new BqesAdmissionError("DBOS receipt timestamp is invalid");
    }
    if (receipt.idempotencyKey !== idempotencyKey) {
      throw new BqesAdmissionError("DBOS receipt idempotency mismatch");
    }
    if (
      deriveWorkflowId(receipt) !== receipt.workflowId ||
      deriveIdempotencyKey(receipt) !== receipt.idempotencyKey
    ) {
      throw new BqesAdmissionError("DBOS receipt derived identity mismatch");
    }
    return transaction(this.db, () => {
      const current = this.get(idempotencyKey);
      if (!current) {
        throw new BqesAdmissionError("BQES admission not found");
      }
      if (
        current.workflowId !== receipt.workflowId ||
        current.workflowId !== deriveWorkflowId(current) ||
        current.cardId !== receipt.cardId ||
        current.queue !== receipt.queue ||
        current.runId !== receipt.runId ||
        current.attemptId !== receipt.attemptId ||
        current.ownerEpoch !== receipt.ownerEpoch
      ) {
        throw new BqesAdmissionError("DBOS receipt workflow identity mismatch");
      }
      if (current.dbosReceipt) {
        const receiptIdentity = (value: BqesDbosReceipt) => ({
          workflowId: value.workflowId,
          idempotencyKey: value.idempotencyKey,
          cardId: value.cardId,
          queue: value.queue,
          runId: value.runId,
          attemptId: value.attemptId,
          ownerEpoch: value.ownerEpoch,
        });
        if (
          stableJson(receiptIdentity(current.dbosReceipt)) !== stableJson(receiptIdentity(receipt))
        ) {
          throw new BqesAdmissionError("conflicting DBOS receipt");
        }
        return {
          outcome: current.state === "completed" ? "replayed" : "duplicate",
          admission: current,
        };
      }
      if (current.state !== "admitted") {
        throw new BqesAdmissionError(`cannot attach DBOS receipt to ${current.state} admission`);
      }
      this.db
        .prepare(
          "UPDATE bqes_admissions SET dbos_receipt = ?, updated_at = ? WHERE idempotency_key = ? AND state = 'admitted'",
        )
        .run(json(receipt), this.now(), idempotencyKey);
      this.addEvent(idempotencyKey, "dbos_acknowledged", "DBOS receipt persisted");
      return { outcome: "persisted", admission: this.get(idempotencyKey)! };
    });
  }

  complete(idempotencyKey: string, evidence: BqesCompletionEvidence): BqesAdmission {
    assertCanonicalControl("autonomousClosure");
    return transaction(this.db, () => {
      const current = this.get(idempotencyKey);
      if (!current) {
        throw new BqesAdmissionError("BQES admission not found");
      }
      if (current.state === "completed") {
        if (stableJson(current.evidence) !== stableJson(evidence)) {
          throw new BqesAdmissionError("conflicting duplicate terminal evidence");
        }
        return current;
      }
      if (current.state !== "running") {
        throw new BqesAdmissionError(`cannot complete BQES ${current.state} admission`);
      }
      if (
        evidence.sourceIdentity !== current.sourceIdentity ||
        evidence.artifactIdentity !== current.artifactIdentity
      ) {
        throw new BqesAdmissionError("BQES provenance identity mismatch");
      }
      if (evidence.ownerEpoch !== current.ownerEpoch) {
        throw new BqesAdmissionError("stale BQES owner epoch");
      }
      if (
        evidence.verification.command !== current.verificationCommand ||
        evidence.verification.exitCode !== 0 ||
        !evidence.verification.outputHash
      ) {
        throw new BqesAdmissionError("BQES verification evidence is invalid");
      }
      if (
        !current.verificationPass ||
        current.verificationPass.proofHash !== evidence.verificationProofHash
      ) {
        throw new BqesAdmissionError("BQES completion requires a matching verification pass");
      }
      if (
        !current.verificationPass.reviewerPrincipal ||
        !current.verificationPass.reviewerSession ||
        !Number.isFinite(current.verificationPass.reviewerSessionIssuedAt) ||
        !Number.isFinite(current.verificationPass.reviewerSessionExpiresAt)
      ) {
        throw new BqesAdmissionError(
          "BQES completion requires a durable independent reviewer pass",
        );
      }
      const reviewerIssuedAt = current.verificationPass.reviewerSessionIssuedAt;
      const reviewerExpiresAt = current.verificationPass.reviewerSessionExpiresAt;
      const now = this.now();
      if (
        reviewerIssuedAt === undefined ||
        reviewerExpiresAt === undefined ||
        reviewerIssuedAt > now ||
        reviewerExpiresAt <= now
      ) {
        throw new BqesAdmissionError("BQES completion reviewer session is stale or expired");
      }
      if (
        evidence.delivery.idempotencyKey !== current.idempotencyKey ||
        !evidence.delivery.acknowledged ||
        !Number.isFinite(evidence.delivery.acknowledgedAt) ||
        evidence.delivery.acknowledgedAt <= 0
      ) {
        throw new BqesAdmissionError("BQES delivery acknowledgement is missing or invalid");
      }
      if (
        evidence.ownership.activeOwnedDescendants !== 0 ||
        evidence.ownership.openDescriptors !== 0 ||
        evidence.ownership.pendingCleanup !== 0
      ) {
        throw new BqesAdmissionError("BQES ownership is not terminal");
      }
      if (
        evidence.ownership.state !== "reaped" &&
        evidence.ownership.state !== "externally_handed_off"
      ) {
        throw new BqesAdmissionError("BQES ownership state is invalid");
      }
      if (
        !Number.isFinite(evidence.ownership.pendingCleanup) ||
        evidence.ownership.pendingCleanup < 0
      ) {
        throw new BqesAdmissionError("BQES cleanup count is invalid");
      }
      if (
        evidence.provenance.sourceSha !== current.sourceIdentity ||
        evidence.provenance.artifactDigest !== current.artifactIdentity ||
        !evidence.provenance.buildIdentity
      ) {
        throw new BqesAdmissionError("BQES provenance evidence is invalid");
      }
      const result = this.db
        .prepare(
          "UPDATE bqes_admissions SET state = 'completed', evidence = ?, updated_at = ? WHERE idempotency_key = ? AND state = 'running'",
        )
        .run(json(evidence), this.now(), idempotencyKey);
      if (Number(result.changes) !== 1) {
        throw new BqesAdmissionError("BQES completion state changed concurrently");
      }
      this.addEvent(idempotencyKey, "completed", "verified terminal evidence");
      return this.get(idempotencyKey)!;
    });
  }

  fail(idempotencyKey: string, detail: string): BqesAdmission {
    requireNonEmpty(detail, "failure detail");
    return transaction(this.db, () => {
      const current = this.get(idempotencyKey);
      if (!current) {
        throw new BqesAdmissionError("BQES admission not found");
      }
      if (current.state === "failed") {
        return current;
      }
      if (current.state !== "running" && current.state !== "admitted") {
        throw new BqesAdmissionError(`cannot fail BQES ${current.state} admission`);
      }
      this.db
        .prepare(
          "UPDATE bqes_admissions SET state = 'failed', updated_at = ? WHERE idempotency_key = ?",
        )
        .run(this.now(), idempotencyKey);
      this.addEvent(idempotencyKey, "failed", detail);
      return this.get(idempotencyKey)!;
    });
  }

  private addEvent(idempotencyKey: string, state: string, detail: string): void {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM bqes_events WHERE idempotency_key = ?",
      )
      .get(idempotencyKey) as Row;
    this.db
      .prepare("INSERT INTO bqes_events VALUES (?, ?, ?, ?, ?)")
      .run(idempotencyKey, Number(row.next), state, detail, this.now());
  }
}
