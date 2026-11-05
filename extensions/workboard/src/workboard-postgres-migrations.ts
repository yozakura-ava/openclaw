import type { StoreSchema } from "openclaw/plugin-sdk/database-engine-worker-runtime";
import { WORKBOARD_POSTGRES_SCHEMA_V3_SQL } from "./workboard-postgres-schema-v3.js";
import { WORKBOARD_POSTGRES_SCHEMA_SQL } from "./workboard-postgres-schema.js";

export const WORKBOARD_POSTGRES_MIGRATIONS: StoreSchema["postgresMigrations"] = [
  {
    version: 4,
    fromSchema: { postgres: WORKBOARD_POSTGRES_SCHEMA_V3_SQL },
    sql: `
      ALTER TABLE workboard_card_events ADD COLUMN actor_id TEXT, ADD COLUMN actor_kind TEXT;
      ALTER TABLE workboard_card_comments ADD COLUMN actor_id TEXT, ADD COLUMN actor_kind TEXT;
      ALTER TABLE workboard_card_proof ADD COLUMN actor_id TEXT, ADD COLUMN actor_kind TEXT;
    `,
    schema: { postgres: WORKBOARD_POSTGRES_SCHEMA_SQL },
  },
];
