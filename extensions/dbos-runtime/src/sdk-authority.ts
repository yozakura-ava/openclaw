import { DBOS, DBOSWorkflowConflictError, type WorkflowHandle } from "@dbos-inc/dbos-sdk";
import type { Pool } from "pg";

/** The DBOS system schema owned by the authenticated authority service. */
export const DBOS_AUTHORITY_SCHEMA = "openclaw_authority";
export const DBOS_AUTHORITY_QUEUE = "canonical-authority";
export const DBOS_AUTHORITY_WORKFLOW = "openclawAuthorityOperation";

export type AuthoritySdkOperation = {
  operationId: string;
  workflowId: string;
  operationKey: string;
  kind: "admit" | "start" | "fail" | "complete";
  identity: {
    cardId: string;
    queue: string;
    runId: string;
    attemptId?: string;
    ownerEpoch?: string;
  };
  payload?: unknown;
};

/**
 * This is intentionally a small DBOS workflow. The authority ledger remains
 * the projection used for cross-store reconciliation; this workflow is the
 * DBOS-owned durable command record and execution boundary. It does not write
 * DBOS tables directly and it never calls an external service.
 */
const durableAuthorityOperation = DBOS.registerWorkflow(
  async (operation: AuthoritySdkOperation): Promise<AuthoritySdkOperation> => operation,
  {
    name: DBOS_AUTHORITY_WORKFLOW,
    serialization: "portable",
    maxRecoveryAttempts: 3,
  },
);

export type DbosSdkAuthority = {
  launch(): Promise<void>;
  execute(operation: AuthoritySdkOperation): Promise<void>;
  status(workflowId: string): Promise<unknown>;
  health(): Promise<boolean>;
  shutdown(): Promise<void>;
};

export function createDbosSdkAuthority(options: {
  pool: Pool;
  systemDatabaseUrl?: string;
  applicationVersion?: string;
  schemaName?: string;
  queueName?: string;
}): DbosSdkAuthority {
  const schemaName = options.schemaName ?? DBOS_AUTHORITY_SCHEMA;
  const queueName = options.queueName ?? DBOS_AUTHORITY_QUEUE;
  const applicationVersion =
    options.applicationVersion ??
    process.env.OPENCLAW_DBOS_SDK_APP_VERSION ??
    "canonical-authority";
  let launched = false;
  let queueRegistered = false;

  return {
    async launch() {
      if (launched) {
        return;
      }
      DBOS.setConfig({
        name: "openclaw-canonical-authority",
        systemDatabaseUrl: options.systemDatabaseUrl,
        systemDatabasePool: options.pool,
        systemDatabaseSchemaName: schemaName,
        applicationVersion,
        // The production authority does not ship DBOS's optional Winston/OTLP
        // packages. Keep this explicit so an ambient DBOS__CLOUD value cannot
        // select a logging path whose optional dependencies are absent.
        enableOTLP: false,
        tracingEnabled: false,
        listenQueues: [queueName],
        maxConcurrentQueueDispatches: 2,
        runMigrations: true,
        logLevel: "error",
      });
      await DBOS.launch();
      const queue = await DBOS.registerQueue(queueName, {
        concurrency: 2,
        workerConcurrency: 2,
        onConflict: "never_update",
      });
      if ((await queue.getConcurrency()) !== 2 || (await queue.getWorkerConcurrency()) !== 2) {
        throw new Error("DBOS authority queue concurrency is not exactly two");
      }
      queueRegistered = true;
      launched = true;
    },

    async execute(operation) {
      if (!launched || !queueRegistered) {
        throw new Error("DBOS authority SDK is not launched");
      }
      let handle: WorkflowHandle<AuthoritySdkOperation>;
      try {
        handle = await DBOS.startWorkflow(durableAuthorityOperation, {
          workflowID: operation.operationId,
          queueName,
          workflowAttributes: {
            authorityWorkflowId: operation.workflowId,
            operationKey: operation.operationKey,
            operationKind: operation.kind,
          },
        })(operation);
      } catch (error) {
        if (!(error instanceof DBOSWorkflowConflictError)) {
          throw error;
        }
        const existing = await DBOS.getWorkflowStatus(operation.operationId);
        if (!existing || existing.status !== "SUCCESS") {
          throw new Error(
            "DBOS authority operation identity conflicts with a non-success workflow",
            { cause: error },
          );
        }
        handle = DBOS.retrieveWorkflow<AuthoritySdkOperation>(operation.operationId);
      }
      const result = await handle.getResult({ pollingIntervalMs: 25 });
      if (
        !result ||
        result.operationId !== operation.operationId ||
        result.workflowId !== operation.workflowId ||
        result.operationKey !== operation.operationKey ||
        result.kind !== operation.kind
      ) {
        throw new Error("DBOS authority workflow returned a malformed operation identity");
      }
    },

    async status(workflowId) {
      if (!launched) {
        return undefined;
      }
      return (await DBOS.getWorkflowStatus(workflowId)) ?? undefined;
    },

    async health() {
      return launched && (await options.pool.query("SELECT 1")).rowCount === 1;
    },

    async shutdown() {
      if (!launched) {
        return;
      }
      await DBOS.shutdown();
      launched = false;
      queueRegistered = false;
    },
  };
}
