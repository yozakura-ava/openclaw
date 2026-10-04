// Helper for tests/test_workboard_reaper.py — DO NOT RUN DIRECTLY.
// The Python pytest spawns this file via `node --import $(realpath scripts/tsx.mjs) <path>`.
//
// Exercises the real workboard plugin (extensions/workboard/src/reaper.ts +
// extensions/workboard/src/store-constants.ts + the actual sqlite harness)
// against the acceptance scenarios from card
// 7decbc47-2073-49df-945d-73f7f35ef9fa:
//
//   1. REVIEW_EXPIRED: review-status card with a real expired claim (>5 min
//      past expiry) → reaper clears claim; subsequent workboard_claim by a
//      different owner SUCCEEDS.
//   2. REVIEW_SENTINEL: review-status card with a dispatcher release-sentinel
//      claim (expiresAt=0) → reaper clears claim; subsequent workboard_claim
//      SUCCEEDS.
//   3. REVIEW_LIVE: review-status card with a live claim (expiresAt future)
//      → reaper does NOT touch it; claim still active.
//   4. RUNNING_EXPIRED: running-status card with an expired claim → reaper
//      does NOT touch it (the bounded dispatch pass at store.ts:479 owns
//      that path; the reaper's eligibleStatuses defaults to ["review"]).
//   5. NO_CLAIM: review-status card with no claim → reaper is a no-op.
//   6. PURE_SELECTOR: selectExpiredClaimsForReaping is a pure function:
//      re-running on the same input yields the same candidates and does
//      not mutate the inputs.
//
// Mirrors the harness pattern from tests/workboard_claim_sentinel_helper.mts:
// real sqlite-backed workboard, no mocks, no vitest coupling.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import {
  reapExpiredClaimsOnCards,
  selectExpiredClaimsForReaping,
} from "../extensions/workboard/src/reaper.js";
import { workboardSqliteBackendEntrypoint } from "../extensions/workboard/src/sqlite-backend-entrypoint.test-support.js";
import { createWorkboardSqliteStores } from "../extensions/workboard/src/sqlite-store.js";
import { isWorkboardClaimReclaimable } from "../extensions/workboard/src/store-constants.js";
import { WorkboardStore } from "../extensions/workboard/src/store.js";

type Harness = {
  store: WorkboardStore;
  cards: ReturnType<typeof createWorkboardSqliteStores>["cards"];
  close: () => Promise<void>;
};

