// PATCH workboard-bounded-multi-claim (card a2deceee, issue #52/#96):
// SQLite-backed regression tests for the bounded, lane-aware, auto-releasing
// multi-claim contract. These exercise the production SQLite code path
// (createWorkboardSqliteStores + WorkboardStore) so the runtime adapter
// chain (WorkboardCoreStore -> WorkboardStoreRuntime.trackCardStore ->
// SqliteStore) is end-to-end covered — not just the in-memory store.
//
// Targeted suite per SOP 12 (no full-extension test sweep). Pairs with
// store-workflow-multiclaim.test.ts (in-memory equivalent).
//
// Coverage:
//   S1 — claim budget enforcement: 3rd claim in same lane returns
//         owner_busy via the WorkboardStore API (WorkboardCoreStore ->
//         runtime adapter -> SqliteStore path), not the raw store path.
//   S2 — lane-aware slots: a claim in a different lane does NOT collide
//         with the budget (reina:* vs rin:*).
//   S3 — claim options object IS forwarded: a call with
//         maxClaimsPerOwner: 3 in the WorkboardStore.claim() options
//         succeeds for 3 claims in the same lane (proves the adapter
//         chain carries options end-to-end).
//   S4 — auto-release on terminal/review/blocked: claim a card, move
//         to "done" via updateCard, verify the claim is cleared and the
//         claim_auto_released event is recorded.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
import { WorkboardStore } from "./store.js";

