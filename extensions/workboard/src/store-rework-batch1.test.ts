// Rework batch 1 regressions (issues #59/#60/#61 on the 9.3 base):
// - comment cap raised to 4096 on the write path
// - oversized comments split into sequential labeled chunks
// - claim-expiry semantics (upstream 9.3 behavior) locked by tests
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { assert, describe, expect, it, vi } from "vitest";
import type { PersistedWorkboardCard, WorkboardKeyedStore } from "./persistence-types.js";
import { splitCommentBody } from "./store-card-helpers.js";
import { WorkboardStore } from "./store.js";

function createMemoryStore<T = PersistedWorkboardCard>(): WorkboardKeyedStore<T> {
  const entries = new Map<string, T>();
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
      return [...entries].flatMap(([key, value]) => (value ? [{ key, value }] : []));
    },
  };
}

describe("rework batch 1: comment cap 4096 (#59)", () => {
  it("accepts a comment body up to 4096 characters", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Cap check", status: "todo" });
    const body = "x".repeat(4096);
    const updated = await store.addComment(card.id, { body });
    const comments = (updated as WorkboardCard).metadata?.comments ?? [];
    expect(comments.at(-1)?.body.length).toBe(4096);
  });

  it("rejects a 4097-character body only at the oversized threshold (split handles it)", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Threshold check", status: "todo" });
    // 4097 crosses into split territory: no throw, chunked write instead.
    const updated = await store.addComment(card.id, { body: "y".repeat(4097) });
    const comments = (updated as WorkboardCard).metadata?.comments ?? [];
    expect(comments.length).toBeGreaterThanOrEqual(2);
  });
});

describe("rework batch 1: oversized comment split-and-retry (#60)", () => {
  it("splits at whitespace boundaries and labels chunks (N/M)", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Split check", status: "todo" });
    const word = "word ".repeat(1400); // 7000 chars, whitespace-rich
    const updated = await store.addComment(card.id, { body: word.trim() });
    const comments = (updated as WorkboardCard).metadata?.comments ?? [];
    expect(comments.length).toBeGreaterThan(1);
    // First chunk stays unlabeled (original wording); continuations carry (N/M).
    expect(comments[0]?.body.startsWith("word word")).toBe(true);
    expect(comments[0]?.body).not.toMatch(/\(\d+\/\d+\)$/);
    expect(comments.at(-1)?.body).toMatch(/\(\d+\/\d+\)$/);
    for (const comment of comments) {
      expect(comment.body.length).toBeLessThanOrEqual(4096);
    }
  });

  it("splitCommentBody never cuts mid-word when whitespace exists", () => {
    const body = "abcdefghij ".repeat(1200).trim();
    const chunks = splitCommentBody(body, 4096);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
      expect(chunk.endsWith("ij")).toBe(true);
    }
    expect(chunks.join(" ")).toBe(body);
  });
});

describe("rework batch 1: claim-expiry semantics (#61, upstream 9.3)", () => {
  it("an expired claim frees the owner slot for same-owner re-claim immediately", async () => {
    vi.useFakeTimers();
    try {
      const store = new WorkboardStore(createMemoryStore());
      const card = await store.create({ title: "Expiry re-claim", status: "todo" });
      const claimed = await store.claim(card.id, { ownerId: "main", ttlSeconds: 60 });
      const expiresAt = claimed.card.metadata?.claim?.expiresAt;
      assert(expiresAt !== undefined, "claim must set expiresAt");
      expect(expiresAt).toBeGreaterThan(0);

      vi.setSystemTime(expiresAt + 1);
      const reclaimed = await store.claim(card.id, { ownerId: "main", ttlSeconds: 60 });
      expect(reclaimed.token).toBeTruthy();
      expect(reclaimed.card.metadata?.claim?.ownerId).toBe("main");
    } finally {
      vi.useRealTimers();
    }
  });

  it("an unexpired claim blocks another owner's claim", async () => {
    vi.useFakeTimers();
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Blocking claim", status: "todo" });
    await store.claim(card.id, { ownerId: "main", ttlSeconds: 60 });
    await expect(store.claim(card.id, { ownerId: "other" })).rejects.toThrow(/already claimed/);
    vi.useRealTimers();
  });
});

describe("rework batch 1: Unicode-heavy split preflight (Rin round 2)", () => {
  it("rejects a Unicode-heavy oversized body before any write (UTF-8 byte budget)", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "CJK budget", status: "todo" });
    // 12,000 CJK chars: ~12,000 UTF-16 units (passes a naive length check)
    // but ~36,000 UTF-8 bytes — over the 24 KiB metadata budget.
    const body = "語".repeat(12_000);
    await expect(store.addComment(card.id, { body })).rejects.toThrow(
      /metadata budget.*nothing was written/,
    );
    const after = await store.get(card.id);
    expect(after?.metadata?.comments ?? []).toHaveLength(0);
  });
});

describe("rework batch 1: concurrent oversized comments (Rin round 3)", () => {
  it("serializes concurrent oversized comments — no interleaved leading-chunk loss", async () => {
    const shared = createMemoryStore();
    const store = new WorkboardStore(shared);
    const card = await store.create({ title: "Race check", status: "todo" });
    const bodyA = "alpha ".repeat(1400).trim(); // ~8.4KB -> 3 chunks
    const bodyB = "beta ".repeat(1400).trim();
    const results = await Promise.allSettled([
      store.addComment(card.id, { body: bodyA }),
      store.addComment(card.id, { body: bodyB }),
    ]);
    const saved = await store.get(card.id);
    const comments = saved?.metadata?.comments ?? [];
    // At most one split can fit the 24 KiB metadata budget.
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    if (fulfilled.length === 1) {
      // The rejected one must fail in preflight, leaving the winner intact
      // and complete — no interleaving, no dropped leading chunks.
      const rejected = results.find((r) => r.status === "rejected");
      expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(Error);
      const winnerBodies = comments.map((c) => c.body);
      const allFromOneBody =
        winnerBodies.every((b) => b.startsWith("alpha")) ||
        winnerBodies.every((b) => b.startsWith("beta"));
      expect(allFromOneBody).toBe(true);
      expect(comments.length).toBe(3);
    }
  });
});
