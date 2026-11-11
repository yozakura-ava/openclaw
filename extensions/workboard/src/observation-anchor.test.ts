// Card 88d5c5b5: observation-anchor rule at the comment write path.
// AC3 coverage: anchored pass, `unobserved:` pass, plain comment pass,
// assertion-without-anchor reject — plus unit coverage of the detectors.
import { describe, expect, it } from "vitest";
import {
  assertObservationAnchor,
  hasEvidenceAnchor,
  isHandoffTagged,
} from "./observation-anchor.js";

const ANCHORED = [
  "[build-handoff] landed branch tsubaki/x @ abc123 — verified via",
  "toolResult toolu_01ABCDEF1234567890 workboard_read turn 14.",
].join(" ");

const UNANCHORED_ASSERTION =
  "[build-handoff] landed branch tsubaki/x @ abc123; tests pass and the gate is green.";

const UNOBSERVED =
  "[diagnosis] unobserved: dispatcher tick behaviour after the reload was not re-checked.";

describe("observation-anchor — AC3 comment write path", () => {
  it("accepts a handoff comment carrying an evidence anchor", async () => {
    const { createWorkboardSqliteTestStore } = await import("./test/sqlite-store.js");
    const { createKernelStores } = await import("./test/sqlite-kernel.js");
    const store = createWorkboardSqliteTestStore({ createStores: createKernelStores });
    const card = await store.create({ title: "Anchor pass" });
    await expect(store.addComment(card.id, { body: ANCHORED })).resolves.toBeDefined();
  });

  it("accepts a handoff comment using the unobserved: prefix", async () => {
    const { createWorkboardSqliteTestStore } = await import("./test/sqlite-store.js");
    const { createKernelStores } = await import("./test/sqlite-kernel.js");
    const store = createWorkboardSqliteTestStore({ createStores: createKernelStores });
    const card = await store.create({ title: "Unobserved pass" });
    await expect(store.addComment(card.id, { body: UNOBSERVED })).resolves.toBeDefined();
  });

  it("accepts a plain (untagged) comment with no anchor", async () => {
    const { createWorkboardSqliteTestStore } = await import("./test/sqlite-store.js");
    const { createKernelStores } = await import("./test/sqlite-kernel.js");
    const store = createWorkboardSqliteTestStore({ createStores: createKernelStores });
    const card = await store.create({ title: "Plain pass" });
    await expect(
      store.addComment(card.id, { body: "ordinary note, nothing asserted" }),
    ).resolves.toBeDefined();
  });

  it("rejects a tagged runtime-event assertion without anchor or unobserved:", async () => {
    const { createWorkboardSqliteTestStore } = await import("./test/sqlite-store.js");
    const { createKernelStores } = await import("./test/sqlite-kernel.js");
    const store = createWorkboardSqliteTestStore({ createStores: createKernelStores });
    const card = await store.create({ title: "Reject case" });
    await expect(store.addComment(card.id, { body: UNANCHORED_ASSERTION })).rejects.toThrow(
      /observation-anchor rule/,
    );
  });

  it("names the rule and both outs in the rejection error", () => {
    expect(() => assertObservationAnchor(UNANCHORED_ASSERTION)).toThrow(
      /card 64feb4bd[\s\S]*unobserved:/,
    );
  });
});

describe("observation-anchor — detector units", () => {
  it("detects handoff/diagnosis tags case-insensitively", () => {
    expect(isHandoffTagged("[BUILD-HANDOFF] x")).toBe(true);
    expect(isHandoffTagged("[Diagnosis] x")).toBe(true);
    expect(isHandoffTagged("no tag here")).toBe(false);
  });

  it("treats a toolResult id alone as an anchor", () => {
    expect(hasEvidenceAnchor("saw it via toolu_01ABCDEF1234567890")).toBe(true);
    expect(hasEvidenceAnchor("saw it via call_abcdef123456")).toBe(true);
  });

  it("requires tool name AND turn/session id when no result id is present", () => {
    expect(hasEvidenceAnchor("workboard_read session agent:tsubaki:main")).toBe(true);
    expect(hasEvidenceAnchor("workboard_read without any session")).toBe(false);
    expect(hasEvidenceAnchor("session agent:tsubaki:main without tool")).toBe(false);
  });

  it("leaves plain comments alone end to end", () => {
    expect(() => assertObservationAnchor("just a note")).not.toThrow();
  });
});
