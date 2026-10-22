import { formatErrorMessage } from "../../infra/errors.js";
import { settlePendingPackageActivation } from "../../infra/package-update-activation.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import { defaultRuntime } from "../../runtime.js";
import type { UpdateCommandOptions } from "./shared.js";
import { assertUpdatePackageActivationAdmission } from "./update-command-package-activation.js";
import { UpdateCommandPendingRecoveryFailure } from "./update-command-result.js";

export async function admitUpdateCommandPackageActivation(params: {
  root: string;
  opts: UpdateCommandOptions;
  postCoreUpdateResume: boolean;
  packageActivationNotes: string[];
}) {
  const { root, opts, postCoreUpdateResume, packageActivationNotes } = params;
  if (!postCoreUpdateResume) {
    const settled = await settlePendingPackageActivation(
      resolveUpdateInstallRoot(root),
      undefined,
      undefined,
      { onlyStaleLease: true, dryRun: opts.dryRun },
    ).catch((cause: unknown) => {
      throw new UpdateCommandPendingRecoveryFailure(
        { status: "error", mode: "unknown", root, steps: [], durationMs: 0 },
        formatErrorMessage(cause),
        { cause },
      );
    });
    if (settled) {
      const note = `${opts.dryRun ? "Would settle" : "Settled"} previous package update ${settled.operationId} (${settled.reason}); update can proceed past package recovery admission. Evidence ${opts.dryRun ? "would be retained" : "retained"} at ${settled.retained}.${settled.warning ? ` ${settled.warning}` : ""}`;
      if (opts.dryRun) {
        packageActivationNotes.push(note);
      } else {
        defaultRuntime.error(note);
      }
    }
  }
  assertUpdatePackageActivationAdmission(root, {
    continuation: postCoreUpdateResume ? opts.run?.executorFence : undefined,
    dryRun: !postCoreUpdateResume && opts.dryRun,
  });
}
