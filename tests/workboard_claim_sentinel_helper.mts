// Helper for tests/test_workboard_claim_sentinel.py — DO NOT RUN DIRECTLY.
// The Python pytest spawns this file via `node --import $(realpath scripts/tsx.mjs) <path>`.
//
// Exercises the real workboard plugin (extensions/workboard/src/store.ts +
// extensions/workboard/src/store-constants.ts + the actual sqlite harness)
// against the two acceptance scenarios from card e03f22e5-48d0-4202-ad3c-74c22aa1c955:
//
//   1. SENTINEL: claim_json ownerId='dispatcher-dispatched', expiresAt=0 on a
//      running card; claim by a different owner SUCCEEDS (overwrites sentinel).
//   2. LIVE: claim_json ownerId='owner-A', expiresAt=now+30min on a running
//      card; claim by a different owner REFUSED with "card already claimed by
//      owner-A".
//
// The official extensions/workboard/src/test/sqlite-store.ts harness depends on
// vitest's afterEach global, so we re-implement a minimal harness here that
// uses the same primitives (createWorkboardSqliteStores + WorkboardStore) but
// without vitest coupling. This keeps the test independent of the vitest
// runner while still exercising the production code path end-to-end.
//
// Writes a single JSON object to stdout on success, non-zero on failure.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { workboardSqliteBackendEntrypoint } from "../extensions/workboard/src/sqlite-backend-entrypoint.test-support.js";
import { createWorkboardSqliteStores } from "../extensions/workboard/src/sqlite-store.js";
import {
  isWorkboardClaimReclaimable,
  workboardCardConsumesOwnerSlot,
} from "../extensions/workboard/src/store-constants.js";
import { WorkboardStore } from "../extensions/workboard/src/store.js";

type Harness = {
  store: WorkboardStore;
  cards: ReturnType<typeof createWorkboardSqliteStores>["cards"];
  close: () => Promise<void>;
};

function buildHarness(): Harness {
  const workerModuleUrl = resolveRuntimeWorkerUrl(workboardSqliteBackendEntrypoint);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-sentinel-test-"));
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

function nowMs(): number {
  return Date.now();
}

async function runSentinelScenario(): Promise<{ ok: boolean; detail: string }> {
  const harness = buildHarness();
  try {
    const { store, cards: cardsStore } = harness;

    const card = await store.create({
      title: "Sentinel scenario card e03f22e5",
      agentId: "riko",
      workspaceAccess: { unrestricted: true },
    });

    const now = nowMs();
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
        status: "running",
        metadata: { ...card.metadata, claim: sentinelClaim },
      },
    });

    if (!isWorkboardClaimReclaimable(sentinelClaim, now)) {
      return {
        ok: false,
        detail: "isWorkboardClaimReclaimable returned false for expiresAt=0; fix missing",
      };
    }
    const after = await store.get(card.id);
    if (!after) {
      return { ok: false, detail: "card disappeared after sentinel write" };
    }
    if (workboardCardConsumesOwnerSlot(after, now)) {
      return {
        ok: false,
        detail: "workboardCardConsumesOwnerSlot returned true for sentinel card; fix missing",
      };
    }

    const claimed = await store.claim(card.id, { ownerId: "riko" });
    if (claimed.card.metadata?.claim?.ownerId !== "riko") {
      return {
        ok: false,
        detail: `claim did not overwrite sentinel; ownerId=${claimed.card.metadata?.claim?.ownerId}`,
      };
    }
    if (!claimed.token) {
      return { ok: false, detail: "claim returned no token" };
    }
    return { ok: true, detail: "sentinel claim succeeded and was overwritten by riko" };
  } finally {
    await harness.close();
  }
}

async function runLiveScenario(): Promise<{ ok: boolean; detail: string }> {
  const harness = buildHarness();
  try {
    const { store, cards: cardsStore } = harness;

    const card = await store.create({
      title: "Live lease scenario card e03f22e5",
      agentId: "owner-A",
      workspaceAccess: { unrestricted: true },
    });

    const now = nowMs();
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
        status: "running",
        metadata: { ...card.metadata, claim: liveClaim },
      },
    });

    if (isWorkboardClaimReclaimable(liveClaim, now)) {
      return {
        ok: false,
        detail: "isWorkboardClaimReclaimable returned true for live lease; regression",
      };
    }
    const after = await store.get(card.id);
    if (!after) {
      return { ok: false, detail: "card disappeared after live-claim write" };
    }
    if (!workboardCardConsumesOwnerSlot(after, now)) {
      return {
        ok: false,
        detail: "workboardCardConsumesOwnerSlot returned false for live lease; regression",
      };
    }

    let refused = false;
    let errorMessage = "";
    try {
      await store.claim(card.id, { ownerId: "owner-B" });
    } catch (err) {
      refused = true;
      errorMessage = err instanceof Error ? err.message : String(err);
    }
    if (!refused) {
      return {
        ok: false,
        detail: "cross-owner claim on live lease succeeded; live fence weakened",
      };
    }
    if (!errorMessage.includes("owner-A")) {
      return {
        ok: false,
        detail: `cross-owner claim error did not name owner-A: ${errorMessage}`,
      };
    }
    return { ok: true, detail: `cross-owner claim refused: ${errorMessage}` };
  } finally {
    await harness.close();
  }
}

async function main(): Promise<void> {
  let sentinel: { ok: boolean; detail: string };
  let live: { ok: boolean; detail: string };
  try {
    sentinel = await runSentinelScenario();
  } catch (err) {
    sentinel = {
      ok: false,
      detail: `threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    };
  }
  try {
    live = await runLiveScenario();
  } catch (err) {
    live = {
      ok: false,
      detail: `threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    };
  }
  const payload = {
    sentinel: sentinel.ok ? "ok" : sentinel.detail,
    live: live.ok ? "ok" : live.detail,
  };
  process.stdout.write(JSON.stringify(payload) + "\n");
  process.exit(sentinel.ok && live.ok ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`helper crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(2);
});
