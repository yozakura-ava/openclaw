import fs from "node:fs";
import { Pool, type PoolConfig } from "pg";
import { createDbosAuthorityServer, loadDbosSharedSecret } from "./authority-server.js";
import { PostgresDbosAuthorityBackend } from "./authority.js";
import { createDbosSdkAuthority } from "./sdk-authority.js";

function credentialValue(pathName: string | undefined, label: string): string | undefined {
  if (!pathName) {
    return undefined;
  }
  const value = fs.readFileSync(pathName, "utf8").trim();
  if (!value) {
    throw new Error(`${label} credential is empty`);
  }
  return value;
}

function poolConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  const password = credentialValue(
    env.OPENCLAW_DBOS_PG_PASSWORD_CREDENTIAL,
    "DBOS PostgreSQL password",
  );
  const databaseUrl = env.OPENCLAW_DBOS_DATABASE_URL ?? env.DATABASE_URL;
  if (databaseUrl) {
    return password
      ? { connectionString: databaseUrl, password }
      : { connectionString: databaseUrl };
  }
  const host = env.OPENCLAW_DBOS_PG_HOST ?? "127.0.0.1";
  const port = Number(env.OPENCLAW_DBOS_PG_PORT ?? "5433");
  const user = env.OPENCLAW_DBOS_PG_USER ?? "honcho";
  const database = env.OPENCLAW_DBOS_PG_DATABASE ?? "dbos_db";
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("DBOS PostgreSQL port is invalid");
  }
  return { host, port, user, database, password };
}

function systemDatabaseUrl(config: PoolConfig): string {
  if (config.connectionString) {
    return config.connectionString;
  }
  const user = encodeURIComponent(config.user ?? "honcho");
  const password = config.password ? `:${encodeURIComponent(String(config.password))}` : "";
  const host = config.host ?? "127.0.0.1";
  const port = config.port ?? 5433;
  const database = encodeURIComponent(config.database ?? "dbos_db");
  return `postgresql://${user}${password}@${host}:${port}/${database}`;
}

const configuredPool = poolConfig();
const pool = new Pool({
  ...configuredPool,
  // The authority backend and the DBOS SDK deliberately share this pool.
  // Each admitted SDK operation can hold a connection while the projection
  // backend acquires another, so four connections are insufficient under the
  // configured two-worker queue concurrency and can surface as pool-connect
  // timeouts even while the health probe is idle.
  max: 12,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});
const sdk = createDbosSdkAuthority({ pool, systemDatabaseUrl: systemDatabaseUrl(configuredPool) });
await sdk.launch();
const backend = new PostgresDbosAuthorityBackend(pool, sdk);
await backend.migrate();
const server = createDbosAuthorityServer({
  backend,
  sharedSecret: loadDbosSharedSecret(),
  allowedHosts: (process.env.OPENCLAW_DBOS_ALLOWED_HOSTS ?? "127.0.0.1,localhost,::1")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
});
const host = process.env.OPENCLAW_DBOS_BIND_HOST ?? "127.0.0.1";
const port = Number(process.env.OPENCLAW_DBOS_PORT ?? 8787);
server.listen(port, host);

const shutdown = async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  await sdk.shutdown();
  await pool.end();
};
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
