import type { WorkboardCard, WorkboardClaim } from "@openclaw/workboard-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CLAIM_TTL_MS, isWorkboardClaimReclaimable } from "./store-constants.js";
import type { WorkboardStore } from "./store.js";
import { requireScopedCard } from "./tools-card-mutations.js";

// Card 1b65ce64 regression tests: cancelled-run claim fence.
// Fence integrity (pre-grace rejection) + cancel-safe reclaim (past-grace allow).

const CLAIM_RECLAIM_MS = 5 * 60 * 1000;

function makeClaim(ownerId: string, claimedAt: number): WorkboardClaim {
  return {
    ownerId,
    token: `tok-${ownerId}`,
    claimedAt,
    lastHeartbeatAt: claimedAt,
    expiresAt: claimedAt + DEFAULT_CLAIM_TTL_MS,
  };
}

function makeCard(claim: WorkboardClaim): WorkboardCard {
  return {
    id: "card-1",
    title: "stale claim test",
    status: "running",
    priority: "normal",
    position: 1000,
    createdAt: 0,
    updatedAt: 0,
    agentId: "builder",
    metadata: { claim },
  } as unknown as WorkboardCard;
}

function stubStore(card: WorkboardCard): WorkboardStore {
  return { get: async () => card } as unknown as WorkboardStore;
}

describe("cancelled-run claim fence (canMutateCard via requireScopedCard)", () => {
  const now = Date.now();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  it("holds the fence for a fresh claim from a different caller", async () => {
    const claim = makeClaim("cancelled-agent", now - 1000);
    await expect(
      requireScopedCard(stubStore(makeCard(claim)), "card-1", "new-caller"),
    ).rejects.toThrow(/claimed by cancelled-agent/);
  });

  it("holds the fence within the 5-min reclaim grace after expiry", async () => {
    const claim = makeClaim("cancelled-agent", now - (DEFAULT_CLAIM_TTL_MS + 60_000));
    expect(isWorkboardClaimReclaimable(claim, now)).toBe(false);
    await expect(
      requireScopedCard(stubStore(makeCard(claim)), "card-1", "new-caller"),
    ).rejects.toThrow(/claimed by cancelled-agent/);
  });

  it("allows a different caller once the reclaim grace has lapsed (cancel-safe)", async () => {
    const claim = makeClaim(
      "cancelled-agent",
      now - (DEFAULT_CLAIM_TTL_MS + CLAIM_RECLAIM_MS + 1000),
    );
    expect(isWorkboardClaimReclaimable(claim, now)).toBe(true);
    const card = await requireScopedCard(stubStore(makeCard(claim)), "card-1", "new-caller");
    expect(card.id).toBe("card-1");
  });

  it("still allows the original owner without a token (no regression)", async () => {
    const claim = makeClaim("original-owner", now - 1000);
    const card = await requireScopedCard(stubStore(makeCard(claim)), "card-1", "original-owner");
    expect(card.id).toBe("card-1");
  });
});
