import type { DatabaseFileIdentity } from "../../infra/sqlite-worker-identity.js";
import type { DoctorSessionScanScope } from "./session-accessor.sqlite-canonical-inventory.js";

export type SessionRunOutcomesWorkerInput = {
  kind: "session-run-outcomes";
  database: { agentId: string; path: string };
  scope: DoctorSessionScanScope;
  expectedIdentity: DatabaseFileIdentity;
};

export type SessionRunOutcomesWorkerValues = {
  "session-run-outcomes": { kind: "session-run-outcomes"; sessionKeys: string[] };
};
