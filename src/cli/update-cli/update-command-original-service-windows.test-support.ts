import { expect, it, vi } from "vitest";
import {
  type Fixture,
  withCurrentF3Admitted,
} from "./update-command-original-service-current.test-support.js";
import { observeOriginalManagedServiceRuntime } from "./update-command-original-service.js";

export function registerCurrentF3WindowsControl(fixture: () => Fixture) {
  it("refuses Windows split-root compensation before stopping the original", async () => {
    const { rootB, before, mocks } = fixture();
    await withCurrentF3Admitted(fixture, async (run) => {
      const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      try {
        await expect(
          observeOriginalManagedServiceRuntime({ root: rootB, opts: { run } }, before),
        ).rejects.toMatchObject({ reason: "original-service-unverified" });
        expect(before.stopped).toBe(false);
        expect(mocks.nativeRestart).not.toHaveBeenCalled();
        expect(mocks.nativeInstall).not.toHaveBeenCalled();
        expect(mocks.restart).not.toHaveBeenCalled();
      } finally {
        platform.mockRestore();
      }
    });
  });
}
