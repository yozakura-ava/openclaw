import { createHmac } from "node:crypto";
import fs from "node:fs";
import { requireNonEmpty } from "@openclaw/execution-contract";

function readCredential(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const pathName = env.OPENCLAW_DBOS_HMAC_CREDENTIAL;
  if (!pathName) {
    return undefined;
  }
  return fs.readFileSync(pathName, "utf8").trim();
}

export function loadDbosSharedSecret(env: NodeJS.ProcessEnv = process.env): string {
  return requireNonEmpty(readCredential(env), "DBOS HMAC secret");
}

export function signDbosRequest(
  secret: string,
  method: string,
  pathName: string,
  timestamp: string,
  nonce: string,
  body: string,
): string {
  return createHmac("sha256", requireNonEmpty(secret, "DBOS HMAC secret"))
    .update(`${method}\n${pathName}\n${timestamp}\n${nonce}\n${body}`)
    .digest("hex");
}
