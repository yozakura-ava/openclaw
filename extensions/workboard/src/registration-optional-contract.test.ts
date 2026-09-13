// Regression test for issue #77: workboard tools must be EXPLICITLY declared
// optional:false in both the manifest toolMetadata and the runtime registerTool
// call. Optional plugin tools are filtered out of fresh-session tool catalogs
// when the workspace-authority guard cannot resolve at session-bootstrap time
// (2026.9.x behavior), which would re-introduce the silent tool omission
// described in yozakura-ava/openclaw#77. A missing entry OR an entry that
// omits the optional flag is just as bad as optional:true — both let the
// bootstrap layer filter the tool out — so we assert presence AND value.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WORKBOARD_TOOL_NAMES } from "./workspace-access.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(here, "..", "openclaw.plugin.json");
const indexSourcePath = path.join(here, "..", "index.ts");

type Manifest = {
  toolMetadata?: Record<string, { optional?: boolean } | undefined>;
};

describe("workboard tool registration contract (#77)", () => {
  it("declares every WORKBOARD_TOOL_NAMES entry with explicit optional:false in the manifest", () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Manifest;
    const metadata = manifest.toolMetadata ?? {};
    const missingOrWrong: string[] = [];
    const valueSeen = new Map<string, unknown>();
    for (const name of WORKBOARD_TOOL_NAMES) {
      const entry = metadata[name];
      valueSeen.set(name, entry?.optional);
      // Require the entry to exist AND have explicit optional:false. Any
      // other value (undefined / missing entry / true / anything else) is a
      // regression that could re-introduce the silent tool omission.
      if (entry?.optional !== false) {
        missingOrWrong.push(`${name} (optional=${JSON.stringify(entry?.optional)})`);
      }
    }
    expect(
      missingOrWrong,
      `manifest toolMetadata.<name>.optional must exist AND equal false for every WORKBOARD_TOOL_NAMES entry (issue #77); offenders: ${missingOrWrong.join(", ")}`,
    ).toEqual([]);
  });

  it("registers the workboard tool group with explicit optional:false in index.ts", () => {
    const source = fs.readFileSync(indexSourcePath, "utf-8");
    // Find the registerTool call that lists WORKBOARD_TOOL_NAMES; its options
    // object must include the literal `optional: false`.
    const match = source.match(
      /registerTool\([\s\S]*?WORKBOARD_TOOL_NAMES[\s\S]*?\}\s*,\s*\{([\s\S]*?)\}\s*\)/u,
    );
    expect(match, "expected a registerTool call referencing WORKBOARD_TOOL_NAMES").not.toBeNull();
    const options = match?.[1] ?? "";
    const optionalMatch = /\boptional\s*:\s*(true|false)\b/u.exec(options);
    expect(
      optionalMatch,
      "registerTool options block must declare the literal `optional: false`",
    ).not.toBeNull();
    expect(optionalMatch?.[1]).toBe("false");
  });
});
