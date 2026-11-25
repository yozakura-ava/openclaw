// Session-audit 2026-11-16 #3 follow-up (card 20a3a9b5): the owner-slot fence
// must name the holder card, session, and claim age, and a read-only view must
// list active claims per owner. Store-level pins; tool wiring in tools.test.ts.
import { describe, expect, it } from "vitest";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

const HOUR_MS = 60 * 60 * 1000;

describe("claim fence enrichment + claims listing (#115 follow-up)", () => {
  it("fence_error_names_holder_card_session_and_claim_age", async () => {
    const store = createWorkboardSqliteTestStore();
    const holder = await store.create({
      title: "Holder card",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
    await store.claim(holder.id, { ownerId: "owner-a" });
    const blocked = await store.create({
      title: "Blocked card",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
    await expect(store.claim(blocked.id, { ownerId: "owner-a" })).rejects.toThrow(
      /already has active Workboard work: card .+ "Holder card".+claim held for \d+s/,
    );
  });

  it("listClaims_reports_active_claim_with_owner_filter", async () => {
    const store = createWorkboardSqliteTestStore();
    const held = await store.create({
      title: "Held card",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
    await store.claim(held.id, { ownerId: "owner-a" });
    const free = await store.create({
      title: "Free card",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });

    const all = await store.listClaims();
    expect(all.map((c) => c.cardId)).toEqual([held.id]);
    expect(all[0]).toMatchObject({ ownerId: "owner-a", status: "running", title: "Held card" });
    expect(typeof all[0].claimedAt).toBe("number");
    expect(all[0].expiresAt).toBeGreaterThan(Date.now());

    await expect(store.listClaims("owner-a")).resolves.toHaveLength(1);
    await expect(store.listClaims("owner-nobody")).resolves.toEqual([]);
    // Unclaimed card holds no slot.
    await expect(store.get(free.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("listClaims_omits_released_and_expired_claims", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Temporary claim",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
    await store.claim(card.id, { ownerId: "owner-a", ttlSeconds: 1 });
    await store.releaseClaim(card.id, {
      ownerId: "owner-a",
      token: (await store.get(card.id)).metadata?.claim?.token,
    });
    await expect(store.listClaims("owner-a")).resolves.toEqual([]);
  });
});
