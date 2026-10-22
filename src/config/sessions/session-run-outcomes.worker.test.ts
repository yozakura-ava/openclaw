import { expect, it, vi } from "vitest";

const { scanDoctorSessionEntryRecords, assertExistingDatabaseIdentity } = vi.hoisted(() => ({
  scanDoctorSessionEntryRecords: vi.fn(),
  assertExistingDatabaseIdentity: vi.fn(),
}));
vi.mock("../../commands/doctor/shared/session-entry-scan.js", () => ({
  scanDoctorSessionEntryRecords,
}));
vi.mock("../../infra/sqlite-worker-identity.js", () => ({ assertExistingDatabaseIdentity }));

import {
  isSessionHistoryReadOperation,
  prepareSessionHistoryReadOperation,
} from "./session-history-read-operation.worker.js";

it("scans legacy run outcomes through a durable history read operation", async () => {
  const request = {
    kind: "session-run-outcomes" as const,
    database: { agentId: "main", path: "/synthetic/agent.sqlite" },
    scope: { agentId: "main", storePath: "/synthetic/agent.sqlite" },
    expectedIdentity: { key: "synthetic-identity", birthtime: 1 },
  };
  scanDoctorSessionEntryRecords.mockImplementation((scope, visit) => {
    visit({ sessionKey: "legacy-running", entry: { status: "running" } });
    visit({ sessionKey: "already-complete", entry: { status: "complete" } });
  });

  expect(isSessionHistoryReadOperation(request)).toBe(true);
  const execute = await prepareSessionHistoryReadOperation(request);
  expect(execute()).toEqual({ kind: "session-run-outcomes", sessionKeys: ["legacy-running"] });
  expect(scanDoctorSessionEntryRecords).toHaveBeenCalledWith(
    request.scope,
    expect.any(Function),
    request.expectedIdentity,
  );
});
