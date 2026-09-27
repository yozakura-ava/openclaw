import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { ensureTaskRegistryReady } from "./runtime-internal.js";
import { createTaskMaintenanceScheduler } from "./task-registry-maintenance-scheduler.js";

export function createTaskRegistryMaintenanceLifecycle(
  runSweep: () => Promise<unknown>,
  runFlowMaintenance: () => Promise<unknown>,
  onError: (error: unknown) => void,
) {
  const scheduler = createTaskMaintenanceScheduler(
    async () => {
      await runSweep();
      await runFlowMaintenance();
    },
    onError,
  );
  return {
    start(gatewayScheduler?: GatewayScheduler) {
      ensureTaskRegistryReady();
      scheduler.start(gatewayScheduler);
    },
    stop: () => scheduler.stop(),
  };
}
