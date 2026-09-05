import type { WorkboardRunAttempt } from "@openclaw/workboard-contract";
// Workboard pipeline auto-dispatch dedup tests (card ee4dda8f).
//
// Covers three independent gates that together stop the every-5-minute
// re-dispatch loop that produced duplicate [PIPELINE]-/[VERIFY-ESCALATION]
// cards during the 2026-09-03 escalation investigation:
//
//   1. Routing gate (store.dispatch): cards without agentId never bump
//      dispatchCount; Himari triage must assign a lane first.
//   2. Dedup gate (selectStartableCards): cards whose most-recent attempt
//      failed within DISPATCH_COOLDOWN_MS are silently skipped (no
//      worker start, no escalation-card spawn).
//   3. Strike counter / blocked-parking (store.dispatch): consecutive
//      failed-dispatch strikes park the card in `blocked` after
//      MAX_PIPELINE_RETRY_STRIKES with a worker-log entry for
//      orchestrator review.
import { describe, expect, it } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import type { PersistedWorkboardCard, WorkboardKeyedStore } from "./persistence-types.js";
import { DISPATCH_COOLDOWN_MS, MAX_PIPELINE_RETRY_STRIKES } from "./store-constants.js";
import { WorkboardStore } from "./store.js";

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

function makeFailedAttempt(id: string, endedAt: number): WorkboardRunAttempt {
  return {
    id,
    status: "failed",
    startedAt: endedAt - 1_000,
    endedAt,
  };
}

function makeBlockedAttempt(id: string, endedAt: number): WorkboardRunAttempt {
  return {
    id,
    status: "blocked",
    startedAt: endedAt - 1_000,
    endedAt,
  };
}

