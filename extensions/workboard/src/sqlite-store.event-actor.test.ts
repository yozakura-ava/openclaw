import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import type { PersistedWorkboardCard } from "./persistence-types.js";
import { createWorkboardSqliteStores } from "./sqlite-store.js";

it("events without an actor default to the system actor id", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "workboard-event-actor-"));
  const dbPath = path.join(dir, "workboard.sqlite");
  const workerModuleUrl = new URL("./sqlite-store.worker.ts", import.meta.url);
  const stores = createWorkboardSqliteStores({ dbPath, workerModuleUrl });
  try {
    await stores.ready;
    const card: PersistedWorkboardCard = {
      version: 1,
      card: {
        id: "event-actor-card",
        title: "Event actor attribution",
        status: "todo",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
        events: [
          {
            id: "evt-no-actor",
            kind: "moved",
            at: 2,
            fromStatus: "todo",
            toStatus: "ready",
          },
          {
            id: "evt-with-actor",
            kind: "moved",
            at: 3,
            fromStatus: "ready",
            toStatus: "running",
            actorId: "tsubaki",
            actorKind: "agent",
          } as never,
        ],
      },
    };
    await stores.cards.register(card.card.id, card);

    const raw = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = raw
        .prepare("SELECT id, actor_id, actor_kind FROM workboard_card_events ORDER BY ordinal")
        .all() as Array<{ id: string; actor_id: string | null; actor_kind: string | null }>;
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({ id: "evt-no-actor", actor_id: "system", actor_kind: "system" });
      expect(rows[1]).toEqual({ id: "evt-with-actor", actor_id: "tsubaki", actor_kind: "agent" });
    } finally {
      raw.close();
    }
  } finally {
    await stores.close();
    await rm(dir, { recursive: true, force: true });
  }
});
