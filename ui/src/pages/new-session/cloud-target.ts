import type { EnvironmentsListResult } from "../../../../packages/gateway-protocol/src/index.js";
import type {
  WorkerMachineOption,
  WorkerOperatingSystem,
} from "../../../../packages/gateway-protocol/src/schema/environments.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { registerSessionPlacementEnglish } from "../../i18n/locales/en-session-placement.ts";
import type { DraftCloudProfile, DraftEnvironment } from "./discovery.ts";
import { readDraftCloudProfiles, readDraftEnvironments } from "./discovery.ts";

registerNewSessionSetupEnglish();
registerSessionPlacementEnglish();

export async function requestPlaceCatalog(
  client: Pick<GatewayBrowserClient, "request">,
  runtimeId?: string,
): Promise<{
  profiles: DraftCloudProfile[];
  environments: DraftEnvironment[];
  suggestedProfile?: EnvironmentsListResult["suggestedProfile"];
}> {
  const result = await client.request<EnvironmentsListResult>(
    "environments.list",
    runtimeId ? { runtimeId } : {},
  );
  return {
    profiles: readDraftCloudProfiles(result?.profiles),
    suggestedProfile: result?.suggestedProfile,
    environments: readDraftEnvironments(result?.environments),
  };
}

export type SessionMenuItemOptions = {
  value: string;
  label: string;
  accessibleProvider?: string;
  description?: string;
  icon?: unknown;
  sub?: string;
  facts?: readonly string[];
  checked: boolean;
  disabled?: boolean;
  title?: string;
  keepOpen?: boolean;
  compact?: boolean;
  capacityLabel?: string;
  platform?: string;
  summary?: string;
  selectedSummary?: string;
  hasSubmenu?: boolean;
  suggested?: boolean;
  capabilityLabels?: readonly string[];
  hardware?: string;
  hideDetails?: boolean;
  remediation?: "enable-session-hosting" | "update-device";
  provider?: string;
  trust?: "persistent" | "disposable";
  onSelect: () => void;
};

<<<<<<< HEAD
function formatUnavailableReason(
  reason: string,
  remediation: SessionMenuItemOptions["remediation"],
) {
  if (remediation === "enable-session-hosting") {
    return html`<div>${t("newSession.sessionHostingAction")}</div>
      <code class="new-session-page__command"
        >openclaw config set nodeHost.workerRuns.enabled true</code
      >
      <code class="new-session-page__command">openclaw node install --force</code>`;
  }
  if (remediation === "update-device") {
    return html`<div>${t("newSession.updateAction")}</div>
      <code class="new-session-page__command">openclaw update</code>
      <div>${t("newSession.reconnectAction")}</div>
      <code class="new-session-page__command">openclaw node restart</code>`;
  }
  return reason;
}

function detailRow(icon: TemplateResult, text: string) {
  return html`<div class="new-session-page__card-row">
    <span class="new-session-page__card-icon" aria-hidden="true">${icon}</span><span>${text}</span>
  </div>`;
}

