/**
 * REL-OS Phase 2 — Council-handoff delivery-boundary sanitizer (TypeScript mirror).
 *
 * Card:    7d65dc27-53a6-4603-8c97-e3058720ec36 (REL-OS Phase 2 / companionship)
 * Sprint:  2026-09-26-relationship-os-we-memory
 * DELEG-REF: rel-os-sprint-2
 *
 * PURPOSE
 * =======
 * Mirrors ``scripts/dispatch/dispatch_sanitizer.scan_envelope`` so the
 * subagent-completion delivery boundary (see
 * ``src/agents/subagents/completion/subagent-completion-delivery.ts``)
 * can refuse to admit a correlated queue entry whose terminal reply
 * carries private-namespace content, a ``privacy_tier`` marker, or a
 * REL-OS canary string. Closes red-team residual Path 13:
 *
 *   "Council handoff summary serialization (sessions_send payload /
 *    council inbox) — REACHABLE-by-design"
 *
 * The upstream OpenClaw dist tree does NOT call any sanitizer between
 * the subagent's canonical terminal text and the parent session
 * conversation. ``selectDeliverableSessionsReply`` in
 * ``dist/sessions-send-tokens-*.mjs`` filters sentinel tokens only.
 * This module is the choke point that closes that gap on the
 * yozakura-ava/openclaw fork tree.
 *
 * The Python source of truth remains
 * ``scripts/dispatch/dispatch_sanitizer.py``; any change to detection
 * patterns (new canaries, new namespaces, new tier values) MUST be
 * mirrored here. The mirror is intentionally stdlib-only — Node has
 * no third-party deps for this purpose, and the choke point must
 * remain hermetic.
 *
 * SCOPE
 * =====
 *   - Provide ``scanEnvelope(value)`` returning
 *     ``{ clean: boolean; hits: SanitizerHit[] }``.
 *   - Provide ``logCouncilHandoffBlock(envelopeId, hits, logPath?)``
 *     writing one JSONL row per block event to
 *     ``data/ops/dispatch_sanitizer_blocks.jsonl`` (default) with
 *     ``surface = "council_handoff"``.
 *   - Reuse the detection predicates validated in
 *     ``scripts/rel_os_namespace_exclusion.py`` (``EXCLUDED_NAMESPACES``
 *     + ``CANARY_MARKERS``) — duplicated here verbatim from the
 *     single-sourced Python module.
 *
 * USAGE
 * -----
 *
 *   import { scanEnvelope, logCouncilHandoffBlock } from
 *     "./subagent-completion-sanitizer.js";
 *
 *   const result = scanEnvelope({
 *     terminalReply: entry.completion?.terminalReply?.text,
 *     resultText: entry.completion?.resultText,
 *     fallbackResultText: entry.completion?.fallbackResultText,
 *   });
 *   if (!result.clean) {
 *     logCouncilHandoffBlock(subagent.runId, result.hits);
 *     // Refuse admission; throw / block.
 *   }
 */

// ── Detection patterns (mirror of Python source) ────────────────────────────

/** Single excluded namespace, hardcoded by V1 design. */
export const EXCLUDED_NAMESPACES: readonly string[] = ["memory/private/"];

/** Canonical REL-OS canary markers (card f9b99c87). */
export const CANARY_MARKERS: readonly string[] = [
  "RELOS-CANARY-PRIVATE-7c3a1f9b",
  "RELOS-CANARY-JOURNAL-2d4e6a8c",
  "RELOS-CANARY-AFFECT-9f1b3e5d",
  "RELOS-CANARY-CRED-4e7a9c2d",
  "RELOS-CANARY-MEDIA-6b8d0f3a",
];

/** Substring prefix that catches newly-added canaries without code changes. */
export const CANARY_PREFIX = "RELOS-CANARY";

/** Privacy tier values that must never leave a private_relationship scope. */
export const PRIVACY_TIER_VALUES: readonly string[] = ["private_relationship"];

// ── Pattern compilation ─────────────────────────────────────────────────────

/**
 * Build a regex that matches any of ``values`` as a complete token.
 *
 * The character after the matched value MUST be a non-word
 * character (``[^A-Za-z0-9_]``) or end-of-string. This keeps
 * sibling names from triggering false positives
 * (``memory/private_archive`` is not a hit because ``_`` is a word
 * character) while still covering common text continuations like
 * ``memory/private/x.md``, ``memory/private.``, or ``memory/private``
 * as the terminal token.
 */
