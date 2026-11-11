import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import {
  requestDevicePairJoinSetup,
  type DevicePairJoinSetup,
} from "../../lib/device-pair-setup.ts";
import { formatUiError } from "../../lib/format-error.ts";

registerNewSessionSetupEnglish();

// Closing, replacing the Gateway, or starting a newer request retires prior setup.
// Both the request token and open state fence late replies.
export class ConnectMachineSetupState {
  private openValue = false;
  private loadingValue = false;
  private errorValue: string | null = null;
  private setupValue: DevicePairJoinSetup | null = null;
  private requestId = 0;

  constructor(
    private readonly gateway: () => { client: GatewayBrowserClient | null; connected: boolean },
    private readonly requestUpdate: () => void,
  ) {}

  get open(): boolean {
    return this.openValue;
  }

  start(): void {
    this.openValue = true;
    this.errorValue = null;
    this.setupValue = null;
    this.requestUpdate();
    void this.refresh();
  }

  close(): void {
    this.requestId += 1;
    this.openValue = false;
    this.loadingValue = false;
    this.errorValue = null;
    this.setupValue = null;
  }

  view(enabled: boolean, onManageDevices: () => void) {
    return {
      open: this.open && enabled,
      loading: this.loadingValue,
      error: this.errorValue,
      setup: this.setupValue,
      onClose: () => {
        this.close();
        this.requestUpdate();
      },
      onRefresh: () => void this.refresh(),
      onManageDevices,
    };
<<<<<<< HEAD
    const { loadingValue: loading, errorValue: error, setupValue: setup } = this;
    const title = t("newSession.connectMachineTitle");
    const joinUrl = setup?.joinUrl?.trim();
    const command = joinUrl ? `npx -y openclaw connect ${quoteCliArg(joinUrl)} --service` : null;
    const expiresAt = setup?.expiresAtMs
      ? formatTimeMs(setup.expiresAtMs, { hour: "numeric", minute: "2-digit" }, "")
      : "";

    return html`
      <openclaw-modal-dialog
        class="connect-machine-dialog"
        label=${title}
        description=${t("newSession.connectMachineDescription")}
        @modal-cancel=${onClose}
      >
        <section class="exec-approval-card connect-machine-dialog__card">
          <header class="exec-approval-header">
            <div>
              <h2 class="exec-approval-title">${title}</h2>
              <p class="exec-approval-sub">${t("newSession.connectMachineDescription")}</p>
            </div>
            <button
              class="btn btn--icon btn--ghost"
              type="button"
              aria-label=${t("common.dismiss")}
              @click=${onClose}
            >
              ${icons.x}
            </button>
          </header>

          <div class="connect-machine-dialog__body">
            ${
              loading && !command
                ? html`<p class="connect-machine-dialog__status" role="status">
                    ${t("newSession.connectMachineGenerating")}
                  </p>`
                : nothing
            }
            ${
              error
                ? html`<p class="exec-approval-error" role="alert">
                    ${t("newSession.connectMachineFailed")} ${error}
                  </p>`
                : nothing
            }
            ${
              command
                ? html`
                    ${renderConnectCommand(`${command} --session-host`)}
                    <p class="connect-machine-dialog__hint">
                      ${t("newSession.connectMachineTeamHint")}
                    </p>
                    <details>
                      <summary>${t("newSession.connectMachineCommandOnly")}</summary>
                      ${renderConnectCommand(command)}
                    </details>
                    <p class="connect-machine-dialog__hint">
                      ${
                        expiresAt
                          ? t("newSession.connectMachineSingleUseExpires", { time: expiresAt })
                          : t("newSession.connectMachineSingleUse")
                      }
                    </p>
                  `
                : nothing
            }
          </div>

          <footer class="exec-approval-actions connect-machine-dialog__actions">
            ${
              command || error
                ? html`<button
                    class="btn"
                    type="button"
                    ?disabled=${loading}
                    @click=${() => void this.refresh()}
                  >
                    ${icons.refresh}
                    ${
                      loading
                        ? t("newSession.connectMachineRefreshing")
                        : t("newSession.connectMachineFreshCode")
                    }
                  </button>`
                : nothing
            }
            <button class="btn btn--ghost" type="button" @click=${onManageDevices}>
              ${t("newSession.connectMachineManageDevices")}
            </button>
          </footer>
        </section>
      </openclaw-modal-dialog>
    `;
=======
>>>>>>> 97b6e87616f
  }

  async refresh(): Promise<void> {
    if (!this.openValue || this.loadingValue) {
      return;
    }
    const { client, connected } = this.gateway();
    if (!connected || !client) {
      this.errorValue = t("newSession.connectMachineUnavailable");
      this.requestUpdate();
      return;
    }
    const requestId = ++this.requestId;
    this.loadingValue = true;
    this.errorValue = null;
    this.requestUpdate();
    try {
      const setup = await requestDevicePairJoinSetup(client);
      if (!this.stillCurrent(requestId, client)) {
        return;
      }
      if (!setup.joinUrl?.trim()) {
        this.setupValue = null;
        this.errorValue = t("newSession.connectMachineMissingUrl");
        return;
      }
      this.setupValue = setup;
    } catch (error) {
      if (this.stillCurrent(requestId, client)) {
        this.errorValue = formatUiError(error);
      }
    } finally {
      if (requestId === this.requestId) {
        this.loadingValue = false;
        this.requestUpdate();
      }
    }
  }

  private stillCurrent(requestId: number, client: GatewayBrowserClient): boolean {
    const gateway = this.gateway();
    return (
      requestId === this.requestId &&
      client === gateway.client &&
      gateway.connected &&
      this.openValue
    );
  }
}
