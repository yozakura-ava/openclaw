// PATCH workboard-review-proof-guard-tests (issue #82)
//
// Regression for "review parking misuse": cards that were declined or
// re-routed entered review without worker submission or proof, inflating
// the review queue with false SLA signals. The move-to-review path now
// requires proof, artifact, or attachment on the card. The guard fires
// for every caller (tool surface, slash command, programmatic) so the
// contract is enforced in one place — `WorkboardPromoteStore.move`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistedWorkboardCard, WorkboardKeyedStore } from "./persistence-types.js";
import { WorkboardStore } from "./store.js";

function createMemoryStore(): WorkboardKeyedStore {
  const entries = new Map<string, PersistedWorkboardCard>();
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
      return [...entries].map(([key, value]) => ({ key, value }));
    },
  };
}

describe("WorkboardPromoteStore.move proof guard (issue #82)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T17:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects move to review when the card has no proof, artifact, or attachment", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Decline / re-route card",
      status: "running",
      workspaceAccess: { unrestricted: true },
    });

    await expect(store.move(card.id, "review")).rejects.toThrow(
      /cannot move card to review without proof/i,
    );
    // Side-effect contract: the card must NOT have moved.
    const after = await store.get(card.id);
    expect(after?.status).toBe("running");
  });

  it("accepts move to review when the card carries proof", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Proof-attached card",
      status: "running",
      workspaceAccess: { unrestricted: true },
    });
    await store.addProof(card.id, {
      status: "passed",
      label: "issue-82 proof",
      command: "scripts/run_test_scope.sh extensions/workboard/src/store-move-proof-guard.test.ts",
    });

    const moved = await store.move(card.id, "review");
    expect(moved.status).toBe("review");
    expect(moved.metadata?.proof?.length).toBeGreaterThan(0);
  });

  it("accepts move to review when the card carries an artifact", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Artifact-attached card",
      status: "running",
      workspaceAccess: { unrestricted: true },
    });
    await store.addArtifact(card.id, {
      label: "issue-82 artifact",
      path: "/tmp/issue-82.txt",
    });

    const moved = await store.move(card.id, "review");
    expect(moved.status).toBe("review");
    expect(moved.metadata?.artifacts?.length).toBeGreaterThan(0);
  });

  it("accepts move to review when the card carries an attachment", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Attachment-attached card",
      status: "running",
      workspaceAccess: { unrestricted: true },
    });
    // Attach a 1-byte attachment — the guard only checks the count, not the
    // content, so we just need a real attachment row.
    await store.addAttachment(card.id, {
      fileName: "issue-82.txt",
      contentBase64: "YQ==", // 'a'
      mimeType: "text/plain",
    });

    const moved = await store.move(card.id, "review");
    expect(moved.status).toBe("review");
    expect(moved.metadata?.attachments?.length).toBeGreaterThan(0);
  });

  it("does not require proof for non-review transitions (regression guard does not over-block)", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Non-review move card",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });

    // No proof attached; moves to blocked, todo, and back to running all
    // pass without proof. The guard is review-specific by design.
    const blocked = await store.move(card.id, "blocked");
    expect(blocked.status).toBe("blocked");

    const todo = await store.move(card.id, "todo");
    expect(todo.status).toBe("todo");
  });
});