function buildTokenSubstringPattern(values: readonly string[]): RegExp {
  const escaped: string[] = [];
  for (const v of values) {
    const cleaned = v.replace(/\/$/, "");
    if (!cleaned) continue;
    // Escape regex metacharacters; mirrors ``re.escape`` in Python.
    escaped.push(cleaned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  }
  if (escaped.length === 0) {
    // Match-nothing pattern (defensive; should not occur).
    return /(?!)/;
  }
  return new RegExp(`(?:${escaped.join("|")})(?=[^A-Za-z0-9_]|$)`, "i");
}

const EXCLUDED_NAMESPACE_TOKEN_RE: RegExp = buildTokenSubstringPattern(EXCLUDED_NAMESPACES);
const PRIVACY_TIER_TOKEN_RE: RegExp = buildTokenSubstringPattern(PRIVACY_TIER_VALUES);

// ── Types ────────────────────────────────────────────────────────────────────

export type SanitizerHitPattern = "memory_private_path" | "privacy_tier" | "canary";

export interface SanitizerHit {
  /** Detection pattern that fired. */
  pattern: SanitizerHitPattern;
  /** JSON-pointer-ish dotted path within the scanned envelope. */
  field_path: string;
  /** Truncated JSON / repr excerpt of the offending text (≤200 chars). */
  excerpt: string;
}

export interface SanitizerScanResult {
  clean: boolean;
  hits: SanitizerHit[];
}

// ── String-level checks ─────────────────────────────────────────────────────

/**
 * Component-aware path exclusion predicate (mirror of Python
 * ``is_excluded_path``).
 *
 * A path is excluded if, after normalization, ANY contiguous
 * subsequence of its path components matches one of
 * ``EXCLUDED_NAMESPACES``. Handles relative paths, absolute paths,
 * ``file://`` URIs, Windows backslashes, and sibling-name false
 * positives.
 */
export function isExcludedPath(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value !== "string") return false;
  if (!value) return false;
  let norm = value;
  if (norm.startsWith("file://")) norm = norm.slice("file://".length);
  norm = norm.replace(/\\/g, "/");
  const parts = norm
    .split("/")
    .filter((c) => c.length > 0)
    .map((c) => c.toLowerCase());
  for (const ns of EXCLUDED_NAMESPACES) {
    const nsStripped = ns.replace(/\/$/, "");
    const nsParts = nsStripped.split("/").map((c) => c.toLowerCase());
    if (parts.length < nsParts.length) continue;
    for (let i = 0; i <= parts.length - nsParts.length; i++) {
      let ok = true;
      for (let j = 0; j < nsParts.length; j++) {
        if (parts[i + j] !== nsParts[j]) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
  }
  return false;
}

/** JSON / repr excerpt of ``value`` capped at ``limit`` chars. */
function excerpt(value: unknown, limit = 200): string {
  let text: string;
  try {
    text = JSON.stringify(value, Object.keys(value as object).sort(), 2);
  } catch {
    text = String(value);
  }
  if (text.length > limit) return text.slice(0, limit - 3) + "...";
  return text;
}

/** Run all string-level checks against ``value``. */
function checkString(value: string, fieldPath: string): SanitizerHit[] {
  const hits: SanitizerHit[] = [];

  // 1. Path-based exclusion (component-aware + token-substring).
  if (isExcludedPath(value) || EXCLUDED_NAMESPACE_TOKEN_RE.test(value)) {
    hits.push({
      pattern: "memory_private_path",
      field_path: fieldPath,
      excerpt: excerpt(value),
    });
  }

  // 2. Explicit privacy_tier (exact value + token-substring).
  if (
    (PRIVACY_TIER_VALUES as readonly string[]).includes(value) ||
    PRIVACY_TIER_TOKEN_RE.test(value)
  ) {
    hits.push({
      pattern: "privacy_tier",
      field_path: fieldPath,
      excerpt: excerpt(value),
    });
  }

  // 3. Canary prefix scan.
  if (value.includes(CANARY_PREFIX)) {
    hits.push({
      pattern: "canary",
      field_path: fieldPath,
      excerpt: excerpt(value),
    });
  }

  // 4. Canonical canary marker exact-substring (defense-in-depth).
  for (const marker of CANARY_MARKERS) {
    if (value.includes(marker)) {
      hits.push({
        pattern: "canary",
        field_path: fieldPath,
        excerpt: excerpt(value),
      });
      break;
    }
  }

  return hits;
}

// ── Traversal ───────────────────────────────────────────────────────────────

/** Recursively walk ``value`` and append hits to ``out``. */
function walkEnvelope(value: unknown, path: string, out: SanitizerHit[]): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, idx) => walkEnvelope(item, `${path}[${idx}]`, out));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const keyPath = path ? `${path}.${k}` : k;
      walkEnvelope(v, keyPath, out);
    }
    return;
  }
  if (typeof value === "string") {
    out.push(...checkString(value, path));
    return;
  }
  // bool/int/float — no string-scannable surface.
}

