import assert from "node:assert/strict";
<<<<<<< HEAD
import fs from "node:fs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { flushLogger } from "../../logging/logger.js";
import { preparedSharingReads } from "./session-accessor.sqlite-entry-cache-publication-state.js";

export function assertNoRetainedSessionSharingReads(): void {
  const retained = [...preparedSharingReads.values()].reduce(
    (count, reads) => count + reads.size,
    0,
  );
  assert.equal(retained, 0, "Completed handlers must release retained session sharing facts");
}
=======
import { preparedSharingReads } from "./session-accessor.sqlite-entry-cache-publication-state.js";
>>>>>>> 97b6e87616f

export function assertNoRetainedSessionSharingReads(): void {
  const retained = [...preparedSharingReads.values()].reduce(
    (count, reads) => count + reads.size,
    0,
  );
  assert.equal(retained, 0, "Completed handlers must release retained session sharing facts");
}
