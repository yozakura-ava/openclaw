// PATCH done-card claim rejection + bounded takeover audit tests (#115 scope
// rebuild, prior art upstream issue #24 — CLOSED).
//
// Re-landed on v2026.11.1 internals per W1 patch-fate §4 order 4/5:
// upstream claim() rejects archived cards but has no done-card rejection and
// no takeover audit; this suite pins the ported semantics, including the
// upstream-native rejection shapes (WorkboardClaimRefusedError for fence
// hits, plain Error for the terminal-card guards).
import { afterEach, describe, expect, it } from "vitest";
import { clearClaimConflictHistory, snapshotClaimConflictHistory } from "./store-claim-conflict.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

const HOUR_MS = 60 * 60 * 1000;

function liveClaim(ownerId: string) {
  const now = Date.now();
  return {
    ownerId,
    token: "live-token",
    claimedAt: now,
    lastHeartbeatAt: now,
    expiresAt: now + HOUR_MS,
  };
}

function expiredClaim(ownerId: string) {
  const now = Date.now();
  return {
    ownerId,
    token: "stale-token",
    claimedAt: now - HOUR_MS,
    lastHeartbeatAt: now - HOUR_MS,
    // Past the 5-min CLAIM_RECLAIM_MS grace.
    expiresAt: now - 10 * 60 * 1000,
  };
}

describe("WorkboardWorkflowStore claim guard (#115 scope)", () => {
  afterEach(() => {
    clearClaimConflictHistory();
  });

  // Negative control: the history is written on the rejection path, not merely
  // declared — an empty history has zero rows before any rejected claim.
  it("claim_conflict_history_empty_before_any_rejection", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Quiet card",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
    await store.claim(card.id, { ownerId: "owner-a" });
    expect(snapshotClaimConflictHistory()).toHaveLength(0);
  });

  it("claim_on_done_card_throws_and_writes_no_claim_metadata", async () => {
    const store = createWorkboardSqliteTestStore();
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
    const after = await store.get(card.id);
    expect(after?.metadata?.claim).toBeUndefined();
    expect(after?.status).toBe("done");
  });

  it("done_card_carrying_a_live_claim_still_hits_the_done_guard_first", async () => {
    // The guard must reject BEFORE the claim fence evaluates:
    // a done card that already carries a live claim must produce
    // claim_on_done, not a claim-fence rejection.
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Done card with stale claim",
      status: "done",
      workspaceAccess: { unrestricted: true },
      metadata: { claim: liveClaim("owner-a") },
    });
    await expect(store.claim(card.id, { ownerId: "owner-b" })).rejects.toThrow(
      /card is completed/i,
    );
    const events = snapshotClaimConflictHistory();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("claim_on_done");
  });

  it("claim_on_archived_card_records_claim_on_archived_event", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Archived card",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
    await store.archive(card.id, true);
    await expect(store.claim(card.id, { ownerId: "owner-a" })).rejects.toThrow(/card is archived/i);
    const events = snapshotClaimConflictHistory();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "claim_on_archived", cardId: card.id });
  });

  it("takeover_conflict_history_appends_one_event_per_rejection", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Live foreign claim",
      status: "ready",
      workspaceAccess: { unrestricted: true },
      metadata: { claim: liveClaim("owner-a") },
    });
    expect(snapshotClaimConflictHistory()).toHaveLength(0);
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

  it("same_owner_expired_claim_reclaim_records_no_takeover", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Self-reclaim",
      status: "ready",
      workspaceAccess: { unrestricted: true },
      metadata: { claim: expiredClaim("owner-a") },
    });
    const reclaimed = await store.claim(card.id, { ownerId: "owner-a" });
    expect(reclaimed.card.metadata?.claim?.ownerId).toBe("owner-a");
    expect(snapshotClaimConflictHistory()).toHaveLength(0);
  });

  it("claim_conflicts_getter_exposes_stable_snapshot", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Snapshot test",
      status: "done",
      workspaceAccess: { unrestricted: true },
    });
    await expect(store.claim(card.id, { ownerId: "owner-a" })).rejects.toThrow();
    const first = store.claimConflicts;
    expect(first).toHaveLength(1);
    const card2 = await store.create({
      title: "Snapshot test 2",
      status: "done",
      workspaceAccess: { unrestricted: true },
    });
    await expect(store.claim(card2.id, { ownerId: "owner-a" })).rejects.toThrow();
    expect(store.claimConflicts.length).toBe(2);
    expect(first.length).toBe(1);
  });
});
