// Pipeline auto-dispatch strike bookkeeping (rebuild of card ee4dda8f / PR #118).
//
// The strike map is deliberately in-memory: a Gateway restart clears it, so
// the dedup gate must not treat an empty map as "safe to dispatch" — the
// persisted run attempts on the card remain authoritative after a restart.

import type { WorkboardCard, WorkboardRunAttempt } from "@openclaw/workboard-contract";

export type PipelineStrike = {
  cardId: string;
  skippedAt: number;
  reason: string;
};

const MAX_STRIKES_PER_CARD = 16;

export class PipelineStrikeMap {
  private readonly strikes = new Map<string, PipelineStrike[]>();

  record(cardId: string, skippedAt: number, reason: string): PipelineStrike {
    const strike: PipelineStrike = { cardId, skippedAt, reason };
    const entries = this.strikes.get(cardId) ?? [];
    entries.push(strike);
    this.strikes.set(cardId, entries.slice(-MAX_STRIKES_PER_CARD));
    return strike;
  }

  /** Most recent strike for the card id, or undefined when none exists. */
  lookup(cardId: string): PipelineStrike | undefined {
    const entries = this.strikes.get(cardId);
    return entries && entries.length > 0 ? entries[entries.length - 1] : undefined;
  }

  hasRecentStrike(cardId: string, now: number, windowMs: number): boolean {
    const entries = this.strikes.get(cardId) ?? [];
    return entries.some((strike) => now - strike.skippedAt < windowMs);
  }

  clear(): void {
    this.strikes.clear();
  }

  get size(): number {
    return this.strikes.size;
  }
}

/** Most-recent run attempt on this card (any status). */
function latestRunAttempt(card: WorkboardCard): WorkboardRunAttempt | undefined {
  const attempts = card.metadata?.attempts;
  return attempts && attempts.length > 0 ? attempts[attempts.length - 1] : undefined;
}

/**
 * True when the card's most-recent attempt ended in a terminal failure
 * (failed/blocked/stopped) within `cooldownMs` of `now`. Re-dispatching a
 * card that just failed duplicates escalation work and burns worker slots.
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
  return typeof attempt.endedAt === "number" && now - attempt.endedAt < cooldownMs;
}

/** Consecutive pipeline strikes persisted on the card automation, if any. */
export function pipelineStrikeCount(card: WorkboardCard): number {
  const automation = card.metadata?.automation as Record<string, unknown> | undefined;
  const strikes = automation?.["pipelineStrikes"];
  return typeof strikes === "number" && Number.isFinite(strikes) && strikes > 0
    ? Math.trunc(strikes)
    : 0;
}
