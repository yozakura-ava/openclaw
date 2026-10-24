// Expired-claim fence recovery tests (card ba1c45e3): a claim past its
// reclaim grace must not fence operator recovery verbs, and after an
// operator release the original assignee can re-claim.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";

const HOUR_MS = 60 * 60 * 1000;

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

function readPayload(result: unknown): Record<string, unknown> {
  return (result as { details?: Record<string, unknown> }).details ?? {};
}

describe("expired-claim fence recovery", () => {
  it("store layer: an expired foreign claim no longer blocks reclaim, comment, or move", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Frozen build",
      status: "running",
      agentId: "reina",
      metadata: { claim: expiredClaim("reina") },
    });

    // Operator reclaim (scoped to a different owner, no token) must succeed.
    const reclaimed = await store.reclaim(
      card.id,
      { reason: "operator release: expired claim (card ba1c45e3)", status: "ready" },
      { ownerId: "operator" },
    );
    expect(reclaimed.status).toBe("ready");
    expect(reclaimed.metadata?.claim).toBeUndefined();

    // Store-level comment likewise proceeds on expired claims.
    const commented = await store.addComment(
      card.id,
      { body: "fence cleared" },
      { ownerId: "operator" },
    );
    expect(commented.metadata?.comments?.at(-1)).toMatchObject({ body: "fence cleared" });
  });

  it("store layer: a LIVE foreign claim still blocks reclaim (negative control)", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Live build",
      status: "running",
      agentId: "reina",
      metadata: { claim: liveClaim("reina") },
    });
    await expect(
      store.reclaim(card.id, { reason: "too early" }, { ownerId: "operator" }),
    ).rejects.toThrow(/claimed by reina/);
  });

  it("tools layer: workboard_reclaim on an expired foreign claim releases the fence; assignee can re-claim", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Verdict writeback",
      status: "running",
      agentId: "reina",
      metadata: { claim: expiredClaim("reina") },
    });
    const operatorTools = new Map(
      createWorkboardTools({ store, context: { agentId: "operator" } }).map((tool) => [
        tool.name,
        tool,
      ]),
    );

    const result = readPayload(
      await expectDefined(operatorTools.get("workboard_reclaim"), "reclaim").execute("r1", {
        id: card.id,
        reason: "operator release: expired claim (card ba1c45e3)",
        status: "ready",
      }),
    );
    const released = result.card as { status: string; metadata?: { claim?: unknown } };
    expect(released.status).toBe("ready");
    expect(released.metadata?.claim).toBeUndefined();

    // Card accepts a comment after the fence clears.
    await expectDefined(operatorTools.get("workboard_comment"), "comment").execute("c1", {
      id: card.id,
      body: "fence cleared by operator (card ba1c45e3)",
    });

    // The original assignee can re-claim.
    const reclaimeeTools = new Map(
      createWorkboardTools({ store, context: { agentId: "reina" } }).map((tool) => [
        tool.name,
        tool,
      ]),
    );
    const reclamed = readPayload(
      await expectDefined(reclaimeeTools.get("workboard_claim"), "claim").execute("rc1", {
        id: card.id,
      }),
    );
    const reclamedCard = reclamed.card as {
      status: string;
      metadata?: { claim?: { ownerId?: string } };
    };
    expect(reclamedCard.status).toBe("running");
    expect(reclamedCard.metadata?.claim).toMatchObject({ ownerId: "reina" });
  });

  it("tools layer: a LIVE foreign claim still fences tool mutations (negative control)", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Live build",
      status: "running",
      agentId: "reina",
      metadata: { claim: liveClaim("reina") },
    });
    const operatorTools = new Map(
      createWorkboardTools({ store, context: { agentId: "operator" } }).map((tool) => [
        tool.name,
        tool,
      ]),
    );
    await expect(
      operatorTools.get("workboard_reclaim")?.execute("r2", {
        id: card.id,
        reason: "must refuse",
      }),
    ).rejects.toThrow(/claimed by reina/);
    await expect(
      operatorTools.get("workboard_move")?.execute("m1", { id: card.id, status: "review" }),
    ).rejects.toThrow(/claimed by reina/);
  });
});
