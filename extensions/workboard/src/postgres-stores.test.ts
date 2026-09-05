import { describe, expect, it } from "vitest";
import type {
  PersistedWorkboardAttachment,
  PersistedWorkboardBoard,
  PersistedWorkboardForceCloseAudit,
  PersistedWorkboardNotificationSubscription,
  WorkboardCardStore,
  WorkboardKeyedStore,
} from "./persistence-types.js";
import type {
  WorkboardAuthorityRecord,
  WorkboardAuthorityWriteResult,
} from "./postgres-authority-types.js";
import { createRemoteBackedStores } from "./postgres-stores.js";

type Value = { id: string; value: string };

function localStore(initial: Value[] = []): WorkboardKeyedStore<Value> {
  const values = new Map(initial.map((value) => [value.id, value]));
  return {
    async register(key, value) {
      values.set(key, value);
    },
    async lookup(key) {
      return values.get(key);
    },
    async delete(key) {
      return values.delete(key);
    },
    async entries() {
      return [...values].map(([key, value]) => ({ key, value }));
    },
  };
}

function fakeAuthority(initial: Array<[string, Value]> = []) {
  const records = new Map<string, WorkboardAuthorityRecord>(
    initial.map(([key, value]) => [key, { found: true, deleted: false, value, updatedAt: 1 }]),
  );
  const operations = new Map<string, WorkboardAuthorityWriteResult>();
  const authority = {
    enabled: true as const,
    async health() {},
    async read(_namespace: string, key: string) {
      return records.get(key) ?? { found: false, deleted: false };
    },
    async list(_namespace: string) {
      return [...records].flatMap(([key, record]) =>
        record.found && !record.deleted ? [{ key, record }] : [],
      );
    },
    async write(input: {
      operationId: string;
      namespace: string;
      key: string;
      value?: unknown;
      mode: "insert" | "upsert" | "delete" | "claim";
      expectedUpdatedAt?: number;
    }) {
      const prior = operations.get(input.operationId);
      if (prior) {
        return prior;
      }
      const current = records.get(input.key) ?? { found: false, deleted: false };
      if (input.expectedUpdatedAt !== undefined && current.updatedAt !== input.expectedUpdatedAt) {
        const conflict = { applied: false, result: "conflict" as const, record: current };
        operations.set(input.operationId, conflict);
        return conflict;
      }
      if (input.mode === "insert" && current.found) {
        const conflict = { applied: false, result: "conflict" as const, record: current };
        operations.set(input.operationId, conflict);
        return conflict;
      }
      if (input.mode === "delete" && !current.found) {
        const missing = { applied: false, result: "updated" as const, record: current };
        operations.set(input.operationId, missing);
        return missing;
      }
      const record = {
        found: true,
        deleted: input.mode === "delete",
        ...(!input || input.mode === "delete" ? {} : { value: input.value }),
        updatedAt: (current.updatedAt ?? 0) + 1,
      } satisfies WorkboardAuthorityRecord;
      records.set(input.key, record);
      const applied = { applied: true, result: "updated" as const, record };
      operations.set(input.operationId, applied);
      return applied;
    },
  };
  return { authority, records };
}

function boardStore(
  local: WorkboardKeyedStore<Value>,
  authority: ReturnType<typeof fakeAuthority>["authority"],
): WorkboardKeyedStore<Value> {
  const stores = createRemoteBackedStores(
    {
      cards: local as unknown as WorkboardCardStore,
      boards: local as unknown as WorkboardKeyedStore<PersistedWorkboardBoard>,
      subscriptions:
        local as unknown as WorkboardKeyedStore<PersistedWorkboardNotificationSubscription>,
      attachments: local as unknown as WorkboardKeyedStore<PersistedWorkboardAttachment>,
      audits: local as unknown as WorkboardKeyedStore<PersistedWorkboardForceCloseAudit>,
    },
    authority,
  );
  return stores.boards as unknown as WorkboardKeyedStore<Value>;
}

describe("PostgreSQL-backed Workboard stores", () => {
  it("migrates SQLite rows once and reads the authority before the projection", async () => {
    const local = localStore([{ id: "local", value: "old" }]);
    const { authority, records } = fakeAuthority();
    const store = boardStore(local, authority);

    await expect(store.lookup("local")).resolves.toEqual({ id: "local", value: "old" });
    expect(records.get("local")?.value).toEqual({ id: "local", value: "old" });

    records.set("local", { found: true, deleted: false, value: { id: "local", value: "new" } });
    await expect(store.lookup("local")).resolves.toEqual({ id: "local", value: "new" });
  });

  it("honors authority tombstones and keeps a failed SQLite projection visible", async () => {
    const local = localStore([{ id: "gone", value: "stale" }]);
    const { authority, records } = fakeAuthority([["gone", { id: "gone", value: "authority" }]]);
    records.set("gone", { found: true, deleted: true, updatedAt: 2 });
    const store = boardStore(local, authority);

    await expect(store.lookup("gone")).resolves.toBeUndefined();
    expect(await store.delete("missing")).toBe(false);
    expect(await store.lookup("gone")).toBeUndefined();
  });

  it("makes repeated writes idempotent at the remote operation boundary", async () => {
    const local = localStore();
    const { authority } = fakeAuthority();
    const store = boardStore(local, authority);
    const value = { id: "board-1", value: "v1" };

    await store.register("board-1", value);
    await store.register("board-1", value);
    await expect(store.entries()).resolves.toEqual([{ key: "board-1", value }]);
  });
});
