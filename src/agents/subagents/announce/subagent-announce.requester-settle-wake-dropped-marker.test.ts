/**
 * Fork issue #106 (Ask #2) — unit tests for the durable dropped-delivery
 * marker writer. The wake module is responsible for calling this helper at
 * every bounded-budget abandonment branch; these tests pin the helper's
 * shape, deduplication, and failure-mode behavior so a future refactor of
 * the wake module can't quietly drop the marker write.
 *
 * Card: 9646d3cd-aa9a-4ff3-bd10-8d54bc1c513c
 * DELEG-REF: 9646d3cd-aa9a-4ff3-bd10-8d54bc1c513c
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const patchSessionEntryWithKey = vi.fn(async () => ({ ok: true }) as unknown);

vi.mock("../../../config/sessions/session-accessor.js", () => ({
  patchSessionEntryWithKey: (params: unknown) =>
    (patchSessionEntryWithKey as unknown as (p: unknown) => Promise<unknown>)(params),
}));

import { recordRequesterSettleWakeDeliveryDropped } from "./subagent-announce.requester-settle-wake-dropped-marker.js";

const REQUESTER_KEY = "agent:main:main";

describe("fork #106 — requester settle wake dropped-delivery marker writer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T15:30:00.000Z"));
    patchSessionEntryWithKey.mockClear();
    patchSessionEntryWithKey.mockResolvedValue({ ok: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes a marker with the documented shape at the deferral-cap boundary", async () => {
    const marker = await recordRequesterSettleWakeDeliveryDropped({
      requesterSessionKey: REQUESTER_KEY,
      childRunIds: ["run-alpha", "run-beta"],
      deferralCount: 10,
      reason: "requester settle wake deferred too many times",
      cap: 10,
      cause: "deferral-cap",
    });
    expect(marker).toMatchObject({
      droppedAt: Date.now(),
      requesterSessionKey: REQUESTER_KEY,
      childRunIds: ["run-alpha", "run-beta"],
      deferralCount: 10,
      reason: "requester settle wake deferred too many times",
      cap: 10,
      cause: "deferral-cap",
    });
    expect(patchSessionEntryWithKey).toHaveBeenCalledExactlyOnceWith({
      sessionKey: REQUESTER_KEY,
      patch: { requesterSettleWakeDroppedDelivery: marker },
    });
  });

  it("dedupes and sorts child run ids", async () => {
    const marker = await recordRequesterSettleWakeDeliveryDropped({
      requesterSessionKey: REQUESTER_KEY,
      childRunIds: ["run-b", "run-a", "run-b", "", "run-c"],
      deferralCount: 10,
      reason: "x",
      cap: 10,
      cause: "deferral-cap",
    });
    expect(marker?.childRunIds).toEqual(["run-a", "run-b", "run-c"]);
  });

  it("does nothing when childRunIds is empty after filtering", async () => {
    const marker = await recordRequesterSettleWakeDeliveryDropped({
      requesterSessionKey: REQUESTER_KEY,
      childRunIds: ["", "", ""],
      deferralCount: 10,
      reason: "x",
      cap: 10,
      cause: "deferral-cap",
    });
    expect(marker).toBeUndefined();
    expect(patchSessionEntryWithKey).not.toHaveBeenCalled();
  });

  it("does nothing when requesterSessionKey is blank", async () => {
    const marker = await recordRequesterSettleWakeDeliveryDropped({
      requesterSessionKey: "   ",
      childRunIds: ["run-a"],
      deferralCount: 10,
      reason: "x",
      cap: 10,
      cause: "deferral-cap",
    });
    expect(marker).toBeUndefined();
    expect(patchSessionEntryWithKey).not.toHaveBeenCalled();
  });

  it("swallows session-store failures (wake module owns the abandoned batch)", async () => {
    patchSessionEntryWithKey.mockRejectedValueOnce(new Error("disk full"));
    const marker = await recordRequesterSettleWakeDeliveryDropped({
      requesterSessionKey: REQUESTER_KEY,
      childRunIds: ["run-a"],
      deferralCount: 10,
      reason: "x",
      cap: 10,
      cause: "deferral-cap",
    });
    expect(marker).toBeUndefined();
  });

  it("truncates oversized reasons to keep the marker cheap", async () => {
    const huge = "x".repeat(2_000);
    const marker = await recordRequesterSettleWakeDeliveryDropped({
      requesterSessionKey: REQUESTER_KEY,
      childRunIds: ["run-a"],
      deferralCount: 10,
      reason: huge,
      cap: 10,
      cause: "ambiguous-replay-cap",
    });
    expect(marker?.cause).toBe("ambiguous-replay-cap");
    expect(marker?.reason.length).toBeLessThan(2_000);
    expect(marker?.reason.endsWith("[reason truncated]")).toBe(true);
  });

  it("accepts each documented cause label", async () => {
    const causes = ["deferral-cap", "ambiguous-replay-cap", "delivery-attempts-exhausted"] as const;
    for (const cause of causes) {
      const marker = await recordRequesterSettleWakeDeliveryDropped({
        requesterSessionKey: REQUESTER_KEY,
        childRunIds: ["run-a"],
        deferralCount: 10,
        reason: "x",
        cap: 10,
        cause,
      });
      expect(marker?.cause).toBe(cause);
    }
  });
});
