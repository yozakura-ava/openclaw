import type {
  PersistedWorkboardAttachment,
  PersistedWorkboardBoard,
  PersistedWorkboardCard,
  PersistedWorkboardForceCloseAudit,
  PersistedWorkboardNotificationSubscription,
  WorkboardBoardCardAggregate,
  WorkboardCardStore,
  WorkboardKeyedStore,
  WorkboardOwnerClaimResult,
} from "./persistence-types.js";
import { deriveWorkboardOperationId } from "./postgres-authority-client.js";
import type {
  WorkboardAuthorityRecord,
  WorkboardAuthorityWriteResult,
} from "./postgres-authority-types.js";
import { cardBoardId } from "./store-card-helpers.js";

export type WorkboardRemoteAuthority = {
  readonly enabled: true;
  health(): Promise<void>;
  read(namespace: string, key: string): Promise<WorkboardAuthorityRecord>;
  list(namespace: string): Promise<Array<{ key: string; record: WorkboardAuthorityRecord }>>;
  write(input: {
    operationId: string;
    namespace: string;
    key: string;
    value?: unknown;
    mode: "insert" | "upsert" | "delete" | "claim";
    expectedUpdatedAt?: number;
    ownerId?: string;
    now?: number;
    maxConcurrentClaims?: number;
  }): Promise<WorkboardAuthorityWriteResult>;
};

const MAX_MIGRATION_ROWS = 10_000;

function isValueRecord(record: WorkboardAuthorityRecord): record is WorkboardAuthorityRecord & {
  value: unknown;
} {
  return record.found && !record.deleted && record.value !== undefined;
}

class RemoteBackedKeyedStore<T> implements WorkboardKeyedStore<T> {
  private migration?: Promise<void>;

  constructor(
    private readonly local: WorkboardKeyedStore<T>,
    private readonly remote: WorkboardRemoteAuthority,
    private readonly namespace: string,
  ) {}

  async ensureMigrated(): Promise<void> {
    this.migration ??= (async () => {
      const localEntries = await this.local.entries();
      if (localEntries.length > MAX_MIGRATION_ROWS) {
        throw new Error(`Workboard ${this.namespace} migration exceeds the bounded row limit`);
      }
      for (const entry of localEntries) {
        const current = await this.remote.read(this.namespace, entry.key);
        if (!current.found) {
          await this.remote.write({
            operationId: deriveWorkboardOperationId({
              operation: "migrate",
              namespace: this.namespace,
              key: entry.key,
              value: entry.value,
            }),
            namespace: this.namespace,
            key: entry.key,
            value: entry.value,
            mode: "insert",
          });
        }
      }
    })();
    await this.migration;
  }

