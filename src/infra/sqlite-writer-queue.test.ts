import { describe, expect, it } from "vitest";
import { SqliteWriterQueue } from "./sqlite-writer-queue.js";

describe("SqliteWriterQueue", () => {
  it("runs asynchronous writers in fair FIFO order", async () => {
    const queue = new SqliteWriterQueue({ name: "test", maxDepth: 4 });
    const order: number[] = [];
    const first = queue.run(async () => {
      await Promise.resolve();
      order.push(1);
      return 1;
    });
    const second = queue.run(() => {
      order.push(2);
      return 2;
    });
    const third = queue.run(() => {
      order.push(3);
      return 3;
    });

    await expect(Promise.all([first, second, third])).resolves.toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]);
    expect(queue.snapshot).toMatchObject({ depth: 0, pending: 0, completed: 3 });
  });

  it("rejects beyond the bounded depth without waiting or dropping FIFO jobs", async () => {
    const queue = new SqliteWriterQueue({ name: "bounded", maxDepth: 1 });
    let releaseFirst!: () => void;
    const first = queue.run(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    await expect(queue.run(() => undefined)).rejects.toMatchObject({
      code: "SQLITE_WRITER_QUEUE_FULL",
    });
    releaseFirst();
    await first;
    expect(queue.snapshot.rejected).toBe(1);
  });

  it("fails closed while degraded and resumes only after explicit recovery", async () => {
    const queue = new SqliteWriterQueue({ name: "degraded", maxDepth: 2 });
    queue.markDegraded();
    await expect(queue.run(() => undefined)).rejects.toMatchObject({
      code: "SQLITE_WRITER_QUEUE_DEGRADED",
    });
    queue.recover();
    await expect(queue.run(() => "recovered")).resolves.toBe("recovered");
  });
});
