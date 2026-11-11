import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { isAgentDeletionBlocked } from "../../agents/agent-lifecycle-registry.js";
import { resolveConfiguredAgentId } from "../../agents/agent-scope-config.js";
import { resolveAgentRunErrorLifecycleFields } from "../../agents/run-termination.js";
import { getRuntimeConfigSnapshotMetadata } from "../../config/runtime-snapshot.js";
import type { SessionEntryCreationOperation } from "../../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import { SessionWorkStartError } from "../../config/sessions/session-work-start.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import { resolveCronRunToolsAllow } from "../../cron/tools-allow.js";
import { execRequestAbortSignal, withExecRequestOwners } from "../../infra/exec-request-context.js";
import type { SourceDeliveryOutcome } from "../../infra/outbound/source-delivery-plan.types.js";
import {
  resolveSystemEventQueueKey,
  withSystemEventOwner,
} from "../../infra/system-event-ownership.js";
import {
  claimSystemEventTurn,
  enqueueRequiredSystemEventEntry,
} from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runWithGatewayDetachedWorkContinuation } from "../../process/gateway-work-admission.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { ReplyPayload } from "../../shared/reply-payload.types.js";
import { readAgentDeletionJournalStatusInWorker } from "../../state/agent-deletion-journal.read.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import type { NormalizeReplySkipReason } from "./normalize-reply-skip-reason.js";
import type { ReplyOperation } from "./reply-run-registry.contracts.js";
import {
  prepareCronRunContinuationCleanup,
  resolveScheduledSessionReplyOptions,
  settleSessionAutomationTurn,
} from "./session-event-automation.js";
import {
  buildSessionEventContext,
  prepareSessionEventInput,
  resolveSessionEventExecRequestOwners,
} from "./session-event-context.js";
import type {
  SessionEventOptions,
  SessionEventOutcome,
  SessionEventReceipt,
} from "./session-event-contract.js";
<<<<<<< HEAD
=======
import { prepareSessionEventDelivery } from "./session-event-delivery.js";
>>>>>>> 97b6e87616f
import { narrowSessionEventSettings } from "./session-event-policy.js";
import {
  assertSessionEventTargetCurrent,
  assertSessionEventSettingsCurrent,
  captureSessionEventTargetForHost,
  getSessionEventRuntimeConfig,
<<<<<<< HEAD
=======
  intersectSessionEventToolsAllow,
>>>>>>> 97b6e87616f
  prepareSessionEventTargetForHost,
} from "./session-event-target.js";

export {
  assertSessionEventTargetCurrent,
  captureSessionEventTargetForHost,
  combineSessionEventTargetsForHost,
} from "./session-event-target.js";
export type { SessionEventReceipt, SessionEventTarget } from "./session-event-contract.js";

const log = createSubsystemLogger("session-events");

<<<<<<< HEAD
/** Policy publications an accepted occurrence may outlive before it waits for an ordinary turn. */
=======
/** Policy publications an accepted occurrence may outlive before it settles as failed. */
>>>>>>> 97b6e87616f
const MAX_CONFIG_READMISSION_ATTEMPTS = 2;

