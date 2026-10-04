import { randomUUID } from "node:crypto";
import { MAX_COMMENT_BODY_LENGTH } from "@openclaw/workboard-contract";
import { assertCanMutateClaimedCard } from "./store-card-helpers.js";
import { MAX_CARD_COMMENTS } from "./store-constants.js";
import type { WorkboardCard, WorkboardComment, WorkboardMutationScope } from "./store-types.js";

/**
 * Chunked storage path for comments whose body length exceeds
 * {@link MAX_COMMENT_BODY_LENGTH}. The single-row `updateMetadata` path in
 * addComment rejects oversize bodies with the canonical
 * `comment body must be 4096 characters or fewer (got N)` error; this module
 * adds an alternate storage layout that splits an oversize body into
 * labeled continuations so e297c1c4-class cards hydrate and mutate again.
 *
 * Invariants:
 *   - Each chunked body has sanitize+cap applied per-chunk (no chunk can
 *     exceed MAX_COMMENT_BODY_LENGTH).
 *   - sum(chunks) === original body length (lossless split; only an
 *     optional "(N/M)" continuation label is added, reserved at split
 *     time so the per-chunk cap is never exceeded).
 *   - The chunked Comment objects reuse the same WorkboardComment type;
 *     continuation is encoded in the body text "(N/M)" suffix so the
 *     on-disk format stays compatible with the existing comments[] array.
 *
 * API (Rin SPEC-CLEARED, child 2 of eae39eff, card 9a97b80d):
 *   - writeChunk: append a single labeled chunk to the comments array.
 *   - readChunk: locate a chunk by id (or by ordinal in a group).
 *   - listChunks: enumerate chunks belonging to a logical comment group.
 *   - compact: collapse a chunk group into a single comment (used when
 *     a recovery path rewrites history).
 */
export const CHUNK_LABEL_RE = /^(.*?) \((\d+)\/(\d+)\)$/;

const LABEL_OVERHEAD = " (NNN/NNN)".length; // 11 chars worst-case: "(9999/9999)"

/** Reserved label length per chunk: ensures sum(chunks) + labels fits MAX_COMMENT_BODY_LENGTH per chunk. */
export function chunkedBodyReserve(totalChunks: number, chunkIndex: number): number {
  // Label format: " (i/N)" — six parts: " ", "(", index digits, "/", total digits, ")".
  const width = Math.max(1, String(totalChunks).length);
  return 1 + 1 + String(chunkIndex).length + 1 + width + 1;
}

/** Maximum usable body length per chunk for the given total chunk count, never below 1. */
export function chunkedBodyLimit(totalChunks: number): number {
  // Worst-case label overhead when chunkIndex = totalChunks (label suffix),
  // so reserve for the index digits as if we were the last chunk.
  const reserved = chunkedBodyReserve(totalChunks, totalChunks);
  return Math.max(1, MAX_COMMENT_BODY_LENGTH - reserved);
}

/**
 * Split an oversize body into N labeled chunks, each at or below
 * MAX_COMMENT_BODY_LENGTH. The returned body strings preserve every byte
 * of the original body (no truncation). Sanitize is the caller's job — the
 * addComment path already trims whitespace before this is reached, and the
 * label suffix is the only non-input data added.
 */
export function splitOversizedBody(body: string): string[] {
  if (body.length <= MAX_COMMENT_BODY_LENGTH) {
    return [body];
  }
  // First pass: assume 2 chunks to size the label; iterate until label overhead fits.
  let total = 2;
  for (;;) {
    const limit = chunkedBodyLimit(total);
    if (limit * total >= body.length) break;
    total += 1;
    if (total > 9999) {
      // Defensive: an oversize body beyond ~4M chars cannot be labeled under our cap.
      throw new Error(
        `comment body too large to chunk (${body.length} chars exceeds supported ${total} chunks).`,
      );
    }
  }
  const limit = chunkedBodyLimit(total);
  const chunks: string[] = [];
  for (let i = 1; i <= total; i += 1) {
    const start = (i - 1) * limit;
    const end = Math.min(body.length, start + limit);
    const slice = body.slice(start, end);
    const label = ` (${i}/${total})`;
    chunks.push(`${slice}${label}`);
  }
  return chunks;
}

export interface OversizedCommentHost {
  /** Append a labeled chunk to a card's comments[] (single-row update). */
  updateMetadata(
    id: string,
    mutator: (existing: WorkboardCard) => WorkboardCard,
  ): Promise<WorkboardCard>;
  /** Apply a per-chunk label-bearing mutation under the mutation-queue section (used by addOversizedComment). */
  updateLatestCard(
    id: string,
    mutator: (existing: WorkboardCard) => WorkboardCard,
  ): Promise<WorkboardCard>;
  enqueueMutation<T>(work: () => Promise<T>): Promise<T>;
}

