import { MAX_COMMENT_BODY_LENGTH, type WorkboardCard } from "@openclaw/workboard-contract";
/**
 * Targeted vitest covering child 1 of eae39eff (card
 * 7011ba05-21de-4ef1-b366-45813c537d6e): the single source-of-truth
 * comment-body cap applied post-sanitize in addComment, with sanitizer
 * paths unable to truncate below MAX_COMMENT_BODY_LENGTH.
 *
 * Acceptance criteria covered:
 * 1. Comment body limit 4096 chars (single source of truth; cap enforced post-sanitize).
 * 2. Sanitizer paths cannot truncate below 4096 (single truncate-or-pass branch).
 * 3. Existing comments trimming logic (comments-first trimMetadataToBudget) is
 *    unchanged in observable behavior — only write-path cap enforcement is
 *    exercised here; the trimMetadataToBudget contract is not modified.
 *
 * Run (HR5 single-file, scoped):
 *   bash scripts/cpu_guard.sh tsubaki -- ./node_modules/.bin/vitest run \
 *     tests/workboard/addComment-cap.test.ts -q
 *
 * Out of scope (handled by separate cards):
 * - Chunked storage for bodies above the cap → child 2 (card 9a97b80d).
 * - Integration test exercising the public workboard_comment tool path → child 3.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkboardSqliteTestStore } from "../../extensions/workboard/src/test/sqlite-store.js";

const AT_CAP_BODY = "x".repeat(MAX_COMMENT_BODY_LENGTH);
const OVER_CAP_BODY = "x".repeat(MAX_COMMENT_BODY_LENGTH + 1);

describe("addComment cap+sanitizer (child 1 of eae39eff, card 7011ba05)", () => {
  let store: ReturnType<typeof createWorkboardSqliteTestStore>;
  let card: WorkboardCard;

  beforeEach(async () => {
    store = createWorkboardSqliteTestStore();
    card = await store.create({ title: "Cap+Sanitizer card" });
  });

  afterEach(async () => {
    await store.close?.();
  });

  it("accepts a body at exactly MAX_COMMENT_BODY_LENGTH chars", async () => {
    const result = await store.addComment(card.id, { body: AT_CAP_BODY });
    const comments = result.metadata?.comments ?? [];
    expect(comments.at(-1)?.body).toBe(AT_CAP_BODY);
    expect(comments.at(-1)?.body.length).toBe(MAX_COMMENT_BODY_LENGTH);
  });

  it("rejects a body one char over MAX_COMMENT_BODY_LENGTH with the canonical cap message", async () => {
    await expect(store.addComment(card.id, { body: OVER_CAP_BODY })).rejects.toThrow(
      new RegExp(
        `comment body must be ${MAX_COMMENT_BODY_LENGTH} characters or fewer \\(got ${MAX_COMMENT_BODY_LENGTH + 1}\\)`,
      ),
    );
  });

  it("enforces the cap after sanitization — sanitizer cannot truncate below the cap", async () => {
    // A body padded with leading/trailing whitespace must be accepted at the
    // full cap length once the sanitizer trims it. If a sanitizer path were
    // to silently truncate, the cap would be unreachable; instead the
    // post-sanitize length check is the single truncate-or-pass branch.
    const padded = `   ${"y".repeat(MAX_COMMENT_BODY_LENGTH)}   `;
    const result = await store.addComment(card.id, { body: padded });
    const persisted = result.metadata?.comments?.at(-1)?.body ?? "";
    // Sanitizer trimmed the whitespace; length is preserved at the cap.
    expect(persisted.length).toBe(MAX_COMMENT_BODY_LENGTH);
    expect(persisted.startsWith("y")).toBe(true);
    expect(persisted.endsWith("y")).toBe(true);
  });

  it("guards the e297c1c4 brick regression — only the `body` key is length-checked", async () => {
    // Regression for card 875df04e (already merged). Re-asserted here to
    // guarantee the new cap path still extracts only the `body` key.
    const longNotes = "n".repeat(MAX_COMMENT_BODY_LENGTH + 50);
    const result = await store.addComment(card.id, {
      body: "ok",
      notes: longNotes,
      title: longNotes,
    } as never);
    expect(result.metadata?.comments?.at(-1)?.body).toBe("ok");
  });

  it("rejects an over-cap body even when sibling input fields are also long", async () => {
    const longNotes = "n".repeat(3879);
    await expect(
      store.addComment(card.id, {
        body: "z".repeat(MAX_COMMENT_BODY_LENGTH + 1),
        notes: longNotes,
      } as never),
    ).rejects.toThrow(
      new RegExp(`comment body must be ${MAX_COMMENT_BODY_LENGTH} characters or fewer`),
    );
  });

  it("rejects an empty/whitespace-only body with the required-field error", async () => {
    await expect(store.addComment(card.id, { body: "" })).rejects.toThrow(
      /comment body is required/,
    );
    await expect(store.addComment(card.id, { body: "   " })).rejects.toThrow(
      /comment body is required/,
    );
  });

  it("preserves comments-first trimMetadataToBudget behavior — write-path cap is independent", async () => {
    // Two at-cap comments must persist without triggering the trimmer
    // (no other metadata fields, so byte budget is comfortably under
    // MAX_CARD_METADATA_BYTES). This guards the constraint that the
    // comments-first trimMetadataToBudget logic keeps its observable
    // behavior under the new write-path cap.
    const first = await store.addComment(card.id, { body: AT_CAP_BODY });
    const second = await store.addComment(card.id, { body: AT_CAP_BODY });
    const comments = second.metadata?.comments ?? [];
    expect(comments.length).toBe(2);
    expect(comments[0]?.body.length).toBe(MAX_COMMENT_BODY_LENGTH);
    expect(comments[1]?.body.length).toBe(MAX_COMMENT_BODY_LENGTH);
    // First and second are the same card with comments appended; sanity
    // check both writes completed without the trimmer dropping rows.
    expect(first.metadata?.comments?.length).toBe(1);
  });
});
