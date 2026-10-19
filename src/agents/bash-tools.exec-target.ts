import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { requireValidExecTarget } from "../infra/exec-approvals-core.js";
import { markToolExecutionNotStarted } from "./tool-effect-receipt.js";

export function resolveRequestedExecTarget(params: { host?: unknown; node?: unknown }) {
  const host = requireValidExecTarget(params.host);
  const node = normalizeOptionalString(params.node);
  if (!node) {
    return host;
  }
  if (params.host != null && host !== "node") {
    throw markToolExecutionNotStarted(
      new Error(
        `exec node=${JSON.stringify(node)} conflicts with host=${JSON.stringify(params.host)}; omit host or use host="node" to run on this node.`,
      ),
    );
  }
  return "node";
}
