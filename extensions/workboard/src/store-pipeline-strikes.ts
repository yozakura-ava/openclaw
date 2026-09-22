// Pipeline auto-dispatch dedup helpers (card ee4dda8f).
//
// Extracted 2026-09-20 from store-card-helpers.ts to satisfy the line-cap
// ratchet on that file. The four functions form a coherent module: detect
// "recently failed within cooldown", count consecutive pipeline strikes,
// and decide whether to park a card whose retry budget is exhausted.
//
// All callers continue to import from store-card-helpers.ts via the
// re-export there — no call-site changes required.

import type {
  WorkboardAutomation,
  WorkboardCard,
  WorkboardRunAttempt,
} from "@openclaw/workboard-contract";

export function normalizePipelineStrikeFields(
  record: Record<string, unknown>,
  fallback: WorkboardAutomation,
): Pick<WorkboardAutomation, "pipelineStrikes" | "pipelineStrikesUpdatedAt"> {
  const pipelineStrikes = Object.hasOwn(record, "pipelineStrikes")
    ? (normalizeStrikeTimestamp(record.pipelineStrikes) ?? 0)
    : fallback.pipelineStrikes;
  const pipelineStrikesUpdatedAt = Object.hasOwn(record, "pipelineStrikesUpdatedAt")
    ? normalizeStrikeTimestamp(record.pipelineStrikesUpdatedAt) || undefined
    : fallback.pipelineStrikesUpdatedAt;
  return {
    ...(pipelineStrikes !== undefined ? { pipelineStrikes } : {}),
    ...(pipelineStrikesUpdatedAt ? { pipelineStrikesUpdatedAt } : {}),
  };
}

function normalizeStrikeTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

/**
 * Most-recent run attempt on this card (any terminal status), used to detect
 * "just failed" within the dispatch cooldown window.
 */
export function latestRunAttempt(card: WorkboardCard): WorkboardRunAttempt | undefined {
  const attempts = card.metadata?.attempts;
  if (!attempts || attempts.length === 0) {
    return undefined;
  }
  return attempts[attempts.length - 1];
}

/**
 * True when the card's most-recent attempt ended in a non-successful status
 * (failed/blocked/stopped) within `cooldownMs` of `now`. Pipeline auto-dispatch
 * must NOT re-dispatch a card that recently failed; doing so creates duplicate
 * escalation cards and burns the worker slot.
 */
export function hasRecentFailedAttempt(
  card: WorkboardCard,
  now: number,
  cooldownMs: number,
): boolean {
  const attempt = latestRunAttempt(card);
  if (!attempt || attempt.status === "running" || attempt.status === "succeeded") {
    return false;
  }
  if (typeof attempt.endedAt !== "number") {
    return false;
  }
  return now - attempt.endedAt < cooldownMs;
}

/**
 * Consecutive pipeline strikes accumulated on the card. 0 means the card has
 * not recently failed dispatch attempts.
 */
export function pipelineStrikeCount(card: WorkboardCard): number {
  const strikes = card.metadata?.automation?.pipelineStrikes;
  return typeof strikes === "number" && Number.isFinite(strikes) && strikes > 0
    ? Math.trunc(strikes)
    : 0;
}

/**
 * True when the card has exhausted its pipeline retry budget and must be
 * parked in `blocked` rather than re-dispatched. Caller parks the card with
 * a notification + worker-log entry explaining the saturation.
 */