function buildHarness(): Harness {
  const workerModuleUrl = resolveRuntimeWorkerUrl(workboardSqliteBackendEntrypoint);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-reaper-test-"));
  const dbPath = path.join(dir, "workboard.sqlite");
  const sqlite = createWorkboardSqliteStores({ dbPath, workerModuleUrl });
  const store = new WorkboardStore(sqlite.cards, sqlite);
  return {
    store,
    cards: sqlite.cards,
    close: async () => {
      try {
        await sqlite.close();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

type ScenarioResult = { ok: boolean; detail: string };

async function runReviewExpiredScenario(): Promise<ScenarioResult> {
  const harness = buildHarness();
  try {
    const { store, cards: cardsStore } = harness;
    const card = await store.create({
      title: "Review-expired scenario 7decbc47",
      agentId: "owner-A",
      workspaceAccess: { unrestricted: true },
    });

    const now = Date.now();
    const expiredClaim = {
      ownerId: "owner-A",
      token: "expired-token",
      claimedAt: now - 60 * 60 * 1000,
      lastHeartbeatAt: now - 60 * 60 * 1000,
      expiresAt: now - 60 * 60 * 1000, // 1 hour past expiry
    };
    await cardsStore.register(card.id, {
      version: 1,
      card: {
        ...card,
        status: "review",
        metadata: { ...card.metadata, claim: expiredClaim },
      },
    });

    if (!isWorkboardClaimReclaimable(expiredClaim, now)) {
      return { ok: false, detail: "precondition: claim should be reclaimable" };
    }

    const before = await store.get(card.id);
    if (!before) return { ok: false, detail: "card disappeared before reap" };

    const cards = await store.list({});
    const result = await reapExpiredClaimsOnCards(store, cards, now);
    if (result.candidates.length !== 1) {
      return {
        ok: false,
        detail: `expected 1 reaper candidate, got ${result.candidates.length}`,
      };
    }
    if (result.reaped.length !== 1) {
      return { ok: false, detail: `expected 1 reaped card, got ${result.reaped.length}` };
    }
    if (result.reaped[0]?.metadata?.claim !== undefined) {
      return {
        ok: false,
        detail: "reaped card still has claim; reap did not clear metadata.claim",
      };
    }
    if (result.reaped[0]?.status !== "review") {
      return {
        ok: false,
        detail: `reaper changed status; expected review, got ${result.reaped[0]?.status}`,
      };
    }

    // Fresh-claim recovery should now succeed (this is the bug being fixed).
    const recovered = await store.claim(card.id, { ownerId: "owner-B" });
    if (recovered.card.metadata?.claim?.ownerId !== "owner-B") {
      return {
        ok: false,
        detail: `fresh claim after reap failed; ownerId=${recovered.card.metadata?.claim?.ownerId}`,
      };
    }
    return { ok: true, detail: "review-expired reap + fresh-claim recovery succeeded" };
  } finally {
    await harness.close();
  }
}

async function runReviewSentinelScenario(): Promise<ScenarioResult> {
  const harness = buildHarness();
  try {
    const { store, cards: cardsStore } = harness;
    const card = await store.create({
      title: "Review-sentinel scenario 7decbc47",
      agentId: "owner-A",
      workspaceAccess: { unrestricted: true },
    });

    const now = Date.now();
    const sentinelClaim = {
      ownerId: "dispatcher-dispatched",
      token: "sentinel-token",
      claimedAt: now,
      dispatchedAt: now,
      lastHeartbeatAt: now,
      expiresAt: 0,
    };
    await cardsStore.register(card.id, {
      version: 1,
      card: {
        ...card,
        status: "review",
        metadata: { ...card.metadata, claim: sentinelClaim },
      },
    });

    const cards = await store.list({});
    const result = await reapExpiredClaimsOnCards(store, cards, now);
    if (result.candidates.length !== 1) {
      return {
        ok: false,
        detail: `expected 1 reaper candidate, got ${result.candidates.length}`,
      };
    }
    if (result.candidates[0]?.reason !== "sentinel_claim") {
      return {
        ok: false,
        detail: `sentinel scenario not classified as sentinel_claim (got ${result.candidates[0]?.reason})`,
      };
    }
    if (result.reaped.length !== 1) {
      return { ok: false, detail: `expected 1 reaped card, got ${result.reaped.length}` };
    }
    if (result.reaped[0]?.metadata?.claim !== undefined) {
      return { ok: false, detail: "reaped sentinel card still has claim" };
    }
    return { ok: true, detail: "review-sentinel reap cleared dispatcher release-sentinel" };
  } finally {
    await harness.close();
  }
}

async function runReviewLiveScenario(): Promise<ScenarioResult> {
  const harness = buildHarness();
  try {
    const { store, cards: cardsStore } = harness;
    const card = await store.create({
      title: "Review-live scenario 7decbc47",
      agentId: "owner-A",
      workspaceAccess: { unrestricted: true },
    });

    const now = Date.now();
    const liveClaim = {
      ownerId: "owner-A",
      token: "live-token",
      claimedAt: now,
      lastHeartbeatAt: now,
      expiresAt: now + 30 * 60 * 1000,
    };
    await cardsStore.register(card.id, {
      version: 1,
      card: {
        ...card,
        status: "review",
        metadata: { ...card.metadata, claim: liveClaim },
      },
    });

    if (isWorkboardClaimReclaimable(liveClaim, now)) {
      return { ok: false, detail: "precondition: live claim should NOT be reclaimable" };
    }

    const cards = await store.list({});
    const result = await reapExpiredClaimsOnCards(store, cards, now);
    if (result.candidates.length !== 0) {
      return {
        ok: false,
        detail: `live claim wrongly selected for reaping (${result.candidates.length})`,
      };
    }
    if (result.reaped.length !== 0) {
      return { ok: false, detail: "reaper cleared live claims" };
    }

    // Confirm the live claim still fences cross-owner claim (regression guard).
    let refused = false;
    let errorMessage = "";
    try {
      await store.claim(card.id, { ownerId: "owner-B" });
    } catch (err) {
      refused = true;
      errorMessage = err instanceof Error ? err.message : String(err);
    }
    if (!refused) {
      return { ok: false, detail: "cross-owner claim on live review-lease succeeded" };
    }
    if (!errorMessage.includes("owner-A")) {
      return {
        ok: false,
        detail: `live-lease refusal did not name owner-A: ${errorMessage}`,
      };
    }
    return { ok: true, detail: "review-live claim correctly left intact" };
  } finally {
    await harness.close();
  }
}

async function runRunningExpiredScenario(): Promise<ScenarioResult> {
  const harness = buildHarness();
  try {
    const { store, cards: cardsStore } = harness;
    const card = await store.create({
      title: "Running-expired scenario 7decbc47",
      agentId: "owner-A",
      workspaceAccess: { unrestricted: true },
    });

    const now = Date.now();
    const expiredClaim = {
      ownerId: "owner-A",
      token: "expired-token",
      claimedAt: now - 60 * 60 * 1000,
      lastHeartbeatAt: now - 60 * 60 * 1000,
      expiresAt: now - 60 * 60 * 1000,
    };
    await cardsStore.register(card.id, {
      version: 1,
      card: {
        ...card,
        status: "running",
        metadata: { ...card.metadata, claim: expiredClaim },
      },
    });

    const cards = await store.list({});
    const result = await reapExpiredClaimsOnCards(store, cards, now);
    if (result.candidates.length !== 0) {
      return {
        ok: false,
        detail: `reaper wrongly touched running card (${result.candidates.length} candidates)`,
      };
    }
    if (result.reaped.length !== 0) {
      return { ok: false, detail: "reaper cleared running claim (out of scope)" };
    }
    return { ok: true, detail: "running card left to bounded dispatch pass" };
  } finally {
    await harness.close();
  }
}

async function runNoClaimScenario(): Promise<ScenarioResult> {
  const harness = buildHarness();
  try {
    const { store, cards: cardsStore } = harness;
    const card = await store.create({
      title: "No-claim scenario 7decbc47",
      agentId: "owner-A",
      workspaceAccess: { unrestricted: true },
    });
    // Force the card into "review" status with no claim attached so the
    // reaper sees a claimless review-status card (its default scope).
    await cardsStore.register(card.id, {
      version: 1,
      card: {
        ...card,
        status: "review",
        metadata: { ...card.metadata, claim: undefined },
      },
    });
    const cards = await store.list({});
    const result = await reapExpiredClaimsOnCards(store, cards, Date.now());
    if (result.candidates.length !== 0) {
      return {
        ok: false,
        detail: `reaper selected claimless card (${result.candidates.length} candidates)`,
      };
    }
    if (result.reaped.length !== 0) {
      return { ok: false, detail: "reaper touched claimless card" };
    }
    return { ok: true, detail: "claimless review-status card left alone" };
  } finally {
    await harness.close();
  }
}

async function runPureSelectorScenario(): Promise<ScenarioResult> {
  // Build a snapshot of cards once, run the selector twice, and confirm
  // the output is identical and the input is unmodified.
  const harness = buildHarness();
  try {
    const { store, cards: cardsStore } = harness;
    const card = await store.create({
      title: "Pure-selector scenario 7decbc47",
      agentId: "owner-A",
      workspaceAccess: { unrestricted: true },
    });
    const now = Date.now();
    const expiredClaim = {
      ownerId: "owner-A",
      token: "expired-token",
      claimedAt: now - 60 * 60 * 1000,
      lastHeartbeatAt: now - 60 * 60 * 1000,
      expiresAt: now - 60 * 60 * 1000,
    };
    await cardsStore.register(card.id, {
      version: 1,
      card: {
        ...card,
        status: "review",
        metadata: { ...card.metadata, claim: expiredClaim },
      },
    });

    const cards = await store.list({});
    const cardsBefore = JSON.stringify(cards);

    const first = selectExpiredClaimsForReaping(cards, now);
    const second = selectExpiredClaimsForReaping(cards, now);

    if (JSON.stringify(cards) !== cardsBefore) {
      return { ok: false, detail: "selector mutated input array" };
    }
    if (first.length !== second.length) {
      return {
        ok: false,
        detail: `selector non-deterministic (${first.length} vs ${second.length})`,
      };
    }
    if (first[0]?.reason !== "expired_claim") {
      return {
        ok: false,
        detail: `expected reason=expired_claim, got ${first[0]?.reason}`,
      };
    }
    return { ok: true, detail: "selector is pure and deterministic" };
  } finally {
    await harness.close();
  }
}

async function safeRun(label: string, fn: () => Promise<ScenarioResult>): Promise<ScenarioResult> {
  try {
    return await fn();
  } catch (err) {
    return {
      ok: false,
      detail: `${label} threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    };
  }
}

async function main(): Promise<void> {
  const scenarios: Record<string, ScenarioResult> = {
    review_expired: await safeRun("review_expired", runReviewExpiredScenario),
    review_sentinel: await safeRun("review_sentinel", runReviewSentinelScenario),
    review_live: await safeRun("review_live", runReviewLiveScenario),
    running_expired: await safeRun("running_expired", runRunningExpiredScenario),
    no_claim: await safeRun("no_claim", runNoClaimScenario),
    pure_selector: await safeRun("pure_selector", runPureSelectorScenario),
  };
  const payload: Record<string, string> = {};
  let allOk = true;
  for (const [key, value] of Object.entries(scenarios)) {
    payload[key] = value.ok ? "ok" : value.detail;
    if (!value.ok) allOk = false;
  }
  process.stdout.write(JSON.stringify(payload) + "\n");
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`helper crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(2);
});
