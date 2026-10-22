import { describe, expect, it } from "vitest";
import {
  QUALIFICATION_GROUP_NAMES,
  selectQualificationGroup,
} from "../../scripts/lib/qualification-groups.mts";
import { QUALIFICATION_LEAVES } from "../../scripts/lib/qualification-leaves.mts";

describe("qualification groups", () => {
  it("partition the complete leaf manifest without duplicates", () => {
    const grouped = QUALIFICATION_GROUP_NAMES.flatMap((name) => selectQualificationGroup(name));

    expect(grouped.map((leaf) => leaf.id).toSorted()).toEqual(
      QUALIFICATION_LEAVES.map((leaf) => leaf.id).toSorted(),
    );
    expect(new Set(grouped.map((leaf) => leaf.id)).size).toBe(QUALIFICATION_LEAVES.length);
    expect(QUALIFICATION_GROUP_NAMES).toEqual([
      "build",
      "lint-core",
      "lint-extensions",
      "lint-support",
      "types-core",
      "types-tests",
      "types-other",
    ]);
  });

  it("keeps high-cost categories in independent runner groups", () => {
    expect(selectQualificationGroup("lint-core").map((leaf) => leaf.id)).toHaveLength(10);
    expect(selectQualificationGroup("lint-extensions").map((leaf) => leaf.id)).toHaveLength(22);
    expect(selectQualificationGroup("types-core")).toHaveLength(41);
  });

  it("rejects a selector outside the manifest", () => {
    expect(() => selectQualificationGroup("all")).toThrow("Unknown qualification group: all");
  });
});