function withStores<T>(
  run: (dbPath: string, stores: ReturnType<typeof createWorkboardSqliteStores>) => Promise<T>,
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-multiclaim-"));
  const dbPath = path.join(dir, "workboard.sqlite");
  const stores = createWorkboardSqliteStores({ dbPath });
  return run(dbPath, stores).finally(() => {
    stores.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

function fixtureReadyCard(index: number): WorkboardCard {
  const id = `card-${index}`;
  return {
    id,
    title: `Card ${index}`,
    status: "ready",
    priority: "normal",
    labels: [],
    position: index,
    createdAt: 1000 + index,
    updatedAt: 2000 + index,
    events: [{ id: `${id}-event`, kind: "created", at: 1000 + index }],
    metadata: {},
  };
}

type UpdateCardExposed = {
  updateCard: (
    id: string,
    patch: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<unknown>;
};
const updateCardExposed = (store: unknown): UpdateCardExposed =>
  store as WorkboardCoreStore & UpdateCardExposed;

describe("workboard sqlite bounded multi-claim (issue #52/#96)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-17T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("S1 — 3rd claim in same lane rejects with owner_busy via the SQLite-backed WorkboardStore", async () => {
    await withStores(async (_dbPath, stores) => {
      const store = new WorkboardStore(stores.cards, stores);
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const card = await store.create({
          title: `Card ${i}`,
          status: "ready",
          workspaceAccess: { unrestricted: true },
        });
        ids.push(card.id);
      }

      // Default budget = 2, so 2 claims in the same lane succeed, the 3rd rejects.
      const c1 = await store.claim(ids[0]!, { ownerId: "reina:sprint-foo" });
      const c2 = await store.claim(ids[1]!, { ownerId: "reina:sprint-foo" });
      expect(c1.card.metadata?.claim?.ownerId).toBe("reina:sprint-foo");
      expect(c2.card.metadata?.claim?.ownerId).toBe("reina:sprint-foo");

      await expect(store.claim(ids[2]!, { ownerId: "reina:sprint-foo" })).rejects.toThrow(
        /already has 2 active Workboard claim.*Conflicting.*Card 0.*Card 1/s,
      );
    });
  });

  it("S2 — lane-aware: claims in different lanes do NOT collide through the SQLite-backed store", async () => {
    await withStores(async (_dbPath, stores) => {
      const store = new WorkboardStore(stores.cards, stores);
      const a = await store.create({
        title: "Card A",
        status: "ready",
        workspaceAccess: { unrestricted: true },
      });
      const b = await store.create({
        title: "Card B",
        status: "ready",
        workspaceAccess: { unrestricted: true },
      });
      const ca = await store.claim(a.id, { ownerId: "reina:sprint-foo" });
      const cb = await store.claim(b.id, { ownerId: "rin:review-abc" });
      expect(ca.card.metadata?.claim?.ownerId).toBe("reina:sprint-foo");
      expect(cb.card.metadata?.claim?.ownerId).toBe("rin:review-abc");
    });
  });

  it("S3 — claim options object IS forwarded through the runtime adapter chain (maxClaimsPerOwner override)", async () => {
    await withStores(async (_dbPath, stores) => {
      const store = new WorkboardStore(stores.cards, stores);
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        const card = await store.create({
          title: `Card ${i}`,
          status: "ready",
          workspaceAccess: { unrestricted: true },
        });
        ids.push(card.id);
      }

      // Raise the per-call budget to 3 via WorkboardClaimOptions. If the
      // runtime adapter (WorkboardStoreRuntime.trackCardStore) drops the
      // options object, this call would fail with owner_busy at the 3rd
      // claim because the default budget (2) would still apply.
      await store.claim(ids[0]!, { ownerId: "reina:sprint-foo" }, { maxClaimsPerOwner: 3 });
      await store.claim(ids[1]!, { ownerId: "reina:sprint-foo" }, { maxClaimsPerOwner: 3 });
      const c3 = await store.claim(
        ids[2]!,
        { ownerId: "reina:sprint-foo" },
        { maxClaimsPerOwner: 3 },
      );
      expect(c3.card.metadata?.claim?.ownerId).toBe("reina:sprint-foo");

      // The 4th must still reject because the override caps at 3.
      await expect(
        store.claim(ids[3]!, { ownerId: "reina:sprint-foo" }, { maxClaimsPerOwner: 3 }),
      ).rejects.toThrow(/already has 3 active Workboard claim/s);
    });
  });

  it("S4 — moving a claimed card to done auto-releases the claim (SQLite-backed WorkboardStore)", async () => {
    await withStores(async (_dbPath, stores) => {
      const store = new WorkboardStore(stores.cards, stores);
      const card = await store.create({
        title: "Card A",
        status: "ready",
        workspaceAccess: { unrestricted: true },
      });
      await store.claim(card.id, { ownerId: "reina:sprint-foo" });
      const claimed = await store.get(card.id);
      expect(claimed?.metadata?.claim?.ownerId).toBe("reina:sprint-foo");

      // Move to "done" — must auto-release the claim and emit the event.
      await updateCardExposed(store).updateCard(
        card.id,
        { status: "done" },
        { expectedUpdatedAt: claimed!.updatedAt },
      );
      const after = await store.get(card.id);
      expect(after?.status).toBe("done");
      expect(after?.metadata?.claim).toBeUndefined();
      const events = (after?.events ?? []).map((e) => e.kind);
      expect(events).toContain("claim_auto_released");

      // And the slot is now free: a fresh claim succeeds again.
      const reclaimed = await store.claim(card.id, { ownerId: "reina:sprint-foo" });
      expect(reclaimed.card.metadata?.claim?.ownerId).toBe("reina:sprint-foo");
    });
  });

  it("S5 — direct sqlite-store path also enforces the budget (defense in depth)", async () => {
    // Bypasses WorkboardStore to prove the SqliteStore layer itself honors
    // the options object when called directly (the contract WorkboardCoreStore
    // relies on after the adapter chain).
    await withStores(async (_dbPath, stores) => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const card = fixtureReadyCard(i);
        await stores.cards.register(card.id, { version: 1, card });
        ids.push(card.id);
      }

      // Rework r3: thread the actually-claimed card payload forward between
      // direct claimIfOwnerAvailable calls. Without this, each call passes a
      // fresh fixture with no claim metadata, so the SqliteStore budget
      // counter never observes prior claims and the 3rd call returns
      // "updated" instead of "owner_busy".
      const latestByIndex = new Map<number, WorkboardCard>();
      const makeClaim = async (index: number, ownerId: string) => {
        const baseline = latestByIndex.get(index) ?? fixtureReadyCard(index);
        const card: WorkboardCard = {
          ...baseline,
          updatedAt: baseline.updatedAt + 1,
          metadata: {
            ...baseline.metadata,
            claim: {
              ownerId,
              token: `token-${index}`,
              claimedAt: 3000,
              lastHeartbeatAt: 3000,
              expiresAt: 6000,
            },
          },
        };
        const result = await stores.cards.claimIfOwnerAvailable(
          card.id,
          { version: 1, card },
          baseline.updatedAt,
          ownerId,
          3000,
        );
        if (result === "updated") {
          latestByIndex.set(index, card);
        }
        return result;
      };

      const r1 = await makeClaim(0, "reina:sprint-foo");
      const r2 = await makeClaim(1, "reina:sprint-foo");
      expect(r1).toBe("updated");
      expect(r2).toBe("updated");
      const r3 = await makeClaim(2, "reina:sprint-foo");
      expect(r3).toMatchObject({ kind: "owner_busy", lane: "reina" });
    });
  });
});
