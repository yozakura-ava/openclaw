import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { sql } from "kysely";
import type { DoctorSessionScanScope } from "../../../config/sessions/session-accessor.sqlite-canonical-inventory.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../../config/sessions/session-accessor.sqlite-scope.js";
import { LEGACY_SESSION_ENTRY_STATE_FIELDS } from "../../../config/sessions/session-entry-state-format.js";
import { assertSupportedSessionStoreEntry } from "../../../config/sessions/supported-session-store.js";
import { iterateSqliteQuerySync } from "../../../infra/kysely-sync.js";
import type { DatabaseFileIdentity } from "../../../infra/sqlite-worker-identity.js";
import { assertOpenClawAgentDatabaseIdentity } from "../../../state/openclaw-agent-db-identity.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../../state/openclaw-agent-db-readonly.js";

/** Select legacy state before loading raw rows into canonical validation or runtime projection. */
export function scanDoctorSessionEntryRecords(
  scope: DoctorSessionScanScope,
  visit: (record: { sessionKey: string; entry: Record<string, unknown> }) => void,
  expectedIdentity: DatabaseFileIdentity,
): void {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    assertOpenClawAgentDatabaseIdentity(database, expectedIdentity);
    for (const row of iterateSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .selectFrom("session_nodes")
        .select(["session_key", "entry_json"])
        .where(
          /* kysely-allow-raw: coarse key filtering bounds parsing; JSON.parse owns duplicate-key precedence. */
          sql<boolean>`CASE WHEN json_valid(entry_json) THEN EXISTS (
            SELECT 1 FROM json_each(entry_json)
            WHERE key IN (${sql.join(LEGACY_SESSION_ENTRY_STATE_FIELDS)})
              OR key IN ('provider', 'lastProvider', 'room')
              OR (key = 'pendingFinalDelivery' AND type IN ('true', 'false'))
              OR (key = 'status' AND value IN ('running', 'queued'))
          ) ELSE 1 END`,
        ),
    )) {
      const entry = safeParseJsonRecord(row.entry_json);
      if (entry) {
        assertSupportedSessionStoreEntry(entry);
        visit({ sessionKey: row.session_key, entry });
      }
    }
  }, toDatabaseOptions(resolved));
  if (!result.found) {
    throw new Error(`Session database unavailable during raw state inspection: ${result.reason}`);
  }
}
