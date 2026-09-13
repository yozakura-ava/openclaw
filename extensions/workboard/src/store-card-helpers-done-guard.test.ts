// PATCH workboard-sweeper-done-guard-tests (issue #81)
//
// Regression for the 2026-09-03 durability reconciler misfire that
// bulk-moved ~150 done cards back to review. The lifecycle helper
// `shouldSyncWorkboardLifecycleStatus` must return false for every
// transition out of "done", regardless of target. The implicit
// "done is not in the allowlist" rule alone was silently removable
// if anyone widened the allowlist; the explicit early-return guard
// makes the invariant a hard line that future refactors cannot
// silently regress. These tests pin the contract on every plausible
// target so the regression class is locked down.

import { describe, expect, it } from "vitest";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { shouldSyncWorkboardLifecycleStatus } from "./store-card-helpers.js";

type MinimalCard = Pick<WorkboardCard, "id" | "status"> & {
  title: string;
  priority: WorkboardCard["priority"];
  position: number;
  createdAt: number;
  updatedAt: number;
  events: WorkboardCard["events"];
  labels: WorkboardCard["labels"];
};

function minimalCard(status: WorkboardCard["status"]): WorkboardCard {
  return {
    id: `card-${status}-1`,
    status,
    title: "t",
    priority: "normal",
    position: 0,
    createdAt: 0,
    updatedAt: 0,
    events: [],
    labels: [],
  } as MinimalCard as WorkboardCard;
}

describe("shouldSyncWorkboardLifecycleStatus done-card guard (issue #81)", () => {
  it("refuses done → review (the 2026-09-03 incident vector)", () => {
    expect(shouldSyncWorkboardLifecycleStatus(minimalCard("done"), "review")).toBe(false);
  });

  it("refuses done → blocked", () => {
    expect(shouldSyncWorkboardLifecycleStatus(minimalCard("done"), "blocked")).toBe(false);
  });

  it("refuses done → running", () => {
    expect(shouldSyncWorkboardLifecycleStatus(minimalCard("done"), "running")).toBe(false);
  });

  it("refuses done → ready", () => {
    expect(shouldSyncWorkboardLifecycleStatus(minimalCard("done"), "ready")).toBe(false);
  });

  it("refuses done → todo", () => {
    expect(shouldSyncWorkboardLifecycleStatus(minimalCard("done"), "todo")).toBe(false);
  });

  it("refuses done → backlog", () => {
    expect(shouldSyncWorkboardLifecycleStatus(minimalCard("done"), "backlog")).toBe(false);
  });

  it("returns false when target is undefined", () => {
    expect(shouldSyncWorkboardLifecycleStatus(minimalCard("done"), undefined)).toBe(false);
  });

  it("returns false when target equals current status (done → done)", () => {
    expect(shouldSyncWorkboardLifecycleStatus(minimalCard("done"), "done")).toBe(false);
  });

  // The original allowlist behavior must still hold for non-done cards so
  // the explicit guard does not regress the working transitions.
  it("still allows running → review (non-done happy path preserved)", () => {
    expect(shouldSyncWorkboardLifecycleStatus(minimalCard("running"), "review")).toBe(true);
  });
});
