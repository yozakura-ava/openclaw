import { describe, expect, it } from "vitest";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

describe("governed Workboard completion", () => {
  it("requires a current verified verdict to complete governed cards", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Governed completion",
      status: "review",
      reviewRequired: true,
    });
    expect(card.metadata?.reviewRequired).toBe(true);
    const persisted = await store.get(card.id);
    expect(persisted?.metadata?.reviewRequired).toBe(true);
    expect(persisted?.status).toBe("review");
    await expect(store.update(card.id, { status: "done" })).rejects.toThrow(
      "card requires a verified review verdict before completion.",
    );
    const claim = await store.claim(card.id, { ownerId: "reviewer", token: "review-token" });
    const scope = { ownerId: "reviewer", token: "review-token" };

    await expect(store.complete(card.id, scope)).rejects.toThrow(
      "card requires a verified review verdict before completion.",
    );
    await store.recordReviewVerdict(
      card.id,
      { verified: false, summary: "Found a defect." },
      scope,
    );
    await expect(store.complete(card.id, scope)).rejects.toThrow(
      "card requires a verified review verdict before completion.",
    );

    await store.recordReviewVerdict(card.id, { verified: true, summary: "Checks passed." }, scope);
    await store.addComment(card.id, { body: "Changed after review." }, scope);
    await expect(store.complete(card.id, scope)).rejects.toThrow(
      "card requires a verified review verdict before completion.",
    );

    await store.recordReviewVerdict(card.id, { verified: true, summary: "Rechecked." }, scope);
    const completed = await store.complete(card.id, { ...scope, summary: "Verified and done." });
    expect(completed.status).toBe("done");
    expect(completed.metadata?.reviewVerdict).toMatchObject({
      verified: true,
      reviewerId: "reviewer",
      summary: "Rechecked.",
    });
    expect(claim.card.metadata?.reviewRequired).toBe(true);
  });
});
