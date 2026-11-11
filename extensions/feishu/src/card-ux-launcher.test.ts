// Feishu tests cover card ux launcher plugin behavior.
import { afterAll, afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import {
  expectFeishuCardButtonRow,
  expectFirstSentCardUsesFillWidthOnly,
<<<<<<< HEAD
=======
  expectFeishuCardButtonRow,
>>>>>>> 97b6e87616f
} from "./card-test-helpers.js";
import { maybeHandleFeishuQuickActionMenu } from "./card-ux-launcher.js";

const sendCardFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("./send.js", () => ({
  sendCardFeishu: sendCardFeishuMock,
}));

describe("feishu quick-action launcher", () => {
  const cfg: ClawdbotConfig = {};

  afterAll(() => {
    vi.doUnmock("./send.js");
    vi.resetModules();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => vi.restoreAllMocks());

  it("opens the launcher from a supported bot menu event", async () => {
    sendCardFeishuMock.mockResolvedValue({ messageId: "m1", chatId: "c1" });
    vi.spyOn(Date, "now").mockReturnValue(100);

    const handled = await maybeHandleFeishuQuickActionMenu({
      cfg,
      eventKey: "quick-actions",
      operatorOpenId: "u123",
      accountId: "main",
    });

    expect(handled).toBe(true);
    expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
    const sendArgs = sendCardFeishuMock.mock.calls.at(0)?.[0] as
      | { accountId?: string; card?: unknown; cfg?: ClawdbotConfig; to?: string }
      | undefined;
    expect(Object.keys(sendArgs ?? {}).toSorted()).toEqual(["accountId", "card", "cfg", "to"]);
    expect(sendArgs?.cfg).toBe(cfg);
    expect(sendArgs?.to).toBe("user:u123");
    expect(sendArgs?.accountId).toBe("main");
    expectFirstSentCardUsesFillWidthOnly(sendCardFeishuMock);
    const buttons = expectFeishuCardButtonRow(sendArgs?.card);
    expect(buttons).toHaveLength(3);
    expect(buttons.map((button) => button.value)).toEqual([
      expect.objectContaining({ q: "/help", c: { u: "u123", e: 600_100, t: "p2p" } }),
      expect.objectContaining({ m: expect.objectContaining({ command: "/new" }) }),
      expect.objectContaining({ m: expect.objectContaining({ command: "/reset" }) }),
    ]);
<<<<<<< HEAD
  });

  it("does not send launcher cards when expiry would exceed a valid Date", async () => {
    const runtime: RuntimeEnv = createRuntimeEnv();

    const handled = await maybeHandleFeishuQuickActionMenu({
      cfg,
      eventKey: "quick-actions",
      operatorOpenId: "u123",
      accountId: "main",
      runtime,
      now: 8_640_000_000_000_000,
    });

    expect(handled).toBe(false);
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      "feishu[main]: failed to open quick-action launcher for u123: invalid expiry clock",
    );
=======
>>>>>>> 97b6e87616f
  });
});
