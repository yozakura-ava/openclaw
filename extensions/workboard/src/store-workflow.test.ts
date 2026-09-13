// PATCH workboard-claim-guard-tests (issue #24, partial: closes remaining gap):
// Targeted regression tests for the claim-guard contract.
//
// Covers:
//   AC1 — archived-card rejection (regression; base: store-workflow.ts:97)
//   AC2 — foreign-claim rejection (regression; base: store-workflow.ts:152)
//   AC3 — same-owner self-recovery does NOT record a takeover event (regression;
//         base: PR #41 card eb0ce23a — must preserve semantics)
//   AC4 — done-card rejection (NEW: closes remaining gap from Ken triage)
//   AC5 — bounded takeover diagnostic ring buffer (NEW: FIFO cap = 64)
//
// PATCH workboard-sweeper-done-guard-tests (issue #81): regression for the
//   2026-09-03 durability reconciler misfire that bulk-moved ~150 done
//   cards back to review. The `shouldSyncWorkboardLifecycleStatus` helper
//   must return false for any transition out of "done" — the implicit
//   "done is not in the allowlist" rule must be a hard line.
//
// PATCH workboard-review-proof-guard-tests (issue #82): the move path must
//   reject "move to review" without proof/artifact/attachment attached.
//   Decline / re-route (no proof) must use blocked with a reason.
//
// Notes on time manipulation:
//   - The WorkboardWorkflowStore.claim path reads Date.now() inside an
//     enqueueMutation closure, so vi.useFakeTimers() is the only reliable
//     way to advance "now" without sleeping for real wall-clock seconds.
//   - We do NOT mutate card.metadata.claim directly (private persistence
//     detail); we use a fresh store + clock advance instead.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistedWorkboardCard, WorkboardKeyedStore } from "./persistence-types.js";
import {
  CLAIM_CONFLICT_HISTORY_CAP,
  clearClaimConflictHistory,
  shouldSyncWorkboardLifecycleStatus,
  snapshotClaimConflictHistory,
} from "./store-card-helpers.js";
import { WorkboardStore } from "./store.js";

function createMemoryStore(): WorkboardKeyedStore {
  const entries = new Map<string, PersistedWorkboardCard>();
  return {
    async register(key, value) {
      entries.set(key, value);
    },
    async lookup(key) {
      return entries.get(key);
    },
    async delete(key) {
      return entries.delete(key);
    },
    async entries() {
      return [...entries].map(([key, value]) => ({ key, value }));
    },
  };
}