/**
 * Marker-shape pass: any dict carrying a ``privacy_tier`` field with
 * a recognized tier value. Mirrors the marker-shape pass in
 * Python ``_scan_marker_like``.
 */
function scanMarkerLike(value: unknown, basePath: string): SanitizerHit[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  const obj = value as Record<string, unknown>;
  const tier = obj.privacy_tier;
  if (typeof tier === "string" && (PRIVACY_TIER_VALUES as readonly string[]).includes(tier)) {
    return [
      {
        pattern: "privacy_tier",
        field_path: basePath,
        excerpt: excerpt({ privacy_tier: tier }),
      },
    ];
  }
  return [];
}

/** Walk the envelope collecting marker-shape hits. */
function scanMarkers(value: unknown, path: string, out: SanitizerHit[]): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, idx) => scanMarkers(item, `${path}[${idx}]`, out));
    return;
  }
  if (typeof value === "object") {
    out.push(...scanMarkerLike(value, path || "<root>"));
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      scanMarkers(v, path ? `${path}.${k}` : k, out);
    }
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Return a :class:`SanitizerScanResult` for ``envelope``.
 *
 * Pure: no I/O, no mutation. Callers that want a side-effecting
 * ``assert + log`` path should pair this with
 * :func:`logCouncilHandoffBlock`.
 */
export function scanEnvelope(envelope: unknown): SanitizerScanResult {
  if (envelope === null || envelope === undefined) {
    return { clean: true, hits: [] };
  }
  if (
    typeof envelope !== "object" &&
    typeof envelope !== "string" &&
    typeof envelope !== "number" &&
    typeof envelope !== "boolean"
  ) {
    return {
      clean: false,
      hits: [
        {
          pattern: "memory_private_path",
          field_path: "<root>",
          excerpt: excerpt(envelope),
        },
      ],
    };
  }
  const hits: SanitizerHit[] = [];
  walkEnvelope(envelope, "", hits);
  scanMarkers(envelope, "", hits);
  return { clean: hits.length === 0, hits };
}

// ── Audit log ───────────────────────────────────────────────────────────────

/** Default log path: workspace-scoped dispatch sanitizer block log. */
export function defaultCouncilHandoffLogPath(): string {
  const workspace = process.env.OPENCLAW_WORKSPACE ?? "/root/.openclaw/workspace";
  return `${workspace.replace(/\/$/, "")}/data/ops/dispatch_sanitizer_blocks.jsonl`;
}

export interface CouncilHandoffBlockRecord {
  timestamp: string;
  envelope_id: string;
  surface: "council_handoff";
  hit_count: number;
  hits: SanitizerHit[];
}

/** Current UTC time in ISO 8601 with explicit ``Z``. */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Append a single block event to ``logPath`` (JSONL).
 *
 * The function is the only place that writes ``council_handoff``
 * surface events to ``data/ops/dispatch_sanitizer_blocks.jsonl``;
 * callers MUST NOT bypass it. The append is sync because the
 * delivery boundary is already synchronous and we need the audit
 * row durable before the throw / block propagates.
 */
export function logCouncilHandoffBlock(
  envelopeId: string,
  hits: readonly SanitizerHit[],
  logPath?: string,
): CouncilHandoffBlockRecord {
  // Lazy import: keep the module pure-functional for tests that
  // only exercise scanEnvelope().
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require("node:path") as typeof import("node:path");

  const target = logPath ?? defaultCouncilHandoffLogPath();
  const targetDir = path.dirname(target);
  fs.mkdirSync(targetDir, { recursive: true });

  const record: CouncilHandoffBlockRecord = {
    timestamp: nowIso(),
    envelope_id: String(envelopeId),
    surface: "council_handoff",
    hit_count: hits.length,
    hits: hits.slice(),
  };
  fs.appendFileSync(target, `${JSON.stringify(record)}\n`, { encoding: "utf-8" });
  return record;
}
