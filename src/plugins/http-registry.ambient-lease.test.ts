import { describe, expect, it, vi } from "vitest";
import { registerPluginHttpRoute, withPluginHttpRouteRegistry } from "./http-registry.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

function createTrackedRouteLease() {
  let active = true;
  const cleanups = new Set<() => void>();
  const lease = {
    isActive: () => active,
    retain: vi.fn((cleanup: () => void) => {
      const release = () => {
        if (cleanups.delete(release)) {
          cleanup();
        }
      };
      cleanups.add(release);
      return release;
    }),
  };
  return {
    lease,
    cleanups,
    revoke: () => {
      active = false;
      for (const cleanup of cleanups) {
        cleanup();
      }
    },
  };
}

describe("ambient plugin HTTP route leases", () => {
  it.each([
    { name: "a different nested registry", childLease: false, expiredOwner: "parent" },
    { name: "a supplied replacement lease", childLease: true, expiredOwner: "parent" },
    { name: "an expired child under an active parent", childLease: true, expiredOwner: "child" },
  ])("rejects expired route authority through $name", ({ childLease, expiredOwner }) => {
    const parentRegistry = createEmptyPluginRegistry();
    const nestedRegistry = createEmptyPluginRegistry();
    const parent = createTrackedRouteLease();
    const child = createTrackedRouteLease();
    (expiredOwner === "parent" ? parent : child).revoke();

    expect(() =>
      withPluginHttpRouteRegistry(
        parentRegistry,
        () =>
          withPluginHttpRouteRegistry(
            nestedRegistry,
            () =>
              registerPluginHttpRoute({
                path: "/independent-webhook",
                auth: "plugin",
                handler: vi.fn(),
                throwOnFailure: true,
              }),
            childLease ? child.lease : undefined,
          ),
        parent.lease,
      ),
    ).toThrow("plugin runtime HTTP route lease is no longer active");

    expect(parentRegistry.httpRoutes).toHaveLength(0);
    expect(nestedRegistry.httpRoutes).toHaveLength(0);
    expect(parent.lease.retain).not.toHaveBeenCalled();
    expect(child.lease.retain).not.toHaveBeenCalled();
  });

  it("releases nested routes from every ambient lease when any owner revokes", () => {
    const parentRegistry = createEmptyPluginRegistry();
    const nestedRegistry = createEmptyPluginRegistry();
    const parent = createTrackedRouteLease();
    const child = createTrackedRouteLease();

    const unregister = withPluginHttpRouteRegistry(
      parentRegistry,
      () =>
        withPluginHttpRouteRegistry(
          nestedRegistry,
          () =>
            registerPluginHttpRoute({
              path: "/nested-webhook",
              auth: "plugin",
              handler: vi.fn(),
              throwOnFailure: true,
            }),
          child.lease,
        ),
      parent.lease,
    );

    expect(parent.cleanups.size).toBe(1);
    expect(child.cleanups.size).toBe(1);
    parent.revoke();

    expect(nestedRegistry.httpRoutes).toHaveLength(0);
    expect(parent.cleanups.size).toBe(0);
    expect(child.cleanups.size).toBe(0);
    unregister();
    child.revoke();
  });
});
