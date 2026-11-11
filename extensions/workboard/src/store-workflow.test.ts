// Tests for consumer_surface_evidence gating on workboard_complete
// (yozakura-ava/openclaw#120). The store verifies evidence independently —
// caller-supplied proof text is never trusted.
<<<<<<< HEAD
=======
// W1.1 semantic port from the fork lineage (70e50616d1e..b31df7b2f5e) onto the
// v2026.11.1 re-land; the fork file's #115-scope claim-guard block is already
// covered on this branch by store-claim-conflict.test.ts and
// store-claim-guard.test.ts and is intentionally not duplicated here.
>>>>>>> 97b6e87616f
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
<<<<<<< HEAD
import { afterEach, describe, expect, it } from "vitest";
import { clearClaimConflictHistory, snapshotClaimConflictHistory } from "./store-claim-conflict.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

const HOUR_MS = 60 * 60 * 1000;

function liveClaim(ownerId: string) {
  const now = Date.now();
  return {
    ownerId,
    token: "live-token",
    claimedAt: now,
    lastHeartbeatAt: now,
    expiresAt: now + HOUR_MS,
  };
}

function expiredClaim(ownerId: string) {
  const now = Date.now();
  return {
    ownerId,
    token: "stale-token",
    claimedAt: now - HOUR_MS,
    lastHeartbeatAt: now - HOUR_MS,
    // Past the 5-min CLAIM_RECLAIM_MS grace.
    expiresAt: now - 10 * 60 * 1000,
  };
}

// PATCH done-card claim rejection + takeover audit tests (#115 scope rebuild,
// prior art upstream issue #24 — CLOSED).
describe("WorkboardWorkflowStore claim guard (#115 scope)", () => {
  afterEach(() => {
    clearClaimConflictHistory();
  });

  // Negative control: the history is written on the rejection path, not merely
  // declared — an empty history has zero rows before any rejected claim.
  it("claim_conflict_history_empty_before_any_rejection", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Quiet card",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
    await store.claim(card.id, { ownerId: "owner-a" });
    expect(snapshotClaimConflictHistory()).toHaveLength(0);
  });

  it("claim_on_done_card_throws_and_writes_no_claim_metadata", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Completed card",
      status: "done",
      workspaceAccess: { unrestricted: true },
    });
    await expect(store.claim(card.id, { ownerId: "owner-a" })).rejects.toThrow(
      /card is completed/i,
    );
    const events = snapshotClaimConflictHistory();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "claim_on_done",
      cardId: card.id,
      attemptedOwnerId: "owner-a",
    });
    const after = await store.get(card.id);
    expect(after?.metadata?.claim).toBeUndefined();
    expect(after?.status).toBe("done");
  });

  it("done_card_carrying_a_live_claim_still_hits_the_done_guard_first", async () => {
    // The guard must reject BEFORE the strict claim fence evaluates:
    // a done card that already carries a live claim must produce
    // claim_on_done, not a claim-fence rejection.
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Done card with stale claim",
      status: "done",
      workspaceAccess: { unrestricted: true },
      metadata: { claim: liveClaim("owner-a") },
    });
    await expect(store.claim(card.id, { ownerId: "owner-b" })).rejects.toThrow(
      /card is completed/i,
    );
    const events = snapshotClaimConflictHistory();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("claim_on_done");
  });

  it("claim_on_archived_card_records_claim_on_archived_event", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Archived card",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
    await store.archive(card.id, true);
    await expect(store.claim(card.id, { ownerId: "owner-a" })).rejects.toThrow(/card is archived/i);
    const events = snapshotClaimConflictHistory();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "claim_on_archived", cardId: card.id });
  });

  it("takeover_conflict_history_appends_one_event_per_rejection", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Live foreign claim",
      status: "ready",
      workspaceAccess: { unrestricted: true },
      metadata: { claim: liveClaim("owner-a") },
    });
    expect(snapshotClaimConflictHistory()).toHaveLength(0);
    await expect(store.claim(card.id, { ownerId: "owner-b" })).rejects.toThrow(
      /claimed by owner-a/i,
    );
    const events = snapshotClaimConflictHistory();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "takeover",
      cardId: card.id,
      attemptedOwnerId: "owner-b",
      priorOwnerId: "owner-a",
    });
    expect(typeof events[0]?.priorExpiresAt).toBe("number");
    expect(events[0]!.priorExpiresAt!).toBeGreaterThan(Date.now());
  });

  it("same_owner_self_recovery_does_not_record_takeover", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Self-reclaim",
      status: "ready",
      workspaceAccess: { unrestricted: true },
      metadata: { claim: expiredClaim("owner-a") },
    });
    const reclaimed = await store.claim(card.id, { ownerId: "owner-a" });
    expect(reclaimed.card.metadata?.claim?.ownerId).toBe("owner-a");
    expect(snapshotClaimConflictHistory()).toHaveLength(0);
  });

  it("claim_conflicts_getter_exposes_stable_snapshot", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Snapshot test",
      status: "done",
      workspaceAccess: { unrestricted: true },
    });
    await expect(store.claim(card.id, { ownerId: "owner-a" })).rejects.toThrow();
    const first = store.claimConflicts;
    expect(first).toHaveLength(1);
    const card2 = await store.create({
      title: "Snapshot test 2",
      status: "done",
      workspaceAccess: { unrestricted: true },
    });
    await expect(store.claim(card2.id, { ownerId: "owner-a" })).rejects.toThrow();
    expect(store.claimConflicts.length).toBe(2);
    expect(first.length).toBe(1);
  });
});

=======
import { describe, expect, it } from "vitest";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

