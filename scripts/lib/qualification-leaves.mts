import { qualificationBuildLeaves } from "./qualification-build-leaves.mts";
import { qualificationLintLeaves } from "./qualification-lint-leaves.mts";
import { qualificationTypeLeaves } from "./qualification-type-leaves.mts";

export type QualificationLeaf = {
  id: string;
  command: string[];
  outputs: string[];
  env?: NodeJS.ProcessEnv;
};
export const QUALIFICATION_LEAVES: QualificationLeaf[] = [
  ...qualificationBuildLeaves,
  ...qualificationLintLeaves,
  ...qualificationTypeLeaves,
];
if (new Set(QUALIFICATION_LEAVES.map((leaf) => leaf.id)).size !== QUALIFICATION_LEAVES.length) {
  throw new Error("Qualification leaf IDs must be unique");
}
