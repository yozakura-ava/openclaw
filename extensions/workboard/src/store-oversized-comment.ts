/**
 * Sibling module for `WorkboardCoreStore.addOversizedComment`. Extracted from
 * `store-core.ts` to keep that file under the line-cap ratchet; the class
 * delegates here when `addComment` sees a body above MAX_COMMENT_BODY_LENGTH.
 *
 * The whole split sequence (preflight + chunk writes) runs inside ONE
 * mutation-queue section: a preflight read outside the queue would race
 * concurrent oversized comments (TOCTOU — both pass the budget check,
 * interleave writes, and drop leading chunks). `updateLatestCard` is the
 * non-enqueuing write primitive; nesting `updateMetadata` here would
 * deadlock the serial queue.
 */
import { randomUUID } from "node:crypto";
import { assertCanMutateClaimedCard, splitCommentBody } from "./store-card-helpers.js";
import {
  MAX_CARD_COMMENTS,
  MAX_CARD_METADATA_BYTES,
  MAX_COMMENT_BODY_LENGTH,
} from "./store-constants.js";
import type { WorkboardCard, WorkboardMutationScope } from "./store-inputs.js";

type CardUpdater = (current: WorkboardCard) => { metadata?: WorkboardCard["metadata"] };

interface OversizedCommentHost {
  enqueueMutation<T>(fn: () => Promise<T>): Promise<T>;
  updateLatestCard(id: string, updater: CardUpdater): Promise<{ card: WorkboardCard }>;
  get(id: string): Promise<WorkboardCard | undefined>;
}

interface AddCommentHost extends OversizedCommentHost {
  updateMetadata(
    id: string,
    updater: (existing: WorkboardCard) => WorkboardCard["metadata"] | undefined,
  ): Promise<WorkboardCard>;
}

/**
 * Write a comment, splitting into labeled chunks when the body exceeds
 * {@link MAX_COMMENT_BODY_LENGTH}. The single-row path uses the standard
 * `updateMetadata` primitive; the split path falls through to
 * {@link addOversizedComment} which keeps the whole split sequence inside one
 * mutation-queue section (no nested `updateMetadata` calls).
 *
 * @param recovery when true, allow the write to proceed against an EXPIRED
 *   claim whose grace window has elapsed. Used by reclaim-then-handoff flows
 *   to record context before re-claiming. Defaults to false (strict).
 */
export async function addCommentWithChunking(
  host: AddCommentHost,
  id: string,
  body: string,
  scope: WorkboardMutationScope | undefined,
  recovery = false,
): Promise<WorkboardCard> {
  const now = Date.now();
  if (body.length > MAX_COMMENT_BODY_LENGTH) {
    return await addOversizedComment(host, id, body, scope, now, recovery);
  }
  const comment = { id: randomUUID(), body, createdAt: now };
  return await host.updateMetadata(id, (existing) => {
    assertCanMutateClaimedCard(existing, scope, recovery);
    return {
      ...existing.metadata,
      comments: [...(existing.metadata?.comments ?? []), comment].slice(-MAX_CARD_COMMENTS),
    };
  });
}

/**
 * Internal oversized-comment write primitive. Not exported — only invoked
 * from {@link addCommentWithChunking} when a body exceeds
 * {@link MAX_COMMENT_BODY_LENGTH}. Kept as a top-level function so the
 * mutation-queue section is self-contained.
 */