/** Producer-owned occurrence; passive notices continue to use enqueueSystemEvent. */
export function enqueueSessionEventForHost(
  text: string,
<<<<<<< HEAD
  {
    assertAcceptanceCurrent,
    ...options
  }: {
    agentId: string;
    sessionKey: string;
    source: SessionEventSource;
    contextKey?: string;
    deliveryContext?: DeliveryContext;
    abortSignal?: AbortSignal;
    expectedTarget?: SessionEventTarget;
    /** Authorized fresh work may create an absent session; captured completions may not. */
    createIfMissing?: true;
    /** Submitting invocation custody lasts through acceptance only. */
    assertAcceptanceCurrent?: () => void;
    /** Durable producer commits its attempt only after normal turn adoption. */
    onAdopted?: () => void | Promise<void>;
    /** Transfer exact queued occurrences into one ordinary turn without duplicating them. */
    occurrences?: readonly SystemEvent[];
    /** Failed promotion retains an existing passive occurrence until ordinary adoption begins. */
    preserveOccurrenceOnRejection?: true;
    /** Internal: policy-change re-admission depth, bounded to stop publication storms. */
    readmissionAttempt?: number;
    /** An explicitly silent source records its result without transport delivery. */
    deliver?: boolean;
    /** Host producer remains live through admission, execution and delivery. */
    assertCurrent?: () => void;
  },
=======
  { assertAcceptanceCurrent, ...options }: SessionEventOptions,
>>>>>>> 97b6e87616f
): SessionEventReceipt {
  let acceptanceAssertion = assertAcceptanceCurrent;
  acceptanceAssertion?.();
  options.assertCurrent?.();
  options.expectedTarget?.assertCurrent?.();
<<<<<<< HEAD
  // The policy snapshot this occurrence was admitted under. A policy publication rejects
  // admission; an accepted occurrence that never started is re-admitted under the current
  // policy at settlement instead of being destroyed (see finish).
  const cfg = getSessionEventRuntimeConfig();
  const configPublication = getRuntimeConfigSnapshotMetadata();
  const agentId = normalizeAgentId(options.agentId);
  resolveConfiguredAgentId(cfg, agentId);
  const sessionKey = resolveSessionEventKey(agentId, options.sessionKey);
  if (!text.trim()) {
    throw new Error("Session event text must not be empty");
  }
  const env = options.expectedTarget
    ? readSessionEventTargetEnvironment(options.expectedTarget)
    : undefined;
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId, env });
=======
  const { cfg, configPublication, agentId, sessionKey, env, storePath, operatorAuthority } =
    prepareSessionEventInput(text, options);
  const cleanupContinuation = prepareCronRunContinuationCleanup(sessionKey, storePath, env);
>>>>>>> 97b6e87616f
  let target = options.expectedTarget;
  let generationLease: Awaited<ReturnType<typeof prepareSessionEventTargetForHost>> | undefined;
  let preparedBinding: { sessionId: string; lifecycleRevision?: string } | undefined;
  if (
    options.expectedTarget &&
    ((options.expectedTarget.storePath && options.expectedTarget.storePath !== storePath) ||
      (options.expectedTarget.agentId && options.expectedTarget.agentId !== agentId) ||
      (options.expectedTarget.sessionKey && options.expectedTarget.sessionKey !== sessionKey))
  ) {
    throw new Error(
      "Session event destination was reset or replaced while its producer was running",
    );
  }
  if (options.expectedTarget) {
    assertSessionEventTargetCurrent(options.expectedTarget);
  }
  let route = structuredClone(options.deliveryContext ?? options.expectedTarget?.deliveryContext);
  const controller = new AbortController();
  const execRequestOwners = resolveSessionEventExecRequestOwners(options);
  const requestSignal = execRequestAbortSignal(execRequestOwners, options.abortSignal);
  const signal = AbortSignal.any(
    [requestSignal, controller.signal, operatorAuthority?.signal].filter(
      (value): value is AbortSignal => Boolean(value),
    ),
  );
  signal.throwIfAborted();
  if (options.preserveOccurrenceOnRejection && !options.occurrences?.length) {
    throw new Error("Preserving a rejected event requires its original queued occurrence");
  }
  if (
    options.occurrences &&
    options.occurrences.map((event) => event.text).join("\n") !== text.trim()
  ) {
    throw new Error("Session event occurrence text changed before admission");
  }
  const freshOccurrence = options.occurrences
    ? undefined
    : enqueueRequiredSystemEventEntry(
        text,
        withExecRequestOwners(
          withSystemEventOwner(
            {
              sessionKey,
              contextKey: options.contextKey,
              deliveryContext: route,
            },
            agentId,
          ),
          execRequestOwners,
        ),
        { allowDuplicate: true },
      );
  const occurrences = options.occurrences
    ? [...options.occurrences]
    : freshOccurrence
      ? [freshOccurrence]
      : [];
  const occurrence = occurrences[0];
  if (!occurrence?.id || occurrences.some((event) => !event.id)) {
    throw new Error("Session event was not enqueued: an identical occurrence is already pending");
  }
  const occurrenceId = occurrence.id;
  const eventText = occurrences.map((event) => event.text).join("\n");
  const ownership = claimSystemEventTurn(
    resolveSystemEventQueueKey(sessionKey, agentId),
    occurrences,
    () => controller.abort(),
    agentId,
  );
  if (!ownership) {
    throw new Error("Session event occurrence no longer available for admission");
  }
  let releaseOperatorAuthority: (() => void) | undefined;
  try {
    // Transfer custody before the completed process releases its original source.
    releaseOperatorAuthority = operatorAuthority?.retain?.();
  } catch (error) {
    ownership.cancel();
    throw error;
  }
  const { promise: settled, resolve } = createDeferredCore<SessionEventOutcome>();
  const acceptance = createDeferredCore<Awaited<SessionEventReceipt["accepted"]>>();
  let accepted = false;
  let started = false;
  let admissionStarted = false;
  let deferred = false;
  let adopted = false;
