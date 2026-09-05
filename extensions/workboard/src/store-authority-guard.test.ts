import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkboardStoreAuthorityGuard } from "./store-authority-guard.js";
import type { WorkboardStore } from "./store.js";

describe("Workboard SQLite authority guard", () => {
  afterEach(() => vi.useRealTimers());

  it("probes during service start without waiting for gateway_start", async () => {
    const probe = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const recover = vi.fn(() => true);
    const service = createWorkboardStoreAuthorityGuard({
      probeSqliteAuthority: probe,
      recoverSqliteAuthority: recover,
    } as unknown as WorkboardStore);

    void service.start({ logger: { warn: vi.fn() } } as never);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());
    service.stop();
    expect(recover).not.toHaveBeenCalled();
  });

  it("attempts recovery when the authority probe fails", async () => {
    const probe = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("closed database"));
    const recover = vi.fn(() => true);
    const warn = vi.fn();
    const service = createWorkboardStoreAuthorityGuard({
      probeSqliteAuthority: probe,
      recoverSqliteAuthority: recover,
    } as unknown as WorkboardStore);

    void service.start({ logger: { warn } } as never);
    await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce());
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("recovery=succeeded"));
    service.stop();
  });
});
