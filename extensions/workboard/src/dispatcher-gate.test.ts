// Dispatch gate tests (#62): scheduled auto-dispatch skips cards with a blank
// agentId; human-initiated (exact) dispatches are never gated.
import { describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import type { PersistedWorkboardCard, WorkboardKeyedStore } from "./persistence-types.js";
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

describe("dispatchAndStartWorkboardCards board selection", () => {
  it("starts workers only for the selected board", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const ops = await store.create({
      title: "Ops worker",
      agentId: "test-agent",
      status: "ready",
      priority: "urgent",
      boardId: "ops",
      workspaceAccess: { unrestricted: true },
    });
    const product = await store.create({
      title: "Product worker",
      agentId: "test-agent",
      status: "ready",
      priority: "urgent",
      boardId: "product",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-ops" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 3, boardId: "ops" },
    });

    expect(result.started).toEqual([expect.objectContaining({ cardId: ops.id })]);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      sessionKey: `agent:test-agent:subagent:workboard-ops-${ops.id}`,
      lane: `workboard:ops:${ops.id}`,
    });
    await expect(store.get(product.id)).resolves.toMatchObject({
      status: "ready",
      metadata: { automation: { boardId: "product" } },
    });
  });
});

describe("dispatchAndStartWorkboardCards agentId gate", () => {
  it("skips scheduled auto-dispatch when a ready card has a blank agentId", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Unassigned ready card",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-blank" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 1 },
    });

    expect(result.started).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "ready" });
    expect((await store.get(card.id))?.metadata?.claim).toBeUndefined();
  });

  it("allows exact (human-initiated) dispatch for a ready card with a blank agentId", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Blank-agentId human dispatch",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-human-blank" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 1, cardId: card.id },
    });

    expect(result.started).toHaveLength(1);
    expect(result.started[0]?.cardId).toBe(card.id);
    expect(run).toHaveBeenCalledOnce();
  });

  it("allows scheduled auto-dispatch for a ready card with a populated agentId", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Assigned ready card",
      status: "ready",
      agentId: "codex-main",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-assigned" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 1 },
    });

    expect(result.started).toHaveLength(1);
    expect(result.started[0]?.cardId).toBe(card.id);
    expect(run).toHaveBeenCalledOnce();
  });
});
