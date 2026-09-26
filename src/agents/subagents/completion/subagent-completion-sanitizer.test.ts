import { describe, expect, it } from "vitest";
import {
  buildTokenSubstringPattern as _unusedBuildTokenSubstringPattern,
  CANARY_MARKERS,
  CANARY_PREFIX,
  EXCLUDED_NAMESPACES,
  isExcludedPath,
  logCouncilHandoffBlock,
  PRIVACY_TIER_VALUES,
  scanEnvelope,
} from "./subagent-completion-sanitizer.js";

describe("subagent-completion-sanitizer", () => {
  describe("detection-pattern constants", () => {
    it("locks the V1 exclusion list, canary markers, and tier values", () => {
      expect([...EXCLUDED_NAMESPACES]).toEqual(["memory/private/"]);
      expect(CANARY_MARKERS.length).toBe(5);
      expect(CANARY_MARKERS.every((m) => m.startsWith(CANARY_PREFIX))).toBe(true);
      expect([...PRIVACY_TIER_VALUES]).toEqual(["private_relationship"]);
    });
  });

  describe("isExcludedPath", () => {
    it.each([
      ["memory/private/diary.md", true],
      ["memory/private/canary_journal.md", true],
      ["memory/private", true],
      ["/root/.openclaw/workspace/memory/private/foo.md", true],
      ["file://memory/private/x.md", true],
      ["C:\\repo\\memory\\private\\x.md", true],
    ])("excludes %s", (path, expected) => {
      expect(isExcludedPath(path)).toBe(expected);
    });

    it.each([
      ["memory/2026-09-25.md", false],
      ["memory/private_archive/x.md", false],
      ["wiki/index.md", false],
      [null, false],
      [undefined, false],
      ["", false],
      [42, false],
    ])("does not exclude %s", (path, expected) => {
      expect(isExcludedPath(path as unknown as string)).toBe(expected);
    });
  });

  describe("scanEnvelope", () => {
    it("treats null and undefined envelopes as clean", () => {
      expect(scanEnvelope(null)).toEqual({ clean: true, hits: [] });
      expect(scanEnvelope(undefined)).toEqual({ clean: true, hits: [] });
    });

    it("returns clean for non-private terminal-reply envelopes", () => {
      const result = scanEnvelope({
        terminalReply: "Validated the cron fix; ready for review.",
        resultText: "Validated the cron fix; ready for review.",
        fallbackResultText: "older fallback",
        task: "Run targeted tests for the cron fix",
      });
      expect(result.clean).toBe(true);
      expect(result.hits).toEqual([]);
    });

    it("flags private-path references inside the terminal reply", () => {
      const result = scanEnvelope({
        terminalReply:
          "I read memory/private/canary_journal.md and the response is RELOS-CANARY-JOURNAL-2d4e6a8c.",
      });
      expect(result.clean).toBe(false);
      const patterns = result.hits.map((h) => h.pattern).sort();
      expect(patterns).toContain("memory_private_path");
      expect(patterns).toContain("canary");
    });

    it("flags privacy_tier markers carried in the resultText", () => {
      const result = scanEnvelope({
        resultText: "metadata: privacy_tier=private_relationship",
      });
      expect(result.clean).toBe(false);
      expect(result.hits.some((h) => h.pattern === "privacy_tier")).toBe(true);
    });

    it("flags marker-shape dicts with a privacy_tier field", () => {
      const result = scanEnvelope({
        marker: { kind: "warmth", privacy_tier: "private_relationship" },
      });
      expect(result.clean).toBe(false);
      expect(result.hits.some((h) => h.pattern === "privacy_tier")).toBe(true);
    });

    it("flags nested canary paths inside lists and dicts", () => {
      const result = scanEnvelope({
        fragments: [
          { kind: "context", text: "safe content" },
          { kind: "private", text: "see memory/private/diary.md" },
        ],
      });
      expect(result.clean).toBe(false);
      expect(
        result.hits.some(
          (h) => h.pattern === "memory_private_path" && h.field_path.includes("fragments"),
        ),
      ).toBe(true);
    });

    it("does not false-positive on sibling namespaces", () => {
      const result = scanEnvelope({
        terminalReply: "See memory/private_archive/notes.md and memory/2026-09-25.md",
      });
      expect(result.clean).toBe(true);
    });

    it("returns clean for scalar string envelopes with no markers", () => {
      expect(scanEnvelope("just a normal reply")).toEqual({ clean: true, hits: [] });
    });
  });

  describe("logCouncilHandoffBlock", () => {
    it("writes one JSONL row with surface=council_handoff", () => {
      // Lazy import to avoid binding the fs module when tests don't log.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require("node:fs") as typeof import("node:fs");
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const path = require("node:path") as typeof import("node:path");
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const os = require("node:os") as typeof import("node:os");

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-handoff-log-"));
      const logPath = path.join(dir, "dispatch_sanitizer_blocks.jsonl");

      const hits = [
        {
          pattern: "memory_private_path" as const,
          field_path: "terminalReply",
          excerpt: "memory/private/diary.md",
        },
      ];
      const record = logCouncilHandoffBlock("run-test-1", hits, logPath);

      expect(record.surface).toBe("council_handoff");
      expect(record.envelope_id).toBe("run-test-1");
      expect(record.hit_count).toBe(1);

      const file = fs.readFileSync(logPath, "utf-8");
      const lines = file.trim().split("\n");
      expect(lines.length).toBe(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.surface).toBe("council_handoff");
      expect(parsed.envelope_id).toBe("run-test-1");
      expect(parsed.hits[0].pattern).toBe("memory_private_path");

      fs.rmSync(dir, { recursive: true, force: true });
    });
  });
});
