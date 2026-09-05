import type { OpenClawPluginApi } from "../api.js";
import type { WorkboardStore } from "./store.js";

export function registerWorkboardStoreLifecycle(
  api: OpenClawPluginApi,
  store: WorkboardStore,
  stopServices?: () => void,
): void {
  api.lifecycle.registerRuntimeLifecycle({
    id: "workboard-sqlite-store",
    cleanup: ({ reason, sessionKey, runId }) => {
      if (
        sessionKey === undefined &&
        runId === undefined &&
        (reason === "disable" || reason === "restart")
      ) {
        stopServices?.();
        store.close();
      }
    },
  });
}
