import { randomUUID } from "node:crypto";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import {
  DISPATCH_COOLDOWN_MS,
  MAX_CARD_NOTIFICATIONS,
  MAX_CARD_WORKER_LOGS,
  MAX_PIPELINE_RETRY_STRIKES,
} from "./store-constants.js";
import type { WorkboardCardPatch } from "./store-inputs.js";
import { normalizeAutomation } from "./store-normalizers.js";
import { hasRecentFailedAttempt, pipelineStrikeCount } from "./store-pipeline-strikes.js";

export async function applyPipelineAutoDispatch(params: {
  card: WorkboardCard;
  now: number;
  updateCard: (id: string, patch: WorkboardCardPatch) => Promise<WorkboardCard>;
  nextNotificationSequence: (now: number) => number;
}): Promise<{ card: WorkboardCard; blocked: boolean }> {
  const { card, now } = params;
  if (card.status !== "ready" || card.metadata?.archivedAt || !card.agentId?.trim()) {
    return { card, blocked: false };
  }
  if (!hasRecentFailedAttempt(card, now, DISPATCH_COOLDOWN_MS)) {
    return {
      card: await updateWithDispatch(params, pipelineStrikeCount(card) > 0 ? 0 : undefined),
      blocked: false,
    };
  }
  const nextStrikes = pipelineStrikeCount(card) + 1;
  if (nextStrikes < MAX_PIPELINE_RETRY_STRIKES) {
    return { card: await updateWithDispatch(params, nextStrikes), blocked: false };
  }
  const saturationReason = `Card exhausted pipeline auto-dispatch retries (${nextStrikes}/${MAX_PIPELINE_RETRY_STRIKES} strikes within ${DISPATCH_COOLDOWN_MS}ms cooldown). Orchestrator review required.`;
  const execution =
    card.execution?.status === "running"
      ? { ...card.execution, status: "blocked" as const, updatedAt: now }
      : card.execution;
  const updated = await params.updateCard(card.id, {
    status: "blocked",
    ...(execution ? { execution } : {}),
    metadata: {
      ...card.metadata,
      automation: normalizeAutomation(
        {
          ...card.metadata?.automation,
          pipelineStrikes: 0,
          pipelineStrikesUpdatedAt: now,
        },
        card.metadata?.automation,
      ),
      notifications: [
        ...(card.metadata?.notifications ?? []),
        {
          id: randomUUID(),
          kind: "failed" as const,
          createdAt: now,
          sequence: params.nextNotificationSequence(now),
          message: saturationReason,
        },
      ].slice(-MAX_CARD_NOTIFICATIONS),
      workerLogs: [
        ...(card.metadata?.workerLogs ?? []),
        {
          id: randomUUID(),
          level: "warning" as const,
          message: `Pipeline dispatch saturated; orchestrator review recommended. ${saturationReason}`,
          createdAt: now,
        },
      ].slice(-MAX_CARD_WORKER_LOGS),
    },
  });
  return { card: updated, blocked: true };
}

async function updateWithDispatch(
  params: Parameters<typeof applyPipelineAutoDispatch>[0],
  pipelineStrikes?: number,
): Promise<WorkboardCard> {
  const automation = normalizeAutomation(
    {
      ...params.card.metadata?.automation,
      dispatchCount: (params.card.metadata?.automation?.dispatchCount ?? 0) + 1,
      lastDispatchAt: params.now,
      ...(pipelineStrikes !== undefined ? { pipelineStrikes } : {}),
    },
    params.card.metadata?.automation,
  );
  return await params.updateCard(params.card.id, {
    metadata: { ...params.card.metadata, ...(automation ? { automation } : {}) },
  });
}
