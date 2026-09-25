import { isMainThread } from "node:worker_threads";

const PROCESS_HEAP_FLAG_PATTERN = /(?:^|\s)--max-(?:old-space|heap)-size(?:=|\s+)(\d+)/u;
let processHeapLimitWarningEmitted = false;

/** Return process-wide V8 heap flags that override worker resourceLimits. */
export function getPreparedModelCatalogProcessHeapFlags(env = process.env): string[] {
  const values = [env.NODE_OPTIONS ?? "", ...process.execArgv];
  return values.filter((value) => PROCESS_HEAP_FLAG_PATTERN.test(value));
}

/** Warn managed gateways when their launch policy defeats the catalog worker budget. */
export function warnIfPreparedModelCatalogWorkerLimitIsOverridden(
  env = process.env,
): readonly string[] {
  if (!isMainThread || processHeapLimitWarningEmitted) {
    return [];
  }
  const managedGateway =
    env.OPENCLAW_SERVICE_KIND === "gateway" || env.OPENCLAW_SYSTEMD_UNIT === "openclaw.service";
  if (!managedGateway) {
    return [];
  }
  const flags = getPreparedModelCatalogProcessHeapFlags(env);
  if (flags.length > 0) {
    processHeapLimitWarningEmitted = true;
    process.emitWarning(
      `managed gateway process-wide V8 heap flags override the prepared catalog worker limit (${flags.join(
        ", ",
      )}); remove --max-old-space-size from ExecStart/NODE_OPTIONS`,
      { code: "OPENCLAW_CATALOG_WORKER_HEAP_LIMIT" },
    );
  }
  return flags;
}

if (isMainThread) {
  warnIfPreparedModelCatalogWorkerLimitIsOverridden();
}
