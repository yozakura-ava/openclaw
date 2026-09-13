// Regression test for issue #77: workboard tools must NOT be declared
// optional:true in either the manifest toolMetadata or the runtime registerTool
// call. Optional plugin tools are filtered out of fresh-session tool catalogs
// when the workspace-authority guard cannot resolve at session-bootstrap time
// (2026.9.x behavior), which would re-introduce the silent tool omission
// described in yozakura-ava/openclaw#77.
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
  it("declares every WORKBOARD_TOOL_NAMES entry with optional:false in the manifest", () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Manifest;
    const metadata = manifest.toolMetadata ?? {};
    const offenders: string[] = [];
    for (const name of WORKBOARD_TOOL_NAMES) {
      const entry = metadata[name];
      if (entry?.optional === true) {
        offenders.push(name);
      }
    }
    expect(
      offenders,
      `manifest toolMetadata.optional must be false for every workboard tool (issue #77); offenders: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("registers the workboard tool group with optional:false in index.ts", () => {
    const source = fs.readFileSync(indexSourcePath, "utf-8");
    // Find the registerTool call that lists WORKBOARD_TOOL_NAMES; its options
    // object must include `optional: false`.
    const match = source.match(
      /registerTool\([\s\S]*?WORKBOARD_TOOL_NAMES[\s\S]*?\}\s*,\s*\{([\s\S]*?)\}\s*\)/u,
    );
    expect(match, "expected a registerTool call referencing WORKBOARD_TOOL_NAMES").not.toBeNull();
    const options = match?.[1] ?? "";
    const optionalMatch = /\boptional\s*:\s*(true|false)\b/u.exec(options);
    expect(optionalMatch, "registerTool options must declare `optional: false`").not.toBeNull();
    expect(optionalMatch?.[1]).toBe("false");
  });
});
