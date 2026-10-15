import { describe, expect, it } from "vitest";
import { SessionTranscriptReadFenceError } from "../config/sessions/session-transcript-read-fence.js";
import { isExpectedRunCancellation } from "./expected-run-cancellation.js";
import { GatewayDrainingError } from "./gateway-work-admission.js";

describe("isExpectedRunCancellation", () => {
  it("classifies direct and wrapped authority cancellation as expected", () => {
    expect(isExpectedRunCancellation(new GatewayDrainingError())).toBe(true);
    expect(isExpectedRunCancellation(new SessionTranscriptReadFenceError("fence"))).toBe(true);
    expect(
      isExpectedRunCancellation(
        new Error("authority ended", { cause: new SessionTranscriptReadFenceError("fence") }),
      ),
    ).toBe(true);
  });

  it("keeps provider and mixed cleanup failures visible", () => {
    expect(isExpectedRunCancellation(new Error("provider failed"))).toBe(false);
    expect(
      isExpectedRunCancellation(
        new AggregateError([new GatewayDrainingError(), new Error("cleanup failed")]),
      ),
    ).toBe(false);
  });
});
