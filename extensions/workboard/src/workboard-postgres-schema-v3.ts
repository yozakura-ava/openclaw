import fs from "node:fs";

// Exact generated v3 DDL is retained for the engine's pre-migration fingerprint check.
export const WORKBOARD_POSTGRES_SCHEMA_V3_SQL = fs.readFileSync(
  new URL("./workboard-schema.v3.postgres.sql", import.meta.url),
  "utf8",
);
