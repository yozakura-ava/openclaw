/** Agent-run lease admission for lifecycle-owned prepared model runtimes. */
import { createAbortError, racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { resolvePluginMetadataSnapshotAsync } from "../plugins/plugin-metadata-snapshot.js";
import { runOutsidePluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { isReservedSystemAgentId } from "../system-agent/agent-id.js";
import {
  getPreparedSharedAuthStoreOwnership,
  prepareSharedAuthStoreOwnership,
} from "./auth-profiles/path-resolve.js";
import { assertPreparedModelRuntimeAdmissionCanWait } from "./prepared-model-runtime-admission.js";
import {
  getPreparedModelRuntimeBorrowedSnapshot,
  getPreparedModelRuntimePluginGeneration,
  runOutsidePreparedModelRuntimePluginGenerationScope,
} from "./prepared-model-runtime-generation-scope.js";
import { capturePreparedModelRuntimeCatalog } from "./prepared-model-runtime.capture.js";
import { isPreparedModelRuntimeMissingOwnerError } from "./prepared-model-runtime.errors.js";
import {
  PreparedModelRuntimeOwnerNotPublishedError,
  PreparedModelRuntimePublicationSupersededError,
  ownerKey,
  normalizePreparedModelRuntimeInput,
  preparedModelRuntimeConfigsMatch,
  publishModelRuntimeSnapshot,
  rebindInputToCommittedConfiguredOwner,
  resolveConfiguredOwner,
  type PreparedModelRuntimeInput,
  type PreparedModelRuntimeLease,
  type PreparedModelRuntimeOwner,
  type PreparedModelRuntimeReplacement,
  type PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.owner.js";
import {
  preparedPluginGenerationReusesBase,
  preparedPluginGenerationSupportsSelections,
} from "./prepared-model-runtime.plugin-generation.js";
import {
  configuredPreparedPluginGenerations,
  retainPreparedPluginGeneration,
} from "./prepared-model-runtime.plugin-lifetime.js";
import {
  retirePreparedModelRuntimeOwnerIfUnused,
  type PreparedModelRuntimeOwnerRetention,
} from "./prepared-model-runtime.retention.js";
import type { PreparedModelRuntimeLeaseOptions } from "./prepared-model-runtime.types.js";

type PreparedModelRuntimeLeaseContext = {
  captureLifetime(): () => void;
  owners: Map<string, PreparedModelRuntimeOwner>;
  agentBuildCompletions: Map<string, Promise<void>>;
  retainedDirectRunOwners: PreparedModelRuntimeOwnerRetention;
  retainedGatewayRunOwners: PreparedModelRuntimeOwnerRetention;
  getBuildTimeoutMs(): number;
  getGatewayLifecycleActive(): boolean;
  getPendingReplacement(
    input?: PreparedModelRuntimeInput,
  ): PreparedModelRuntimeReplacement | undefined;
};

function createPreparedModelRuntimeAdmissionClaim(context: PreparedModelRuntimeLeaseContext) {
  let claimed: { key: string; owner: PreparedModelRuntimeOwner } | undefined;
  const release = () => {
    if (!claimed) {
      return;
    }
    const { key, owner } = claimed;
    claimed = undefined;
    owner.admissionCount = Math.max(0, (owner.admissionCount ?? 1) - 1);
    retirePreparedModelRuntimeOwnerIfUnused(
      context.owners,
      key,
      owner,
      context.retainedDirectRunOwners.has(key, owner) ||
        context.retainedGatewayRunOwners.has(key, owner),
    );
  };
  return {
    claim: (key: string, owner: PreparedModelRuntimeOwner) => {
      if (claimed?.key === key && claimed.owner === owner) {
        return;
      }
      release();
      if (
        (owner.provenance !== "run" && owner.provenance !== "ephemeral") ||
        context.owners.get(key) !== owner
      ) {
        return;
      }
      owner.admissionCount = (owner.admissionCount ?? 0) + 1;
      claimed = { key, owner };
    },
    release,
  };
}

export async function acquirePreparedModelRuntimeLeaseFromOwners(
  rawInput: PreparedModelRuntimeInput,
  provenance: "run" | "ephemeral",
  context: PreparedModelRuntimeLeaseContext,
  options: PreparedModelRuntimeLeaseOptions = {},
): Promise<PreparedModelRuntimeLease> {
  const assertLifetime = context.captureLifetime();
  const assertAdmission = () => {
    assertLifetime();
    if (options.abortSignal?.aborted) {
      throw createAbortError("Prepared model runtime lease admission aborted", {
        cause: options.abortSignal.reason,
      });
    }
  };
<<<<<<< HEAD
  // Re-admission on a superseded configured generation moves the run to its replacement.
  let admittedGeneration = options.pluginGeneration;
  const deriveSelections = options.deriveRuntimePluginSelections;
  // Caller choices belong to this invocation; only config-derived choices may change after a wait.
  const requestedSelections = deriveSelections
    ? structuredClone(rawInput.runtimePluginSelections ?? [])
    : [];
=======
  const acquire = () =>
    acquirePreparedModelRuntimeLeaseAttempt(
      rawInput,
      provenance,
      context,
      options,
      assertAdmission,
    );
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await (attempt === 0
        ? acquire()
        : runOutsidePreparedModelRuntimePluginGenerationScope(() =>
            runOutsidePluginRuntimeGenerationScope(acquire),
          ));
    } catch (error) {
      // Explicit and inherited pins belong to admitted work, including nested completions.
      if (
        !(error instanceof PreparedModelRuntimePublicationSupersededError) ||
        provenance !== "run" ||
        options.pluginGeneration ||
        getPreparedModelRuntimePluginGeneration()
      ) {
        throw error;
      }
      assertAdmission();
      if (attempt === 1) {
        throw new PreparedModelRuntimePublicationSupersededError(
          "Model runtime changed during both preparation attempts; retry the request",
          { cause: error },
        );
      }
    }
  }
}

async function acquirePreparedModelRuntimeLeaseAttempt(
  rawInput: PreparedModelRuntimeInput,
  provenance: "run" | "ephemeral",
  context: PreparedModelRuntimeLeaseContext,
  options: PreparedModelRuntimeLeaseOptions,
  assertAdmission: () => void,
): Promise<PreparedModelRuntimeLease> {
  assertAdmission();
  if (!getPreparedSharedAuthStoreOwnership(rawInput.env ?? process.env)) {
    await prepareSharedAuthStoreOwnership(rawInput.env);
  }
  assertAdmission();
  let replacement = context.getPendingReplacement(rawInput);
  // Drain, retirement, and failed-activation recovery each own one gate; further churn is best effort.
  for (let waits = 0; replacement && waits < 3; waits += 1) {
    assertPreparedModelRuntimeAdmissionCanWait();
    await racePromiseWithAbortSignal(replacement.promise, options.abortSignal);
    assertAdmission();
    replacement = context.getPendingReplacement(rawInput);
  }
  if (replacement) {
    throw new PreparedModelRuntimeOwnerNotPublishedError(
      `prepared model runtime lease admission made no publication progress for ${rawInput.agentDir}; retry the request`,
    );
  }

>>>>>>> 97b6e87616f
  let input = normalizePreparedModelRuntimeInput({
    ...rawInput,
    preserveWorkspaceDirOnRefresh:
      rawInput.preserveWorkspaceDirOnRefresh ?? rawInput.workspaceDir !== undefined,
  });
<<<<<<< HEAD
  let key = ownerKey(input);
  let owner: PreparedModelRuntimeOwner;
  let snapshot: PreparedModelRuntimeSnapshot;
  const admission = createPreparedModelRuntimeAdmissionClaim(context);
  let lastExternalPublication: Promise<unknown> | undefined;
  let previousAttempt: readonly unknown[] | undefined;
  let supersededPublication: PreparedModelRuntimePublicationSupersededError | undefined;
  for (;;) {
    admission.release();
    assertAdmission();
    // Replacement owns publication from synchronous staling through atomic generation commit.
    // Dynamic work arriving inside that window must retry after the new owners become visible.
    const replacement = context.getPendingReplacement();
    const currentOwner = context.owners.get(key);
    const configuredCatalog = resolveConfiguredOwner(context.owners, input)?.pluginGeneration
      ?.remoteCatalog;
    const attempt = [
      key,
      replacement,
      currentOwner,
      currentOwner?.generation,
      currentOwner?.snapshot,
      currentOwner?.pending,
      currentOwner?.needsRefresh,
      configuredCatalog,
      lastExternalPublication,
      admittedGeneration,
    ];
    if (previousAttempt?.every((value, index) => value === attempt[index])) {
      // Failed dynamic owners can disappear. A newly accepted catalog is still progress;
      // rebuilding without either identity changing would spin.
      throw (
        supersededPublication ??
        new PreparedModelRuntimeOwnerNotPublishedError(
          `prepared model runtime lease admission made no publication progress for ${input.agentDir}; retry the request`,
        )
      );
    }
    previousAttempt = attempt;
    supersededPublication = undefined;
    if (replacement) {
      lastExternalPublication = replacement.promise;
      assertPreparedModelRuntimeAdmissionCanWait();
      await racePromiseWithAbortSignal(replacement.promise, options.abortSignal);
      if (context.getPendingReplacement()) {
        continue;
      }
=======
  if (provenance === "run" && context.getGatewayLifecycleActive()) {
    const configured = resolveConfiguredOwner(context.owners, input);
    if (configured?.pending) {
      assertPreparedModelRuntimeAdmissionCanWait(configured);
      await racePromiseWithAbortSignal(configured.pending, options.abortSignal);
>>>>>>> 97b6e87616f
      assertAdmission();
    }
  }
  if (provenance === "run" && !options.pluginGeneration && context.getGatewayLifecycleActive()) {
    try {
      input = rebindInputToCommittedConfiguredOwner(context.owners, input);
    } catch (error) {
      if (!isPreparedModelRuntimeMissingOwnerError(error)) {
        throw error;
      }
      const existing = context.owners.get(ownerKey(input));
      const reservedSetup = input.agentId !== undefined && isReservedSystemAgentId(input.agentId);
      if (!existing && !reservedSetup) {
        throw error;
      }
    }
  }

  let pluginMetadataSnapshot = options.pluginMetadataSnapshot;
  if (options.deriveRuntimePluginSelections) {
    pluginMetadataSnapshot =
      options.pluginGeneration?.pluginMetadataSnapshot ??
      pluginMetadataSnapshot ??
      (await resolvePluginMetadataSnapshotAsync({
        config: input.config,
        env: input.env,
        workspaceDir: input.workspaceDir,
        allowWorkspaceScopedCurrent: true,
      }));
    const metadataSnapshot = pluginMetadataSnapshot;
    const deriveSelections = options.deriveRuntimePluginSelections;
    input = withPluginMetadataSnapshotScope(
      pluginMetadataSnapshot,
      () =>
        normalizePreparedModelRuntimeInput({
          ...input,
          runtimePluginSelections: [
            ...(rawInput.runtimePluginSelections ?? []),
            ...deriveSelections({ config: input.config, metadataSnapshot }),
          ],
        }),
      { trustConfigIdentity: true },
    );
  }

  const key = ownerKey(input);
  const admission = createPreparedModelRuntimeAdmissionClaim(context);
  try {
    let owner = context.owners.get(key);
    const configuredOwner = resolveConfiguredOwner(context.owners, input);
    if (
      provenance === "run" &&
<<<<<<< HEAD
      !admittedGeneration &&
      (replacement || context.getGatewayLifecycleActive())
=======
      context.getGatewayLifecycleActive() &&
      options.pluginGeneration &&
      configuredOwner &&
      (configuredOwner.needsRefresh ||
        configuredOwner.pluginGeneration !== options.pluginGeneration)
>>>>>>> 97b6e87616f
    ) {
      const borrowed = getPreparedModelRuntimeBorrowedSnapshot(options.pluginGeneration);
      if (
        !configuredOwner.needsRefresh &&
        borrowed &&
        borrowed.metadataSnapshot === options.pluginGeneration.pluginMetadataSnapshot &&
        preparedModelRuntimeConfigsMatch(borrowed.config, input.config) &&
        borrowed.agentId === input.agentId &&
        borrowed.agentDir === input.agentDir &&
        borrowed.inheritedAuthDir === input.inheritedAuthDir &&
        borrowed.workspaceDir === input.workspaceDir &&
        (!input.allowGatewaySubagentBinding || borrowed.allowGatewaySubagentBinding) &&
        !input.readOnly &&
        !input.loadRuntimePlugins &&
        !input.skipCredentials &&
        !input.env &&
        preparedPluginGenerationSupportsSelections(options.pluginGeneration, input)
      ) {
        // Nested work borrows its still-open parent; it cannot publish or widen that authority.
        assertAdmission();
        return {
          snapshot: borrowed,
          pluginGeneration: options.pluginGeneration,
          [Symbol.asyncDispose]: retainPreparedPluginGeneration(options.pluginGeneration),
        };
      }
<<<<<<< HEAD
    }
    // Recipes run after config admission. Never carry a derived owner into a later rebind.
    let pluginMetadataSnapshot = options.pluginMetadataSnapshot;
    if (deriveSelections) {
      pluginMetadataSnapshot =
        admittedGeneration?.pluginMetadataSnapshot ??
        pluginMetadataSnapshot ??
        resolvePluginMetadataSnapshot({
          config: input.config,
          env: input.env,
          workspaceDir: input.workspaceDir,
          allowWorkspaceScopedCurrent: true,
        });
      const metadataSnapshot = pluginMetadataSnapshot;
      input = withPluginMetadataSnapshotScope(
        metadataSnapshot,
        () => {
          const derived = deriveSelections({
            config: input.config,
            metadataSnapshot,
          });
          return normalizePreparedModelRuntimeInput({
            ...input,
            runtimePluginSelections: [...requestedSelections, ...derived],
          });
        },
        { trustConfigIdentity: true },
      );
    }
    key = ownerKey(input);
    if (provenance === "run" && context.getGatewayLifecycleActive() && admittedGeneration) {
      const configuredOwner = resolveConfiguredOwner(context.owners, input);
      if (configuredOwner?.pending) {
        assertPreparedModelRuntimeAdmissionCanWait(configuredOwner);
        lastExternalPublication = configuredOwner.pending;
        await racePromiseWithAbortSignal(
          configuredOwner.pending.catch(() => undefined),
          options.abortSignal,
        );
        continue;
      }
      if (
        configuredOwner &&
        (configuredOwner.needsRefresh || configuredOwner.pluginGeneration !== admittedGeneration)
      ) {
        const borrowed = getPreparedModelRuntimeBorrowedSnapshot(admittedGeneration);
        if (
          !configuredOwner.needsRefresh &&
          borrowed &&
          borrowed.metadataSnapshot === admittedGeneration.pluginMetadataSnapshot &&
          preparedModelRuntimeConfigsMatch(borrowed.config, input.config) &&
          borrowed.agentId === input.agentId &&
          borrowed.agentDir === input.agentDir &&
          borrowed.inheritedAuthDir === input.inheritedAuthDir &&
          borrowed.workspaceDir === input.workspaceDir &&
          (!input.allowGatewaySubagentBinding || borrowed.allowGatewaySubagentBinding) &&
          !input.readOnly &&
          !input.loadRuntimePlugins &&
          !input.skipCredentials &&
          !input.env
        ) {
          // A turn may finish under its still-open parent lease after reload. Its historic
          // generation must never publish over the configured owner for newly admitted work.
          if (preparedPluginGenerationSupportsSelections(admittedGeneration, input)) {
            assertAdmission();
            return {
              snapshot: borrowed,
              pluginGeneration: admittedGeneration,
              [Symbol.asyncDispose]: retainPreparedPluginGeneration(admittedGeneration),
            };
          }
          // Acquisition precedes run side effects. A run admitted on a superseded configured
          // generation is admitted afresh on its replacement; nested parents stay confined.
          if (
            configuredOwner.pluginGeneration &&
            configuredPreparedPluginGenerations.has(admittedGeneration)
          ) {
            admittedGeneration = configuredOwner.pluginGeneration;
            continue;
          }
        }
        throw new PreparedModelRuntimePublicationSupersededError(
          `prepared model runtime plugin generation was superseded for ${input.agentDir}`,
        );
      }
    }
=======
      throw new PreparedModelRuntimePublicationSupersededError(
        `prepared model runtime plugin generation was superseded for ${input.agentDir}`,
      );
    }

    // Gateway inventory belongs to the configured agent; the session cwd only controls execution.
    const inventoryInput = context.getGatewayLifecycleActive()
      ? { ...input, workspaceDir: configuredOwner?.input.workspaceDir }
      : input;
>>>>>>> 97b6e87616f
    if (
      provenance === "run" &&
      context.getGatewayLifecycleActive() &&
      options.catalogMode === "static" &&
      !admittedGeneration &&
      !options.pluginMetadataSnapshot &&
      !input.readOnly &&
      !input.loadRuntimePlugins &&
      !input.skipCredentials &&
      configuredOwner?.snapshot &&
      configuredOwner.pluginGeneration &&
      !configuredOwner.pending &&
      !configuredOwner.needsRefresh &&
      !configuredOwner.refreshError &&
      configuredOwner.snapshot.config === input.config &&
      ownerKey({ ...configuredOwner.input, runtimePluginSelections: undefined }) ===
        ownerKey({ ...inventoryInput, runtimePluginSelections: undefined }) &&
      preparedPluginGenerationSupportsSelections(configuredOwner.pluginGeneration, inventoryInput)
    ) {
      owner = configuredOwner;
    }
<<<<<<< HEAD
    const existing = context.owners.get(key);
    const staleDynamicOwner =
      existing?.needsRefresh &&
      !existing.pending &&
      (existing.provenance === "run" || existing.provenance === "ephemeral");
    // A static owner cannot satisfy explicit live discovery; publish a new exact generation.
    const ownerGenerationChanged =
      (admittedGeneration !== undefined &&
        !preparedPluginGenerationReusesBase(
          existing?.pending ? existing.pendingPluginGeneration : existing?.pluginGeneration,
          admittedGeneration,
=======

    const ownerGenerationChanged = () =>
      (options.pluginGeneration !== undefined &&
        !preparedPluginGenerationReusesBase(
          owner?.pending ? owner.pendingPluginGeneration : owner?.pluginGeneration,
          options.pluginGeneration,
>>>>>>> 97b6e87616f
        )) ||
      (options.catalogMode === "live" && owner?.catalogMode === "static");
    if (owner?.pending) {
      assertPreparedModelRuntimeAdmissionCanWait(owner);
      admission.claim(key, owner);
      await racePromiseWithAbortSignal(owner.pending, options.abortSignal);
      assertAdmission();
    }

    let snapshot: PreparedModelRuntimeSnapshot;
    const staleDynamicOwner =
      owner?.needsRefresh && (owner.provenance === "run" || owner.provenance === "ephemeral");
    if (!owner || staleDynamicOwner || ownerGenerationChanged()) {
      const publication = publishModelRuntimeSnapshot(
        input,
        context.owners,
        context.agentBuildCompletions,
        context.getBuildTimeoutMs(),
        undefined,
        provenance,
        options.catalogMode,
        options.pluginGeneration,
        pluginMetadataSnapshot,
      );
<<<<<<< HEAD
      continue;
    }
    try {
      if (existing?.pending && !ownerGenerationChanged) {
        assertPreparedModelRuntimeAdmissionCanWait(existing);
        // Matching callers lease the immutable generation they joined even if a queued
        // mismatched caller publishes the next owner immediately after this one settles.
        admission.claim(key, existing);
        lastExternalPublication = existing.pending;
        snapshot = await racePromiseWithAbortSignal(existing.pending, options.abortSignal);
        if (existing.snapshot !== snapshot || existing.needsRefresh) {
          continue;
        }
        owner = existing;
        break;
      }
      if (existing && !staleDynamicOwner && !ownerGenerationChanged) {
        if (existing.needsRefresh) {
          throw existing.refreshError ?? new Error("prepared model runtime refresh is pending");
        }
        if (
          !existing.snapshot ||
          (input.readOnly && !preparedModelRuntimeConfigsMatch(existing.input.config, input.config))
        ) {
          throw new PreparedModelRuntimeOwnerNotPublishedError(
            `prepared model runtime owner was not published for ${input.agentDir}`,
          );
        }
        // The exact keyed owner already carries the prepared selection and snapshot.
        snapshot = existing.snapshot;
      } else {
        // Fresh keys publish a first generation; stale dynamic owners publish a distinct
        // replacement owner because existing leases retain their immutable snapshot, so
        // their release cannot delete the generation admitted for new work at this key.
        const publication = publishModelRuntimeSnapshot(
          input,
          context.owners,
          context.agentBuildCompletions,
          context.getBuildTimeoutMs(),
          undefined,
          provenance,
          options.catalogMode,
          admittedGeneration,
          pluginMetadataSnapshot,
=======
      owner = context.owners.get(key);
      if (!owner) {
        throw new PreparedModelRuntimeOwnerNotPublishedError(
          `prepared model runtime owner was not published for ${input.agentDir}`,
>>>>>>> 97b6e87616f
        );
      }
      admission.claim(key, owner);
      snapshot = await racePromiseWithAbortSignal(publication, options.abortSignal);
    } else {
      if (owner.needsRefresh) {
        throw owner.refreshError ?? new Error("prepared model runtime refresh is pending");
      }
      if (
        !owner.snapshot ||
        (input.readOnly && !preparedModelRuntimeConfigsMatch(owner.input.config, input.config))
      ) {
        throw new PreparedModelRuntimeOwnerNotPublishedError(
          `prepared model runtime owner was not published for ${input.agentDir}`,
        );
      }
      snapshot = owner.snapshot;
    }
    assertAdmission();
    if (owner.needsRefresh || owner.snapshot !== snapshot) {
      throw new PreparedModelRuntimePublicationSupersededError(
        `prepared model runtime publication was superseded for ${input.agentDir}`,
      );
    }
    // Execution purpose isolates plugins, not the configured agent's published inventory.
    const catalogOwner =
      configuredOwner &&
      ownerKey({
        ...configuredOwner.input,
        loadRuntimePlugins: false,
        runtimePluginPurpose: undefined,
        runtimePluginSelections: undefined,
      }) ===
        ownerKey({
          ...inventoryInput,
          loadRuntimePlugins: false,
          runtimePluginPurpose: undefined,
          runtimePluginSelections: undefined,
        })
        ? configuredOwner
        : owner;
    snapshot = capturePreparedModelRuntimeCatalog(snapshot, catalogOwner.snapshot);
    const pluginGeneration = owner.pluginGeneration!;
    if (owner.provenance !== provenance) {
      return {
        snapshot,
        pluginGeneration,
        [Symbol.asyncDispose]: retainPreparedPluginGeneration(pluginGeneration),
      };
    }
    if (provenance === "run" && options.retainIdleRunOwner) {
      context.retainedDirectRunOwners.retain(key, owner, context.owners);
    } else if (provenance === "run" && context.getGatewayLifecycleActive()) {
      context.retainedGatewayRunOwners.retain(key, owner, context.owners);
    }
    const releaseGeneration = retainPreparedPluginGeneration(pluginGeneration);
    owner.leaseCount = (owner.leaseCount ?? 0) + 1;
    admission.release();
    let released = false;
    return {
      snapshot,
      pluginGeneration,
      [Symbol.asyncDispose]: async () => {
        if (released) {
          return;
        }
        released = true;
        owner.leaseCount = Math.max(0, (owner.leaseCount ?? 1) - 1);
        retirePreparedModelRuntimeOwnerIfUnused(
          context.owners,
          key,
          owner,
          context.retainedDirectRunOwners.has(key, owner) ||
            context.retainedGatewayRunOwners.has(key, owner),
        );
        await releaseGeneration();
      },
    };
  } finally {
    admission.release();
  }
}
