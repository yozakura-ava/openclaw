import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import { retrySessionHistoryAdmission } from "./session-transcript-admission-retry.js";

const overloaded = () =>
  Object.assign(new Error("worker task capacity reached"), { code: "overloaded" });

describe("retrySessionHistoryAdmission", () => {
  it("passes through successful admission without delay", async () => {
    let calls = 0;
    const value = await retrySessionHistoryAdmission(async () => {
      calls++;
      return "ok";
    }, 5_000);
    assert.equal(value, "ok");
    assert.equal(calls, 1);
  });

  it("retries transient overloaded admissions and succeeds", async () => {
    let calls = 0;
    const start = performance.now();
    const value = await retrySessionHistoryAdmission(async () => {
      calls++;
      if (calls < 3) throw overloaded();
      return "recovered";
    }, 5_000);
    assert.equal(value, "recovered");
    assert.equal(calls, 3);
    // Two backoff waits (25ms + 50ms nominal, jittered) stay well under the deadline.
    assert.ok(performance.now() - start < 5_000);
  });

  it("treats the request timeout as the total retry deadline", async () => {
    const start = performance.now();
    await assert.rejects(
      retrySessionHistoryAdmission(async () => {
        throw overloaded();
      }, 80),
      (error: unknown) => {
        assert.ok(error instanceof WorkerTaskError);
        assert.equal((error as WorkerTaskError).code, "timeout");
        return true;
      },
    );
    const elapsed = performance.now() - start;
    assert.ok(elapsed >= 80, `deadline respected (elapsed=${elapsed}ms)`);
    assert.ok(elapsed < 2_000, `bounded retries (elapsed=${elapsed}ms)`);
  });

  it("rethrows non-overloaded errors immediately", async () => {
    let calls = 0;
    await assert.rejects(
      retrySessionHistoryAdmission(async () => {
        calls++;
        throw new Error("fatal");
      }, 5_000),
      /fatal/,
    );
    assert.equal(calls, 1);
  });

  it("honors abort signals while waiting for backoff", async () => {
    const controller = new AbortController();
    const start = performance.now();
    const pending = retrySessionHistoryAdmission(
      async () => {
        throw overloaded();
      },
      60_000,
      controller.signal,
    );
    setTimeout(() => controller.abort(new Error("cancelled")), 10);
    await assert.rejects(pending, /cancelled/);
    assert.ok(performance.now() - start < 1_000);
  });
});
