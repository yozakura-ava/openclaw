// PATCH workboard-bounded-multi-claim (card a2deceee, issue #52/#96):
// Regression tests for the bounded, lane-aware, auto-releasing multi-claim
// contract. Targeted suite per SOP 12 (no full-extension test sweep).
//
// Coverage:
//   AC1 — agent can hold up to maxClaimsPerOwner concurrent claims in the
//         same lane without owner_busy (default 2).
//   Budget enforcement and conflict details are covered through the
//   production SQLite-backed path in sqlite-store-multiclaim.test.ts.
//   AC3 — lane-aware: a claim in a different lane does NOT count against
//         the lane budget ("reina:sprint-X" vs "rin:review-Y").
//   AC4 — moving a card to "done" auto-releases its claim (read-back).
//   AC5 — moving a card to "review" auto-releases its claim.
//   AC6 — moving a card to "blocked" auto-releases its claim.
//   AC7 — no two claims can coexist on the SAME card (the foreign-claim
//         guard, regression for PR #41 semantics preserved).
//   AC8 — deriveOwnerLane() splits at the first ":" correctly.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistedWorkboardCard, WorkboardKeyedStore } from "./persistence-types.js";
import { deriveOwnerLane } from "./store-constants.js";
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

async function makeReadyCard(store: WorkboardStore, title: string): Promise<string> {
  const card = await store.create({
    title,
    status: "ready",
    workspaceAccess: { unrestricted: true },
  });
  return card.id;
}

async function moveTo(
  store: WorkboardStore,
  id: string,
  status: "done" | "review" | "blocked" | "running",
) {
  // Direct metadata/status update via updateCard; we don't go through a
  // public move helper to keep this test focused on the auto-release path.
  const existing = await store.get(id);
  if (!existing) {
    throw new Error(`test fixture missing: ${id}`);
  }
  await TestStore.from(store).updateCard(id, { status }, { expectedUpdatedAt: existing.updatedAt });
}

class TestStore extends WorkboardStore {
  public updateCard(
    id: string,
    patch: Record<string, unknown>,
    options?: { expectedUpdatedAt?: number },
  ): Promise<unknown> {
    return super.updateCard(id, patch as never, options as never);
  }
  static from(store: WorkboardStore): TestStore {
    return store as unknown as TestStore;
  }
}

describe("WorkboardWorkflowStore bounded multi-claim (issue #52/#96)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-17T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("deriveOwnerLane splits at the first ':' and falls back to bare owner", () => {
    expect(deriveOwnerLane("reina:sprint-2026-09-17")).toBe("reina");
    expect(deriveOwnerLane("rin:review-abc")).toBe("rin");
    expect(deriveOwnerLane("tsubaki")).toBe("tsubaki");
    expect(deriveOwnerLane("")).toBe("");
    expect(deriveOwnerLane(undefined)).toBe("");
  });

  it("AC1 — same agent can claim two cards in the same lane (default budget=2)", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const a = await makeReadyCard(store, "card A");
    const b = await makeReadyCard(store, "card B");
    const claimed1 = await store.claim(a, { ownerId: "reina:sprint-foo" });
    const claimed2 = await store.claim(b, { ownerId: "reina:sprint-foo" });
    expect(claimed1.card.metadata?.claim?.ownerId).toBe("reina:sprint-foo");
    expect(claimed2.card.metadata?.claim?.ownerId).toBe("reina:sprint-foo");
  });

  it("AC3 — lane-aware: claims in different lanes do NOT collide", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const a = await makeReadyCard(store, "card A");
    const b = await makeReadyCard(store, "card B");
    // Two different agents in two different lanes — must both succeed.
    await store.claim(a, { ownerId: "reina:sprint-foo" });
    await store.claim(b, { ownerId: "rin:review-abc" });
    const cardA = await store.get(a);
    const cardB = await store.get(b);
    expect(cardA?.metadata?.claim?.ownerId).toBe("reina:sprint-foo");
    expect(cardB?.metadata?.claim?.ownerId).toBe("rin:review-abc");
  });

  it("AC4 — moving a card to done auto-releases its claim", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const a = await makeReadyCard(store, "card A");
    await store.claim(a, { ownerId: "reina:sprint-foo" });
    await moveTo(store, a, "done");
    const after = await store.get(a);
    expect(after?.status).toBe("done");
    expect(after?.metadata?.claim).toBeUndefined();
    const events = (after?.events ?? []).map((e) => e.kind);
    expect(events).toContain("claim_auto_released");
  });

  it("AC5 — moving a card to review auto-releases its claim", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const a = await makeReadyCard(store, "card A");
    await store.claim(a, { ownerId: "reina:sprint-foo" });
    await moveTo(store, a, "review");
    const after = await store.get(a);
    expect(after?.status).toBe("review");
    expect(after?.metadata?.claim).toBeUndefined();
  });

  it("AC6 — moving a card to blocked auto-releases its claim", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const a = await makeReadyCard(store, "card A");
    await store.claim(a, { ownerId: "reina:sprint-foo" });
    await moveTo(store, a, "blocked");
    const after = await store.get(a);
    expect(after?.status).toBe("blocked");
    expect(after?.metadata?.claim).toBeUndefined();
  });

  it("AC7 — no two claims can coexist on the SAME card (foreign-claim regression)", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const a = await makeReadyCard(store, "card A");
    await store.claim(a, { ownerId: "reina:sprint-foo" });
    await expect(store.claim(a, { ownerId: "rin:review-other" })).rejects.toThrow(
      /card already claimed by/,
    );
  });
});
