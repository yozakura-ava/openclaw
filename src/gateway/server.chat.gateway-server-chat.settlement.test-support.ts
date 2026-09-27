import { afterEach, beforeEach, expect } from "vitest";
import {
  getActiveGatewayRootWorkCount,
  getActiveGatewayRootWorkHolders,
} from "../process/gateway-work-admission.js";
import { observeGatewayRunExecution } from "./agent-command.test-helpers.js";
import { dispatchInboundMessageMock } from "./test-helpers.runtime-state.js";

export function installGatewayChatExecutionSettlement(): void {
  let requestExecution: Awaited<ReturnType<typeof observeGatewayRunExecution>>;
  beforeEach(async () => {
    dispatchInboundMessageMock.mockReset();
    requestExecution = await observeGatewayRunExecution();
  });
  afterEach(async () => {
    try {
      await requestExecution.waitForCompletion();
      expect(getActiveGatewayRootWorkCount(), getActiveGatewayRootWorkHolders().join(", ")).toBe(0);
    } finally {
      await requestExecution.restore();
    }
  });
}
