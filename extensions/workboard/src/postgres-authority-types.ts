export type WorkboardAuthorityRecord = {
  found: boolean;
  deleted: boolean;
  value?: unknown;
  revision?: number;
  updatedAt?: number;
};

export type WorkboardAuthorityWriteResult = {
  applied: boolean;
  result: "updated" | "conflict" | "owner_busy";
  record: WorkboardAuthorityRecord;
};
