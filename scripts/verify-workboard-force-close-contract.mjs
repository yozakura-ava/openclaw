#!/usr/bin/env node

/**
 * Verify the complete Workboard force-close exposure chain.
 *
 * Static checks cover source, the tool-name registry, the plugin manifest, and
 * configured per-agent policy. Optional live checks call /tools/invoke with
 * intentionally invalid arguments: an allowed agent must reach validation,
 * while a denied agent must be rejected as unavailable. No card is mutated.
 *
 * Usage:
 *   node scripts/verify-workboard-force-close-contract.mjs \
 *     --config /root/.openclaw/openclaw.json
 *
 * Live probe:
 *   node scripts/verify-workboard-force-close-contract.mjs \
 *     --config /root/.openclaw/openclaw.json \
 *     --live-url http://127.0.0.1:18789 \
 *     --live-auth-header 'Authorization: Bearer <token>'
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const toolName = "workboard_force_close";
const allowedAgentIds = ["main", "himari", "reina"];

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : undefined;
}

function requireFile(relativePath) {
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath)) {
    throw new Error(`missing ${relativePath}`);
  }
  return fs.readFileSync(filePath, "utf8");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function hasTool(allow, name = toolName) {
  return Array.isArray(allow) && allow.some((entry) => entry === name);
}

function verifyStaticExposure() {
  const toolSource = requireFile("extensions/workboard/src/tools.ts");
  const namesSource = requireFile("extensions/workboard/src/workspace-access.ts");
  const policySource = requireFile("extensions/workboard/src/store-constants.ts");
  const manifest = JSON.parse(requireFile("extensions/workboard/openclaw.plugin.json"));

  assert(
    /name:\s*["']workboard_force_close["']/.test(toolSource),
    "tool implementation is missing",
  );
  assert(namesSource.includes(`"${toolName}"`), "WORKBOARD_TOOL_NAMES is missing force-close");
  assert(
    allowedAgentIds.every((id) => policySource.includes(`"${id}"`)),
    "canonical force-close agent policy is missing main/himari/reina",
  );
  assert(
    manifest.contracts?.tools?.includes(toolName),
    "manifest contracts.tools is missing force-close",
  );
  assert(
    manifest.toolMetadata?.[toolName]?.optional === true,
    "manifest toolMetadata does not mark force-close optional",
  );
}

function verifyConfiguredPolicy(configPath) {
  if (!configPath) {
    return { checked: false, failures: [] };
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const entries = config?.agents?.entries;
  assert(
    entries && typeof entries === "object" && !Array.isArray(entries),
    "agents.entries is missing",
  );

  const failures = [];
  for (const [agentId, entry] of Object.entries(entries)) {
    const allow = entry?.tools?.allow;
    const hasForceClose = hasTool(allow);
    if (allowedAgentIds.includes(agentId)) {
      if (Array.isArray(allow) && !hasForceClose) {
        failures.push(`${agentId}: explicit allowlist omits ${toolName}`);
      }
    } else if (hasForceClose) {
      failures.push(`${agentId}: deny-by-default policy must omit ${toolName}`);
    }
  }
  return { checked: true, failures };
}

async function verifyLivePolicy(baseUrl, authHeader) {
  if (!baseUrl) {
    return { checked: false, failures: [] };
  }
  const headers = { "content-type": "application/json" };
  if (authHeader) {
    const separator = authHeader.indexOf(":");
    assert(separator > 0, "--live-auth-header must be formatted as 'Name: value'");
    headers[authHeader.slice(0, separator).trim()] = authHeader.slice(separator + 1).trim();
  }
  const failures = [];
  for (const [agentId, expectedAllowed] of [
    ["himari", true],
    ["tomoe", false],
  ]) {
    const response = await fetch(`${baseUrl.replace(/\/$/u, "")}/tools/invoke`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: toolName,
        agentId,
        sessionKey: agentId,
        args: {},
      }),
    });
    const body = await response.json().catch(() => ({}));
    const unavailable = response.status === 404 && body?.error?.type === "not_found";
    if (expectedAllowed ? unavailable : !unavailable) {
      failures.push(
        `${agentId}: expected ${expectedAllowed ? "validation" : "not_found"}, got ${response.status} ${JSON.stringify(body)}`,
      );
    }
  }
  return { checked: true, failures };
}

try {
  verifyStaticExposure();
  const configPath = readOption("--config");
  const configured = verifyConfiguredPolicy(configPath);
  const live = await verifyLivePolicy(readOption("--live-url"), readOption("--live-auth-header"));
  const failures = [...configured.failures, ...live.failures];
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exitCode = 1;
  } else {
    console.log(
      `workboard-force-close-contract: PASS (static; config=${configured.checked ? "checked" : "skipped"}, live=${live.checked ? "checked" : "skipped"})`,
    );
  }
} catch (error) {
  console.error(
    `workboard-force-close-contract: FAIL: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
