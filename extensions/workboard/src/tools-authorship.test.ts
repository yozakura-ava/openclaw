import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";

describe("Workboard tool authorship", () => {
  it("persists comment and proof authorship through normalized child rows", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "Authored evidence" });
    const tools = new Map(
      createWorkboardTools({ store, context: { agentId: "writer-7" } }).map((tool) => [
        tool.name,
        tool,
      ]),
    );

    await expectDefined(tools.get("workboard_comment"), "comment").execute("comment", {
      id: card.id,
      body: "Authored comment",
    });
    await expectDefined(tools.get("workboard_proof"), "proof").execute("proof", {
      id: card.id,
      status: "passed",
      note: "Authored proof",
    });

    await store.update(card.id, { notes: "Unrelated update" });
    await expect(store.get(card.id)).resolves.toMatchObject({
      metadata: {
        comments: [
          expect.objectContaining({
            body: "Authored comment",
            actorId: "writer-7",
            actorKind: "agent",
          }),
        ],
        proof: [
          expect.objectContaining({
            note: "Authored proof",
            actorId: "writer-7",
            actorKind: "agent",
          }),
        ],
      },
    });
  });

  it("attributes direct writes without caller context to the system actor", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "Unattributed evidence" });
    await store.addComment(card.id, { body: "No caller context" });
    await store.addProof(card.id, { status: "unknown", note: "No caller context" });
    await expect(store.get(card.id)).resolves.toMatchObject({
      metadata: {
        comments: [expect.objectContaining({ actorId: "workboard-system", actorKind: "system" })],
        proof: [expect.objectContaining({ actorId: "workboard-system", actorKind: "system" })],
      },
    });
  });

  it.each(['"', "\\"])(
    "rejects unrepresentable JSON-escaped comment chunks (%s) atomically",
    async (character) => {
      const store = createWorkboardSqliteTestStore();
      const card = await store.create({ title: "Escaped oversized comment" });
      await store.addComment(card.id, { body: "Existing evidence" });
      await expect(store.addComment(card.id, { body: character.repeat(12_500) })).rejects.toThrow(
        /metadata budget.*nothing was written/,
      );
      const unchanged = await store.get(card.id);
      expect(unchanged?.metadata?.comments?.map((comment) => comment.body)).toEqual([
        "Existing evidence",
      ]);
    },
  );

  it("preserves authorship across safely split oversized comments", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "Chunked comment" });
    const comment = expectDefined(
      createWorkboardTools({ store, context: { agentId: "writer-8" } }).find(
        (tool) => tool.name === "workboard_comment",
      ),
      "comment",
    );
    const body = "word ".repeat(1_000);

    await comment.execute("comment", { id: card.id, body });

    const updated = await store.get(card.id);
    expect(updated?.metadata?.comments).toHaveLength(2);
    expect(updated?.metadata?.comments?.every((entry) => entry.body.length <= 4096)).toBe(true);
    expect(updated?.metadata?.comments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actorId: "writer-8", actorKind: "agent" }),
        expect.objectContaining({ body: expect.stringMatching(/\(2\/2\)$/), actorId: "writer-8" }),
      ]),
    );
  });
});
