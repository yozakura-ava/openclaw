import type { WorkboardChange } from "@openclaw/workboard-contract";
import { describe, expect, it, vi } from "vitest";
import {
  WorkboardDurableEventIntake,
  type WorkboardDurableEvent,
  type WorkboardDurableEventPersistence,
} from "./durable-event-intake.js";

function persistence(): WorkboardDurableEventPersistence & { rows: WorkboardDurableEvent[] } {
  const rows: WorkboardDurableEvent[] = [];
  return {
    rows,
    enqueue: vi.fn(async (event) => {
      if (rows.some((row) => row.idempotencyKey === event.idempotencyKey)) {
        return true;
      }
      if (rows.filter((row) => row.state === "pending").length >= 2) {
        return false;
      }
      rows.push(event);
      return true;
    }),
    due: vi.fn(async (now, limit) =>
      rows.filter((row) => row.state === "pending" && row.nextAttemptAt <= now).slice(0, limit),
    ),
    acknowledge: vi.fn(async (id) => {
      const row = rows.find((entry) => entry.id === id);
      if (row) {
        row.state = "acked";
      }
    }),
    fail: vi.fn(async (id, error, now) => {
      const row = rows.find((entry) => entry.id === id);
      if (!row) {
        return;
      }
      row.attempts += 1;
      row.lastError = error;
      row.state =
        row.attempts >= WorkboardDurableEventIntake.maxAttempts() ? "dead_letter" : "pending";
      row.nextAttemptAt = now + WorkboardDurableEventIntake.retryDelay(row.attempts);
    }),
    replayDeadLetters: vi.fn(async (now) => {
      let count = 0;
      for (const row of rows) {
        if (row.state === "dead_letter") {
          row.state = "pending";
          row.nextAttemptAt = now;
          count += 1;
        }
      }
      return count;
    }),
  };
}

const change: WorkboardChange = { epoch: "epoch-a", revision: 1 };

describe("WorkboardDurableEventIntake", () => {
  it("persists before delivery and acknowledges only after delivery", async () => {
    const store = persistence();
    const intake = new WorkboardDurableEventIntake(store, () => 100);
    await intake.enqueue(change);
    const delivered: WorkboardChange[] = [];
    await expect(
      intake.drain((entry) => {
        delivered.push(entry);
      }),
    ).resolves.toEqual({
      delivered: 1,
      failed: 0,
    });
    expect(delivered).toEqual([change]);
    expect(store.rows[0]?.state).toBe("acked");
    expect(store.rows[0]?.idempotencyKey).toBe("workboard.change:epoch-a:1");
  });

  it("retains failure state, dead-letters after bounded retries, and replays", async () => {
    const store = persistence();
    const intake = new WorkboardDurableEventIntake(store, () => 100);
    await intake.enqueue(change);
    for (let attempt = 0; attempt < WorkboardDurableEventIntake.maxAttempts(); attempt += 1) {
      await intake.drain(() => {
        throw new Error("gateway unavailable");
      });
      const row = store.rows[0]!;
      row.nextAttemptAt = 100;
    }
    expect(store.rows[0]?.state).toBe("dead_letter");
    await expect(intake.replayDeadLetters()).resolves.toBe(1);
    expect(store.rows[0]?.state).toBe("pending");
  });

  it("deduplicates a replayed idempotency key", async () => {
    const store = persistence();
    const intake = new WorkboardDurableEventIntake(store, () => 100);
    await intake.enqueue(change);
    await intake.enqueue(change);
    expect(store.rows).toHaveLength(1);
  });
});