describe("WorkboardWorkflowStore claim guard (issue #24)", () => {
  beforeEach(() => {
    clearClaimConflictHistory();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T20:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    clearClaimConflictHistory();
  });

  // AC1 — archived rejection (regression).
  it("rejects a claim on an archived card and records claim_on_archived", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Archived card",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
    await store.archive(card.id, true);

    await expect(store.claim(card.id, { ownerId: "owner-a" })).rejects.toThrow(/card is archived/i);

    const events = snapshotClaimConflictHistory();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "claim_on_archived",
      cardId: card.id,
      attemptedOwnerId: "owner-a",
    });
    expect(typeof events[0]?.at).toBe("number");
  });

  // AC2 — foreign-claim rejection records a takeover event with prior owner.
  it("rejects a foreign live claim and records a takeover event with prior owner", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Live foreign claim",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
    // First claim succeeds.
    await store.claim(card.id, { ownerId: "owner-a", ttlSeconds: 600 });
    expect(snapshotClaimConflictHistory()).toHaveLength(0);

    // Second claim by a DIFFERENT owner hits the live-foreign-claim fence.
    await expect(store.claim(card.id, { ownerId: "owner-b" })).rejects.toThrow(
      /claimed by owner-a/i,
    );

    const events = snapshotClaimConflictHistory();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "takeover",
      cardId: card.id,
      attemptedOwnerId: "owner-b",
      priorOwnerId: "owner-a",
    });
    expect(typeof events[0]?.priorExpiresAt).toBe("number");
    expect(events[0]!.priorExpiresAt!).toBeGreaterThan(Date.now());
  });

  // AC3 — same-owner self-recovery does NOT record a takeover event.
  //       PR #41 (card eb0ce23a) semantics must be preserved: once the
  //       original owner's claim is past expiresAt, the same owner may
  //       reclaim its own slot immediately. That is NOT a takeover.
  it("does not record a takeover event when the same owner reclaims its own expired slot", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Self-reclaim",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
    // Claim with a 1-second TTL so we can advance past expiresAt quickly.
    await store.claim(card.id, { ownerId: "owner-a", ttlSeconds: 1 });
    expect(snapshotClaimConflictHistory()).toHaveLength(0);

    // Advance past expiresAt + the 5-minute CLAIM_RECLAIM_MS grace so the
    // existingClaim is no longer "active" — PR #41 self-recovery path.
    vi.setSystemTime(new Date("2026-09-07T20:10:00Z"));

    // Same owner reclaims — should succeed WITHOUT recording a takeover.
    const reclaimed = await store.claim(card.id, { ownerId: "owner-a" });
    expect(reclaimed.card.metadata?.claim?.ownerId).toBe("owner-a");
    expect(snapshotClaimConflictHistory()).toHaveLength(0);
  });

  // AC4 — done-card rejection (NEW — closes the remaining gap).
  it("rejects a claim on a card with status === 'done' and records claim_on_done", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Completed card",
      status: "done",
      workspaceAccess: { unrestricted: true },
    });

    await expect(store.claim(card.id, { ownerId: "owner-a" })).rejects.toThrow(
      /card is completed/i,
    );

    const events = snapshotClaimConflictHistory();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "claim_on_done",
      cardId: card.id,
      attemptedOwnerId: "owner-a",
    });

    // Side-effect contract: no claim token must be attached to the card.
    const after = await store.get(card.id);
    expect(after?.metadata?.claim).toBeUndefined();
    expect(after?.status).toBe("done");
  });

  // AC5 — bounded ring buffer enforces the FIFO cap.
  it("caps the takeover history at CLAIM_CONFLICT_HISTORY_CAP entries (FIFO drop)", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Cap test card",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
    // Initial claim by owner-original with a LONG TTL so the original
    // claim stays LIVE throughout the test — every foreign claim attempt
    // hits the live-foreign-claim fence and is rejected.
    await store.claim(card.id, { ownerId: "owner-original", ttlSeconds: 3600 });
    expect(snapshotClaimConflictHistory()).toHaveLength(0);

    // Every subsequent claim by a different owner must fail and record.
    const totalAttempts = CLAIM_CONFLICT_HISTORY_CAP + 5;
    for (let i = 0; i < totalAttempts; i += 1) {
      await expect(store.claim(card.id, { ownerId: `foreign-owner-${i}` })).rejects.toThrow();
    }

    const events = snapshotClaimConflictHistory();
    expect(events.length).toBe(CLAIM_CONFLICT_HISTORY_CAP);
    // FIFO: the first events (foreign-owner-0 ... foreign-owner-4) were dropped.
    expect(events.find((e) => e.attemptedOwnerId === "foreign-owner-0")).toBeUndefined();
    expect(events.find((e) => e.attemptedOwnerId === "foreign-owner-4")).toBeUndefined();
    // The LAST attempts must still be present.
    expect(events.at(-1)?.attemptedOwnerId).toBe(`foreign-owner-${totalAttempts - 1}`);
    expect(events.at(-2)?.attemptedOwnerId).toBe(`foreign-owner-${totalAttempts - 2}`);
  });

  // claimConflicts getter returns a defensive (snapshot) copy.
  it("claimConflicts getter exposes a stable snapshot that does not mutate with later writes", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Snapshot test",
      status: "done",
      workspaceAccess: { unrestricted: true },
    });
    await expect(store.claim(card.id, { ownerId: "owner-a" })).rejects.toThrow();
    const first = store.claimConflicts;
    expect(first).toHaveLength(1);

    // Trigger another conflict — the first snapshot must not change.
    const card2 = await store.create({
      title: "Snapshot test 2",
      status: "done",
      workspaceAccess: { unrestricted: true },
    });
    await expect(store.claim(card2.id, { ownerId: "owner-a" })).rejects.toThrow();

    const second = store.claimConflicts;
    expect(second.length).toBe(2);
    expect(first.length).toBe(1); // defensive copy — original is unchanged
  });
});

