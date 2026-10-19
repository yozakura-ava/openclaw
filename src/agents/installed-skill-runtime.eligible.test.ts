// Card ece9ecfa: hidden-but-eligible skills stay readable and searchable while the
// prompt directory keeps showing only the prompt-visible projection.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildSkillSnapshot } from "../skills/loading/workspace-skill-prompt.js";
import { writeWorkspaceSkills } from "../skills/test-support/e2e-test-helpers.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { finalizeAgentToolAvailability } from "./agent-tool-availability.js";
import { prepareEmbeddedSkills } from "./embedded-agent-runner/skill-runtime.js";
import { prepareInstalledSkillCatalog } from "./installed-skill-runtime.js";
import { createInstalledSkillTools } from "./tools/installed-skill-tools.js";

vi.mock("../skills/loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
}));

const AGENT_ID = "sumire";
const HIDDEN_COUNT = 9;
const TOTAL_COUNT = 30;
const BODY_MARKER = "quokka-deployment-canary";
const HIDDEN_BODY_MARKER = "hidden-protocol-zephyr";

const skillName = (index: number) => `eligible-skill-${String(index).padStart(2, "0")}`;
const hiddenNames = new Set(
  Array.from({ length: HIDDEN_COUNT }, (_, offset) => skillName(offset * 3)),
);
const allNames = Array.from({ length: TOTAL_COUNT }, (_, index) => skillName(index));

async function buildReproSnapshot(workspaceDir: string) {
  await writeWorkspaceSkills(
    workspaceDir,
    allNames.map((name) => ({
      name,
      description: `Skill ${name} for ${BODY_MARKER} work`,
      body: hiddenNames.has(name)
        ? `# ${name}\n\n${BODY_MARKER} instructions for ${name}.\n\n${HIDDEN_BODY_MARKER}\n`
        : `# ${name}\n\n${BODY_MARKER} instructions for ${name}.\n`,
      ...(hiddenNames.has(name) ? { frontmatterExtra: "disable-model-invocation: true" } : {}),
    })),
  );
  const config = {
    agents: { entries: { [AGENT_ID]: { skills: allNames } } },
  } as unknown as OpenClawConfig;
  return await buildSkillSnapshot(workspaceDir, { config, agentId: AGENT_ID });
}

describe("eligible vs prompt-visible skill sets", () => {
  it("keeps hidden skills out of the prompt while skills tools resolve the eligible set", async () => {
    await withTempDir("installed-skill-eligible-", async (workspaceDir) => {
      const snapshot = await buildReproSnapshot(workspaceDir);
      const promptNames = allNames.filter((name) => snapshot.prompt.includes(name));

      // Catalog projection: exactly the visible 21.
      expect(promptNames).toHaveLength(TOTAL_COUNT - HIDDEN_COUNT);
      for (const name of hiddenNames) {
        expect(snapshot.prompt).not.toContain(name);
      }

      const installedSkills = prepareInstalledSkillCatalog({
        snapshot,
        workspaceDir,
      });
      const catalogNames = new Set(installedSkills.map((skill) => skill.name));
      for (const name of allNames) {
        expect(catalogNames.has(name)).toBe(true);
      }
      // Hidden skills never reach a model-invoking surface.
      const invocable = installedSkills.filter((skill) => skill.modelInvocable !== false);
      expect(invocable).toHaveLength(TOTAL_COUNT - HIDDEN_COUNT);

      const tools = createInstalledSkillTools(installedSkills);
      finalizeAgentToolAvailability(tools);
      const search = expectDefined(tools[0], "search");
      const read = expectDefined(tools[1], "read");

      const hiddenName = expectDefined([...hiddenNames][0], "hidden skill name");
      const readResult = await read.execute("call-read", { name: hiddenName });
      expect(readResult.details).toMatchObject({ name: hiddenName });
      expect(JSON.stringify(readResult.details)).toContain(BODY_MARKER);

      const searchResult = await search.execute("call-search", { query: BODY_MARKER, limit: 20 });
      // Full coverage omits the coverage field entirely; a partial index reports
      // bodyIndexed below the catalog size, so an absent field IS the 30/30 result.
      expect(searchResult.details.coverage).toBeUndefined();
      // A broad term matches all 30 equally, so containment is asserted on the
      // hidden-only term below instead of on the capped result page.
      expect((searchResult.details.skills as unknown[]).length).toBe(20);

      // A term that exists only inside a hidden skill's body proves the search
      // index reaches hidden-skill bodies, not just their metadata.
      const hiddenSearch = await search.execute("call-search", {
        query: HIDDEN_BODY_MARKER,
        limit: 20,
      });
      expect((hiddenSearch.details.skills as Array<{ name: string }>).map((s) => s.name)).toContain(
        hiddenName,
      );
    });
  });

  it("keeps hidden skills non-invocable at the Code Mode surface", async () => {
    await withTempDir("installed-skill-code-mode-", async (workspaceDir) => {
      const snapshot = await buildReproSnapshot(workspaceDir);
      const prepared = await prepareEmbeddedSkills({
        attempt: { config: {}, skillsSnapshot: snapshot },
        effectiveWorkspace: workspaceDir,
        sandbox: undefined,
        sessionAgentId: AGENT_ID,
        includeCodeModeSkills: true,
        applySkillEnvironment: false,
      });

      // Surface-level guard: deleting the modelInvocable filter in skill-runtime.ts
      // puts every hidden skill into codeModeSkills and fails this assertion.
      const codeModeNames = prepared.codeModeSkills.map((skill) => skill.name);
      expect(codeModeNames.length).toBeGreaterThan(0);
      for (const name of hiddenNames) {
        expect(codeModeNames).not.toContain(name);
      }
      // And the readable superset is unaffected: hidden skills stay in the catalog.
      expect(prepared.installedSkills.map((skill) => skill.name).sort()).toEqual(
        [...allNames].sort(),
      );
    });
  });

  it("leaves the prompt-visible projection unchanged when no skill is hidden", async () => {
    await withTempDir("installed-skill-visible-", async (workspaceDir) => {
      await writeWorkspaceSkills(
        workspaceDir,
        allNames.map((name) => ({
          name,
          description: `Skill ${name}`,
          body: `# ${name}\n`,
        })),
      );
      const config = {
        agents: { entries: { [AGENT_ID]: { skills: allNames } } },
      } as unknown as OpenClawConfig;
      const snapshot = await buildSkillSnapshot(workspaceDir, { config, agentId: AGENT_ID });
      const installedSkills = prepareInstalledSkillCatalog({ snapshot, workspaceDir });

      expect(installedSkills).toHaveLength(TOTAL_COUNT);
      expect(installedSkills.every((skill) => skill.modelInvocable !== false)).toBe(true);
      expect(snapshot.discoverySkills?.map((skill) => skill.name).sort()).toEqual(allNames);
    });
  });
});
