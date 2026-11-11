// Tests Dockerfile metadata and expected install commands.
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLED_PLUGIN_ROOT_DIR } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { isMap, parseAllDocuments } from "yaml";
import { useAutoCleanupTempDirTracker } from "../test/helpers/temp-dir.js";
import { resolveTestNodeExecPath } from "./test-utils/node-process.js";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const dockerfilePath = join(repoRoot, "Dockerfile");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function collapseDockerContinuations(dockerfile: string): string {
  return dockerfile.replace(/\\\r?\n[ \t]*/g, " ");
}

async function stageDockerManifestCopies(params: { body: string; fixture: string; stage: string }) {
  const stageRoot = join(params.fixture, params.stage);
  const body = params.body.replaceAll("${OPENCLAW_BUNDLED_PLUGIN_DIR}", BUNDLED_PLUGIN_ROOT_DIR);
  for (const [, from, inputs, destination] of body.matchAll(
    /^COPY (?:--from=(\S+) )?(.+) (\S+)$/gm,
  )) {
    if (!inputs || !destination) {
      throw new Error("Docker manifest COPY inputs are missing");
    }
    const sourceRoot = from ? join(params.fixture, from) : repoRoot;
    const destinationRoot = destination.startsWith("/")
      ? join(stageRoot, destination)
      : join(stageRoot, "app", destination);
    for (const input of inputs.split(/\s+/)) {
      const source = join(sourceRoot, input);
      const sourceStat = await stat(source);
      const target =
        !sourceStat.isDirectory() && destination.endsWith("/")
          ? join(destinationRoot, basename(input))
          : destinationRoot;
      await mkdir(dirname(target), { recursive: true });
      if (from || sourceStat.isFile()) {
        await cp(source, target, { recursive: true });
        continue;
      }
      await mkdir(target, { recursive: true });
      // The extraction stage reads only direct workspace manifests, not their source trees.
      for (const entry of await readdir(source, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }
        for (const file of await readdir(join(source, entry.name))) {
          if (file !== "package.json" && file !== "openclaw.plugin.json") {
            continue;
          }
          const manifestTarget = join(target, entry.name, file);
          await mkdir(dirname(manifestTarget), { recursive: true });
          await cp(join(source, entry.name, file), manifestTarget);
        }
      }
    }
  }
  return stageRoot;
}

