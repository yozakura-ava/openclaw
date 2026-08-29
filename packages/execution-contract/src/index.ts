import { createHash } from "node:crypto";

export type ExecutionIdentityInput = {
  cardId: string;
  queue: string;
  runId: string;
};

/**
 * The single admission envelope shared by BQES, DBOS, and gateway dispatch.
 * `workflowId` and `admissionTimestamp` are filled in by the admission
 * authority; callers must not invent a second identity for the same attempt.
 */
export type AdmissionEnvelope = ExecutionIdentityInput & {
  attemptId: string;
  idempotencyKey: string;
  workflowId: string;
  sourceIdentity: string;
  artifactIdentity: string;
  ownerEpoch: string;
  allowedFiles: string[];
  targetFiles: string[];
  acceptanceCriteria: string[];
  verificationCommand: string;
  artifactPath?: string;
  buildArtifactPath?: string;
  documentedExemptPaths?: string[];
  admissionTimestamp: number;
};

export type AdmissionGate = {
  assertAdmissionOpen(): void;
};

export type CanonicalControlName = "admission" | "autonomousClosure" | "repair" | "bridgeDelivery";

export type CanonicalKillSwitches = Record<CanonicalControlName, boolean>;

/**
 * Control-plane switches are environment-owned so a broken card cannot
 * re-enable a disabled operation by writing metadata into Workboard.
 */
export function readCanonicalKillSwitches(
  env: NodeJS.ProcessEnv = process.env,
): CanonicalKillSwitches {
  const disabled = (name: CanonicalControlName): boolean =>
    env[`OPENCLAW_KILL_${name.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`] === "1";
  return {
    admission: !disabled("admission"),
    autonomousClosure: !disabled("autonomousClosure"),
    repair: !disabled("repair"),
    bridgeDelivery: !disabled("bridgeDelivery"),
  };
}

export function assertCanonicalControl(
  name: CanonicalControlName,
  switches: CanonicalKillSwitches = readCanonicalKillSwitches(),
): void {
  if (!switches[name]) {
    throw new Error(`canonical control is disabled: ${name}`);
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function identityDigest(input: ExecutionIdentityInput): string {
  return createHash("sha256")
    .update(`${input.cardId}\0${input.queue}\0${input.runId}`)
    .digest("hex");
}

export function deriveIdempotencyKey(input: ExecutionIdentityInput): string {
  return `openclaw:${identityDigest(input)}`;
}

export function deriveWorkflowId(input: ExecutionIdentityInput): string {
  return `dbos:${identityDigest(input)}`;
}

export function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

export type ApprovedVerificationCommand = {
  executable: "go" | "npm" | "pnpm";
  args: string[];
  command: string;
};

const SAFE_ARGUMENT = /^[A-Za-z0-9_./:@=+,%~?-]+$/;

function containsVerificationShellSyntax(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f || "'\"\\;|&><$()`".includes(character)) {
      return true;
    }
  }
  return false;
}

function rejectUnsafeVerificationArgument(argument: string): void {
  if (
    !argument ||
    !SAFE_ARGUMENT.test(argument) ||
    argument.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(argument) ||
    argument.split("/").some((segment) => segment === "..") ||
    argument.includes("/../")
  ) {
    throw new Error(`verification command argument is outside the approved policy: ${argument}`);
  }
}

/**
 * Parse the only verification commands admitted by the canonical contract.
 * The result is suitable for direct argv execution; no caller may pass a
 * shell command string to a trusted verifier or the DBOS authority.
 */
export function parseApprovedVerificationCommand(value: unknown): ApprovedVerificationCommand {
  const command = requireNonEmpty(value, "verification command");
  if (command.length > 500 || containsVerificationShellSyntax(command)) {
    throw new Error("verification command contains shell or control syntax");
  }
  const tokens = command.split(/ +/u);
  if (tokens.some((token) => token.length === 0)) {
    throw new Error("verification command contains invalid whitespace");
  }
  const [executable, ...args] = tokens;
  if (executable !== "pnpm" && executable !== "npm" && executable !== "go") {
    throw new Error(`verification executable is not approved: ${executable}`);
  }
  args.forEach(rejectUnsafeVerificationArgument);

  if (executable === "pnpm") {
    if (args[0] !== "test") {
      throw new Error("pnpm verification must invoke the test script");
    }
    const testTargets = args.slice(1);
    if (testTargets.some((argument) => argument.startsWith("-"))) {
      throw new Error(
        "pnpm verification permits only repository-relative test targets after the test script",
      );
    }
  } else if (executable === "npm") {
    if (args.length !== 1 || args[0] !== "test") {
      throw new Error("npm verification must be exactly npm test");
    }
  } else {
    if (args[0] !== "test" || args.slice(1).some((argument) => argument.startsWith("-"))) {
      throw new Error("go verification must invoke go test without executable override flags");
    }
    if (args.slice(1).some((argument) => !argument.startsWith("./") && argument !== ".")) {
      throw new Error("go verification packages must be repository-relative");
    }
  }
  return { executable, args, command: [executable, ...args].join(" ") };
}

/**
 * Normalize and validate a repository-relative file manifest.  Admission is
 * deliberately stricter than a generic path parser: a card must not be able
 * to smuggle an absolute path, a parent traversal, a URL, or a placeholder
 * into a worker scope.
 */
export function normalizeRepositoryRelativeManifest(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} manifest is required.`);
  }
  const paths = value.map((entry) => {
    const raw = requireNonEmpty(entry, `${label} path`).replaceAll("\\", "/");
    if (
      raw.startsWith("/") ||
      /^[A-Za-z]:\//.test(raw) ||
      raw.startsWith("//") ||
      raw.includes("\0") ||
      raw === "." ||
      raw === ".." ||
      raw.startsWith("../") ||
      raw.includes("/../") ||
      raw.endsWith("/..") ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw) ||
      /(?:\$\{|\$\(|<[^>]*>|\*|\.\.\.)/.test(raw)
    ) {
      throw new Error(`${label} contains a non-repository-relative path: ${raw}`);
    }
    return raw.replace(/^\.\//, "");
  });
  return [...new Set(paths)].toSorted();
}

export function requireSpecificationSections(value: unknown): void {
  const text = requireNonEmpty(value, "specification");
  if (!/(^|\n)\s*#{0,6}\s*acceptance criteria\s*:?.*$/im.test(text)) {
    throw new Error("specification must contain an Acceptance Criteria section.");
  }
  if (!/(^|\n)\s*#{0,6}\s*verification\s*:?.*$/im.test(text)) {
    throw new Error("specification must contain a Verification section.");
  }
}
