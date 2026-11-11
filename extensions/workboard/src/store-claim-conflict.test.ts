// PATCH workboard-claim-conflict-history-tests (#115 scope rebuild, prior art
// upstream issue #24 — CLOSED): unit tests for the bounded module-scoped
// claim-conflict ring buffer in store-claim-conflict.ts.
//
// Covers:
//   AC5a — recordClaimConflict appends one event per rejection
//   AC5b — FIFO cap at CLAIM_CONFLICT_HISTORY_CAP (64) entries
//   AC5c — snapshot is a defensive copy; clear empties (restart semantics)

import { describe, expect, it } from "vitest";
import {
  CLAIM_CONFLICT_HISTORY_CAP,
  clearClaimConflictHistory,
  recordClaimConflict,
  snapshotClaimConflictHistory,
  type WorkboardClaimConflictEvent,
} from "./store-claim-conflict.js";

function event(n: number): WorkboardClaimConflictEvent {
  return {
    kind: "takeover",
    cardId: `card-${n}`,
    attemptedOwnerId: `attempter-${n}`,
    priorOwnerId: `prior-${n}`,
    priorExpiresAt: 1000 + n,
    at: 2000 + n,
  };
}

describe("store-claim-conflict ring buffer", () => {
  it("claim_conflict_history_starts_empty_negative_control", () => {
    clearClaimConflictHistory();
    // Negative control: with no rejection-path writes the history has zero
    // rows — any assertion below would fail vacuously without real writes.
    expect(snapshotClaimConflictHistory()).toHaveLength(0);
  });

  it("claim_conflict_history_appends_one_event_per_record", () => {
    clearClaimConflictHistory();
    recordClaimConflict(event(1));
    recordClaimConflict(event(2));
    const events = snapshotClaimConflictHistory();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ cardId: "card-1", attemptedOwnerId: "attempter-1" });
    expect(events[1]).toMatchObject({
      kind: "takeover",
      cardId: "card-2",
      priorOwnerId: "prior-2",
      priorExpiresAt: 1002,
    });
  });

  it("claim_conflict_history_caps_at_64_with_fifo_eviction", () => {
    clearClaimConflictHistory();
    const total = CLAIM_CONFLICT_HISTORY_CAP + 5;
    for (let i = 0; i < total; i += 1) {
      recordClaimConflict(event(i));
    }
    const events = snapshotClaimConflictHistory();
    expect(events.length).toBe(CLAIM_CONFLICT_HISTORY_CAP);
    // FIFO: the oldest entries were evicted.
    expect(events.find((e) => e.attemptedOwnerId === "attempter-0")).toBeUndefined();
    expect(events.find((e) => e.attemptedOwnerId === "attempter-4")).toBeUndefined();
    // The newest entries survive in order.
    expect(events.at(-1)?.attemptedOwnerId).toBe(`attempter-${total - 1}`);
    expect(events.at(-2)?.attemptedOwnerId).toBe(`attempter-${total - 2}`);
  });

  it("snapshot_is_defensive_copy_and_clear_empties_history", () => {
    clearClaimConflictHistory();
    recordClaimConflict(event(1));
    const first = snapshotClaimConflictHistory();
    expect(first).toHaveLength(1);
    recordClaimConflict(event(2));
    expect(first).toHaveLength(1); // snapshot not mutated by later writes
    expect(snapshotClaimConflictHistory()).toHaveLength(2);
    clearClaimConflictHistory(); // restart clears the non-persisted buffer
    expect(snapshotClaimConflictHistory()).toHaveLength(0);
  });
});