async function addOversizedComment(
  host: OversizedCommentHost,
  id: string,
  body: string,
  scope: WorkboardMutationScope | undefined,
  now: number,
  recovery = false,
): Promise<WorkboardCard> {
  return await host.enqueueMutation(async () => {
    // Reserve space for "(N/M)" continuation labels so no labeled chunk
    // exceeds the body cap. 20 chars covers bodies up to ~1 GiB worth of
    // chunks (worst-case label is " (245894/245894)" = 17 chars).
    const LABEL_RESERVE = 20;
    const rawChunks = splitCommentBody(body, MAX_COMMENT_BODY_LENGTH - LABEL_RESERVE);
    const total = rawChunks.length;
    if (total < 2) {
      // Single-chunk edge case (whitespace boundary produced one oversized chunk).
      const comment = { id: randomUUID(), body: rawChunks[0] ?? body, createdAt: now };
      const single = await host.updateLatestCard(id, (current) => ({
        metadata: {
          ...current.metadata,
          comments: [...(current.metadata?.comments ?? []), comment].slice(-MAX_CARD_COMMENTS),
        },
      }));
      return single.card;
    }
    // Label continuation chunks with " (N/M)". The first chunk stays intact so
    // the rendered comment begins with the operator's original wording.
    const labeledChunks = rawChunks.map((chunk, index) =>
      index === 0 ? chunk : `${chunk} (${index + 1}/${total})`,
    );
    // Preflight inside the queued section: reject unrepresentable splits
    // BEFORE writing anything. The comment sequence is retained by trimming
    // oldest rows, so a split that cannot fit alongside the existing
    // comments (row budget or aggregate metadata byte budget) would
    // silently drop leading chunks while still reporting success.
    const preflightCard = await host.get(id);
    if (!preflightCard) {
      throw new Error(`card ${id} not found.`);
    }
    const existingComments = preflightCard.metadata?.comments ?? [];
    if (existingComments.length + labeledChunks.length > MAX_CARD_COMMENTS) {
      throw new Error(
        `oversized comment split would need ${labeledChunks.length} chunks, exceeding the ` +
          `comment budget (${MAX_CARD_COMMENTS} rows, ${existingComments.length} already present); ` +
          `nothing was written`,
      );
    }
    const COMMENT_ROW_OVERHEAD_BYTES = 120;
    // Byte-budget in the same units the trimmer enforces (UTF-8, via
    // Buffer.byteLength) - JSON.stringify().length counts UTF-16 code
    // units and undercounts Unicode-heavy bodies, letting the write pass
    // preflight and then silently drop rows in the per-write trimmer.
    const estimatedMetadataBytes =
      Buffer.byteLength(JSON.stringify(preflightCard.metadata ?? {}), "utf8") +
      labeledChunks.reduce(
        (sum, chunk) => sum + Buffer.byteLength(chunk, "utf8") + COMMENT_ROW_OVERHEAD_BYTES,
        0,
      );
    if (estimatedMetadataBytes > MAX_CARD_METADATA_BYTES) {
      throw new Error(
        `oversized comment split would exceed the card metadata budget ` +
          `(${estimatedMetadataBytes} > ${MAX_CARD_METADATA_BYTES} bytes); nothing was written`,
      );
    }
    // Write each chunk sequentially as its own comment row. On mid-sequence
    // failure the chunks already persisted stay on the card; the ORIGINAL
    // error is rethrown with split-progress attached (identity preserved).
    const written: number[] = [];
    let lastCard: WorkboardCard | undefined;
    try {
      for (const [index, chunk] of labeledChunks.entries()) {
        const comment = {
          id: randomUUID(),
          body: chunk,
          createdAt: now + index,
        };
        const result = await host.updateLatestCard(id, (current) => {
          assertCanMutateClaimedCard(current, scope, recovery);
          return {
            metadata: {
              ...current.metadata,
              comments: [...(current.metadata?.comments ?? []), comment].slice(-MAX_CARD_COMMENTS),
            },
          };
        });
        lastCard = result.card;
        written.push(index + 1);
      }
    } catch (error) {
      const progress =
        written.length > 0
          ? `chunks ${written.join(", ")} of ${total} were persisted before the failure`
          : "no chunks were persisted before the failure";
      if (error instanceof Error) {
        (error as Error & { splitProgress?: string }).splitProgress = progress;
        throw error;
      }
      throw new Error(`oversized comment split failed (${progress}): ${String(error)}`, {
        cause: error,
      });
    }
    if (!lastCard) {
      throw new Error("oversized comment split produced no chunks.");
    }
    return lastCard;
  });
}
