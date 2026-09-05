import { randomUUID } from "node:crypto";
// Durable BQES admission and completion authority for Workboard-controlled runs.
// This is intentionally independent from card JSON so a card cannot manufacture
// its own admission or terminal evidence.
import fs from "node:fs";
import path from "node:path";
import {
  assertCanonicalControl,
  deriveIdempotencyKey,
  deriveWorkflowId,
  requireNonEmpty,
  stableJson,
  type AdmissionGate,
} from "@openclaw/execution-contract";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import {
  bqesJson as json,
  bqesNumber as number,
  bqesText as text,
  initializeBqesSchema,
  normalizeInput,
  readAdmission,
  sameAdmission,
  transaction,
  type BqesRow,
} from "./bqes-persistence.js";
import type {
  BqesAdmission,
  BqesAdmissionInput,
  BqesCompletionEvidence,
  BqesDbosReceipt,
  BqesFreezeReceipt,
  BqesReviewer,
  BqesVerificationPass,
  ReceiptReconciliation,
} from "./bqes-types.js";

export type {
  BqesAdmission,
  BqesAdmissionInput,
  BqesCompletionEvidence,
  BqesDbosReceipt,
  BqesFreezeReceipt,
  BqesReviewer,
  BqesVerificationPass,
  ReceiptReconciliation,
} from "./bqes-types.js";

type Row = BqesRow;

class BqesAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BqesAdmissionError";
  }
}

export class BqesService implements AdmissionGate {
  readonly db: ReturnType<typeof openNodeSqliteDatabase>;
  private readonly now: () => number;

  constructor(options: { dbPath?: string; now?: () => number } = {}) {
    const dbPath =
      options.dbPath ?? path.join(resolveStateDir(), "plugins", "workboard", "bqes.sqlite");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = openNodeSqliteDatabase(dbPath);
    this.now = options.now ?? Date.now;
    initializeBqesSchema(this.db, this.now);
  }

  close(): void {
    this.db.close();
  }

  assertAdmissionOpen(): void {
    assertCanonicalControl("admission");
    const row = this.db
      .prepare("SELECT frozen, reason FROM bqes_admission_fence WHERE id = 1")
      // SAFETY: the singleton admission-fence query returns the schema's frozen/reason columns.
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
        // SAFETY: the singleton admission-fence query returns the schema's frozen column.
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
        // SAFETY: the singleton admission-fence query returns the schema's frozen/token columns.
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
      // SAFETY: the singleton admission-fence query returns the schema's frozen/reason/updated_at columns.
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
        // SAFETY: the admission query returns a row matching the BQES Row schema when present.
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
          // SAFETY: the insert above makes the idempotency-key row exist in this transaction.
          .get(input.idempotencyKey) as Row,
      );
    });
  }

  get(idempotencyKey: string): BqesAdmission | undefined {
    const row = this.db
      .prepare("SELECT * FROM bqes_admissions WHERE idempotency_key = ?")
      // SAFETY: the keyed admission query returns a BQES Row when present.
      .get(idempotencyKey) as Row | undefined;
    if (!row) {
      return undefined;
    }
    const admission = readAdmission(row);
    const pass = this.db
      .prepare("SELECT * FROM bqes_verification_passes WHERE idempotency_key = ?")
      // SAFETY: the keyed verification query returns a BQES Row when present.
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
        // SAFETY: the admission SELECT projects rows compatible with the BQES Row shape.
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
      // SAFETY: the aggregate event query always returns one row with the next sequence value.
      .get(idempotencyKey) as Row;
    this.db
      .prepare("INSERT INTO bqes_events VALUES (?, ?, ?, ?, ?)")
      .run(idempotencyKey, Number(row.next), state, detail, this.now());
  }
}
