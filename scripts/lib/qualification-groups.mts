import { QUALIFICATION_LEAVES } from "./qualification-leaves.mts";

const typeCoreLeaves = QUALIFICATION_LEAVES.filter(
  (leaf) => /^types-core-\d+$/u.test(leaf.id) || leaf.id === "types-ui",
);
const typeTestLeaves = QUALIFICATION_LEAVES.filter(
  (leaf) => leaf.id.startsWith("types-core-test-") || leaf.id.startsWith("types-test-root-"),
);
const typeOtherIds = new Set([...typeCoreLeaves, ...typeTestLeaves].map((leaf) => leaf.id));

const groupedLeaves = {
  build: QUALIFICATION_LEAVES.filter((leaf) =>
    /^(?:build-|boundary-|format-check$|create-package$|install-smoke$)/u.test(leaf.id),
  ),
  "lint-core": QUALIFICATION_LEAVES.filter((leaf) => /^lint-core-\d+$/u.test(leaf.id)),
  "lint-extensions": QUALIFICATION_LEAVES.filter((leaf) => /^lint-extensions-\d+$/u.test(leaf.id)),
  "lint-support": QUALIFICATION_LEAVES.filter((leaf) =>
    ["lint-i18n", "lint-scripts", "lint-stylelint"].includes(leaf.id),
  ),
  "types-core": typeCoreLeaves,
  "types-tests": typeTestLeaves,
  "types-other": QUALIFICATION_LEAVES.filter(
    (leaf) => leaf.id.startsWith("types-") && !typeOtherIds.has(leaf.id),
  ),
} satisfies Record<string, typeof QUALIFICATION_LEAVES>;

const groupedIds = Object.values(groupedLeaves).flatMap((leaves) => leaves.map((leaf) => leaf.id));
const expectedIds = QUALIFICATION_LEAVES.map((leaf) => leaf.id);
if (
  groupedIds.length !== expectedIds.length ||
  new Set(groupedIds).size !== expectedIds.length ||
  expectedIds.some((id) => !groupedIds.includes(id))
) {
  throw new Error("Qualification groups must be a disjoint, complete leaf partition");
}

export const QUALIFICATION_GROUP_NAMES = Object.keys(groupedLeaves) as Array<
  keyof typeof groupedLeaves
>;

export function selectQualificationGroup(name: string) {
  if (!Object.hasOwn(groupedLeaves, name)) {
    throw new Error(`Unknown qualification group: ${name}`);
  }
  return groupedLeaves[name as keyof typeof groupedLeaves];
}
