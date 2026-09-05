import type { WorkboardChange } from "@openclaw/workboard-contract";
import type { OpenClawPluginService } from "../api.js";
import type { WorkboardStore } from "./store.js";

const WORKBOARD_EXTERNAL_CHANGE_CHECK_MS = 1000;

export type WorkboardChangeEventService = OpenClawPluginService & {
  onStoreAvailable: () => void;
};

export function createWorkboardChangeEventService(params: {
  store: WorkboardStore;
  isStoreAvailable?: () => boolean;
  onStoreFailure?: (error: unknown) => void;
}): WorkboardChangeEventService;
export function createWorkboardChangeEventService(
  store: WorkboardStore,
): WorkboardChangeEventService;
export function createWorkboardChangeEventService(
  input:
    | WorkboardStore
    | {
        store: WorkboardStore;
        isStoreAvailable?: () => boolean;
        onStoreFailure?: (error: unknown) => void;
      },
): WorkboardChangeEventService {
  const params: {
    store: WorkboardStore;
    isStoreAvailable?: () => boolean;
    onStoreFailure?: (error: unknown) => void;
  } = "isStoreAvailable" in input || "onStoreFailure" in input ? input : { store: input };
  const isStoreAvailable = params.isStoreAvailable ?? (() => true);
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let context: Parameters<OpenClawPluginService["start"]>[0] | undefined;

  const bind = () => {
    if (!context || !context.gatewayEvents || unsubscribe || !isStoreAvailable()) {
      return;
    }
    const gatewayEvents = context.gatewayEvents;
    const emit = (change: WorkboardChange) => {
      gatewayEvents.emit("changed", change, {
        scope: "operator.read",
      });
    };
    try {
      unsubscribe = params.store.subscribeChanges(emit);
      params.store.announceChangeEpoch();
      timer = setInterval(() => {
        if (!isStoreAvailable()) {
          return;
        }
        try {
          params.store.reconcileExternalChanges();
        } catch (error) {
          context?.logger.warn(`workboard external change check failed: ${String(error)}`);
          params.onStoreFailure?.(error);
        }
      }, WORKBOARD_EXTERNAL_CHANGE_CHECK_MS);
      timer.unref?.();
    } catch (error) {
      context.logger.warn(`workboard change-event service paused: ${String(error)}`);
      params.onStoreFailure?.(error);
    }
  };

  return {
    id: "workboard-change-events",
    start(ctx) {
      context = ctx;
      bind();
    },
    onStoreAvailable() {
      bind();
    },
    stop() {
      unsubscribe?.();
      unsubscribe = undefined;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      context = undefined;
    },
  };
}