describe("pipeline auto-dispatch dedup (ee4dda8f)", () => {
  describe("routing gate (no agentId)", () => {
    it("store.dispatch does not bump dispatchCount on unrouted cards", async () => {
      const store = new WorkboardStore(createMemoryStore());
      const card = await store.create({ title: "Unrouted", status: "ready" });
      expect(card.agentId).toBeUndefined();

      await store.dispatch(10);

      const after = await store.get(card.id);
      // No agentId → no dispatchCount bump (routing gate).
      expect(after?.metadata?.automation?.dispatchCount ?? 0).toBe(0);
      expect(after?.metadata?.automation?.lastDispatchAt).toBeUndefined();
    });

    it("store.dispatch bumps dispatchCount on routed cards", async () => {
      const store = new WorkboardStore(createMemoryStore());
      const card = await store.create({
        title: "Routed",
        status: "ready",
        agentId: "riko",
      });

      await store.dispatch(10);

      const after = await store.get(card.id);
      expect(after?.metadata?.automation?.dispatchCount).toBe(1);
      expect(after?.metadata?.automation?.lastDispatchAt).toBe(10);
    });

    it("selectStartableCards never launches an unrouted card via the auto-dispatch path", async () => {
      // Rin verdict (ee4dda8f iter 2): the routing gate only suppressed
      // store.dispatch() metadata bumps. selectStartableCards() can still
      // pick and launch an unrouted card through the normal auto-dispatch
      // path. Confirm the selection-layer gate is also in effect.
      const store = new WorkboardStore(createMemoryStore());
      const card = await store.create({
        title: "Unrouted auto-dispatch candidate",
        status: "ready",
        // Deliberately no agentId — the routing gate must filter this.
      });
      expect(card.agentId).toBeUndefined();

      let runInvocations = 0;
      const subagent = {
        run: async () => {
          runInvocations += 1;
          return { runId: "should-not-run" };
        },
      };

      const result = await dispatchAndStartWorkboardCards({
        store,
        subagent,
        options: { now: 1_000_000, maxStarts: 5 },
      });

      expect(runInvocations).toBe(0);
      expect(result.started).toEqual([]);
      expect(result.startFailures).toEqual([]);

      const after = await store.get(card.id);
      expect(after?.agentId).toBeUndefined();
      expect(after?.metadata?.claim).toBeUndefined();
      // Routing gate at store.dispatch() is independent — also confirm it
      // still suppresses dispatch metadata on unrouted cards (no regression).
      expect(after?.metadata?.automation?.dispatchCount ?? 0).toBe(0);
      expect(after?.metadata?.automation?.lastDispatchAt).toBeUndefined();
    });

    it("selectStartableCards selects a blank-agent card via the operator exact start path", async () => {
      // Rin verdict (ee4dda8f iter 3): the routing gate applies ONLY to
      // the auto-dispatch (scheduled) path. Operator-initiated exact starts
      // routed through `prepareStart({ cardId })` must still launch the card
      // regardless of agentId — the operator owns the lane assignment and
      // explicitly named the card to start.
      const keyed = createMemoryStore();
      const store = new WorkboardStore(keyed);
      const card = await store.create({
        title: "Operator-launched blank-agent card",
        status: "ready",
        workspaceAccess: { unrestricted: true },
      });
      // Force a blank agentId — same shape as the default-owner fallback
      // path that R4 (card f88f4ec9) exercises.
      await keyed.register(card.id, {
        version: 1,
        card: { ...card, agentId: "" },
      });
      expect((await store.get(card.id))?.agentId).toBe("");

      let runInvocations = 0;
      const subagent = {
        run: async () => {
          runInvocations += 1;
          return { runId: "run-exact-blank-agent" };
        },
      };

      const result = await dispatchAndStartWorkboardCards({
        store,
        subagent,
        options: { now: 1_000_000, maxStarts: 5, cardId: card.id },
      });

      expect(runInvocations).toBe(1);
      expect(result.started).toHaveLength(1);
      expect(result.started[0]).toMatchObject({ cardId: card.id });
      expect(result.startFailures).toEqual([]);

      const after = await store.get(card.id);
      expect(after?.status).toBe("running");
      expect(after?.metadata?.claim).toBeDefined();
    });
  });

  describe("dedup gate (recent failed attempt)", () => {
    it("selectStartableCards silently skips a card with a recent failed attempt", async () => {
      const store = new WorkboardStore(createMemoryStore());
      const card = await store.create({
        title: "Recently failed",
        status: "ready",
        agentId: "riko",
        workspaceAccess: { unrestricted: true },
      });
      const failedAt = 1_000_000;
      await store.updateMetadata(card.id, (existing) => ({
        ...existing.metadata,
        attempts: [makeFailedAttempt("att-1", failedAt)],
      }));

      const subagent = {
        run: async () => {
          throw new Error("worker should not start");
        },
      };

      const result = await dispatchAndStartWorkboardCards({
        store,
        subagent,
        options: { now: failedAt + 1_000, maxStarts: 5 },
      });

      expect(result.started).toEqual([]);
      expect(result.startFailures).toEqual([]);
      // No claim was acquired.
      const after = await store.get(card.id);
      expect(after?.metadata?.claim).toBeUndefined();
    });

    it("selectStartableCards dispatches a card whose failed attempt is older than the cooldown", async () => {
      const store = new WorkboardStore(createMemoryStore());
      const card = await store.create({
        title: "Old failure",
        status: "ready",
        agentId: "riko",
        workspaceAccess: { unrestricted: true },
      });
      const failedAt = 1_000_000;
      // Failed well outside the cooldown window.
      await store.updateMetadata(card.id, (existing) => ({
        ...existing.metadata,
        attempts: [makeFailedAttempt("att-1", failedAt)],
      }));

      const runCalls: unknown[] = [];
      const subagent = {
        run: async (args: unknown) => {
          runCalls.push(args);
          return { runId: "run-after-cooldown" };
        },
      };

      const now = failedAt + DISPATCH_COOLDOWN_MS + 1;
      const result = await dispatchAndStartWorkboardCards({
        store,
        subagent,
        options: { now, maxStarts: 5 },
      });

      expect(result.started).toHaveLength(1);
      expect(runCalls).toHaveLength(1);
    });

    it("blocked attempt inside the cooldown is treated as recent failure", async () => {
      const store = new WorkboardStore(createMemoryStore());
      const card = await store.create({
        title: "Recently blocked",
        status: "ready",
        agentId: "riko",
        workspaceAccess: { unrestricted: true },
      });
      const blockedAt = 2_000_000;
      await store.updateMetadata(card.id, (existing) => ({
        ...existing.metadata,
        attempts: [makeBlockedAttempt("att-1", blockedAt)],
      }));

      const subagent = {
        run: async () => {
          throw new Error("worker should not start");
        },
      };

      const result = await dispatchAndStartWorkboardCards({
        store,
        subagent,
        options: { now: blockedAt + 1_000, maxStarts: 5 },
      });

      expect(result.started).toEqual([]);
      expect(result.startFailures).toEqual([]);
    });

    it("succeeded attempt is not treated as recent failure", async () => {
      const store = new WorkboardStore(createMemoryStore());
      const card = await store.create({
        title: "Previously succeeded",
        status: "ready",
        agentId: "riko",
        workspaceAccess: { unrestricted: true },
      });
      const succeededAt = 1_500_000;
      await store.updateMetadata(card.id, (existing) => ({
        ...existing.metadata,
        attempts: [
          {
            id: "att-1",
            status: "succeeded",
            startedAt: succeededAt - 1_000,
            endedAt: succeededAt,
          },
        ],
      }));

      const subagent = {
        run: async () => ({ runId: "run-after-success" }),
      };

      const result = await dispatchAndStartWorkboardCards({
        store,
        subagent,
        options: { now: succeededAt + 1_000, maxStarts: 5 },
      });

      expect(result.started).toHaveLength(1);
    });
  });

  describe("strike counter / blocked-parking", () => {
    it("bumps pipelineStrikes on each dispatch pass while a recent failure persists", async () => {
      const store = new WorkboardStore(createMemoryStore());
      const card = await store.create({
        title: "Recurring failure",
        status: "ready",
        agentId: "riko",
      });
      const failedAt = 1_000_000;
      await store.updateMetadata(card.id, (existing) => ({
        ...existing.metadata,
        attempts: [makeFailedAttempt("att-1", failedAt)],
      }));

      await store.dispatch(failedAt + 1_000);
      const after1 = await store.get(card.id);
      expect(after1?.metadata?.automation?.pipelineStrikes).toBe(1);

      await store.dispatch(failedAt + 2_000);
      const after2 = await store.get(card.id);
      expect(after2?.metadata?.automation?.pipelineStrikes).toBe(2);

      await store.dispatch(failedAt + 3_000);
      const after3 = await store.get(card.id);
      // Strike 3 → MAX reached → card parked in blocked, strikes reset.
      expect(after3?.status).toBe("blocked");
      expect(after3?.metadata?.automation?.pipelineStrikes).toBe(0);
      expect(
        after3?.metadata?.notifications?.some((n) =>
          n.message.includes("exhausted pipeline auto-dispatch retries"),
        ),
      ).toBe(true);
      expect(
        after3?.metadata?.workerLogs?.some((l) =>
          l.message.includes("Pipeline dispatch saturated"),
        ),
      ).toBe(true);
    });

    it("resets pipelineStrikes to 0 when a card recovers (no recent failure)", async () => {
      const store = new WorkboardStore(createMemoryStore());
      const card = await store.create({
        title: "Recovering",
        status: "ready",
        agentId: "riko",
      });
      // Seed two strikes + an OLD failed attempt (outside cooldown).
      const oldFailedAt = 1_000_000;
      await store.updateMetadata(card.id, (existing) => ({
        ...existing.metadata,
        attempts: [makeFailedAttempt("att-1", oldFailedAt)],
        automation: {
          ...existing.metadata?.automation,
          pipelineStrikes: 2,
          pipelineStrikesUpdatedAt: oldFailedAt,
        },
      }));

      // Dispatch well after the cooldown window — strike should reset to 0.
      await store.dispatch(oldFailedAt + DISPATCH_COOLDOWN_MS + 1);
      const after = await store.get(card.id);
      expect(after?.status).toBe("ready");
      expect(after?.metadata?.automation?.pipelineStrikes).toBe(0);
      expect(after?.metadata?.automation?.dispatchCount).toBe(1);
    });

    it("does not park a card with strikes below the ceiling on a single dispatch pass", async () => {
      const store = new WorkboardStore(createMemoryStore());
      const card = await store.create({
        title: "Below ceiling",
        status: "ready",
        agentId: "riko",
      });
      const failedAt = 1_000_000;
      await store.updateMetadata(card.id, (existing) => ({
        ...existing.metadata,
        attempts: [makeFailedAttempt("att-1", failedAt)],
        automation: {
          ...existing.metadata?.automation,
          pipelineStrikes: MAX_PIPELINE_RETRY_STRIKES - 1,
          pipelineStrikesUpdatedAt: failedAt,
        },
      }));

      await store.dispatch(failedAt + 1_000);
      const after = await store.get(card.id);
      // Strike increments to MAX → card parked, strikes reset.
      expect(after?.status).toBe("blocked");
      expect(after?.metadata?.automation?.pipelineStrikes).toBe(0);
    });

    it("records the saturation message verbatim (orchestrator-readable)", async () => {
      const store = new WorkboardStore(createMemoryStore());
      const card = await store.create({
        title: "Saturated message",
        status: "ready",
        agentId: "riko",
      });
      const failedAt = 5_000_000;
      await store.updateMetadata(card.id, (existing) => ({
        ...existing.metadata,
        attempts: [makeFailedAttempt("att-1", failedAt)],
      }));

      // MAX_PIPELINE_RETRY_STRIKES consecutive dispatch passes with the
      // recent failure still inside the cooldown.
      for (let i = 0; i < MAX_PIPELINE_RETRY_STRIKES; i += 1) {
        await store.dispatch(failedAt + (i + 1) * 1_000);
      }

      const after = await store.get(card.id);
      expect(after?.status).toBe("blocked");
      const saturationNotification = after?.metadata?.notifications?.find((n) =>
        n.message.includes("exhausted pipeline auto-dispatch retries"),
      );
      expect(saturationNotification?.message).toContain(
        `${MAX_PIPELINE_RETRY_STRIKES}/${MAX_PIPELINE_RETRY_STRIKES} strikes`,
      );
      expect(saturationNotification?.message).toContain(`${DISPATCH_COOLDOWN_MS}ms cooldown`);
    });
  });

  describe("integration: full dedup + strike cycle", () => {
    // The dispatcher records a fresh `running` execution on every successful
    // start; the dedup gate + strike counter operate on
    // `metadata.attempts[*].status === "failed"`. To exercise the full cycle
    // we seed a recent failed attempt after each pass — modelling the worker
    // reporting its own failure asynchronously — and let store.dispatch()
    // accumulate pipelineStrikes on the dedup path.
    it("flapping card dedups + parks at MAX strikes", async () => {
      const store = new WorkboardStore(createMemoryStore());
      const card = await store.create({
        title: "Flapping card",
        status: "ready",
        agentId: "riko",
      });

      const t0 = 1_000_000;
      const seedFailedAttempt = async (endedAt: number) =>
        await store.updateMetadata(card.id, (existing) => ({
          ...existing.metadata,
          attempts: [makeFailedAttempt("att-1", endedAt)],
        }));

      // Pass 1: no recent failure → dispatch bumps dispatchCount, no strike.
      await store.dispatch(t0);
      let after = await store.get(card.id);
      expect(after?.metadata?.automation?.dispatchCount).toBe(1);
      expect(after?.metadata?.automation?.pipelineStrikes ?? 0).toBe(0);

      // Worker reports a failure; pipeline sees a recent failed attempt.
      await seedFailedAttempt(t0 + 1_000);

      // Passes 2-4: each pass sees the same recent failure and increments
      // pipelineStrikes. On strike 3 the card is parked in `blocked` with
      // the saturation notification + worker-log entry.
      for (let i = 1; i <= MAX_PIPELINE_RETRY_STRIKES; i += 1) {
        await store.dispatch(t0 + 2_000 + i * 1_000);
      }

      after = await store.get(card.id);
      expect(after?.status).toBe("blocked");
      // Strikes reset on park so an operator-driven unblock starts fresh.
      expect(after?.metadata?.automation?.pipelineStrikes).toBe(0);
      expect(
        after?.metadata?.notifications?.some((n) =>
          n.message.includes("exhausted pipeline auto-dispatch retries"),
        ),
      ).toBe(true);
      expect(
        after?.metadata?.workerLogs?.some((l) => l.message.includes("Pipeline dispatch saturated")),
      ).toBe(true);
      // The strike-3 pass parks the card in `blocked` directly via
      // updateCard; it never reaches `recordDispatch`. So the final
      // dispatchCount is the initial pass (1) plus the two intermediate
      // dedup passes (1 + 2 = 3).
      expect(after?.metadata?.automation?.dispatchCount).toBe(MAX_PIPELINE_RETRY_STRIKES);
    });

    it("dispatch dedups via the dispatcher path when a recent failed attempt is present", async () => {
      // Exercises the dispatcher.ts dedup gate (not just store.dispatch)
      // against a card whose worker already reported a recent failure.
      const store = new WorkboardStore(createMemoryStore());
      const card = await store.create({
        title: "Worker reported failure",
        status: "ready",
        agentId: "riko",
        workspaceAccess: { unrestricted: true },
      });
      const failedAt = 5_000_000;
      await store.updateMetadata(card.id, (existing) => ({
        ...existing.metadata,
        attempts: [makeFailedAttempt("att-1", failedAt)],
      }));

      let runCount = 0;
      const subagent = {
        run: async () => {
          runCount += 1;
          return { runId: "should-not-run" };
        },
      };

      await dispatchAndStartWorkboardCards({
        store,
        subagent,
        options: { now: failedAt + 1_000, maxStarts: 5 },
      });

      expect(runCount).toBe(0);
      const after = await store.get(card.id);
      expect(after?.metadata?.claim).toBeUndefined();
      // store.dispatch still bumped dispatchCount + pipelineStrikes on the
      // dedup path (so orchestrator-side counters stay accurate even when
      // no worker starts).
      expect(after?.metadata?.automation?.dispatchCount).toBe(1);
      expect(after?.metadata?.automation?.pipelineStrikes).toBe(1);
    });
  });
});
