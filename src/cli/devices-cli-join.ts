import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
<<<<<<< HEAD
=======
import type { DevicePairSetupCodeResult } from "../../packages/gateway-protocol/src/index.js";
>>>>>>> 97b6e87616f
import { ADMIN_SCOPE } from "../gateway/method-scopes.js";
import { defaultRuntime } from "../runtime.js";
import { callGatewayFromCliWithTransport } from "./gateway-rpc.js";
import type { GatewayRpcOpts } from "./gateway-rpc.types.js";
<<<<<<< HEAD
import { quoteCliArg } from "./quote-cli-arg.js";

export async function runDevicesJoinCodeCommand(opts: GatewayRpcOpts): Promise<void> {
  const result = await callGatewayFromCliWithTransport<{ joinUrl?: unknown }>(
=======

export async function runDevicesJoinCodeCommand(opts: GatewayRpcOpts): Promise<void> {
  const result = await callGatewayFromCliWithTransport<DevicePairSetupCodeResult>(
>>>>>>> 97b6e87616f
    "device.pair.setupCode",
    opts,
    { bootstrapProfile: "node", includeQr: false, joinUrl: true },
    {
      label: "Devices device.pair.setupCode",
      defaultTimeoutMs: 10_000,
      scopes: [ADMIN_SCOPE],
      sharedStateMode: "read-only",
    },
  );
  const joinUrl = normalizeOptionalString(result.joinUrl);
  if (!joinUrl) {
    throw new Error("Gateway did not return a device join URL.");
  }
<<<<<<< HEAD
  const serviceCommand = `npx -y openclaw connect ${quoteCliArg(joinUrl)} --service`;
  const command = `${serviceCommand} --session-host`;
  if (opts.json) {
    defaultRuntime.writeJson({ joinUrl, command });
=======
  const command = normalizeOptionalString(result.command);
  const serviceCommand = normalizeOptionalString(result.serviceCommand);
  const installedCommand = normalizeOptionalString(result.installedCommand);
  const versionNote = normalizeOptionalString(result.versionNote);
  if (!command || !serviceCommand || !installedCommand) {
    throw new Error(
      "Gateway did not return device join commands. Update the Gateway and try again.",
    );
  }
  if (opts.json) {
    defaultRuntime.writeJson({
      joinUrl,
      command,
      serviceCommand,
      installedCommand,
      ...(versionNote ? { versionNote } : {}),
    });
>>>>>>> 97b6e87616f
    return;
  }
  defaultRuntime.log(joinUrl);
  defaultRuntime.log(command);
  defaultRuntime.log("Installs a background node service that can run agent sessions.");
  defaultRuntime.log(`Command-only node: ${serviceCommand}`);
<<<<<<< HEAD
=======
  defaultRuntime.log(`Already have OpenClaw installed? Run: ${installedCommand}`);
  if (versionNote) {
    defaultRuntime.log(versionNote);
  }
>>>>>>> 97b6e87616f
}