<<<<<<< HEAD
  // Set when admission observed a policy publication. finish() uses it to re-admit an
  // unstarted occurrence under the current policy instead of destroying it.
  let configPublicationChanged = false;
  // Set when adoption was attempted; queue bookkeeping reports a policy-rejected
  // adoption as abandonment, so only pre-adoption abandonment is terminal.
  let adoptionAttempted = false;
  // Set when the queue owner abandons this occurrence (Stop, lifecycle cleanup).
  // Abandonment is terminal even when a policy publication also fired.
=======
  // A policy publication rejected this occurrence's stale-config execution; finish()
  // re-admits it under the current policy when it never started.
  let configPublicationChanged = false;
  // Queue-owner abandonment (lifecycle cleanup) stays terminal.
>>>>>>> 97b6e87616f
  let abandoned = false;
  // The live re-admission attempt; receipt.cancel forwards to it once it exists.
  let readmittedReceipt: SessionEventReceipt | undefined;
  let operation: ReplyOperation | undefined;
  let replyRunRegistry: (typeof import("./reply-run-registry.js"))["replyRunRegistry"];
  let inputRecorder: UserTurnTranscriptRecorder | undefined;
  let delivered = false;
  let deliveryAttempted = false;
  let deliveryAmbiguous = false;
  let deliveryError: string | undefined;
  let deliverySuppressionReason: NormalizeReplySkipReason | undefined;
  let summary: string | undefined;
  let failure: Error | string | undefined;
  let nextCheckMs: number | undefined;
  let sourceDeliveryOutcome: SourceDeliveryOutcome | undefined;
  let automationResult: SessionEventOutcome["automationResult"];
  let settlement: "settling" | "finished" | undefined;
  let settings = options.expectedTarget?.settings;
  let settingsAdmitted = false;
  const jobTools = options.scheduledAutomation
    ? resolveCronRunToolsAllow(options.scheduledAutomation.job)
    : undefined;
  const producerTools = options.expectedTarget?.toolsAllow;
  const toolsAllow = intersectSessionEventToolsAllow(jobTools, producerTools);
  const assertOwnerCurrent = () => {
    if (settlement === "finished") {
      throw new Error("Session event occurrence is settled");
    }
    signal.throwIfAborted();
    operatorAuthority?.assertCurrent();
    if (!accepted) {
      acceptanceAssertion?.();
    }
    options.assertCurrent?.();
    options.expectedTarget?.assertCurrent?.();
    const currentConfig = getSessionEventRuntimeConfig();
<<<<<<< HEAD
    if (currentConfig !== cfg || getRuntimeConfigSnapshotMetadata() !== configPublication) {
      // Admission never proceeds under a policy published after acceptance; a queued run
      // still holds the earlier config, so readmission here would execute stale authority.
      // finish() re-admits an accepted, unstarted occurrence under the current policy.
      configPublicationChanged = true;
      throw new Error("Session event configuration changed; retry under the current policy");
    }
=======
>>>>>>> 97b6e87616f
    resolveConfiguredAgentId(currentConfig, agentId);
    if (isAgentDeletionBlocked(agentId, { env })) {
      throw new Error("Session event agent is being deleted");
    }
    options.scheduledAutomation?.assertCurrent();
    if (
      operation &&
      (operation.abortSignal.aborted || replyRunRegistry.get(sessionKey) !== operation)
    ) {
      throw new Error("Session event admission no longer owns its destination");
    }
  };
  const assertCurrent = () => {
    assertOwnerCurrent();
    generationLease?.assertCurrent();
    if (settingsAdmitted && generationLease) {
      assertSessionEventSettingsCurrent(settings, generationLease.readSessionSettings());
    }
  };
  const assertEffectCurrent = () => {
    assertCurrent();
    if (
      getSessionEventRuntimeConfig() !== cfg ||
      getRuntimeConfigSnapshotMetadata() !== configPublication
    ) {
      // The dispatched run holds the config captured at enqueue; it must never execute
      // under a superseded policy. finish() re-admits an unstarted occurrence instead.
      configPublicationChanged = true;
      throw new Error("Session event configuration changed; retry under the current policy");
    }
  };
  const accept = () => {
    if (accepted || settlement === "finished") {
      return;
    }
    assertCurrent();
    accepted = true;
    acceptanceAssertion = undefined;
    acceptance.resolve({ ok: true });
  };
  const prepareCurrent = async () => {
    assertOwnerCurrent();
    if (operation && preparedBinding && operation.sessionId !== preparedBinding.sessionId) {
      const replacement = await captureSessionEventTargetForHost(agentId, sessionKey, {
        env,
        assertCurrent: assertOwnerCurrent,
      });
      if (replacement.sessionId !== operation.sessionId) {
        throw new Error("Session event reply owner lost its rotated destination");
      }
      const replacementLease = await prepareSessionEventTargetForHost(replacement);
      try {
        assertOwnerCurrent();
      } catch (error) {
        replacementLease.release();
        throw error;
      }
      generationLease?.release();
      generationLease = replacementLease;
      preparedBinding = replacement;
    }
    await options.scheduledAutomation?.prepare?.();
    for (let read = generationLease?.prepareRead(); read; read = generationLease?.prepareRead()) {
      await read;
    }
    assertCurrent();
  };
  const start = () => {
    assertCurrent();
    if (started) {
      return;
    }
    ownership.start();
    started = true;
    accept();
  };
  const prepareStart = async (runId?: string) => {
    await prepareCurrent();
    if (runId) {
      start();
    }
  };
  const finish = () => {
    if (settlement) {
      return;
    }
    settlement = "settling";
    const complete = async () => {
      try {
        inputRecorder?.finishPendingInput?.(signal.aborted ? "cancelled" : "interrupted");
        await inputRecorder?.waitForPendingInputSettlement?.();
      } catch (error) {
        failure ??= error instanceof Error ? error : String(error);
      }
      settlement = "finished";
      // Submitting custody ends at the first acceptance; a pre-acceptance re-admission
<<<<<<< HEAD
      // must carry the still-live assertion so revoked ingress rejects before the new
      // attempt prepares a session or admits a turn.
      const pendingAcceptanceAssertion = accepted ? undefined : acceptanceAssertion;
      acceptanceAssertion = undefined;
      // Only a policy publication retains an unstarted occurrence: it is re-admitted
      // under the current policy instead of being destroyed. The rejection may land
      // before acceptance (a publication racing admission) or at adoption (a
      // publication while deferred); producers never retry either way. Stop, abort,
      // and abandonment still settle terminally and consume the occurrence.
=======
      // carries the still-live assertion so revoked ingress rejects the retry.
      const pendingAcceptanceAssertion = accepted ? undefined : acceptanceAssertion;
      acceptanceAssertion = undefined;
      // Producers never retry, so a policy publication that rejected an unstarted
      // occurrence re-admits it under the current policy instead of destroying it.
      // Stop, abort and abandonment still settle terminally.
>>>>>>> 97b6e87616f
      const configChangeRetention =
        configPublicationChanged && !started && !deliveryAttempted && !signal.aborted && !abandoned;
      const attempt = options.readmissionAttempt ?? 0;
      const canReadmit = configChangeRetention && attempt < MAX_CONFIG_READMISSION_ATTEMPTS;
      const status = signal.aborted ? "cancelled" : failure ? "failed" : "completed";
<<<<<<< HEAD
      if (status === "failed" && !configChangeRetention) {
=======
      if (status === "failed" && !canReadmit) {
>>>>>>> 97b6e87616f
        log.error("session event execution failed", {
          source: options.source,
          agentId,
          sessionKey,
<<<<<<< HEAD
          eventId: occurrence.id,
          error: failure,
=======
          eventId: occurrenceId,
          error: String(failure),
>>>>>>> 97b6e87616f
        });
      }
      signal.removeEventListener("abort", onAbort);
      generationLease?.release();
<<<<<<< HEAD
      // Passive-promotion preservation is reserved for occurrences that already
      // existed as passive notices before a failed promotion; policy re-admissions
      // never opt into it, so terminal cancellation, abandonment, or a failed retry
      // of a producer-owned occurrence always consumes instead of resurfacing as
      // contract-less passive text in a later ordinary turn.
      const retainCustody = configChangeRetention
        ? canReadmit
        : Boolean(options.preserveOccurrenceOnRejection && !adopted && !started);
      if (retainCustody) {
=======
      if (canReadmit) {
        // Passive custody survives only until some attempt adopts the occurrence.
        const preservePassive =
          options.preserveOccurrenceOnRejection && !adopted ? true : undefined;
        ownership.release();
        try {
          // A fresh dispatch binds the current policy for admission, execution and
          // delivery. The captured target, producer assertions, cancellation and
          // delivery opt-out carry over, so a moved destination or retired producer
          // still rejects. Only an occurrence that was already a passive notice keeps
          // passive custody on rejection; producer-owned text never becomes passive.
          readmittedReceipt = enqueueSessionEventForHost(eventText, {
            ...options,
            agentId,
            sessionKey,
            assertAcceptanceCurrent: pendingAcceptanceAssertion,
            occurrences,
            preserveOccurrenceOnRejection: preservePassive,
            readmissionAttempt: attempt + 1,
          });
        } catch (error) {
          if (!preservePassive) {
            // The released occurrence carries no producer contract; consume it.
            claimSystemEventTurn(
              resolveSystemEventQueueKey(sessionKey, agentId),
              occurrences,
              () => {},
              agentId,
            )?.cancel();
          }
          failure = error instanceof Error ? error : String(error);
          log.error("session event policy readmission rejected", {
            source: options.source,
            agentId,
            sessionKey,
            eventId: occurrenceId,
            error: String(failure),
          });
        }
      } else if (options.preserveOccurrenceOnRejection && !adopted && !started) {
>>>>>>> 97b6e87616f
        ownership.release();
      } else {
        ownership.cancel();
      }
<<<<<<< HEAD
      if (configChangeRetention) {
        if (canReadmit) {
          try {
            // Re-dispatch from scratch so admission, execution, and delivery all bind
            // the current policy. The captured target, producer authority ceiling,
            // settings, delivery opt-out, liveness assertion, and cancellation signal
            // all carry over; a destination move or retired producer still rejects.
            readmittedReceipt = enqueueSessionEventForHost(eventText, {
              agentId,
              sessionKey,
              source: options.source,
              ...(options.contextKey ? { contextKey: options.contextKey } : {}),
              ...(options.deliveryContext
                ? { deliveryContext: structuredClone(options.deliveryContext) }
                : {}),
              ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
              ...(options.expectedTarget ? { expectedTarget: options.expectedTarget } : {}),
              ...(options.assertCurrent ? { assertCurrent: options.assertCurrent } : {}),
              ...(pendingAcceptanceAssertion
                ? { assertAcceptanceCurrent: pendingAcceptanceAssertion }
                : {}),
              occurrences,
              // Deliberately no preserveOccurrenceOnRejection: the occurrence is
              // producer-owned, not a pre-existing passive notice, so any terminal
              // settlement of this attempt (cancel, Stop, admission refusal) consumes
              // it instead of parking contract-less text for a later turn.
              readmissionAttempt: attempt + 1,
              // A durable producer still commits its attempt only once the re-admitted
              // turn is adopted.
              ...(options.onAdopted ? { onAdopted: options.onAdopted } : {}),
              ...(options.deliver !== undefined ? { deliver: options.deliver } : {}),
              ...(options.createIfMissing ? { createIfMissing: options.createIfMissing } : {}),
            });
          } catch (error) {
            // Re-admission rejected synchronously (retired producer, moved destination,
            // revoked ingress). The released occurrence carries no producer contract,
            // so it must not wait as passive text for a later ordinary turn; consume
            // it terminally instead.
            claimSystemEventTurn(
              resolveSystemEventQueueKey(sessionKey, agentId),
              occurrences,
              () => {},
              agentId,
            )?.cancel();
            log.error("session event policy readmission rejected; occurrence settled", {
              source: options.source,
              agentId,
              sessionKey,
              eventId: occurrence.id,
              error: String(error),
            });
          }
        } else {
          // Bounded re-admission is exhausted; the occurrence was already consumed
          // above so it never drains into a later turn as contract-less text.
          log.error("session event policy readmission attempts exhausted; occurrence settled", {
            source: options.source,
            agentId,
            sessionKey,
            eventId: occurrence.id,
            error: failure,
          });
        }
      }
      if (!accepted) {
        // A producer waiting on acceptance observes the re-admission's acceptance
        // outcome, not the stale rejection that triggered it.
        acceptance.resolve(
          readmittedReceipt?.accepted ?? {
            ok: false,
            error: failure ?? "Session event was cancelled before acceptance",
=======
      releaseOperatorAuthority?.();
      releaseOperatorAuthority = undefined;
      if (!accepted) {
        acceptance.resolve(
          readmittedReceipt?.accepted ?? {
            ok: false,
            error: failure ? String(failure) : "Session event was cancelled before acceptance",
>>>>>>> 97b6e87616f
          },
        );
      }
      if (readmittedReceipt) {
        resolve(readmittedReceipt.settled);
        return;
      }
      resolve({
        status,
        executionStarted: started,
        interruptedByRestart:
          status !== "completed" &&
          resolveAgentRunErrorLifecycleFields(failure, operation?.abortSignal ?? signal)
            .stopReason === "restart",
        delivered,
        deliveryAttempted,
        deliveryAmbiguous,
        deliveryError,
        deliverySuppressionReason,
        admissionDeferred:
          !started &&
          operation?.result?.kind === "aborted" &&
          operation.result.code === "aborted_for_supersession",
        summary,
        nextCheckMs,
        sourceDeliveryOutcome,
        automationResult,
        ...(failure ? { error: String(failure) } : {}),
        ...(failure instanceof SessionWorkStartError ? { retryable: failure.retryable } : {}),
      });
      cleanupContinuation?.();
    };
    if (operation?.ownerSettlement) {
      void operation.ownerSettlement.then(complete, complete);
    } else {
      void complete();
    }
  };
  const onAbort = () => {
    // Started admission owns native preparation and reply settlement, even before model start.
    if (!operation && !admissionStarted) {
      finish();
    }
  };
  const deliver = async (payload: ReplyPayload, kind: "tool" | "block" | "final") => {
    await prepareCurrent();
    if (kind === "final" && payload.text) {
      summary ??= truncateUtf16Safe(payload.text, 2000);
    }
    if (options.deliver === false || target?.deliver === false) {
      return;
    }
    if (kind === "final" && sourceDeliveryOutcome?.satisfiesSourceDelivery) {
      return;
    }
    if (!route?.channel || route.channel === INTERNAL_MESSAGE_CHANNEL) {
      // The normal transcript remains the result for internal/WebChat turns.
      // This is not evidence of a transport send.
      return;
    }
    const deliverReply = await prepareSessionEventDelivery(route, assertCurrent);
    deliveryAttempted = true;
    const result = await deliverReply({
      cfg: getSessionEventRuntimeConfig(),
      agentId,
      sessionKey,
      payload,
      replyKind: kind,
      abortSignal: signal,
      beforeDeliver: async () => {
        await options.scheduledAutomation?.beforeDeliver?.();
        assertEffectCurrent();
      },
      assertCurrent: assertEffectCurrent,
    });
    delivered ||= result.delivered;
    deliveryAmbiguous ||= result.ambiguous === true;
    if (!result.ok) {
      if (!options.scheduledAutomation) {
        throw new Error(result.error ?? "Session event delivery failed");
      }
      // Cron records transport failure separately from completed agent work.
      deliveryError = result.error ?? "Session event delivery failed";
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });
  // Completion outlives the producer's request scope and transcript writer.
  // Keep detached work through settlement; explicit request/Stop signals above
  // still cancel the occurrence and join its native execution owner.
  void runWithoutOwnedSessionTranscriptWrites(() =>
    runWithGatewayDetachedWorkContinuation(async () => {
      admissionStarted = true;
      await readAgentDeletionJournalStatusInWorker(agentId, { env }, signal);
      assertOwnerCurrent();
      const { dispatchInboundMessageWithRoutedChannelDispatcher } = await import("../dispatch.js");
      ({ replyRunRegistry } = await import("./reply-run-registry.js"));
      const { prepareSessionGenerationFacts } =
        await import("../../config/sessions/session-delivery-generation.js");
      target ??= await captureSessionEventTargetForHost(agentId, sessionKey, {
        env,
        assertCurrent: options.assertCurrent,
        assertCaptureCurrent: assertOwnerCurrent,
      });
      assertSessionEventTargetCurrent(target);
      if (!target.sessionId && !options.createIfMissing) {
        throw new Error("Session event origin is missing; start fresh authorized work instead");
      }
      generationLease = await prepareSessionEventTargetForHost(target, {
        createIfMissing: options.createIfMissing,
        assertAcceptanceCurrent: assertOwnerCurrent,
      });
      settings ??= target.settings;
      route ??= structuredClone(target.deliveryContext);
      await prepareCurrent();
      settings = narrowSessionEventSettings(settings, generationLease.readSessionSettings());
      settingsAdmitted = true;
      const promptText = options.scheduledAutomation?.preparePrompt
        ? await options.scheduledAutomation.preparePrompt(cfg)
        : eventText;
      assertEffectCurrent();
      const ctx = buildSessionEventContext({
        cfg,
        agentId,
        sessionKey,
        text: promptText,
        options,
        occurrenceId,
        deliveryContext: route,
        target,
        assertCurrent,
      });
      const result = await dispatchInboundMessageWithRoutedChannelDispatcher({
        cfg: { ...cfg, session: { ...cfg.session, store: storePath } },
        ctx,
        dispatcherOptions: {
          deliver: (payload, info) => deliver(payload, info.kind),
          onError: (error) => {
            failure ??= error instanceof Error ? error : String(error);
          },
          onSkip: (_payload, info) => {
            if (info.kind === "final") {
              deliverySuppressionReason = info.reason;
            }
          },
        },
        replyOptions: {
          scheduledAutomation: options.scheduledAutomation,
          ...resolveScheduledSessionReplyOptions(options.scheduledAutomation),
          operatorAuthority: options.scheduledAutomation?.operatorAuthority ?? operatorAuthority,
          admittedSessionSettings: settings,
          toolsAllow,
          onDeliberateSilentTerminalReply: () => {
            deliverySuppressionReason = "silent";
          },
          abortSignal: signal,
          expectedExistingSessionId: target.sessionId || undefined,
          pinExpectedExistingSession: Boolean(target.sessionId),
          onSessionPrepared: (binding) => {
            if (binding.sessionKey === sessionKey) {
              preparedBinding = binding;
            }
          },
          queueModeOverride: "followup",
          suppressTyping: true,
          typingPolicy: "system_event",
          onReplyOperationOwned: (owned) => {
            operation = owned;
          },
          internalEventExecution: {
            prepareInput: async (recorder) => {
              inputRecorder = recorder;
              if (
                !recorder.stageApproved ||
                !(await recorder.stageApproved({ runId: occurrenceId, assertCurrent }))
              ) {
                throw new Error("Session event input was not durably admitted");
              }
            },
            execRequestOwners,
            deliver: options.deliver === false || target.deliver === false ? false : undefined,
            assertCurrent: assertEffectCurrent,
            ...(target.sessionId === "" && options.createIfMissing
              ? {
                  bindSessionCreation: (creation: SessionEntryCreationOperation) => {
                    assertOwnerCurrent();
                    if (!generationLease) {
                      throw new Error("Session event lost its original generation owner");
                    }
                    const assertCreationCurrent = generationLease.bindCreation(creation);
                    return () => {
                      assertOwnerCurrent();
                      assertCreationCurrent();
                    };
                  },
                }
              : {}),
            onFailed: (error) => {
              failure ??= error instanceof Error ? error : String(error);
            },
            onSuppressed: (reason) => {
              deliverySuppressionReason = reason === "silent" ? "silent" : undefined;
              if (reason === "aborted") {
                failure ??= "Session event execution was aborted";
              }
            },
            beforeStart: () => prepareStart(),
            ...(options.scheduledAutomation ? { beforeScheduledStart: prepareStart } : {}),
            onStarted: start,
            onTerminal: async (runId, outcome, deliveryEvidence) => {
              if (outcome !== "completed") {
                failure ??=
                  deliveryEvidence?.meta?.error?.message ||
                  deliveryEvidence?.payloads?.find(
                    (payload) => payload.isError && payload.text?.trim(),
                  )?.text ||
                  `Session event execution ${outcome}`;
              }
              await prepareCurrent();
              if (options.scheduledAutomation) {
                const automationOutcome = await settleSessionAutomationTurn({
                  automation: options.scheduledAutomation,
                  runId,
                  deliveryEvidence,
                  prepareCurrent,
                  outcome,
                });
                nextCheckMs = automationOutcome.nextCheckMs;
                sourceDeliveryOutcome = automationOutcome.sourceDeliveryOutcome;
                automationResult = automationOutcome.automationResult;
                delivered ||= sourceDeliveryOutcome?.satisfiesSourceDelivery === true;
              }
            },
          },
          onQueuedFollowupReplyBatch: async (batch) => {
            if (batch.completion.kind === "failed") {
              failure ??= batch.completion.error;
            } else if (batch.completion.kind === "aborted") {
              failure ??= "Session event execution was aborted";
            }
            try {
              for (const payload of batch.payloads) {
                await deliver(payload, batch.completion.kind === "progress" ? "block" : "final");
              }
            } catch (error) {
              failure ??= error instanceof Error ? error : String(error);
              throw error;
            }
          },
          turnAdoptionLifecycle: {
            admission: "exclusive",
            abortSignal: signal,
            onDeferred: () => {
              assertCurrent();
              deferred = true;
              options.scheduledAutomation?.onLaneWait?.({ waiting: true });
              return true;
            },
            onAdopted: async () => {
              adoptionAttempted = true;
              adopted = true;
              options.scheduledAutomation?.onLaneWait?.({ waiting: false });
              operation = replyRunRegistry.get(sessionKey);
              if (!operation) {
                throw new Error("Session event has no admitted reply owner");
              }
              // The normal owner may create a previously absent session or
              // rotate through compaction during admission. Adopt only its
              // published binding while that exact reply operation is live.
              if (
                preparedBinding &&
                !generationLease?.isCreationAdopted() &&
                preparedBinding.sessionId === operation.sessionId &&
                (target?.sessionId !== preparedBinding.sessionId ||
                  target?.lifecycleRevision !== preparedBinding.lifecycleRevision)
              ) {
                generationLease?.release();
                generationLease = undefined;
                generationLease = await prepareSessionGenerationFacts({
                  agentId,
                  storePath,
                  sessionKey,
                  sessionId: preparedBinding.sessionId,
                  lifecycleRevision: preparedBinding.lifecycleRevision ?? null,
                });
              }
              await prepareCurrent();
              await options.onAdopted?.();
              assertCurrent();
              accept();
            },
            onAbandoned: () => {
<<<<<<< HEAD
              // Queue bookkeeping also reports a policy-rejected adoption as
              // abandonment; that is the publication rejection, not a cancellation.
              // Only abandonment before any adoption attempt (Stop, lifecycle
              // cleanup) is terminal.
              if (!adoptionAttempted || !configPublicationChanged) {
                abandoned = true;
              }
=======
              // A stale-policy rejection before adoption also ends as abandonment;
              // only abandonment without that rejection (Stop, cleanup) is terminal.
              abandoned ||= !configPublicationChanged;
>>>>>>> 97b6e87616f
              failure ??= "Session event was abandoned before execution";
            },
            onSettled: () => {
              if (deferred) {
                finish();
              }
            },
          },
        },
      });
      if (result.deferredToActiveRun) {
        // onDeferred precedes queue insertion; only the dispatch result proves acceptance.
        accept();
      } else {
        if (!started) {
          failure ??= "Session event was not admitted; retry against the current session";
        }
        finish();
      }
      await settled;
    }, "session:event"),
  )
    .catch((error: unknown) => {
      // Preserve the execution failure if terminal cleanup also rejects admission.
      failure ??= error instanceof Error ? error : String(error);
      finish();
      return settled.then(() => undefined);
    })
    .finally(() => generationLease?.release());
  return {
    id: occurrenceId,
    cancel: () => {
<<<<<<< HEAD
      // After a policy re-admission, cancellation must reach the live attempt;
      // producers (e.g. exec completion ack) keep this original handle.
=======
      // Producers keep this original handle; cancellation reaches the live attempt.
>>>>>>> 97b6e87616f
      if (readmittedReceipt) {
        return readmittedReceipt.cancel();
      }
      if (options.preserveOccurrenceOnRejection && !adopted && !started) {
        if (settlement === "finished" || signal.aborted) {
          return false;
        }
        // Native preparation and a queued reply retain custody until finish releases the claim.
        controller.abort();
        return true;
      }
      return ownership.cancel();
    },
    settled,
    accepted: acceptance.promise,
  };
}
