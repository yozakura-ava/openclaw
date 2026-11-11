import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(() => ({ ok: true, applicable: false }) as const),
}));

vi.mock("./driver-artifact-verification.js", () => ({
  inspectCuaDriverArtifacts: mocks.inspect,
  readPackageIdentity: vi.fn(),
}));

import { verifyInstalledCuaDriverArtifacts } from "./driver-artifacts.js";

it("supplies the accepted artifact record without depending on the bundled module path", () => {
  verifyInstalledCuaDriverArtifacts();

  expect(mocks.inspect).toHaveBeenCalledWith(
    expect.objectContaining({
      pluginManifest: expect.objectContaining({
<<<<<<< HEAD
        dependencies: expect.objectContaining({ "@trycua/cua-driver": "0.32.0" }),
=======
        dependencies: expect.objectContaining({ "@trycua/cua-driver": "0.33.4" }),
>>>>>>> 97b6e87616f
        cuaDriverArtifacts: expect.objectContaining({
          "win32-arm64-msvc": {
            files: {
              "cua_driver_node_runtime.node":
<<<<<<< HEAD
                "86bb03da87daefe3e3a8d23912f974e514dea0e9475106f3381c0742ee26b1cd",
              "cua_driver_sdk.dll":
                "8fae395cf152807465c7b4c00c7e3dffbf765c9790fac091427dd43a1be2aaa4",
=======
                "003d7de1f901d91b94bc362ae387ee6d5371436574195390f33517406afa7c7f",
              "cua_driver_sdk.dll":
                "5f5784a148486c057e5b425c12770fb26f03f9ddf1ecf19fd067978a67cc551c",
>>>>>>> 97b6e87616f
            },
          },
        }),
      }),
    }),
  );
});
