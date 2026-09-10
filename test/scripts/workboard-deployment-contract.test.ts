import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectWorkboardArchiveErrors,
  collectWorkboardSourceContractErrors,
  extractWorkboardToolNames,
  WORKBOARD_REQUIRED_ARCHIVE_PATHS,
} from "../../scripts/lib/workboard-deployment-contract.mts";

describe("Workboard deployment contract", () => {
  it("extracts the complete runtime registration list", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "extensions/workboard/src/workspace-access.ts"),
      "utf8",
    );
    const names = extractWorkboardToolNames(source);

    expect(names).toHaveLength(36);
    expect(names).toContain("workboard_force_close");
    expect(new Set(names).size).toBe(names.length);
  });

  it("keeps the checked-out source, manifest, and registration options aligned", () => {
    expect(collectWorkboardSourceContractErrors(process.cwd())).toStrictEqual([]);
  });

  it("fails closed when archive paths are missing", () => {
    const errors = collectWorkboardArchiveErrors(["dist/build-info.json"]);

    expect(errors).toHaveLength(WORKBOARD_REQUIRED_ARCHIVE_PATHS.length - 1);
    expect(errors).toContain(
      "Workboard deployment archive is missing required path: dist/extensions/workboard/openclaw.plugin.json",
    );
  });

  it("accepts an archive containing the Workboard runtime and workspace templates", () => {
    expect(collectWorkboardArchiveErrors(WORKBOARD_REQUIRED_ARCHIVE_PATHS)).toStrictEqual([]);
  });
});