describe("Dockerfile", () => {
<<<<<<< HEAD
  it("runs the built port-aware Gateway liveness probe", async () => {
    const dockerfile = collapseDockerContinuations(await readFile(dockerfilePath, "utf8"));
    const compose = await readFile(dockerComposePath, "utf8");

    expect(dockerfile).toContain('CMD ["node", "dist/docker-healthcheck.js"]');
    expect(dockerfile).not.toContain("127.0.0.1:18789/healthz");
    expect(compose).toContain('"dist/docker-healthcheck.js"');
    expect(compose).not.toContain("127.0.0.1:18789/healthz");
  });

  it("executes the documented Compose health command and validates JSON envelopes", async () => {
    const docs = await readFile(dockerInstallDocsPath, "utf8");
    const composeSetup = await readFile(composeSetupScriptPath, "utf8");
    const gatewayHealthCommand =
      'node dist/index.js gateway health --token "$OPENCLAW_GATEWAY_TOKEN"';

    expect(docs).toContain(`docker compose exec openclaw-gateway sh -lc '${gatewayHealthCommand}'`);
    expect(docs).not.toContain('node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"');
    expect(composeSetup).toContain(
      `"\${COMPOSE[@]}" exec -T openclaw-gateway sh -lc '${gatewayHealthCommand}'`,
    );
    expect(composeSetup.match(/gateway health --token "\$TOKEN" --json/g)).toHaveLength(2);
    expect(composeSetup).toContain('assert_gateway_health_json "gateway service"');
    expect(composeSetup).toContain('assert_gateway_health_json "CLI sidecar"');
    expect(composeSetup).toContain('--detail "gateway:documentedHealthCommand=passed"');
    expect(composeSetup).toContain('--detail "gateway:healthJsonEnvelope=passed"');
    expect(composeSetup).toContain('--detail "cli:healthJsonEnvelope=passed"');
    expect(composeSetup).not.toContain('dist/index.js health --token "$TOKEN"');
    expect(composeSetup).toContain('-v "$PROJECT_DIR:/target"');
    expect(composeSetup).toContain("rm -rf /target/* /target/.[!.]* /target/..?*");
  });

  it("does not force an external Dockerfile frontend pull", async () => {
    for (const path of dockerSetupDockerfilePaths) {
      const dockerfile = await readFile(join(repoRoot, path), "utf8");
      expect(dockerfile, path).not.toMatch(/^#\s*syntax=/m);
    }
  });

  it("uses full bookworm for build stages and slim bookworm for runtime", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    expect(dockerfile).toContain(
      'ARG OPENCLAW_NODE_BOOKWORM_IMAGE="docker.io/library/node:24.22.1-bookworm@sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a"',
    );
    expect(dockerfile).toContain(
      'ARG OPENCLAW_NODE_BOOKWORM_SLIM_IMAGE="docker.io/library/node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205"',
    );
    expect(dockerfile).toContain(
      'ARG OPENCLAW_BUN_IMAGE="docker.io/oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895"',
    );
    expect(dockerfile).toContain("FROM ${OPENCLAW_NODE_BOOKWORM_IMAGE} AS workspace-deps");
    expect(dockerfile).toContain("FROM ${OPENCLAW_NODE_BOOKWORM_IMAGE} AS dependency-inputs");
    expect(dockerfile).toContain("FROM dependency-inputs AS build");
    expect(dockerfile).toContain("FROM ${OPENCLAW_NODE_BOOKWORM_SLIM_IMAGE} AS base-runtime");
    expect(dockerfile).toContain("FROM base-runtime");
    expect(dockerfile).toContain("current multi-arch manifest list entries");
    expect(dockerfile).not.toContain("current amd64 entry");
    expect(dockerfile).not.toContain("OPENCLAW_VARIANT");
  });

  it("installs CA certificates and refreshes the trust store", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const collapsed = collapseDockerContinuations(dockerfile);
    expect(collapsed).toMatch(/apt-get install -y --no-install-recommends\s+ca-certificates/);
    expect(collapsed).toContain("update-ca-certificates");
  });

  it("installs Python, tini, and the llama-server OpenMP runtime in the slim stage", async () => {
    const dockerfile = collapseDockerContinuations(await readFile(dockerfilePath, "utf8"));
    const runtimeIndex = dockerfile.indexOf(
      "FROM ${OPENCLAW_NODE_BOOKWORM_SLIM_IMAGE} AS base-runtime",
    );
    const pythonInstallIndex = dockerfile.indexOf(
      "ca-certificates curl git hostname libgomp1 lsof openssh-client openssl procps python3",
    );

    expect(runtimeIndex).toBeGreaterThan(-1);
    expect(pythonInstallIndex).toBeGreaterThan(runtimeIndex);
    expect(pythonInstallIndex).toBeLessThan(dockerfile.indexOf("RUN chown node:node /app"));
    expect(dockerfile).toContain(
      "ca-certificates curl git hostname libgomp1 lsof openssh-client openssl procps python3 tini",
    );
    expect(dockerfile).toContain(
      'ENTRYPOINT ["tini", "-s", "--", "node", "/app/docker-entrypoint.mjs"]',
    );
  });

  it.runIf(process.platform !== "win32").each([
    {
      name: "legacy packages when the preferred argument is empty",
      env: {
        OPENCLAW_IMAGE_APT_PACKAGES: "",
        OPENCLAW_DOCKER_APT_PACKAGES: "git curl jq",
      },
      expected: "git curl jq",
    },
    {
      name: "no packages when both arguments are absent",
      env: {},
      expected: "",
    },
    {
      name: "preferred packages when both arguments are present",
      env: {
        OPENCLAW_IMAGE_APT_PACKAGES: "python3",
        OPENCLAW_DOCKER_APT_PACKAGES: "git",
      },
      expected: "python3",
    },
  ])("resolves optional apt package args: $name", async ({ env, expected }) => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    expect(resolveOptionalAptPackages(dockerfile, env)).toBe(expected);
  });

  it("installs optional browser dependencies after pnpm install", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const installIndex = dockerfile.indexOf("pnpm install --frozen-lockfile");
    const browserArgIndex = dockerfile.indexOf("ARG OPENCLAW_INSTALL_BROWSER");

    expect(installIndex).toBeGreaterThan(-1);
    expect(browserArgIndex).toBeGreaterThan(-1);
    expect(browserArgIndex).toBeGreaterThan(installIndex);
    expect(dockerfile).toContain(
      "node /app/node_modules/playwright-core/cli.js install --with-deps chromium",
    );
    expect(dockerfile).toContain("apt-get install -y --no-install-recommends xvfb");
  });

  it("uses the Docker target platform for both frozen installs", async () => {
    const dockerfile = collapseDockerContinuations(await readFile(dockerfilePath, "utf8"));
    const installs = dockerfile.match(/^RUN .*pnpm install[^\n]+/gm) ?? [];

    expect(installs).toHaveLength(2);
    for (const install of installs) {
      expect(install).toContain("pnpm install --frozen-lockfile");
      expect(install).toContain("--config.supportedArchitectures.os=linux");
      expect(install).toContain(
        "--config.supportedArchitectures.cpu=\"$(node -p 'process.arch')\"",
      );
      expect(install).toContain("--config.supportedArchitectures.libc=glibc");
    }
  });

  it("verifies matrix-sdk-crypto native addons without hardcoded pnpm virtual-store paths", async () => {
    const [dockerfile, nativeCheck] = await Promise.all([
      readFile(dockerfilePath, "utf8"),
      readFile(join(repoRoot, "scripts/docker/verify-native-addons.sh"), "utf8"),
    ]);
    expect(dockerfile.match(/^RUN sh scripts\/docker\/verify-native-addons.sh$/gm)).toHaveLength(2);
    expect(nativeCheck).toContain("grep -qx 'matrix' /tmp/openclaw-selected-plugin-dirs");
    expect(nativeCheck).toContain('find /app/node_modules -name "matrix-sdk-crypto*.node"');
    expect(nativeCheck).toContain(
      "node /app/node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js",
    );
    expect(nativeCheck).toContain("matrix-sdk-crypto native addon missing after retries");
    expect(nativeCheck).not.toMatch(
      /ADDON_DIR=.*node_modules\/\.pnpm\/@matrix-org\+matrix-sdk-crypto-nodejs@/,
    );
  });

  it("uses portable copies for workspace dependency inputs", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const workspaceDepsStart = dockerfile.indexOf(
      "FROM ${OPENCLAW_NODE_BOOKWORM_IMAGE} AS workspace-deps",
    );
    const workspaceDepsEnd = dockerfile.indexOf("FROM ${OPENCLAW_BUN_IMAGE} AS bun-binary");

    expect(workspaceDepsStart).toBeGreaterThan(-1);
    expect(workspaceDepsEnd).toBeGreaterThan(workspaceDepsStart);

    const workspaceDeps = dockerfile.slice(workspaceDepsStart, workspaceDepsEnd);
    const extractionIndex = workspaceDeps.indexOf("RUN mkdir -p /out/");
    const inputCopies = [
      "COPY scripts/lib/docker-plugin-selection.mjs /tmp/docker-plugin-selection.mjs",
      "COPY packages /tmp/packages",
      "COPY examples /tmp/examples",
      "COPY ${OPENCLAW_BUNDLED_PLUGIN_DIR} /tmp/${OPENCLAW_BUNDLED_PLUGIN_DIR}",
    ];

    expect(extractionIndex).toBeGreaterThan(-1);
    for (const copy of inputCopies) {
      const copyIndex = workspaceDeps.indexOf(copy);
      expect(copyIndex, copy).toBeGreaterThan(-1);
      expect(copyIndex, copy).toBeLessThan(extractionIndex);
    }
    expect(workspaceDeps).not.toContain("--mount=type=bind");
  });

  it("copies install workspace manifests before pnpm install", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const installIndex = dockerfile.indexOf("pnpm install --frozen-lockfile");
    const postinstallIndex = dockerfile.indexOf("COPY scripts/postinstall-bundled-plugins.mjs");
    const prepareIndex = dockerfile.indexOf("scripts/prepare-git-hooks.mjs");
    const distImportHelperIndex = dockerfile.indexOf(
      "COPY scripts/lib/package-dist-imports.mjs ./scripts/lib/package-dist-imports.mjs",
    );
    const packageManifestIndex = dockerfile.indexOf(
      "COPY --from=workspace-deps /out/packages/ ./packages/",
    );
    const extensionManifestIndex = dockerfile.indexOf(
      "COPY --from=workspace-deps /out/${OPENCLAW_BUNDLED_PLUGIN_DIR}/ ./${OPENCLAW_BUNDLED_PLUGIN_DIR}/",
    );
    const exampleManifestIndex = dockerfile.indexOf(
      "COPY --from=workspace-deps /out/examples/ ./examples/",
    );

    expect(postinstallIndex).toBeGreaterThan(-1);
    expect(prepareIndex).toBeGreaterThan(-1);
    expect(distImportHelperIndex).toBeGreaterThan(-1);
    expect(packageManifestIndex).toBeGreaterThan(-1);
    expect(extensionManifestIndex).toBeGreaterThan(-1);
    expect(exampleManifestIndex).toBeGreaterThan(-1);
    expect(dockerfile).toContain("for manifest in /tmp/packages/*/package.json");
    expect(dockerfile).toContain(
      'node /tmp/docker-plugin-selection.mjs "/tmp/${OPENCLAW_BUNDLED_PLUGIN_DIR}" "$OPENCLAW_EXTENSIONS"',
    );
    expect(dockerfile).toContain("/tmp/examples/*/package.json");
    expect(dockerfile).toContain('"/tmp/${OPENCLAW_BUNDLED_PLUGIN_DIR}"/*/package.json');
    expect(dockerfile).toContain('[ -f "$manifest" ] || continue');
    expect(dockerfile).toContain(
      "COPY --from=workspace-deps /out/openclaw-selected-plugin-dirs /tmp/openclaw-selected-plugin-dirs",
    );
    expect(postinstallIndex).toBeLessThan(installIndex);
    expect(prepareIndex).toBeLessThan(installIndex);
    expect(distImportHelperIndex).toBeLessThan(installIndex);
    expect(packageManifestIndex).toBeLessThan(installIndex);
    expect(extensionManifestIndex).toBeLessThan(installIndex);
    expect(exampleManifestIndex).toBeLessThan(installIndex);
  });

