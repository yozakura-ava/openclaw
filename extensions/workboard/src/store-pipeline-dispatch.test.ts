// Pipeline auto-dispatch dedup tests (rebuild of card ee4dda8f / PR #118).
//
// Covers the routing/dedup gate that stops the every-5-minute re-dispatch
// loop that produced duplicate escalation cards:
//   1. Dedup gate (scheduled path): a card whose latest attempt failed inside
//      PIPELINE_DEDUP_WINDOW_MS is skipped; the skip records a strike with the
//      skipped card identity.
//   2. Cold start: an empty in-memory strike map must NOT allow a duplicate
//      dispatch — the persisted failed attempt still gates the dispatch.
//   3. Negative control: with the guard forced off, the same scenario starts
//      two runs — proving the guard is load-bearing.
//   4. Exact starts keep current semantics (operator bypass).

import type { WorkboardRunAttempt } from "@openclaw/workboard-contract";
import { describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { PIPELINE_DEDUP_WINDOW_MS, pipelineDedupGuardEnabled } from "./store-pipeline-dispatch.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

const T = 1_000_000;

function makeFailedAttempt(id: string, endedAt: number): WorkboardRunAttempt {
  return { id, status: "failed", startedAt: endedAt - 1_000, endedAt };
}

async function updateCard(
  store: ReturnType<typeof createWorkboardSqliteTestStore>,
  id: string,
  mutate: (
    existing: NonNullable<Awaited<ReturnType<typeof store.get>>>,
  ) => Parameters<ReturnType<typeof store.update>>[1],
): Promise<void> {
  const current = await store.get(id);
  if (!current) {
    throw new Error(`card not found: ${id}`);
  }
  await store.update(id, mutate(current));
}

async function createRoutedCard(store: ReturnType<typeof createWorkboardSqliteTestStore>) {
  return await store.create({
    title: "Pipeline-routed card",
    status: "ready",
    agentId: "riko",
    workspaceAccess: { unrestricted: true },
  });
}

async function failFirstRun(
  store: ReturnType<typeof createWorkboardSqliteTestStore>,
  cardId: string,
  endedAt: number,
): Promise<void> {
  await updateCard(store, cardId, (existing) => ({
    status: "ready",
    metadata: {
      ...existing.metadata,
      claim: undefined,
      attempts: [...(existing.metadata?.attempts ?? []), makeFailedAttempt("att-1", endedAt)],
    },
  }));
}

describe("pipeline auto-dispatch dedup (rebuild of ee4dda8f)", () => {
  it("pipeline_dispatch_dedup_blocks_the_second_dispatch_of_same_card", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await createRoutedCard(store);
    const run = vi.fn().mockResolvedValue({ runId: "run-1" });

    const first = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: T, maxStarts: 5 },
    });
    expect(first.started).toHaveLength(1);

    await failFirstRun(store, card.id, T + 500);
    const second = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: T + 2000, maxStarts: 5 },
    });

    expect(second.started).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(store.pipelineStrikes.lookup(card.id)).toBeDefined();
  });

  it("strike_entry_is_recorded_with_the_skipped_card_identity", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await createRoutedCard(store);
    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn().mockResolvedValue({ runId: "run-1" }) },
      options: { now: T, maxStarts: 5 },
    });
    await failFirstRun(store, card.id, T + 500);
    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn().mockResolvedValue({ runId: "run-2" }) },
      options: { now: T + 2000, maxStarts: 5 },
    });

    const strike = store.pipelineStrikes.lookup(card.id);
    expect(strike).toMatchObject({ cardId: card.id, skippedAt: T + 2000 });
    expect(typeof strike?.reason).toBe("string");
    expect(strike?.reason.length).toBeGreaterThan(0);
  });

  it("cold_start_empty_strike_map_does_not_duplicate_dispatch", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await createRoutedCard(store);
    const run = vi.fn().mockResolvedValue({ runId: "run-1" });
    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: T, maxStarts: 5 },
    });
    await failFirstRun(store, card.id, T + 500);

    // Simulate a Gateway restart: the in-memory strike map resets to empty.
    store.pipelineStrikes.clear();
    expect(store.pipelineStrikes.size).toBe(0);
    expect(store.pipelineStrikes.lookup(card.id)).toBeUndefined();

    // The persisted failed attempt still gates the dispatch — no duplicate.
    const afterRestart = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: T + 2000, maxStarts: 5 },
    });
    expect(afterRestart.started).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
    // A strike is (re)recorded from the persisted signal.
    expect(store.pipelineStrikes.lookup(card.id)).toBeDefined();
  });

  it("first_dispatch_of_a_running_card_does_not_duplicate_on_the_following_tick", async () => {
    const store = createWorkboardSqliteTestStore();
    await createRoutedCard(store);
    const run = vi.fn().mockResolvedValue({ runId: "run-1" });
    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: T, maxStarts: 5 },
    });
    const nextTick = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: T + 1, maxStarts: 5 },
    });
    expect(nextTick.started).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("guard_off_negative_control_fails", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await createRoutedCard(store);
    const run = vi.fn().mockResolvedValue({ runId: "run" });
    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: T, maxStarts: 5, pipelineDedupGuard: false },
    });
    await failFirstRun(store, card.id, T + 500);

    // Guard forced off + empty strike map: the duplicate-dispatch assertion
    // that the guard normally enforces now FAILS — two runs start.
    const second = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: T + 2000, maxStarts: 5, pipelineDedupGuard: false },
    });
    expect(second.started).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(store.pipelineStrikes.size).toBe(0);
  });

  it("exact_operator_starts_bypass_the_gate", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await createRoutedCard(store);
    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn().mockResolvedValue({ runId: "run-1" }) },
      options: { now: T, maxStarts: 5 },
    });
    await failFirstRun(store, card.id, T + 500);
    store.pipelineStrikes.clear();

    const run = vi.fn().mockResolvedValue({ runId: "run-exact" });
    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: T + 2000, cardId: card.id },
    });
    expect(result.started).toHaveLength(1);
    expect(result.started[0]).toMatchObject({ cardId: card.id });
  });

  it("dedup_window_and_guard_flag_behave_as_documented", () => {
    expect(PIPELINE_DEDUP_WINDOW_MS).toBe(10 * 60 * 1000);
    expect(pipelineDedupGuardEnabled({})).toBe(true);
    expect(pipelineDedupGuardEnabled({ OPENCLAW_PIPELINE_DEDUP_GUARD: "off" })).toBe(false);
    expect(pipelineDedupGuardEnabled({ OPENCLAW_PIPELINE_DEDUP_GUARD: "0" })).toBe(false);
    expect(pipelineDedupGuardEnabled({ OPENCLAW_PIPELINE_DEDUP_GUARD: "false" })).toBe(false);
    expect(pipelineDedupGuardEnabled({ OPENCLAW_PIPELINE_DEDUP_GUARD: "1" })).toBe(true);
  });
});
