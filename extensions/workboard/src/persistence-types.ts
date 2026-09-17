// Workboard plugin module implements persistence types behavior.
import type {
  WorkboardAttachment,
  WorkboardBoardMetadata,
  WorkboardCard,
  WorkboardNotificationSubscription,
} from "@openclaw/workboard-contract";

export type PersistedWorkboardCard = {
  version: 1;
  card: WorkboardCard;
};

export type PersistedWorkboardBoard = {
  version: 1;
  board: WorkboardBoardMetadata;
};

export type PersistedWorkboardNotificationSubscription = {
  version: 1;
  subscription: WorkboardNotificationSubscription;
};

export type PersistedWorkboardAttachment = {
  version: 1;
  attachment: WorkboardAttachment;
  contentBase64: string;
};

export type WorkboardKeyedStore<T = PersistedWorkboardCard> = {
  register(key: string, value: T): Promise<void>;
  lookup(key: string): Promise<T | undefined>;
  delete(key: string): Promise<boolean>;
  entries(): Promise<Array<{ key: string; value: T }>>;
};

export type WorkboardBoardCardAggregate = {
  boardId: string;
  status: WorkboardCard["status"];
  total: number;
  archived: number;
  updatedAt: number;
};

// PATCH workboard-bounded-multi-claim (card a2deceee, issue #52/#96):
// owner_busy is now an object so the rejection message can name the
// conflicting cards (acceptance criterion #3). "updated" / "conflict"
// remain string literals for backwards compat with existing callers that
// compare with ===.
export type WorkboardOwnerClaimBusy = {
  kind: "owner_busy";
  lane: string;
  conflicting: ReadonlyArray<{
    id: string;
    title: string;
    ownerId: string;
    lane: string;
  }>;
};

export type WorkboardOwnerClaimResult = "updated" | "conflict" | WorkboardOwnerClaimBusy;

// PATCH workboard-bounded-multi-claim (card a2deceee, issue #52/#96):
// Per-call override of the store-wide claim config. Both fields are
// optional; implementations fall back to their configured defaults when
// omitted. Runtime adapters (e.g. WorkboardStoreRuntime.trackCardStore)
// must forward this object verbatim so production SQLite honors per-call
// configuration from WorkboardCoreStore.updateCard().
export type WorkboardClaimIfOptions = {
  maxClaimsPerOwner?: number;
  laneAware?: boolean;
};

export type WorkboardCardStore = WorkboardKeyedStore & {
  registerIfAbsent(key: string, value: PersistedWorkboardCard): Promise<boolean>;
  registerIfUpdatedAt(
    key: string,
    value: PersistedWorkboardCard,
    expectedUpdatedAt: number,
  ): Promise<boolean>;
  deleteIfUpdatedAt(key: string, expectedUpdatedAt: number): Promise<boolean>;
  claimIfOwnerAvailable(
    key: string,
    value: PersistedWorkboardCard,
    expectedUpdatedAt: number,
    ownerId: string,
    now: number,
    options?: WorkboardClaimIfOptions,
  ): Promise<WorkboardOwnerClaimResult>;
  listBoardAggregates(): Promise<WorkboardBoardCardAggregate[]>;
};

export function isWorkboardCardStore(store: WorkboardKeyedStore): store is WorkboardCardStore {
  return (
    "listBoardAggregates" in store &&
    typeof store.listBoardAggregates === "function" &&
    "registerIfAbsent" in store &&
    typeof store.registerIfAbsent === "function" &&
    "registerIfUpdatedAt" in store &&
    typeof store.registerIfUpdatedAt === "function" &&
    "claimIfOwnerAvailable" in store &&
    typeof store.claimIfOwnerAvailable === "function" &&
    "deleteIfUpdatedAt" in store &&
    typeof store.deleteIfUpdatedAt === "function"
  );
}
