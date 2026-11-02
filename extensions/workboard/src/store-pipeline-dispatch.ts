// Pipeline auto-dispatch routing gate + dedup decision (rebuild of card
// ee4dda8f / PR #118). The gate applies ONLY to the auto-dispatch
// ("scheduled") path in the dispatcher; operator-initiated exact starts keep
// current semantics. Re-enable/suppress the guard via the env flag below.

import type { WorkboardCard } from "@openclaw/workboard-contract";
import {
  hasRecentFailedAttempt,
  PipelineStrikeMap,
  type PipelineStrike,
} from "./store-pipeline-strikes.js";

/** Dedup window: a skipped dispatch blocks re-dispatch attempts this long. */
export const PIPELINE_DEDUP_WINDOW_MS = 10 * 60 * 1000;

export type PipelineDispatchGate = {
  strikes: PipelineStrikeMap;
  windowMs: number;
  enabled: boolean;
};

/**
 * Guard kill-switch. ON by default; OPENCLAW_PIPELINE_DEDUP_GUARD=0|false|off
 * disables the dedup gate (negative-control / emergency escape hatch).
 */
export function pipelineDedupGuardEnabled(
  env: { readonly [key: string]: string | undefined } = process.env,
): boolean {
  const value = env.OPENCLAW_PIPELINE_DEDUP_GUARD?.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "off");
}

export function pipelineDispatchGateFromOptions(params: {
  strikes: PipelineStrikeMap;
  guard?: boolean;
  windowMs?: number;
}): PipelineDispatchGate {
  return {
    strikes: params.strikes,
    windowMs: params.windowMs ?? PIPELINE_DEDUP_WINDOW_MS,
    enabled: params.guard ?? pipelineDedupGuardEnabled(),
  };
}

/**
 * Decide whether the dispatcher must skip this card's auto-dispatch tick.
 * When the gate is enabled and the card was dispatched recently (a recorded
 * strike inside the window) or its latest run attempt failed inside the
 * window, a strike is recorded and the skip reason returned. Returning a
 * strike means "skip"; undefined means "dispatch may proceed".
 */
export function evaluatePipelineDispatchGate(params: {
  card: WorkboardCard;
  now: number;
  gate: PipelineDispatchGate;
}): PipelineStrike | undefined {
  const { card, now, gate } = params;
  if (!gate.enabled) {
    return undefined;
  }
  const reason = gate.strikes.hasRecentStrike(card.id, now, gate.windowMs)
    ? `Pipeline dispatch dedup: card skipped again within ${gate.windowMs}ms window.`
    : hasRecentFailedAttempt(card, now, gate.windowMs)
      ? "Pipeline dispatch dedup: latest run attempt failed within the dedup window."
      : undefined;
  return reason === undefined ? undefined : gate.strikes.record(card.id, now, reason);
}