// ---------------------------------------------------------------------------
// PATCH workboard-sweeper-done-guard-tests (issue #81)
//
// Regression for the 2026-09-03 durability reconciler misfire that
// bulk-moved ~150 done cards back to review. The lifecycle helper
// `shouldSyncWorkboardLifecycleStatus` must return false for every
// transition out of "done", regardless of target. The implicit
// "done is not in the allowlist" rule alone was silently removable
// if anyone widened the allowlist; the explicit early-return guard
// makes the invariant a hard line that future refactors cannot
// silently regress. These tests pin the contract on every plausible
// target so the regression class is locked down.
// ---------------------------------------------------------------------------
describe("shouldSyncWorkboardLifecycleStatus done-card guard (issue #81)", () => {
  // Minimal card factory — status and id only.
  function doneCard(): {
    id: string;
    status: "done";
    title: string;
    priority: string;
    position: number;
    createdAt: number;
    updatedAt: number;
    events: never[];
    labels: never[];
  } {
    return {
      id: "card-done-1",
      status: "done",
      title: "t",
      priority: "normal",
      position: 0,
      createdAt: 0,
      updatedAt: 0,
      events: [],
      labels: [],
    };
  }

  it("refuses done → review (the 2026-09-03 incident vector)", () => {
    expect(shouldSyncWorkboardLifecycleStatus(doneCard() as never, "review")).toBe(false);
  });

  it("refuses done → blocked", () => {
    expect(shouldSyncWorkboardLifecycleStatus(doneCard() as never, "blocked")).toBe(false);
  });

  it("refuses done → running", () => {
    expect(shouldSyncWorkboardLifecycleStatus(doneCard() as never, "running")).toBe(false);
  });

  it("refuses done → ready", () => {
    expect(shouldSyncWorkboardLifecycleStatus(doneCard() as never, "ready")).toBe(false);
  });

  it("refuses done → todo", () => {
    expect(shouldSyncWorkboardLifecycleStatus(doneCard() as never, "todo")).toBe(false);
  });

  it("returns false when target is undefined", () => {
    expect(shouldSyncWorkboardLifecycleStatus(doneCard() as never, undefined)).toBe(false);
  });

  it("returns false when target equals current status (done → done)", () => {
    expect(shouldSyncWorkboardLifecycleStatus(doneCard() as never, "done")).toBe(false);
  });

  // The original allowlist behavior must still hold for non-done cards so
  // the explicit guard does not regress the working transitions.
  it("still allows running → review (non-done happy path preserved)", () => {
    expect(
      shouldSyncWorkboardLifecycleStatus({ ...doneCard(), status: "running" } as never, "review"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PATCH workboard-review-proof-guard-tests (issue #82)
//
// Regression for "review parking misuse": cards that were declined or
// re-routed entered review without worker submission or proof, inflating
// the review queue with false SLA signals. The move-to-review path now
// requires proof, artifact, or attachment on the card. The guard fires
// for every caller (tool surface, slash command, programmatic) so the
// contract is enforced in one place — `WorkboardPromoteStore.move`.
// ---------------------------------------------------------------------------
describe("WorkboardPromoteStore.move proof guard (issue #82)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T17:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects move to review when the card has no proof, artifact, or attachment", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Decline / re-route card",
      status: "running",
      workspaceAccess: { unrestricted: true },
    });

    await expect(store.move(card.id, "review")).rejects.toThrow(
      /cannot move card to review without proof/i,
    );
    // Side-effect contract: the card must NOT have moved.
    const after = await store.get(card.id);
    expect(after?.status).toBe("running");
  });

  it("accepts move to review when the card carries proof", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Proof-attached card",
      status: "running",
      workspaceAccess: { unrestricted: true },
    });
    await store.addProof(card.id, {
      status: "passed",
      label: "issue-82 proof",
      command: "scripts/run_test_scope.sh extensions/workboard/src/store-workflow.test.ts",
    });

    const moved = await store.move(card.id, "review");
    expect(moved.status).toBe("review");
    expect(moved.metadata?.proof?.length).toBeGreaterThan(0);
  });

  it("accepts move to review when the card carries an artifact", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Artifact-attached card",
      status: "running",
      workspaceAccess: { unrestricted: true },
    });
    await store.addArtifact(card.id, {
      label: "issue-82 artifact",
      path: "/tmp/issue-82.txt",
    });

    const moved = await store.move(card.id, "review");
    expect(moved.status).toBe("review");
    expect(moved.metadata?.artifacts?.length).toBeGreaterThan(0);
  });

  it("accepts move to review when the card carries an attachment", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Attachment-attached card",
      status: "running",
      workspaceAccess: { unrestricted: true },
    });
    // Attach a 1-byte attachment — the guard only checks the count, not the
    // content, so we just need a real attachment row.
    await store.addAttachment(card.id, {
      fileName: "issue-82.txt",
      contentBase64: "YQ==", // 'a'
      mimeType: "text/plain",
    });

    const moved = await store.move(card.id, "review");
    expect(moved.status).toBe("review");
    expect(moved.metadata?.attachments?.length).toBeGreaterThan(0);
  });

  it("does not require proof for non-review transitions (regression guard does not over-block)", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Non-review move card",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });

    // No proof attached; moves to blocked, todo, and back to running all
    // pass without proof. The guard is review-specific by design.
    const blocked = await store.move(card.id, "blocked");
    expect(blocked.status).toBe("blocked");

    const todo = await store.move(card.id, "todo");
    expect(todo.status).toBe("todo");
  });
});
