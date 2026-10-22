import { describe, expect, it } from "vitest";
import { createKernelStores } from "./test/sqlite-kernel.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

function linksOf(metadata: unknown): Array<Record<string, unknown>> {
  return (metadata as { links?: Array<Record<string, unknown>> } | undefined)?.links ?? [];
}

describe("Workboard dependency link demote/unlink", () => {
  it("demotes both sides and releases the child gate while the parent stays open", async () => {
    const store = createWorkboardSqliteTestStore({ createStores: createKernelStores });
    const parent = await store.create({ title: "Live parent", status: "running" });
    const child = await store.create({
      title: "Duplicate child",
      status: "todo",
      parents: [parent.id],
    });
    expect(child.status).toBe("todo");

    const result = await store.demoteDependencyLink(child.id, parent.id, "demote");
    expect(result.child.id).toBe(child.id);
    expect(result.parent.id).toBe(parent.id);

    // Parent is still legitimately open/blocked — not forced done.
    expect(result.parent.status).not.toBe("done");

    // Both sides demoted to relates_to, targetCardId retained.
    expect(linksOf(result.child.metadata)).toEqual([
      expect.objectContaining({ type: "relates_to", targetCardId: parent.id }),
    ]);
    expect(linksOf(result.parent.metadata)).toEqual([
      expect.objectContaining({ type: "relates_to", targetCardId: child.id }),
    ]);

    // Gate released: child can close while the parent is still open.
    const closed = await store.complete(child.id, { summary: "Duplicate absorbed." });
    expect(closed.status).toBe("done");
    const parentAfter = await store.get(parent.id);
    expect(parentAfter?.status).toBe("running");
  });

  it("keeps unrelated dependency links untouched", async () => {
    const store = createWorkboardSqliteTestStore({ createStores: createKernelStores });
    const otherParent = await store.create({ title: "Other parent", status: "running" });
    const parent = await store.create({ title: "Live parent", status: "running" });
    const child = await store.create({
      title: "Child",
      status: "todo",
      parents: [parent.id, otherParent.id],
    });

    const result = await store.demoteDependencyLink(child.id, parent.id, "demote");
    const childLinks = linksOf(result.child.metadata);
    expect(
      childLinks.filter((link) => link.type === "parent").map((link) => link.targetCardId),
    ).toEqual([otherParent.id]);
    expect(childLinks.filter((link) => link.type === "relates_to")).toHaveLength(1);
  });

  it("throws loudly when the dependency pair is missing on either side", async () => {
    const store = createWorkboardSqliteTestStore({ createStores: createKernelStores });
    const parent = await store.create({ title: "Live parent", status: "running" });
    const child = await store.create({ title: "Child", status: "todo", parents: [parent.id] });
    const stranger = await store.create({ title: "Stranger", status: "todo" });

    await expect(store.demoteDependencyLink(stranger.id, parent.id, "demote")).rejects.toThrow(
      /dependency link pair not found/,
    );
    await expect(store.demoteDependencyLink(child.id, stranger.id, "demote")).rejects.toThrow(
      /dependency link pair not found/,
    );
    await expect(store.demoteDependencyLink(child.id, child.id, "demote")).rejects.toThrow(
      /must differ/,
    );
  });

  it("removes both links in unlink mode", async () => {
    const store = createWorkboardSqliteTestStore({ createStores: createKernelStores });
    const parent = await store.create({ title: "Live parent", status: "running" });
    const child = await store.create({ title: "Child", status: "todo", parents: [parent.id] });

    const result = await store.demoteDependencyLink(child.id, parent.id, "unlink");
    expect(linksOf(result.child.metadata)).toEqual([]);
    expect(linksOf(result.parent.metadata)).toEqual([]);
    const closed = await store.complete(child.id, { summary: "Duplicate absorbed." });
    expect(closed.status).toBe("done");
  });
});