export function renderSessionMenuItem(params: SessionMenuItemOptions, submitting: boolean) {
  const unavailableReason = params.disabled ? params.title || params.description : undefined;
  const description = params.compact ? undefined : params.description;
  const accessibleBlocker = params.compact && params.disabled && !params.hideDetails;
  const touchDetails = params.compact && !params.disabled && !params.hideDetails;
  const accessibilityHints = [
    params.suggested ? t("newSession.machineDefault") : undefined,
    params.accessibleProvider
      ? t("newSession.cloudWorkerProvider", { provider: params.accessibleProvider })
      : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  const accessibleDescription = [
    accessibilityHints,
    params.accessibleProvider ? unavailableReason : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  const row = html`
    <button
      type="button"
      class="session-menu__item ${
        description ? "session-menu__item--described" : ""
      } ${params.compact ? "new-session-page__environment-option" : ""}"
      data-suggested=${params.suggested ? "true" : nothing}
      aria-description=${accessibleDescription || nothing}
      data-value=${params.value}
      data-popover=${params.keepOpen || accessibleBlocker ? nothing : "close"}
      aria-pressed=${String(params.checked)}
      title=${params.compact ? nothing : (params.title ?? nothing)}
      ?disabled=${submitting || (Boolean(params.disabled) && !accessibleBlocker)}
      aria-disabled=${accessibleBlocker ? "true" : nothing}
      @click=${(event: MouseEvent) => {
        if (params.disabled) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        params.onSelect();
      }}
    >
      ${
        params.icon
          ? html`<span class="session-menu__icon" aria-hidden="true">${params.icon}</span>`
          : nothing
      }
      <span class="session-menu__text">
        ${params.label}
        ${
          params.selectedSummary
            ? html`<span class="new-session-page__selected-summary"
                >${params.selectedSummary}</span
              >`
            : nothing
        }
        ${
          description
            ? html`<span class="session-menu__description">${description}</span>`
            : nothing
        }
      </span>
      ${
        !params.compact && params.facts?.length
          ? html`<span class="new-session-page__menu-meta">
              <span class="new-session-page__menu-facts">
                ${params.facts.map(
                  (fact) => html`<span class="new-session-page__menu-fact">${fact}</span>`,
                )}
              </span>
            </span>`
          : nothing
      }
      ${
        !params.compact && params.sub
          ? html`<span class="session-menu__sub">${params.sub}</span>`
          : nothing
      }

      <span class="session-menu__check" aria-hidden="true"
        >${params.checked ? icons.check : nothing}</span
      >
      ${
        params.hasSubmenu
          ? html`<span class="new-session-page__submenu-chevron" aria-hidden="true"
              >${icons.chevronRight}</span
            >`
          : nothing
      }
    </button>
  `;
  return params.compact && !params.hideDetails
    ? html`<openclaw-tooltip
        class="new-session-page__environment-details"
        placement="right-start"
        ?open-on-click=${accessibleBlocker || touchDetails}
      >
        <div class="new-session-page__environment-detail-trigger">
          ${row}
          ${
            touchDetails
              ? html`<button
                  type="button"
                  class="new-session-page__touch-details"
                  aria-label=${t("newSession.environmentDetails", { name: params.label })}
                  ?disabled=${submitting}
                >
                  ${icons.info}
                </button>`
              : nothing
          }
        </div>
        <div slot="content" class="new-session-page__environment-card">
          ${accessibilityHints ? html`<span hidden>${accessibilityHints}, </span>` : nothing}
          ${
            unavailableReason
              ? html`<span>${formatUnavailableReason(unavailableReason, params.remediation)}</span>`
              : html`
                  <strong>${params.label}</strong>
                  ${params.summary ? detailRow(icons.info, params.summary) : nothing}
                  ${params.platform ? detailRow(icons.layers, params.platform) : nothing}
                  ${params.sub ? detailRow(icons.info, params.sub) : nothing}
                  ${
                    params.capabilityLabels?.length
                      ? detailRow(icons.info, params.capabilityLabels.join(", "))
                      : nothing
                  }
                  ${
                    params.trust
                      ? detailRow(
                          params.trust === "persistent" ? icons.repeat : icons.clock,
                          t(
                            params.trust === "persistent"
                              ? "newSession.persistentEnvironmentHint"
                              : "newSession.disposableEnvironmentHint",
                          ),
                        )
                      : nothing
                  }
                  ${params.provider ? detailRow(icons.server, params.provider) : nothing}
                  ${params.hardware ? detailRow(icons.info, params.hardware) : nothing}
                  ${[
                    ...new Set(
                      [
                        params.description,
                        ...(params.facts ?? []),
                        params.provider && !params.disabled ? undefined : params.title,
                      ].filter(Boolean),
                    ),
                  ].map((detail) => detailRow(icons.info, detail!))}
                  ${
                    params.capacityLabel
                      ? html`<div class="new-session-page__card-row">
                          <span class="new-session-page__card-icon" aria-hidden="true"
                            >${icons.activity}</span
                          ><span class="new-session-page__capacity-caption"
                            >${params.capacityLabel}</span
                          >
                        </div>`
                      : nothing
                  }
                `
          }
        </div>
      </openclaw-tooltip>`
    : row;
}

export function renderCloudProfileMenuItems(params: {
=======
export type CloudProfileMenuItemsOptions = {
>>>>>>> 97b6e87616f
  profiles: readonly DraftCloudProfile[];
  selectedId: string;
  selectedOs?: string;
  selectedMachine?: string;
  onSelectOs?: (osId: string) => void;
  onSelectMachine?: (machineId: string) => void;
  submitting: boolean;
  disabled?: boolean;
  disabledReason?: string;
  profileDisabledReason?: (profile: DraftCloudProfile) => string | undefined;
  compact?: boolean;
  onSelect: (profileId: string, useDefaults?: boolean) => void;
};

export type CloudChoiceMenuItemsOptions = {
  kind: "machine" | "os";
  choices: readonly (WorkerMachineOption & WorkerOperatingSystem)[];
  selectedId: string;
  suggestedId?: string;
  submitting: boolean;
  onSelect: (id: string) => void;
};

/** Machine shape as a picker sub-line; providers may report neither, one, or both numbers. */
export function machineShapeText(machine: WorkerMachineOption): string | undefined {
  const cpu = machine.cpu === undefined ? undefined : String(machine.cpu);
  const memory = machine.memoryGb === undefined ? undefined : String(machine.memoryGb);
  if (cpu && memory) {
    return t("newSession.machineShape", { cpu, memory });
  }
  if (cpu) {
    return t("newSession.machineCpu", { cpu });
  }
  return memory ? t("newSession.machineMemory", { memory }) : undefined;
}
