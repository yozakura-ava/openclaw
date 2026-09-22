import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";

const STATUS_TIMEOUT_DEFAULT_MS = 1_500;
const EVALUATION_TIMEOUT_DEFAULT_MS = 650_000;
const OFFLINE_LOCK_TIMEOUT_DEFAULT_MS = 250;
const APPLY_TIMEOUT_DEFAULT_MS = 1_850_000;

function readPositiveIntegerEnvMs(envName: string, fallbackMs: number): number {
  const rawValue = process.env[envName];
  if (!rawValue) {
    return fallbackMs;
  }
  return parseStrictPositiveInteger(rawValue) ?? fallbackMs;
}

export function resolveGatewaySkillsStatusTimeoutMs(): number {
  return readPositiveIntegerEnvMs("OPENCLAW_SKILLS_STATUS_TIMEOUT_MS", STATUS_TIMEOUT_DEFAULT_MS);
}

export function resolveGatewaySkillsEvaluationTimeoutMs(): number {
  return readPositiveIntegerEnvMs(
    "OPENCLAW_SKILLS_EVALUATION_TIMEOUT_MS",
    EVALUATION_TIMEOUT_DEFAULT_MS,
  );
}

export function resolveGatewaySkillsOfflineLockTimeoutMs(): number {
  return readPositiveIntegerEnvMs(
    "OPENCLAW_SKILLS_OFFLINE_LOCK_TIMEOUT_MS",
    OFFLINE_LOCK_TIMEOUT_DEFAULT_MS,
  );
}

export function resolveGatewaySkillsApplyTimeoutMs(): number {
  return readPositiveIntegerEnvMs("OPENCLAW_SKILLS_APPLY_TIMEOUT_MS", APPLY_TIMEOUT_DEFAULT_MS);
}
