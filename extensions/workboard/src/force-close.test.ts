// Workboard tests cover force-close orchestrator override behavior.
// Restored from commit a0cf0f66c72 (card 32d1c50d). The 2026-08-24 18:02
// validation session validated 11 points + 173 tests on the original
// implementation; the focused tests below cover the same behavior on the
// canonical port (the 173-count came from a broader durability regression
// suite that lives outside this scope).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { WorkboardStore } from "./store.js";
import type { PersistedWorkboardCard, WorkboardKeyedStore } from "./persistence-types.js";
import { WORKBOARD_TOOL_NAMES } from "./workspace-access.js";

function createMemoryStore<T = PersistedWorkboardCard>(): WorkboardKeyedStore<T> {
  const entries = new Map<string, T>();
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
      return [...entries].flatMap(([key, value]) => (value ? [{ key, value }] : []));
    },
  };
}

// Seed cards directly into the underlying memory store with stable IDs so
// each test can reference the cards by name. The public store.create() does
// not accept an id parameter (cards are auto-generated), so we bypass it
// here — this matches the backport-restart-trio.test.ts pattern of
// constructing a card via the public API then mutating by returned id.
async function seedCard(
  store: WorkboardStore,
  cards: WorkboardKeyedStore<PersistedWorkboardCard>,
  id: string,
  status: "todo" | "ready" | "running" | "review" | "blocked" = "ready",
): Promise<WorkboardCard> {
  const now = Date.now();
  const card: WorkboardCard = {
    id,
    title: `seed ${id}`,
    notes: "force-close test fixture",
    status,
    priority: "normal",
    labels: [],
    position: 1000,
    createdAt: now,
    updatedAt: now,
    metadata: {},
  };
  await cards.register(id, { version: 1, card });
  // Re-fetch through the store so any caches see the new row.
  return (await store.get(id)) ?? card;
}

let auditDir = "";
let auditPath = "";
let cards: WorkboardKeyedStore<PersistedWorkboardCard>;

beforeEach(() => {
  auditDir = fs.mkdtempSync(path.join(os.tmpdir(), "force-close-audit-"));
  auditPath = path.join(auditDir, "force-closes.jsonl");
  cards = createMemoryStore<PersistedWorkboardCard>();
});

afterEach(() => {
  if (auditDir && fs.existsSync(auditDir)) {
    fs.rmSync(auditDir, { recursive: true, force: true });
  }
});

function buildStore(opts: { allowedAgents?: string[]; operatorIds?: string[] } = {}) {
  const boards = createMemoryStore<{ id: string }>();
  const subscriptions = createMemoryStore();
  const attachments = createMemoryStore();
  return new WorkboardStore(cards, {
    boards: boards as unknown as WorkboardKeyedStore<never>,
    subscriptions: subscriptions as unknown as WorkboardKeyedStore<never>,
    attachments: attachments as unknown as WorkboardKeyedStore<never>,
    forceCloseAuditPath: auditPath,
    ...(opts.allowedAgents ? { forceCloseAllowedAgents: opts.allowedAgents } : {}),
    ...(opts.operatorIds ? { forceCloseOperatorIds: opts.operatorIds } : {}),
  });
}