  private async compatibilityWrite(action: string, run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch (error) {
      // PostgreSQL is authoritative. A projection failure must be visible but
      // cannot make an already-committed authority mutation appear rejected.
      console.warn(
        `[workboard] sqlite compatibility projection failed (${action}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async remoteRecord(key: string): Promise<WorkboardAuthorityRecord> {
    await this.ensureMigrated();
    return await this.remote.read(this.namespace, key);
  }

  async register(key: string, value: T): Promise<void> {
    await this.ensureMigrated();
    const result = await this.remote.write({
      operationId: deriveWorkboardOperationId({
        operation: "register",
        namespace: this.namespace,
        key,
        value,
      }),
      namespace: this.namespace,
      key,
      value,
      mode: "upsert",
    });
    if (!result.applied && result.result !== "updated") {
      throw new Error(`Workboard authority rejected ${this.namespace}/${key}: ${result.result}`);
    }
    await this.compatibilityWrite("register", () => this.local.register(key, value));
  }

  async lookup(key: string): Promise<T | undefined> {
    const record = await this.remoteRecord(key);
    // SAFETY: isValueRecord validates the persisted envelope before exposing its generic payload.
    return isValueRecord(record) ? (record.value as T) : undefined;
  }

  async delete(key: string): Promise<boolean> {
    await this.ensureMigrated();
    const result = await this.remote.write({
      operationId: deriveWorkboardOperationId({
        operation: "delete",
        namespace: this.namespace,
        key,
      }),
      namespace: this.namespace,
      key,
      mode: "delete",
    });
    if (result.applied) {
      await this.compatibilityWrite("delete", () => this.local.delete(key));
    }
    return result.applied;
  }

  async entries(): Promise<Array<{ key: string; value: T }>> {
    await this.ensureMigrated();
    const rows = await this.remote.list(this.namespace);
    return rows.flatMap((row) =>
      // SAFETY: isValueRecord validates each persisted envelope before exposing its generic payload.
      isValueRecord(row.record) ? [{ key: row.key, value: row.record.value as T }] : [],
    );
  }
}

class RemoteBackedCardStore implements WorkboardCardStore {
  private readonly generic: RemoteBackedKeyedStore<PersistedWorkboardCard>;

  constructor(
    private readonly local: WorkboardCardStore,
    private readonly remote: WorkboardRemoteAuthority,
    private readonly namespace: string,
  ) {
    this.generic = new RemoteBackedKeyedStore(this.local, remote, namespace);
  }

  async register(key: string, value: PersistedWorkboardCard): Promise<void> {
    await this.generic.register(key, value);
  }

  async lookup(key: string): Promise<PersistedWorkboardCard | undefined> {
    return await this.generic.lookup(key);
  }

  async delete(key: string): Promise<boolean> {
    return await this.generic.delete(key);
  }

  async entries(): Promise<Array<{ key: string; value: PersistedWorkboardCard }>> {
    return await this.generic.entries();
  }

  async registerIfAbsent(key: string, value: PersistedWorkboardCard): Promise<boolean> {
    await this.generic.ensureMigrated();
    const result = await this.remote.write({
      operationId: deriveWorkboardOperationId({
        operation: "insert",
        namespace: this.namespace,
        key,
        value,
      }),
      namespace: this.namespace,
      key,
      value,
      mode: "insert",
    });
    if (result.applied) {
      await this.compatibility("registerIfAbsent", () => this.local.register(key, value));
    }
    return result.applied;
  }

  async registerIfUpdatedAt(
    key: string,
    value: PersistedWorkboardCard,
    expectedUpdatedAt: number,
  ): Promise<boolean> {
    await this.generic.ensureMigrated();
    const result = await this.remote.write({
      operationId: deriveWorkboardOperationId({
        operation: "cas",
        namespace: this.namespace,
        key,
        value,
        expectedUpdatedAt,
      }),
      namespace: this.namespace,
      key,
      value,
      mode: "upsert",
      expectedUpdatedAt,
    });
    if (result.applied) {
      await this.compatibility("registerIfUpdatedAt", () => this.local.register(key, value));
    }
    return result.applied;
  }

  async deleteIfUpdatedAt(key: string, expectedUpdatedAt: number): Promise<boolean> {
    await this.generic.ensureMigrated();
    const result = await this.remote.write({
      operationId: deriveWorkboardOperationId({
        operation: "cas-delete",
        namespace: this.namespace,
        key,
        expectedUpdatedAt,
      }),
      namespace: this.namespace,
      key,
      mode: "delete",
      expectedUpdatedAt,
    });
    if (result.applied) {
      await this.compatibility("deleteIfUpdatedAt", () => this.local.delete(key));
    }
    return result.applied;
  }

  async claimIfOwnerAvailable(
    key: string,
    value: PersistedWorkboardCard,
    expectedUpdatedAt: number,
    ownerId: string,
    now: number,
    maxConcurrentClaims: number,
  ): Promise<WorkboardOwnerClaimResult> {
    await this.generic.ensureMigrated();
    const result = await this.remote.write({
      operationId: deriveWorkboardOperationId({
        operation: "claim",
        namespace: this.namespace,
        key,
        value,
        expectedUpdatedAt,
        ownerId,
        now,
        maxConcurrentClaims,
      }),
      namespace: this.namespace,
      key,
      value,
      mode: "claim",
      expectedUpdatedAt,
      ownerId,
      now,
      maxConcurrentClaims,
    });
    if (result.applied) {
      await this.compatibility("claim", () => this.local.register(key, value));
    }
    return result.result;
  }

  async listBoardAggregates(): Promise<WorkboardBoardCardAggregate[]> {
    const rows = await this.entries();
    const aggregates = new Map<string, WorkboardBoardCardAggregate>();
    for (const row of rows) {
      const card = row.value.card;
      const boardId = cardBoardId(card);
      const key = `${boardId}\0${card.status}`;
      const current = aggregates.get(key);
      if (current) {
        current.total += 1;
        current.archived += card.metadata?.archivedAt ? 1 : 0;
        current.updatedAt = Math.max(current.updatedAt, card.updatedAt);
      } else {
        aggregates.set(key, {
          boardId,
          status: card.status,
          total: 1,
          archived: card.metadata?.archivedAt ? 1 : 0,
          updatedAt: card.updatedAt,
        });
      }
    }
    return [...aggregates.values()].toSorted((left, right) =>
      `${left.boardId}\0${left.status}`.localeCompare(`${right.boardId}\0${right.status}`),
    );
  }

  private async compatibility(action: string, run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch (error) {
      console.warn(
        `[workboard] sqlite compatibility projection failed (${action}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

export function createRemoteBackedStores(
  stores: {
    cards: WorkboardCardStore;
    boards: WorkboardKeyedStore<PersistedWorkboardBoard>;
    subscriptions: WorkboardKeyedStore<PersistedWorkboardNotificationSubscription>;
    attachments: WorkboardKeyedStore<PersistedWorkboardAttachment>;
    audits: WorkboardKeyedStore<PersistedWorkboardForceCloseAudit>;
  },
  remote: WorkboardRemoteAuthority,
) {
  return {
    cards: new RemoteBackedCardStore(stores.cards, remote, "cards"),
    boards: new RemoteBackedKeyedStore(stores.boards, remote, "boards"),
    subscriptions: new RemoteBackedKeyedStore(stores.subscriptions, remote, "subscriptions"),
    attachments: new RemoteBackedKeyedStore(stores.attachments, remote, "attachments"),
    audits: new RemoteBackedKeyedStore(stores.audits, remote, "audits"),
  };
}
