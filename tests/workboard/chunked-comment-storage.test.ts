import { MAX_COMMENT_BODY_LENGTH, type WorkboardCard } from "@openclaw/workboard-contract";
/**
 * Targeted vitest covering child 2 of eae39eff (card
 * 9a97b80d-a0dd-4866-aa4b-cc32954905a9): the chunked storage path
 * for oversize comment bodies. AddComment rejects bodies above
 * MAX_COMMENT_BODY_LENGTH; the chunked module splits the body into
 * labeled continuations (writeChunk/readChunk/listChunks/compact).
 *
 * Acceptance criteria covered:
 * 1. store-oversized-comment.ts exposes writeChunk / readChunk /
 *    listChunks / compact and splitOversizedBody.
 * 2. Each chunked body has sanitize+cap applied per-chunk — no chunk
 *    can exceed MAX_COMMENT_BODY_LENGTH.
 * 3. sum(chunks) preserves every byte of the original body (lossless).
 * 4. compact() reassembles a chunk group into a single comment.
 *
 * Run (HR5 single-file, scoped):
 *   bash scripts/cpu_guard.sh tsubaki -- ./node_modules/.bin/vitest run \
 *     tests/workboard/chunked-comment-storage.test.ts -q
 *
 * Out of scope (handled by separate cards):
 * - addComment cap + sanitizer rework → child 1 (card 7011ba05, already merged).
 * - Integration test exercising the public workboard_comment tool path → child 3.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chunkedBodyLimit,
  compact,
  listChunks,
  readChunk,
  splitOversizedBody,
  stripChunkLabel,
  writeChunk,
} from "../../extensions/workboard/src/store-oversized-comment.js";
import { createWorkboardSqliteTestStore } from "../../extensions/workboard/src/test/sqlite-store.js";

const AT_CAP_BODY = "x".repeat(MAX_COMMENT_BODY_LENGTH);

describe("chunked comment storage (child 2 of eae39eff, card 9a97b80d)", () => {
  let store: ReturnType<typeof createWorkboardSqliteTestStore>;
  let card: WorkboardCard;

  beforeEach(async () => {
    store = createWorkboardSqliteTestStore();
    card = await store.create({ title: "Chunked storage card" });
  });

  afterEach(async () => {
    await store.close?.();
  });

  describe("splitOversizedBody (pure)", () => {
    it("returns the body verbatim when at or below the cap", () => {
      expect(splitOversizedBody(AT_CAP_BODY)).toEqual([AT_CAP_BODY]);
      expect(splitOversizedBody("")).toEqual([""]);
    });

    it("splits an oversize body into labeled chunks each <= MAX_COMMENT_BODY_LENGTH", () => {
      const body = "y".repeat(MAX_COMMENT_BODY_LENGTH + 17);
      const chunks = splitOversizedBody(body);
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(MAX_COMMENT_BODY_LENGTH);
      }
    });

    it("preserves every byte of the original body (lossless split)", () => {
      const body = "z".repeat(MAX_COMMENT_BODY_LENGTH * 3 + 7);
      const reassembled = splitOversizedBody(body).map(stripChunkLabel).join("");
      expect(reassembled.length).toBe(body.length);
      expect(reassembled).toBe(body);
    });

    it("labels chunks in (i/N) order", () => {
      const body = "a".repeat(MAX_COMMENT_BODY_LENGTH * 2 + 1);
      const chunks = splitOversizedBody(body);
      expect(chunks).toHaveLength(3);
      expect(chunks[0]?.endsWith(" (1/3)")).toBe(true);
      expect(chunks[1]?.endsWith(" (2/3)")).toBe(true);
      expect(chunks[2]?.endsWith(" (3/3)")).toBe(true);
    });
  });

  describe("chunkedBodyLimit", () => {
    it("shrinks as totalChunks grows to keep per-chunk cap honored", () => {
      const a = chunkedBodyLimit(2);
      const b = chunkedBodyLimit(3);
      // For single-digit totals, both limits are equal (label "(N/M)" is 6 chars
      // regardless of N). For larger totals where the digit count grows the
      // limit shrinks; assert that shrink here so the contract is explicit.
      expect(a).toBeGreaterThanOrEqual(b);
      expect(chunkedBodyLimit(9)).toBeGreaterThan(chunkedBodyLimit(10));
      // Both must leave headroom for the "(N/M)" label suffix.
      expect(a).toBeLessThanOrEqual(MAX_COMMENT_BODY_LENGTH - "(1/2)".length);
      expect(b).toBeLessThanOrEqual(MAX_COMMENT_BODY_LENGTH - "(3/3)".length);
    });

    it("never goes below 1", () => {
      expect(chunkedBodyLimit(1)).toBeGreaterThanOrEqual(1);
      expect(chunkedBodyLimit(9999)).toBeGreaterThanOrEqual(1);
    });
  });

  describe("writeChunk / readChunk / listChunks / compact", () => {
    it("writeChunk appends a labeled chunk with the per-chunk cap enforced", async () => {
      const oversized = "k".repeat(MAX_COMMENT_BODY_LENGTH + 11);
      const chunks = splitOversizedBody(oversized);
      let cardForWrite = card;
      for (const body of chunks) {
        cardForWrite = await writeChunk(
          store as never,
          cardForWrite.id,
          {
            id: `chunk-${chunks.indexOf(body)}`,
            body,
            createdAt: Date.now() + chunks.indexOf(body),
          },
          undefined,
        );
      }
      const reloaded = await store.get(cardForWrite.id);
      const comments = reloaded?.metadata?.comments ?? [];
      expect(comments).toHaveLength(chunks.length);
      for (const entry of comments) {
        expect(entry.body.length).toBeLessThanOrEqual(MAX_COMMENT_BODY_LENGTH);
      }
    });

    it("readChunk locates a chunk by id and returns undefined when missing", async () => {
      const chunk = { id: "find-me", body: "hello (1/1)", createdAt: Date.now() };
      const updated = await writeChunk(store as never, card.id, chunk, undefined);
      expect(readChunk(updated, "find-me")?.body).toBe("hello (1/1)");
      expect(readChunk(updated, "missing")).toBeUndefined();
    });

    it("listChunks returns chunks in (i/N) label order for a group", async () => {
      const groupA = ["x".repeat(200), "y".repeat(200), "z".repeat(200)].map((body, i) => ({
        id: `grp-${i}`,
        body: `${body} (${i + 1}/3)`,
        createdAt: Date.now() + i,
      }));
      // Plus a non-chunked comment that should NOT appear in the group's list.
      const noise = { id: "noise", body: "not a chunk", createdAt: Date.now() };
      let cardForList = card;
      for (const entry of [...groupA, noise]) {
        cardForList = await writeChunk(store as never, cardForList.id, entry, undefined);
      }
      // Group by the first chunk id (chunkGroupId strips labels).
      const list = listChunks(cardForList, "grp-0");
      expect(list).toHaveLength(3);
      expect(list[0]?.body.endsWith("(1/3)")).toBe(true);
      expect(list[2]?.body.endsWith("(3/3)")).toBe(true);
    });

    it("compact reassembles a chunk group into a single comment", async () => {
      const parts = ["alpha", "beta", "gamma"];
      let cardForCompact = card;
      for (let i = 0; i < parts.length; i += 1) {
        cardForCompact = await writeChunk(
          store as never,
          cardForCompact.id,
          {
            id: `c-${i}`,
            body: `${parts[i]} (${i + 1}/${parts.length})`,
            createdAt: Date.now() + i,
          },
          undefined,
        );
      }
      const merged = await compact(store as never, cardForCompact.id, "c-0", undefined);
      expect(merged).toBeDefined();
      const reassembled = listChunks(merged!, "c-0")
        .map((c) => stripChunkLabel(c.body))
        .join("");
      expect(reassembled).toBe("alphabeta" + parts.join("").slice("alphabeta".length));
      // Original chunks remain; the merged comment is appended.
      const comments = merged!.metadata?.comments ?? [];
      expect(comments.length).toBeGreaterThanOrEqual(parts.length + 1);
      // The merged comment body equals the concatenation of all chunks'
      // label-stripped bodies.
      const mergedComment = comments[comments.length - 1]!;
      expect(mergedComment.body).toBe(
        listChunks(merged!, "c-0")
          .slice(0, parts.length)
          .map((c) => stripChunkLabel(c.body))
          .join(""),
      );
    });

    it("writeChunk rejects bodies exceeding MAX_COMMENT_BODY_LENGTH", async () => {
      await expect(
        writeChunk(
          store as never,
          card.id,
          { id: "oversize", body: "m".repeat(MAX_COMMENT_BODY_LENGTH + 1), createdAt: Date.now() },
          undefined,
        ),
      ).rejects.toThrow(/chunk body must be .* characters or fewer/);
    });
  });
});