/**
 * Append a single labeled chunk to a card's comments[] array. The cap is
 * re-checked on every call so a stray oversized chunk cannot sneak through
 * the chunked path. The per-chunk reserve comes from {@link chunkedBodyLimit}.
 */
export async function writeChunk(
  host: OversizedCommentHost,
  cardId: string,
  chunk: WorkboardComment,
  scope: WorkboardMutationScope | undefined,
): Promise<WorkboardCard> {
  if (chunk.body.length > MAX_COMMENT_BODY_LENGTH) {
    throw new Error(
      `chunk body must be ${MAX_COMMENT_BODY_LENGTH} characters or fewer (got ${chunk.body.length}).`,
    );
  }
  return await host.updateMetadata(cardId, (existing) => {
    assertCanMutateClaimedCard(existing, scope);
    return {
      ...existing.metadata,
      comments: [...(existing.metadata?.comments ?? []), chunk].slice(-MAX_CARD_COMMENTS),
    };
  });
}

/** Read a chunk by id. Returns undefined when the chunk is not in this card's comments. */
export function readChunk(card: WorkboardCard, chunkId: string): WorkboardComment | undefined {
  return card.metadata?.comments?.find((c) => c.id === chunkId);
}

/**
 * Enumerate all chunks belonging to a logical comment group. The `groupId`
 * argument may be either a chunk id (any chunk from the group — its label
 * `(N/M)` total is used to identify siblings) or a `chunk:${M}` key produced
 * by {@link chunkGroupId}. Chunks are returned in `(i/M)` label order.
 */
export function listChunks(card: WorkboardCard, groupId: string): WorkboardComment[] {
  const all = card.metadata?.comments ?? [];
  // Fast path: groupId may already be a "chunk:${M}" key from chunkGroupId.
  const directMatch = groupId.match(/^chunk:(\d+)$/);
  let refTotal: string | undefined = directMatch?.[1];
  if (refTotal === undefined) {
    const ref = all.find((c) => c.id === groupId);
    if (!ref) return [];
    const refMatch = ref.body.match(CHUNK_LABEL_RE);
    if (!refMatch) return [ref];
    refTotal = refMatch[3];
  }
  return all
    .filter((c) => {
      const m = c.body.match(CHUNK_LABEL_RE);
      return m !== null && m[3] === refTotal;
    })
    .sort((a, b) => chunkLabelSortKey(a) - chunkLabelSortKey(b));
}

/**
 * Collapse a chunk group into a single comment by concatenating the
 * label-stripped bodies in order. Used when a recovery path needs to
 * rewrite history (e.g. reconciling split comments after a downgrade
 * of MAX_COMMENT_BODY_LENGTH). The resulting comment is appended as a
 * fresh entry with a new id; original chunks remain untouched.
 */
export async function compact(
  host: OversizedCommentHost,
  cardId: string,
  groupId: string,
  scope: WorkboardMutationScope | undefined,
): Promise<WorkboardCard | undefined> {
  const card = await host.updateMetadata(cardId, (existing) => existing);
  const chunks = listChunks(card, groupId);
  if (chunks.length === 0) return undefined;
  const reassembled = chunks.map((c) => stripChunkLabel(c.body)).join("");
  const merged: WorkboardComment = {
    id: randomUUID(),
    body: reassembled,
    createdAt: chunks[0]?.createdAt ?? Date.now(),
  };
  return await host.updateMetadata(cardId, (existing) => {
    assertCanMutateClaimedCard(existing, scope);
    return {
      ...existing.metadata,
      comments: [...(existing.metadata?.comments ?? []), merged].slice(-MAX_CARD_COMMENTS),
    };
  });
}

/* ------------------------------------------------------------------ */
/* Internal helpers                                                   */
/* ------------------------------------------------------------------ */

/** Stable group id derived from a chunk's label `(N/M)` total. Chunks from the
 * same split share the same M; non-labeled comments belong to their own single-id
 * group. Group identity is the (N/M) total so all chunks from a single logical
 * comment are enumerated together even when their ids are independently random. */
export function chunkGroupId(comment: WorkboardComment): string {
  const match = comment.body.match(CHUNK_LABEL_RE);
  if (!match) {
    return `single:${comment.id}`;
  }
  return `chunk:${match[3]}`;
}

/** Strip the "(N/M)" label suffix from a chunked body. */
export function stripChunkLabel(body: string): string {
  const match = body.match(CHUNK_LABEL_RE);
  return match ? match[1] : body;
}

/** Sort key derived from "(N/M)" label; non-labeled comments sort last. */
function chunkLabelSortKey(comment: WorkboardComment): number {
  const match = comment.body.match(CHUNK_LABEL_RE);
  if (!match) return Number.MAX_SAFE_INTEGER;
  return Number.parseInt(match[2] ?? "0", 10);
}

/** Re-export for callers needing the single-source-of-truth cap. */
export { MAX_COMMENT_BODY_LENGTH };
