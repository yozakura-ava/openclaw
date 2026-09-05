import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deriveIdempotencyKey } from "../../../packages/execution-contract/src/index.js";
import { BqesService } from "./bqes.js";

function makeService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bqes-"));
  return {
    service: new BqesService({ dbPath: path.join(dir, "bqes.sqlite"), now: () => 1000 }),
    dir,
  };
}

function input() {
  const identity = { cardId: "card-1", queue: "workboard", runId: "run-1" } as const;
  return {
    ...identity,
    attemptId: "attempt-1",
    idempotencyKey: deriveIdempotencyKey(identity),
    sourceIdentity: "git:source-sha",
    artifactIdentity: "artifact:sha",
    ownerEpoch: "epoch-1",
    allowedFiles: ["src/a.ts"],
    targetFiles: ["src/a.ts"],
    acceptanceCriteria: ["tests pass"],
    verificationCommand: "pnpm test extensions/workboard",
  };
}

describe("durable BQES admission", () => {
  it("rejects a package-manager flag that the repository test entrypoint cannot execute", () => {
    const { service } = makeService();
    expect(() =>
      service.admit({ ...input(), verificationCommand: "pnpm test --filter workboard" }),
    ).toThrow(/repository-relative test targets/);
    service.close();
  });

  it("freezes atomically and rejects new admissions until the matching token unfreezes", () => {
    const { service } = makeService();
    const freeze = service.freeze("cutover");
    expect(() => service.admit(input())).toThrow("admission is frozen");
    expect(() => service.unfreeze("wrong-token")).toThrow("freeze token");
    service.unfreeze(freeze.token);
    expect(service.admit(input()).state).toBe("admitted");
    service.close();
  });

  it("rejects identity mismatches and stale ownership", () => {
    const { service } = makeService();
    const admission = service.admit(input());
    expect(admission.workflowId).toMatch(/^dbos:/);
    expect(() => service.start(admission.idempotencyKey, "old-epoch")).toThrow("stale");
    service.attachDbosReceipt(admission.idempotencyKey, {
      workflowId: admission.workflowId,
      idempotencyKey: admission.idempotencyKey,
      cardId: admission.cardId,
      queue: admission.queue,
      runId: admission.runId,
      attemptId: admission.attemptId,
      ownerEpoch: admission.ownerEpoch,
      acknowledgedAt: 1000,
    });
    expect(service.admit(input()).state).toBe("admitted");
    service.start(admission.idempotencyKey, "epoch-1");
    expect(() => service.admit({ ...input(), sourceIdentity: "different" })).toThrow(
      "conflicting BQES idempotency identity",
    );
    service.close();
  });

  it("recovers the one active admission by card identity", () => {
    const { service } = makeService();
    const admission = service.admit(input());
    expect(service.findActiveByCardId("card-1", "workboard")).toMatchObject({
      idempotencyKey: admission.idempotencyKey,
      workflowId: admission.workflowId,
    });
    expect(service.findActiveByCardId("card-1", "other-queue")).toBeUndefined();
    service.close();
  });

  it("fails closed when a card has multiple active admissions", () => {
    const { service } = makeService();
    service.admit(input());
    const retryIdentity = { cardId: "card-1", queue: "workboard", runId: "run-2" } as const;
    service.admit({
      ...input(),
      ...retryIdentity,
      attemptId: "attempt-2",
      idempotencyKey: deriveIdempotencyKey(retryIdentity),
    });
    expect(() => service.findActiveByCardId("card-1", "workboard")).toThrow(
      "ambiguous active BQES admissions",
    );
    service.close();
  });

  it("requires drained ownership, successful verification, and acknowledged delivery", () => {
    const { service } = makeService();
    const admission = service.admit(input());
    service.attachDbosReceipt(admission.idempotencyKey, {
      workflowId: admission.workflowId,
      idempotencyKey: admission.idempotencyKey,
      cardId: admission.cardId,
      queue: admission.queue,
      runId: admission.runId,
      attemptId: admission.attemptId,
      ownerEpoch: admission.ownerEpoch,
      acknowledgedAt: 1000,
    });
    service.start(admission.idempotencyKey, "epoch-1");
    const base = {
      sourceIdentity: "git:source-sha",
      artifactIdentity: "artifact:sha",
      ownerEpoch: "epoch-1",
      verification: { command: "pnpm test extensions/workboard", exitCode: 0, outputHash: "out" },
      verificationProofHash: "proof-hash",
      delivery: {
        idempotencyKey: admission.idempotencyKey,
        acknowledged: true as const,
        acknowledgedAt: 1000,
      },
      ownership: {
        state: "reaped" as const,
        activeOwnedDescendants: 0,
        openDescriptors: 0,
        pendingCleanup: 0,
      },
      provenance: {
        sourceSha: "git:source-sha",
        artifactDigest: "artifact:sha",
        buildIdentity: "build",
      },
    };
    service.recordVerification(admission.idempotencyKey, "proof-hash", {
      principal: "reviewer",
      session: "reviewer-session",
      issuedAt: 900,
      expiresAt: 1900,
    });
    expect(() =>
      service.complete(admission.idempotencyKey, {
        ...base,
        ownership: { ...base.ownership, openDescriptors: 1 },
      }),
    ).toThrow("ownership");
    const completed = service.complete(admission.idempotencyKey, base);
    expect(completed.state).toBe("completed");
    expect(service.complete(admission.idempotencyKey, base).state).toBe("completed");
    const replay = service.recordVerification(admission.idempotencyKey, "proof-hash-replay", {
      principal: "fresh-reviewer",
      session: "fresh-reviewer-session",
      issuedAt: 1200,
      expiresAt: 2200,
    });
    expect(replay.proofHash).toBe("proof-hash-replay");
    expect(service.get(admission.idempotencyKey)?.verificationPass?.reviewerPrincipal).toBe(
      "fresh-reviewer",
    );
    expect(() =>
      service.complete(admission.idempotencyKey, {
        ...base,
        provenance: { ...base.provenance, buildIdentity: "other" },
      }),
    ).toThrow("conflicting");
    service.close();
  });

  it("rejects a reviewer pass that expires before final closure", () => {
    let now = 1000;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bqes-review-expiry-"));
    const service = new BqesService({ dbPath: path.join(dir, "bqes.sqlite"), now: () => now });
    const admission = service.admit(input());
    service.attachDbosReceipt(admission.idempotencyKey, {
      workflowId: admission.workflowId,
      idempotencyKey: admission.idempotencyKey,
      cardId: admission.cardId,
      queue: admission.queue,
      runId: admission.runId,
      attemptId: admission.attemptId,
      ownerEpoch: admission.ownerEpoch,
      acknowledgedAt: 1000,
    });
    service.start(admission.idempotencyKey, "epoch-1");
    service.recordVerification(admission.idempotencyKey, "proof-hash", {
      principal: "reviewer",
      session: "reviewer-session",
      issuedAt: 900,
      expiresAt: 1100,
    });
    now = 1100;
    const evidence = {
      sourceIdentity: "git:source-sha",
      artifactIdentity: "artifact:sha",
      ownerEpoch: "epoch-1",
      verification: { command: "pnpm test extensions/workboard", exitCode: 0, outputHash: "out" },
      verificationProofHash: "proof-hash",
      delivery: {
        idempotencyKey: admission.idempotencyKey,
        acknowledged: true as const,
        acknowledgedAt: 1000,
      },
      ownership: {
        state: "reaped" as const,
        activeOwnedDescendants: 0,
        openDescriptors: 0,
        pendingCleanup: 0,
      },
      provenance: {
        sourceSha: "git:source-sha",
        artifactDigest: "artifact:sha",
        buildIdentity: "build",
      },
    };
    expect(() => service.complete(admission.idempotencyKey, evidence)).toThrow("stale or expired");
    service.close();
  });

  it.each([
    ["success", "persisted"],
    ["duplicate", "duplicate"],
    ["replay", "replayed"],
  ] as const)("reconciles a %s receipt deterministically", (mode, expected) => {
    const { service } = makeService();
    const admission = service.admit(input());
    const receipt = {
      workflowId: admission.workflowId,
      idempotencyKey: admission.idempotencyKey,
      cardId: admission.cardId,
      queue: admission.queue,
      runId: admission.runId,
      attemptId: admission.attemptId,
      ownerEpoch: admission.ownerEpoch,
      acknowledgedAt: 1000,
    };
    const first = service.reconcileDbosReceipt(admission.idempotencyKey, receipt);
    expect(first.outcome).toBe("persisted");
    if (mode === "success") {
      service.close();
      return;
    }
    if (mode === "replay") {
      service.start(admission.idempotencyKey, "epoch-1");
      const evidence = {
        sourceIdentity: "git:source-sha",
        artifactIdentity: "artifact:sha",
        ownerEpoch: "epoch-1",
        verification: { command: "pnpm test extensions/workboard", exitCode: 0, outputHash: "out" },
        verificationProofHash: "proof-hash",
        delivery: {
          idempotencyKey: admission.idempotencyKey,
          acknowledged: true as const,
          acknowledgedAt: 1000,
        },
        ownership: {
          state: "reaped" as const,
          activeOwnedDescendants: 0,
          openDescriptors: 0,
          pendingCleanup: 0,
        },
        provenance: {
          sourceSha: "git:source-sha",
          artifactDigest: "artifact:sha",
          buildIdentity: "build",
        },
      };
      service.recordVerification(admission.idempotencyKey, "proof-hash", {
        principal: "reviewer",
        session: "reviewer-session",
        issuedAt: 900,
        expiresAt: 1900,
      });
      service.complete(admission.idempotencyKey, evidence);
    }
    expect(service.reconcileDbosReceipt(admission.idempotencyKey, receipt).outcome).toBe(expected);
    service.close();
  });

  it("rejects a receipt whose workflow identity does not match the admission", () => {
    const { service } = makeService();
    const admission = service.admit(input());
    expect(() =>
      service.reconcileDbosReceipt(admission.idempotencyKey, {
        workflowId: "dbos:wrong",
        idempotencyKey: admission.idempotencyKey,
        cardId: admission.cardId,
        queue: admission.queue,
        runId: admission.runId,
        attemptId: admission.attemptId,
        ownerEpoch: admission.ownerEpoch,
        acknowledgedAt: 1000,
      }),
    ).toThrow("identity mismatch");
    service.close();
  });
});