>>>>>>> 97b6e87616f
const execFileAsync = promisify(execFile);

async function createBuildCard(
  store: Awaited<ReturnType<typeof createWorkboardSqliteTestStore>>,
  labels: string[],
) {
  const card = await store.create({ title: "consumer surface card", labels });
  await store.claim(card.id, { ownerId: "tester" });
  return card;
}

async function createTempGitRepo(): Promise<{ dir: string; sha: string; file: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cse-repo-"));
  const run = (args: string[]) => execFileAsync("git", ["-C", dir, ...args]);
  await run(["init", "-q"]);
  const file = path.join(dir, "consumer_surface.ts");
  fs.writeFileSync(file, "export const consumer = true;\n");
  await run(["add", "."]);
  await run(["-c", "user.email=t@example.test", "-c", "user.name=t", "commit", "-qm", "surface"]);
  const { stdout } = await run(["rev-parse", "HEAD"]);
  return { dir, sha: stdout.trim(), file };
}

describe("workboard_complete consumer_surface_evidence", () => {
  it("AC1: fails closed on a [BUILD] card without evidence", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await createBuildCard(store, ["[BUILD]"]);
    await expect(store.complete(card.id, { ownerId: "tester", summary: "done" })).rejects.toThrow(
      /consumer_surface_evidence/,
    );
    const after = await store.get(card.id);
    expect(after?.status).toBe("running");
  });

  it("AC1: fails closed on an [INFRA] card without evidence", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await createBuildCard(store, ["[INFRA]"]);
    await expect(store.complete(card.id, { ownerId: "tester", summary: "done" })).rejects.toThrow(
      /consumer_surface_evidence/,
    );
  });

  it("AC2: rejects forged code evidence (commit does not resolve)", async () => {
    const store = createWorkboardSqliteTestStore();
    const { dir, sha } = await createTempGitRepo();
    const card = await createBuildCard(store, ["[BUILD]"]);
    await expect(
      store.complete(card.id, {
        ownerId: "tester",
        summary: "done",
        consumer_surface_evidence: {
          kind: "code",
          repoPath: dir,
          commitSha: `${sha.slice(0, 30)}${"0".repeat(10)}`,
        },
      }),
    ).rejects.toThrow(/does not resolve/);
  });

  it("AC2: rejects forged skill evidence (SKILL.md path absent)", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await createBuildCard(store, ["[BUILD]"]);
    const missing = path.join(os.tmpdir(), "cse-missing-SKILL.md");
    await expect(
      store.complete(card.id, {
        ownerId: "tester",
        summary: "done",
        consumer_surface_evidence: { kind: "skill", filePath: missing },
      }),
    ).rejects.toThrow(/failed verification/);
  });

  it("AC2: rejects unknown evidence kind", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await createBuildCard(store, ["[BUILD]"]);
    await expect(
      store.complete(card.id, {
        ownerId: "tester",
        summary: "done",
        consumer_surface_evidence: { kind: "vibes", note: "trust me" },
      }),
    ).rejects.toThrow(/kind must be one of/);
  });

  it("positive: verifiable code evidence completes a [BUILD] card and records the artifact", async () => {
    const store = createWorkboardSqliteTestStore();
    const { dir, sha, file } = await createTempGitRepo();
    const card = await createBuildCard(store, ["[BUILD]"]);
    const done = await store.complete(card.id, {
      ownerId: "tester",
      summary: "landed",
      consumer_surface_evidence: {
        kind: "code",
        repoPath: dir,
        commitSha: sha,
        filePath: file,
      },
    });
    expect(done.status).toBe("done");
    expect(
      (done.metadata?.artifacts ?? []).some((artifact) =>
        artifact.label?.startsWith("consumer_surface_evidence:code"),
      ),
    ).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("positive: existing SKILL.md satisfies skill evidence", async () => {
    const store = createWorkboardSqliteTestStore();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cse-skill-"));
    const skill = path.join(dir, "SKILL.md");
    fs.writeFileSync(skill, "# Skill\n");
    const card = await createBuildCard(store, ["[BUILD]"]);
    const done = await store.complete(card.id, {
      ownerId: "tester",
      summary: "landed",
      consumer_surface_evidence: { kind: "skill", filePath: skill },
    });
    expect(done.status).toBe("done");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("positive: non-empty artifact file satisfies research evidence; empty file is rejected", async () => {
    const store = createWorkboardSqliteTestStore();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cse-research-"));
    const report = path.join(dir, "report.md");
    fs.writeFileSync(report, "findings");
    const card = await createBuildCard(store, ["[INFRA]"]);
    const done = await store.complete(card.id, {
      ownerId: "tester",
      summary: "landed",
      consumer_surface_evidence: { kind: "research", filePath: report },
    });
    expect(done.status).toBe("done");

    const empty = path.join(dir, "empty.md");
    fs.writeFileSync(empty, "");
    const card2 = await createBuildCard(store, ["[BUILD]"]);
    await expect(
      store.complete(card2.id, {
        ownerId: "tester",
        summary: "done",
        consumer_surface_evidence: { kind: "research", filePath: empty },
      }),
    ).rejects.toThrow(/failed verification/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("AC3: non-build cards complete unchanged without evidence", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await createBuildCard(store, ["[RESEARCH]"]);
    const done = await store.complete(card.id, { ownerId: "tester", summary: "done" });
    expect(done.status).toBe("done");
    expect(
      (done.metadata?.artifacts ?? []).some((artifact) =>
        artifact.label?.startsWith("consumer_surface_evidence"),
      ),
    ).toBe(false);
  });
});
