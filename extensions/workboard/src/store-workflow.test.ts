// Tests for consumer_surface_evidence gating on workboard_complete
// (yozakura-ava/openclaw#120). The store verifies evidence independently —
// caller-supplied proof text is never trusted.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

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
