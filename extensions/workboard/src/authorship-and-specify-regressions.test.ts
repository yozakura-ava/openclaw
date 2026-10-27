// Round-2 board-clear regressions (cards b21ff3c9 + 9dd79ad6):
//  - system-actor default on unattributed comment/proof writes (9dd79ad6),
//  - notes budget raised so a full repair footer fits (b21ff3c9 gap 1),
//  - automation.branch/headSha survive a specify re-stamp (b21ff3c9 gap 2).
import { describe, expect, it } from "vitest";
import { SYSTEM_FALLBACK_ACTOR } from "./actor-attribution.js";
import { MAX_NOTES_LENGTH } from "./store-constants.js";
import { normalizeAutomation, normalizeNotes } from "./store-normalizers.js";

describe("card 9dd79ad6 — system-actor default on unattributed writes", () => {
  it("exposes the paired system fallback", () => {
    expect(SYSTEM_FALLBACK_ACTOR).toEqual({
      actorId: "workboard-system",
      actorKind: "system",
    });
  });

  it("stamps workboard-system on a comment written with no actor", async () => {
    const { createWorkboardSqliteTestStore } = await import("./test/sqlite-store.js");
    const { createKernelStores } = await import("./test/sqlite-kernel.js");
    const store = createWorkboardSqliteTestStore({ createStores: createKernelStores });
    const card = await store.create({ title: "Actor default" });
    await store.addComment(card.id, { body: "anonymous by the old path" });
    const after = await store.get(card.id);
    const last = after?.metadata?.comments?.at(-1);
    expect(last?.actorId).toBe("workboard-system");
    expect(last?.actorKind).toBe("system");
  });

  it("keeps an explicit actor untouched", async () => {
    const { createWorkboardSqliteTestStore } = await import("./test/sqlite-store.js");
    const { createKernelStores } = await import("./test/sqlite-kernel.js");
    const store = createWorkboardSqliteTestStore({ createStores: createKernelStores });
    const card = await store.create({ title: "Actor kept" });
    await store.addComment(card.id, {
      body: "attributed",
      actorId: "tsubaki",
      actorKind: "agent",
    });
    const after = await store.get(card.id);
    const last = after?.metadata?.comments?.at(-1);
    expect(last?.actorId).toBe("tsubaki");
    expect(last?.actorKind).toBe("agent");
  });

  it("stamps workboard-system on a proof written with no actor", async () => {
    const { createWorkboardSqliteTestStore } = await import("./test/sqlite-store.js");
    const { createKernelStores } = await import("./test/sqlite-kernel.js");
    const store = createWorkboardSqliteTestStore({ createStores: createKernelStores });
    const card = await store.create({ title: "Proof default" });
    await store.addProof(card.id, { status: "passed", note: "green" });
    const after = await store.get(card.id);
    const last = after?.metadata?.proof?.at(-1);
    expect(last?.actorId).toBe("workboard-system");
    expect(last?.actorKind).toBe("system");
  });
});

describe("card b21ff3c9 gap 1 — notes budget carries a full repair footer", () => {
  it("accepts notes between the old 4000 cap and the new budget", () => {
    const repairFooter = "x".repeat(8_000);
    expect(normalizeNotes(repairFooter)).toBe(repairFooter);
  });

  it("still rejects notes above the raised budget", () => {
    expect(() => normalizeNotes("x".repeat(MAX_NOTES_LENGTH + 1))).toThrow(
      new RegExp(`notes must be ${MAX_NOTES_LENGTH}`),
    );
  });
});

describe("card b21ff3c9 gap 2 — automation.branch/headSha survive specify", () => {
  it("normalizeAutomation preserves branch and headSha from the previous stamp", () => {
    const carried = normalizeAutomation(
      { summary: "re-specified" },
      { branch: "tsubaki/x", headSha: "abc123", boardId: "default" },
    );
    expect(carried).toMatchObject({
      branch: "tsubaki/x",
      headSha: "abc123",
      boardId: "default",
      summary: "re-specified",
    });
  });

  it("normalizes newly supplied branch/headSha values", () => {
    const stamped = normalizeAutomation({
      branch: "tsubaki/y",
      headSha: "def456789",
    });
    expect(stamped).toMatchObject({ branch: "tsubaki/y", headSha: "def456789" });
  });

  it("end-to-end: a specify round-trip keeps the merge lane's branch/headSha", async () => {
    const { createWorkboardSqliteTestStore } = await import("./test/sqlite-store.js");
    const { createKernelStores } = await import("./test/sqlite-kernel.js");
    const store = createWorkboardSqliteTestStore({ createStores: createKernelStores });
    const card = await store.create({ title: "Specify round-trip", status: "todo" });
    await store.update(card.id, {
      metadata: {
        automation: { branch: "tsubaki/keep-me", headSha: "cafe1234" },
      },
    });
    await store.specify(card.id, { summary: "spec'd after merge-lane stamp" });
    const after = await store.get(card.id);
    expect(after?.metadata?.automation).toMatchObject({
      branch: "tsubaki/keep-me",
      headSha: "cafe1234",
      summary: "spec'd after merge-lane stamp",
    });
  });
});
