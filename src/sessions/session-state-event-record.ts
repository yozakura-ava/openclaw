import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import type { SessionStateActorType, SessionStateEventKind } from "./session-state-event-kinds.js";
import type { SessionStateEventRow } from "./session-state-events.kernel.js";

export type SessionStateEventRecord = {
  sequence: number;
  sessionKey: string;
  sessionId?: string;
  agentId: string;
  kind: SessionStateEventKind;
  actorType: SessionStateActorType;
  actorId?: string;
  runId?: string;
  occurredAt: number;
  summary: string;
  payload?: Record<string, unknown>;
};

export function rowToSessionStateEvent(row: SessionStateEventRow): SessionStateEventRecord {
  const payload = row.payload_json ? safeParseJsonRecord(row.payload_json) : undefined;
  return {
    sequence: normalizeSqliteNumber(row.sequence) ?? 0,
    sessionKey: row.session_key,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    agentId: row.agent_id,
    kind: row.kind as SessionStateEventKind,
    actorType: row.actor_type as SessionStateActorType,
    ...(row.actor_id ? { actorId: row.actor_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    occurredAt: normalizeSqliteNumber(row.occurred_at) ?? 0,
    summary: row.summary,
    ...(payload ? { payload } : {}),
  };
}