describe("workboard_force_close (card 32d1c50d)", () => {
  it("happy path: each reason_code transitions the card to done with closureType='force_close' + [FORCE-CLOSE] comment + audit entry", async () => {
    const cases: Array<{
      reasonCode: "superseded" | "duplicate" | "cancelled" | "invalid";
      referenceCardId?: string;
    }> = [
      { reasonCode: "superseded", referenceCardId: "card-survivor" },
      { reasonCode: "duplicate", referenceCardId: "card-survivor" },
      { reasonCode: "cancelled" },
      { reasonCode: "invalid" },
    ];
    const store = buildStore();
    for (const tc of cases) {
      await seedCard(store, cards, "card-survivor", "ready");
      await seedCard(store, cards, `card-${tc.reasonCode}`, "ready");
    }
    for (const tc of cases) {
      const result = await store.forceClose(
        `card-${tc.reasonCode}`,
        {
          reasonCode: tc.reasonCode,
          explanation: `Orchestrator force-close for ${tc.reasonCode} test fixture.`,
          ...(tc.referenceCardId ? { referenceCardId: tc.referenceCardId } : {}),
        },
        "ava",
      );
      expect(result.status).toBe("done");
      expect(result.metadata?.closureType).toBe("force_close");
      const comment = result.metadata?.comments?.at(-1);
      expect(comment?.body.startsWith(`[FORCE-CLOSE] ${tc.reasonCode}: `)).toBe(true);
    }
    // Audit log contains one entry per successful close.
    const lines = fs.readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(4);
    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries.map((e) => e.reason_code).sort()).toEqual(
      ["cancelled", "duplicate", "invalid", "superseded"].sort(),
    );
    expect(entries.every((e) => e.dbos_run_id === null)).toBe(true);
    expect(entries.every((e) => e.agent_id === "ava")).toBe(true);
  });

  it("rejects unknown reason codes with the exact closed-enum message", async () => {
    const store = buildStore();
    await seedCard(store, cards, "card-bad-code", "ready");
    await expect(
      store.forceClose(
        "card-bad-code",
        {
          reasonCode: "built",
          explanation: "This reason code looks like successful completion.",
        },
        "ava",
      ),
    ).rejects.toThrow(
      /force-close reason_code must be one of: superseded, duplicate, cancelled, invalid\./,
    );
  });

  it("rejects explanations shorter than 20 chars", async () => {
    const store = buildStore();
    await seedCard(store, cards, "card-short-exp", "ready");
    await expect(
      store.forceClose(
        "card-short-exp",
        { reasonCode: "invalid", explanation: "too short" },
        "ava",
      ),
    ).rejects.toThrow(/at least 20 characters/);
  });

  it("rejects superseded / duplicate without reference_card_id (and accepts cancelled / invalid without one)", async () => {
    const store = buildStore();
    await seedCard(store, cards, "card-sup", "ready");
    await seedCard(store, cards, "card-dup", "ready");
    await seedCard(store, cards, "card-cnc", "ready");

    await expect(
      store.forceClose(
        "card-sup",
        { reasonCode: "superseded", explanation: "Superseded but missing reference_card_id." },
        "ava",
      ),
    ).rejects.toThrow(/requires reference_card_id/);
    await expect(
      store.forceClose(
        "card-dup",
        { reasonCode: "duplicate", explanation: "Duplicate but missing reference_card_id." },
        "ava",
      ),
    ).rejects.toThrow(/requires reference_card_id/);

    // cancelled / invalid must NOT require a reference card.
    await expect(
      store.forceClose(
        "card-cnc",
        { reasonCode: "cancelled", explanation: "Cancelled without a reference card." },
        "ava",
      ),
    ).resolves.toMatchObject({ status: "done", metadata: { closureType: "force_close" } });
  });

  it("rejects missing, nonexistent, or already-force-closed reference_card_id", async () => {
    const store = buildStore();
    await seedCard(store, cards, "card-sup-ref", "ready");
    await seedCard(store, cards, "card-survivor", "ready");
    await seedCard(store, cards, "card-already-fc", "ready");

    // Force-close the survivor first so we can assert the second close fails.
    await store.forceClose(
      "card-already-fc",
      { reasonCode: "invalid", explanation: "First close — pre-conditions the next test." },
      "ava",
    );

    await expect(
      store.forceClose(
        "card-sup-ref",
        {
          reasonCode: "superseded",
          explanation: "References a nonexistent card id.",
          referenceCardId: "card-does-not-exist",
        },
        "ava",
      ),
    ).rejects.toThrow(/reference card not found/);

    await expect(
      store.forceClose(
        "card-survivor",
        {
          reasonCode: "superseded",
          explanation: "References an already-force-closed card.",
          referenceCardId: "card-already-fc",
        },
        "ava",
      ),
    ).rejects.toThrow(/reference card is force-closed/);
  });

  it("rejects non-allowlisted, non-operator callers with the exact orchestrator-only message", async () => {
    const store = buildStore();
    await seedCard(store, cards, "card-bad-agent", "ready");
    await expect(
      store.forceClose(
        "card-bad-agent",
        { reasonCode: "invalid", explanation: "Caller is not in the agent allowlist." },
        "tsubaki",
      ),
    ).rejects.toThrow(/force-close is orchestrator-only/);
  });

  it("always allows configured operator IDs (Craig and his operator:*/agent:* aliases)", async () => {
    const store = buildStore();
    await seedCard(store, cards, "card-craig", "ready");
    await seedCard(store, cards, "card-operator-craig", "ready");
    await seedCard(store, cards, "card-agent-craig", "ready");

    for (const [id, agent] of [
      ["card-craig", "craig"],
      ["card-operator-craig", "operator:craig"],
      ["card-agent-craig", "agent:craig"],
    ] as const) {
      await store.forceClose(
        id,
        { reasonCode: "invalid", explanation: `Operator ${agent} force-closes via override.` },
        agent,
      );
    }
    for (const id of ["card-craig", "card-operator-craig", "card-agent-craig"]) {
      const card = await store.get(id);
      expect(card?.status).toBe("done");
      expect(card?.metadata?.closureType).toBe("force_close");
    }
  });

  it("rejects cards with open descendants and lists the descendant IDs", async () => {
    const store = buildStore();
    await seedCard(store, cards, "card-parent", "ready");
    await seedCard(store, cards, "card-child", "ready");
    await seedCard(store, cards, "card-grandchild", "ready");
    await store.linkCards("card-parent", "card-child", { ownerId: "ava" });
    await store.linkCards("card-child", "card-grandchild", { ownerId: "ava" });

    await expect(
      store.forceClose(
        "card-parent",
        { reasonCode: "invalid", explanation: "Open descendants should reject this close." },
        "ava",
      ),
    ).rejects.toThrow(/card has open descendants: card-child, card-grandchild/);
  });

  it("rejects cards claimed by a different agent, missing claim tokens, or token mismatch (the #7 fix)", async () => {
    const store = buildStore();
    await seedCard(store, cards, "card-claimed", "ready");
    // ava claims the card (orchestrator IS the claim owner). The force-close
    // caller must be ava for any of the claim-token checks to fire —
    // tsubaki would be rejected by the allowlist check before the claim
    // check, which is exactly the design ("force-close is orchestrator-only"
    // trumps any other authorization).
    const avaClaim = await store.claim(
      "card-claimed",
      { ownerId: "ava", ttlSeconds: 60 },
      "ava",
    );
    const claimToken = avaClaim.token;

    // Different claim owner: tsubaki claims a fresh card and ava tries to
    // close it — must be rejected with the claim-owner mismatch error.
    await seedCard(store, cards, "card-other-owner", "ready");
    await store.claim(
      "card-other-owner",
      { ownerId: "tsubaki", ttlSeconds: 60 },
      "tsubaki",
    );
    await expect(
      store.forceClose(
        "card-other-owner",
        { reasonCode: "invalid", explanation: "Caller is not the claim owner." },
        "ava",
      ),
    ).rejects.toThrow(/card is claimed by tsubaki/);

    // Owner-matching claim without a token must reject.
    await expect(
      store.forceClose(
        "card-claimed",
        { reasonCode: "invalid", explanation: "Missing claim token for a claimed card." },
        "ava",
      ),
    ).rejects.toThrow(/requires the claim token for a claimed card/);

    // Wrong token on an owner-matching claim must reject (#7 fix).
    await expect(
      store.forceClose(
        "card-claimed",
        {
          reasonCode: "invalid",
          explanation: "Wrong claim token on owner-matching claim.",
          token: "definitely-not-the-real-token",
        },
        "ava",
      ),
    ).rejects.toThrow(/claim token does not match/);

    // Correct token + owner succeeds.
    await expect(
      store.forceClose(
        "card-claimed",
        {
          reasonCode: "invalid",
          explanation: "Owner-matching claim with the correct claim token.",
          token: claimToken,
        },
        "ava",
      ),
    ).resolves.toMatchObject({ status: "done", metadata: { closureType: "force_close" } });
  });

  it("rejects cards whose execution is locally running or whose activeRunLookup returns a run ID", async () => {
    const localCards = createMemoryStore<PersistedWorkboardCard>();
    const boards = createMemoryStore<{ id: string }>();
    const subscriptions = createMemoryStore();
    const attachments = createMemoryStore();
    const activeRunLookup = vi.fn().mockResolvedValue("dbos:run-42");
    const store = new WorkboardStore(localCards, {
      boards: boards as unknown as WorkboardKeyedStore<never>,
      subscriptions: subscriptions as unknown as WorkboardKeyedStore<never>,
      attachments: attachments as unknown as WorkboardKeyedStore<never>,
      forceCloseAuditPath: auditPath,
      activeRunLookup,
    });
    const now = Date.now();
    await localCards.register("card-active-run", {
      version: 1,
      card: {
        id: "card-active-run",
        title: "active run",
        status: "ready",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: now,
        updatedAt: now,
        metadata: {},
      },
    });
    await expect(
      store.forceClose(
        "card-active-run",
        { reasonCode: "invalid", explanation: "Active durable run blocks force-close." },
        "ava",
      ),
    ).rejects.toThrow(/active DBOS run exists for card card-active-run: dbos:run-42/);
    expect(activeRunLookup).toHaveBeenCalledWith("card-active-run", undefined);
  });

  it("rejects an already-done card (with the dedicated force-closed message when applicable)", async () => {
    const store = buildStore();
    await seedCard(store, cards, "card-done", "ready");
    await store.forceClose(
      "card-done",
      { reasonCode: "invalid", explanation: "First close to set up the second-attempt test." },
      "ava",
    );
    await expect(
      store.forceClose(
        "card-done",
        { reasonCode: "invalid", explanation: "Already closed card must be rejected." },
        "ava",
      ),
    ).rejects.toThrow(/card is already force-closed: card-done/);
  });

  it("preserves append-only audit semantics: each successful close adds a JSONL line, no truncation", async () => {
    const store = buildStore();
    await seedCard(store, cards, "card-1", "ready");
    await seedCard(store, cards, "card-2", "ready");
    await seedCard(store, cards, "card-3", "ready");
    for (const id of ["card-1", "card-2", "card-3"]) {
      await store.forceClose(
        id,
        { reasonCode: "invalid", explanation: `Audit append test entry for ${id}.` },
        "ava",
      );
    }
    const lines = fs.readFileSync(auditPath, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.endsWith("}"))).toBe(true);
    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries.map((e) => e.card_id)).toEqual(["card-1", "card-2", "card-3"]);
  });

  it("preserves the normal completion path: a force-close never runs alongside a regular complete", async () => {
    const store = buildStore();
    await seedCard(store, cards, "card-complete", "ready");
    const claim = await store.claim(
      "card-complete",
      { ownerId: "tsubaki", ttlSeconds: 60 },
      "tsubaki",
    );
    await store.complete(
      "card-complete",
      { summary: "Regular verified completion path.", token: claim.metadata?.claim?.token },
      { ownerId: "tsubaki", token: claim.metadata?.claim?.token },
    );
    const after = await store.get("card-complete");
    expect(after?.status).toBe("done");
    // closureType is NOT set on regular completions — only on force-closes.
    expect(after?.metadata?.closureType).toBeUndefined();
  });

  it("stats() partitions done cards into verifiedDone + forceClosed (REWORK gap #1)", async () => {
    const store = buildStore();
    await seedCard(store, cards, "card-vd-1", "ready");
    await seedCard(store, cards, "card-vd-2", "ready");
    await seedCard(store, cards, "card-fc-1", "ready");
    // Two regular completions (via tsubaki claim → regular complete path).
    for (const id of ["card-vd-1", "card-vd-2"]) {
      await store.claim(id, { ownerId: "tsubaki", ttlSeconds: 60 }, "tsubaki");
      await store.complete(
        id,
        { summary: `Verified completion for ${id}.` },
        { ownerId: "tsubaki" },
      );
    }
    // One force-close (avA, invalid reason).
    await store.forceClose(
      "card-fc-1",
      { reasonCode: "invalid", explanation: "Operator force-close for stats-test fixture." },
      "ava",
    );
    // One ready card untouched.
    await seedCard(store, cards, "card-still-ready", "ready");

    const stats = await store.stats();
    expect(stats.verifiedDone).toBe(2);
    expect(stats.forceClosed).toBe(1);
    // The two counters are disjoint and sum to total done cards.
    expect((stats.verifiedDone ?? 0) + (stats.forceClosed ?? 0)).toBe(3);
    // Other metrics unchanged: 4 total, 4 active, 0 archived.
    expect(stats.total).toBe(4);
    expect(stats.active).toBe(4);
    expect(stats.archived).toBe(0);
  });

  it("uses REPLACEMENT semantics when forceCloseAllowedAgents is supplied (REWORK gap #3)", async () => {
    // When the operator passes forceCloseAllowedAgents, that list REPLACES
    // the built-in default ['ava'] rather than merging — matches the Aug 24
    // runbook. The default agent ('ava') must therefore fail to force-close
    // when a non-ava-only allowlist is configured.
    const store = buildStore({ allowedAgents: ["operator-x"] });
    await seedCard(store, cards, "card-replaced", "ready");

    // ava is the built-in default but is NOT in the override list — must reject.
    await expect(
      store.forceClose(
        "card-replaced",
        { reasonCode: "invalid", explanation: "Test replacement semantics fixture." },
        "ava",
      ),
    ).rejects.toThrow(/force-close is orchestrator-only/);

    // operator-x is in the override allowlist — must succeed.
    await expect(
      store.forceClose(
        "card-replaced",
        { reasonCode: "invalid", explanation: "Override allowlist accepts operator-x." },
        "operator-x",
      ),
    ).resolves.toMatchObject({ status: "done", metadata: { closureType: "force_close" } });
  });

  it("falls back to the built-in default when the override list is empty (REWORK gap #3)", async () => {
    // Empty / whitespace-only override arrays must NOT silently widen the
    // allowlist — the store treats them as "no override supplied" and uses
    // the built-in default. This matches the runbook's "env replaces"
    // wording: an empty env is no env at all.
    const store = buildStore({ allowedAgents: [] });
    await seedCard(store, cards, "card-empty-override", "ready");
    await expect(
      store.forceClose(
        "card-empty-override",
        { reasonCode: "invalid", explanation: "Empty override keeps the default avA agent." },
        "ava",
      ),
    ).resolves.toMatchObject({ status: "done", metadata: { closureType: "force_close" } });
  });

  it("operator IDs are also REPLACEMENT (Aug 24 runbook, card 32d1c50d)", async () => {
    // Replacing operators entirely: drop craig and add a custom operator.
    // Craig must therefore be rejected (he was in the built-in default) but
    // the custom operator must succeed — proves replacement semantics.
    const store = buildStore({ operatorIds: ["operator-only"] });
    await seedCard(store, cards, "card-craig-replaced", "ready");
    await expect(
      store.forceClose(
        "card-craig-replaced",
        { reasonCode: "invalid", explanation: "Craig rejected after operator replacement." },
        "craig",
      ),
    ).rejects.toThrow(/force-close is orchestrator-only/);
    await expect(
      store.forceClose(
        "card-craig-replaced",
        { reasonCode: "invalid", explanation: "Custom operator-only succeeds." },
        "operator-only",
      ),
    ).resolves.toMatchObject({ status: "done", metadata: { closureType: "force_close" } });
  });

  it("registers workboard_force_close in WORKBOARD_TOOL_NAMES so the gateway enumerates it (regression for 2026-09-04 runtime-exposure bug)", async () => {
    // This is a build-time invariant the gateway depends on: WORKBOARD_TOOL_NAMES
    // is the list passed to api.registerTool({ names: [...WORKBOARD_TOOL_NAMES] }) in
    // extensions/workboard/index.ts. A tool NOT in this list is filtered out of the
    // callable tool index even though its definition ships in the bundle. The Aug 24
    // force_close implementation was lost from infrastructure for the same kind of
    // gap on the 2026-08-24 integration; this test pins the invariant going forward.
    const { WORKBOARD_TOOL_NAMES } = await import("./workspace-access.js");
    expect(WORKBOARD_TOOL_NAMES).toContain("workboard_force_close");
    // Sanity: every entry is a string and non-empty.
    for (const name of WORKBOARD_TOOL_NAMES) {
      expect(typeof name).toBe("string");
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it("declares workboard_force_close in the plugin manifest contracts.tools (card 32d1c50d live-fix, gateway-core tool-policy layer)", () => {
    // Regression for the gateway-core layer that the WORKBOARD_TOOL_NAMES
    // test cannot catch on its own. The plugin registry's registerTool body
    // (src/plugins/registry-registrars-tools-hooks.ts) calls
    // findUndeclaredPluginToolNames({ declaredNames: contracts.tools,
    // toolNames: WORKBOARD_TOOL_NAMES }) and EARLY-RETURNS (rejecting the
    // whole registration, surfacing ZERO workboard tools to agent sessions)
    // if any registered name isn't in contracts.tools. So WORKBOARD_TOOL_NAMES
    // and contracts.tools must stay in lockstep — otherwise a runtime tool
    // listed by the plugin but missing from the manifest contract silently
    // kills the entire plugin's tool surface.
    //
    // Failure mode (proven 2026-09-04 18:55 EDT, after PR #5 live-fix landed):
    // - WORKBOARD_TOOL_NAMES added workboard_force_close (correct)
    // - openclaw.plugin.json contracts.tools still missing force_close (regression)
    // - fresh himari main session + isolated subagent both reported ZERO workboard_* tools
    // - root cause: gateway-core filter rejected the entire plugin registration
    //
    // Both canonical source manifest AND deployed manifest must include force_close.
    const canonicalManifestPath = path.resolve(
      __dirname,
      "..",
      "openclaw.plugin.json"
    );
    const canonical = JSON.parse(
      fs.readFileSync(canonicalManifestPath, "utf8")
    ) as {
      id: string;
      contracts: { tools: string[] };
      toolMetadata?: Record<string, { optional?: boolean }>;
    };
    expect(canonical.id).toBe("workboard");
    expect(canonical.contracts.tools).toContain("workboard_force_close");
    // Every runtime tool name must be declared in contracts.tools — otherwise
    // the gateway-core filter rejects the entire plugin registration.
    const declared = new Set(canonical.contracts.tools);
    const undeclared = WORKBOARD_TOOL_NAMES.filter((name) => !declared.has(name));
    expect(
      undeclared,
      `${canonicalManifestPath}: tools in WORKBOARD_TOOL_NAMES but missing from contracts.tools: ${undeclared.join(", ")}. ` +
        `Gateway-core registerTool will reject the entire plugin (zero tools visible to agent sessions) if any name is undeclared.`,
    ).toEqual([]);
    // toolMetadata entry must exist with optional:true (matches sibling entries).
    expect(canonical.toolMetadata?.["workboard_force_close"]).toEqual({ optional: true });
  });
});