=======
>>>>>>> 97b6e87616f
  it.runIf(process.platform !== "win32").each(["", "matrix"])(
    "stages every locked workspace manifest while retaining optional plugin selection: %j",
    async (selection) => {
      const dockerfile = collapseDockerContinuations(await readFile(dockerfilePath, "utf8"));
      const stages = new Map(
        [...dockerfile.matchAll(/^FROM \S+ AS (\S+)\n([\s\S]*?)(?=^FROM |(?![\s\S]))/gm)].map(
          ([, name, body]) => [name, body],
        ),
      );
      const workspaceBody = stages.get("workspace-deps");
      const dependencyBody = stages.get("dependency-inputs");
      if (!workspaceBody || !dependencyBody) {
        throw new Error("Docker dependency input stages are missing");
      }
      const fixture = tempDirs.make("openclaw-docker-workspace-manifests-");
      const workspaceRoot = await stageDockerManifestCopies({
        body: workspaceBody,
        fixture,
        stage: "workspace-deps",
      });
      const extraction = [...workspaceBody.matchAll(/^RUN (.+)$/gm)]
        .map(([, command]) => command)
        .join("\n")
        .replace(/\/(tmp|out)(?=\/|["\s]|$)/g, `${workspaceRoot}/$1`);
      expect(extraction).not.toBe("");
      execFileSync("/bin/sh", ["-eu", "-c", extraction], {
        env: {
          PATH: process.env.PATH,
          OPENCLAW_EXTENSIONS: selection,
          OPENCLAW_BUNDLED_PLUGIN_DIR: BUNDLED_PLUGIN_ROOT_DIR,
        },
      });
      const inputsRoot = await stageDockerManifestCopies({
        body: dependencyBody,
        fixture,
        stage: "dependency-inputs",
      });
      const appRoot = join(inputsRoot, "app");
      const documents = parseAllDocuments(await readFile(join(appRoot, "pnpm-lock.yaml"), "utf8"));
      expect(documents.flatMap((document) => document.errors)).toEqual([]);
      const importers = documents.at(-1)?.get("importers", true);
      if (!isMap(importers)) {
        throw new Error("Application pnpm lockfile importers are missing");
      }
      expect(importers.items.length).toBeGreaterThan(1);
      for (const importer of importers.items) {
        const manifest = join(String(importer.key), "package.json");
        expect(
          await readFile(join(appRoot, manifest)).catch(() => null),
          `Docker dependency inputs are missing ${manifest}`,
        ).toEqual(await readFile(join(repoRoot, manifest)));
      }

      const selected = await readFile(
        join(inputsRoot, "tmp/openclaw-selected-plugin-dirs"),
        "utf8",
      );
      expect(selected).toBe(selection ? `${selection}\n` : "");
      const installed = (
        await readFile(join(inputsRoot, "tmp/openclaw-workspace-plugin-dirs"), "utf8")
      )
        .trim()
        .split("\n");
      expect(installed).toContain("telegram");
      expect(installed).not.toContain("facetime");
      expect(installed.includes("matrix")).toBe(selection === "matrix");
    },
  );

  it("keeps validated plugin selection outside the build-context copy destination", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const selectionCopyIndex = dockerfile.indexOf(
      "COPY --from=workspace-deps /out/openclaw-selected-plugin-dirs /tmp/openclaw-selected-plugin-dirs",
    );
    const buildContextCopyIndex = dockerfile.indexOf("COPY . .");

    expect(selectionCopyIndex).toBeGreaterThan(-1);
    expect(buildContextCopyIndex).toBeGreaterThan(selectionCopyIndex);
    expect(dockerfile).not.toContain("/app/.openclaw-selected-plugin-dirs");
    expect(dockerfile).not.toContain("./.openclaw-selected-plugin-dirs");
    expect(dockerfile).toContain(
      'selected_plugin_dirs="$(cat /tmp/openclaw-selected-plugin-dirs)"',
    );
    expect(dockerfile).toContain('OPENCLAW_EXTENSIONS="$(cat /tmp/openclaw-selected-plugin-dirs)"');
  });

  it.each(["Dockerfile", "scripts/docker/cleanup-smoke/Dockerfile"])(
    "runs root lifecycle scripts from %s dependency inputs",
    async (dockerfileName) => {
      const dockerfile = collapseDockerContinuations(
        await readFile(join(repoRoot, dockerfileName), "utf8"),
      );
      const installIndex = dockerfile.indexOf("pnpm install --frozen-lockfile");
      expect(installIndex).toBeGreaterThan(-1);
      const fixture = await mkdtemp(join(tmpdir(), "openclaw-docker-lifecycle-"));
      try {
        // Stage the actual local COPY inputs, not a separately maintained import list.
        // Workspace manifests do not contribute executable root lifecycle modules.
        for (const [, sources, destination] of dockerfile
          .slice(0, installIndex)
          .matchAll(/^COPY ([^\n]+) (\.\/\S*)$/gm)) {
          if (!sources || !destination) {
            throw new Error("Expected local COPY sources and destination");
          }
          if (sources.startsWith("--")) {
            continue;
          }
          for (const input of sources.split(/\s+/)) {
            if (input !== "package.json" && !input.endsWith(".mjs")) {
              continue;
            }
            const target = join(
              fixture,
              destination.endsWith("/") ? join(destination, basename(input)) : destination,
            );
            await mkdir(dirname(target), { recursive: true });
            await cp(join(repoRoot, input), target);
          }
        }
        const packageJson = JSON.parse(await readFile(join(fixture, "package.json"), "utf8")) as {
          scripts: Record<string, string>;
        };
        const home = join(fixture, "home");
        await mkdir(home);
        for (const lifecycle of ["preinstall", "install", "postinstall", "prepare"]) {
          const command = packageJson.scripts[lifecycle];
          if (!command) {
            continue;
          }
          const scriptPath = command.match(/^node (scripts\/[^\s]+)$/)?.[1];
          if (!scriptPath) {
            throw new Error(`Unsupported root lifecycle command: ${command}`);
          }
          expect
            .soft(
              () =>
                execFileSync(resolveTestNodeExecPath(), [scriptPath], {
                  cwd: fixture,
                  env: {
                    HOME: home,
                    USERPROFILE: home,
                    PATH: process.env.PATH,
                    npm_config_user_agent: "pnpm/12",
                  },
                  stdio: "pipe",
                }),
              lifecycle,
            )
            .not.toThrow();
        }
      } finally {
        await rm(fixture, { recursive: true, force: true });
      }
    },
  );

  it("normalizes plugin and agent paths permissions in image layers", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    expect(dockerfile).toContain(
      "RUN for dir in /app/${OPENCLAW_BUNDLED_PLUGIN_DIR} /app/.agent /app/.agents; do \\",
    );
    expect(dockerfile).toContain('find "$dir" -type d -exec chmod 755 {} +');
    expect(dockerfile).toContain('find "$dir" -type f -exec chmod 644 {} +');
  });

  it("counts primary pub keys before Docker apt fingerprint compare and dearmor", async () => {
    const dockerfile = collapseDockerContinuations(await readFile(dockerfilePath, "utf8"));
    expect(dockerfile).toContain('== "fpr" {');
    expect(dockerfile).not.toContain('\\"fpr\\"');
    expect(dockerfile).toMatch(
      /curl -fsSL --connect-timeout 10 --max-time 120\s+https:\/\/download\.docker\.com\/linux\/debian\/gpg -o \/tmp\/docker\.gpg\.asc/u,
    );
    const anchor = dockerfile.indexOf(
      "https://download.docker.com/linux/debian/gpg -o /tmp/docker.gpg.asc",
    );
    expect(anchor).toBeGreaterThan(-1);
    const slice = dockerfile.slice(anchor);
    expect(slice).toContain("docker_gpg_pub_count=");
    expect(slice).toContain('$1 == "pub"');
    expect(slice).not.toContain('\\"pub\\"');
    const pubCountIdx = slice.indexOf("docker_gpg_pub_count=");
    const fpIdx = slice.indexOf("actual_fingerprint=");
    const dearmorIdx = slice.indexOf("gpg --dearmor");
    expect(pubCountIdx).toBeLessThan(fpIdx);
    expect(fpIdx).toBeLessThan(dearmorIdx);
    expect(slice).toContain('[ "$docker_gpg_pub_count" != "1" ]');
  });

  it("pre-creates named-volume mount points before switching to the node user", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const runtimeStageIndex = dockerfile.lastIndexOf("FROM base-runtime");
    const parentConfigDirIndex = dockerfile.indexOf(
      "RUN install -d -m 0755 -o node -g node /home/node/.config",
      runtimeStageIndex,
    );
    const stateDirIndex = dockerfile.indexOf(
      "install -d -m 0700 -o node -g node \\",
      parentConfigDirIndex,
    );
    const userIndex = dockerfile.indexOf("USER node", runtimeStageIndex);

    expect(runtimeStageIndex).toBeGreaterThan(-1);
    // Regression: /home/node/.config parent must be created with node ownership
    // before the leaf .config/openclaw dir (issue #85968).
    expect(parentConfigDirIndex).toBeGreaterThan(-1);
    expect(stateDirIndex).toBeGreaterThan(-1);
    expect(userIndex).toBeGreaterThan(-1);
    expect(parentConfigDirIndex).toBeGreaterThan(runtimeStageIndex);
    expect(parentConfigDirIndex).toBeLessThan(stateDirIndex);
    expect(stateDirIndex).toBeGreaterThan(runtimeStageIndex);
    expect(stateDirIndex).toBeLessThan(userIndex);
    expect(dockerfile).not.toContain("mkdir -p /home/node/.openclaw");
    expect(dockerfile).toContain("/home/node/.openclaw/workspace");
    expect(dockerfile).toContain("/home/node/.config/openclaw");
    expect(dockerfile).toContain(
      "stat -c '%U:%G %a' /home/node/.openclaw | grep -qx 'node:node 700'",
    );
    expect(dockerfile).toContain(
      "stat -c '%U:%G %a' /home/node/.openclaw/workspace | grep -qx 'node:node 700'",
    );
    // Regression: assert parent /home/node/.config is also node-owned (issue #85968).
    expect(dockerfile).toContain(
      "stat -c '%U:%G %a' /home/node/.config | grep -qx 'node:node 755'",
    );
    expect(dockerfile).toContain(
      "stat -c '%U:%G %a' /home/node/.config/openclaw | grep -qx 'node:node 700'",
    );
  });
});
