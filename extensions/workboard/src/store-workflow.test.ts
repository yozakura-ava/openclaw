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
