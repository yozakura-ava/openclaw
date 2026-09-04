import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Regression tests for the restart-trio backport (card a3922b20, 2026-09-03):
// - 80d44431: reclaim→done attaches a skipped-status proof stub
// - d16f9796: review-independence invariant on passed clearances
// - 6c9736f1: guardedChildRows skips malformed child rows (sqlite store)
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { WorkboardKeyedStore } from "./persistence-types.js";
import type { PersistedWorkboardCard } from "./persistence-types.js";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
import { WorkboardStore } from "./store.js";

function createMemoryStore<T = PersistedWorkboardCard>(): WorkboardKeyedStore<T> {
  const entries = new Map<string, T>();
  return {
    async register(key, value) {
      entries.set(key, value);
    },
    async lookup(key) {
      return entries.get(key);
    },
    async delete(key) {
      return entries.delete(key);
    },
    async entries() {
      return [...entries].flatMap(([key, value]) => (value ? [{ key, value }] : []));
    },
  };
}

describe("80d44431 backport: reclaim→done proof stub", () => {
  it("attaches a skipped proof stub when reclaiming straight to done with no proof", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Reclaim to done",
      status: "review",
      agentId: "builder-agent",
    });
    const reclaimed = await store.reclaim(
      card.id,
      { reason: "operator recovery", status: "done" },
      null,
    );
    expect(reclaimed.status).toBe("done");
    const proof = reclaimed.metadata?.proof ?? [];
    expect(proof).toHaveLength(1);
    expect(proof[0]).toMatchObject({
      status: "skipped",
      label: "reclaim recovery",
    });
    expect(proof[0].note).toContain("operator recovery");
    // no done_without_proof diagnostic when the stub lands
    expect(reclaimed.metadata?.diagnostics?.map((entry) => entry.kind) ?? []).not.toContain(
      "done_without_proof",
    );
  });

  it("does not attach a stub when proof already exists", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Has proof", status: "review" });
    await store.addProof(card.id, {
      status: "passed",
      label: "Existing",
      command: "cmd",
      note: "pre-existing proof",
    });
    const reclaimed = await store.reclaim(
      card.id,
      { reason: "operator recovery", status: "done" },
      null,
    );
    expect(reclaimed.metadata?.proof).toHaveLength(1);
    expect(reclaimed.metadata?.proof?.[0]).toMatchObject({ label: "Existing" });
  });
});

describe("d16f9796 backport: review-independence invariant", () => {
  it("rejects a passed clearance whose scope shares the builder agent namespace", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Self review",
      agentId: "tsubaki",
    });
    await expect(
      store.addProof(
        card.id,
        { status: "passed", label: "Rin clearance", command: "cmd", note: "n" },
        { sessionKey: "agent:tsubaki:review-x" },
      ),
    ).rejects.toThrow(/review-independence invariant/);
  });

  it("accepts a passed clearance from a different agent namespace", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Independent review",
      agentId: "tsubaki",
    });
    const updated = await store.addProof(
      card.id,
      { status: "passed", label: "Rin clearance", command: "cmd", note: "n" },
      { sessionKey: "agent:rin:review-y" },
    );
    expect(updated.metadata?.proof?.[0]).toMatchObject({ status: "passed" });
  });
});

describe("6c9736f1 backport: guardedChildRows skips malformed rows", () => {
  it("skips a comment row with an empty id and audits it to workboard_bad_rows", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-backport-trio-"));
    const dbPath = path.join(dir, "workboard.sqlite");
    try {
      const stores = createWorkboardSqliteStores({ dbPath });
      const card = {
        id: "card-malformed",
        title: "Malformed child",
        status: "todo",
        priority: "normal",
        boardId: "default",
        position: 0,
        createdAt: 1,
        updatedAt: 1,
        automation: null,
      };
      void stores.cards.register("card-malformed", { version: 1, card });
      const db = new DatabaseSync(dbPath);
      db.prepare(
        "INSERT INTO workboard_card_comments (id, card_id, ordinal, body, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run("", "card-malformed", 0, "malformed row", 123);
      const read = stores.cards.lookup("card-malformed");
      const bad = db
        .prepare("SELECT * FROM workboard_bad_rows WHERE card_id = ?")
        .all("card-malformed") as Array<{ table_name: string }>;
      db.close();
      stores.close();
      // synchronous register/lookup contract: entries resolve immediately
      expect(read).toBeDefined();
      expect(bad).toHaveLength(1);
      expect(bad[0].table_name).toBe("workboard_card_comments");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
