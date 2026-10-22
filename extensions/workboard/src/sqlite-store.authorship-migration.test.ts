import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import type { PersistedWorkboardCard } from "./persistence-types.js";
import { createWorkboardSqliteStores } from "./sqlite-store.js";

it("adds nullable authorship columns without losing historical comments or proof", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "workboard-authorship-migration-"));
  const dbPath = path.join(dir, "workboard.sqlite");
  const workerModuleUrl = new URL("./sqlite-store.worker.ts", import.meta.url);
  const initial = createWorkboardSqliteStores({ dbPath, workerModuleUrl });
  try {
    await initial.ready;
    const card: PersistedWorkboardCard = {
      version: 1,
      card: {
        id: "historical-card",
        title: "Historical evidence",
        status: "todo",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
        metadata: {
          comments: [{ id: "old-comment", body: "Kept history", createdAt: 2 }],
          proof: [{ id: "old-proof", status: "passed", note: "Kept proof", createdAt: 3 }],
        },
      },
    };
    await initial.cards.register(card.card.id, card);
  } finally {
    await initial.close();
  }

  const legacy = new DatabaseSync(dbPath);
  try {
    for (const table of ["workboard_card_comments", "workboard_card_proof"]) {
      legacy.exec(`ALTER TABLE ${table} DROP COLUMN actor_id`);
      legacy.exec(`ALTER TABLE ${table} DROP COLUMN actor_kind`);
    }
  } finally {
    legacy.close();
  }

  const migrated = createWorkboardSqliteStores({ dbPath, workerModuleUrl });
  try {
    await migrated.ready;
    await expect(migrated.cards.lookup("historical-card")).resolves.toMatchObject({
      card: {
        metadata: {
          comments: [{ id: "old-comment", body: "Kept history" }],
          proof: [{ id: "old-proof", status: "passed", note: "Kept proof" }],
        },
      },
    });
    const schema = new DatabaseSync(dbPath, { readOnly: true });
    try {
      for (const table of ["workboard_card_comments", "workboard_card_proof"]) {
        const columns = new Set(
          (schema.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
            (column) => column.name,
          ),
        );
        expect(columns).toContain("actor_id");
        expect(columns).toContain("actor_kind");
      }
    } finally {
      schema.close();
    }
  } finally {
    await migrated.close();
    await rm(dir, { recursive: true, force: true });
  }
});
