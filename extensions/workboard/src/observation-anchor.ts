/**
 * Observation-anchor rule (Craig ADOPTED 2026-10-15, decision card
 * 64feb4bd-b219-433b-8c54-ba9de0d4fee5; build card 88d5c5b5).
 *
 * A workboard comment that carries a handoff/diagnosis tag and asserts a
 * runtime event must carry exactly one of:
 *  (a) an evidence anchor — a toolResult/call id plus tool name plus
 *      turn/session identifier; or
 *  (b) the literal prefix `unobserved:` marking the assertion as not
 *      observed by the author.
 *
 * Enforced at the single comment write choke point (`WorkboardCoreStore.
 * addComment`, before chunking — a split could otherwise carry the tag and
 * the assertion into different rows). Storage schema is untouched.
 */
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

/** Handoff/diagnosis tags that put a comment under the rule (case-insensitive). */
const HANDOFF_TAG_RE =
  /\[(?:build-handoff|handoff|review-handoff|ops-handoff|dispatch-handoff|diagnosis)\]/i;

/** The literal opt-out prefix; presence at line start OR directly after a
 *  handoff/diagnosis tag (`[diagnosis] unobserved: …`) satisfies the rule —
 *  the tag-adjacent form is the natural one-line shape for a comment whose
 *  whole content is unobserved. Buried mid-prose occurrences still require
 *  the line-start form, keeping the marker prominent. */
const UNOBSERVED_PREFIX_RE =
  /(?:^|\n)\s*unobserved:|\[(?:build-handoff|handoff|review-handoff|ops-handoff|dispatch-handoff|diagnosis)\]\s*unobserved:/i;

/** A tool result / tool-call identifier, e.g. `toolu_01Ab…`, `call_xyz…`. */
const TOOL_RESULT_ID_RE = /\b(?:toolu|tool_call|toolresult|call)[-_][a-z0-9]{6,}\b/i;

/** A plausible tool name mention, e.g. `workboard_read`, `sessions_spawn`. */
const TOOL_NAME_RE = /\b[a-z][a-z0-9]*_[a-z0-9_]{2,}\b/;

/** A turn/session/run identifier with its value, e.g. `session agent:tsubaki:…`. */
const TURN_SESSION_RE =
  /\b(?:turn|session|runid|run id|sessionkey|session key|attempt)\b[\s:=]*[a-z0-9][a-z0-9:_./-]{5,}/i;

/** True when the body carries a recognisable evidence anchor. */
export function hasEvidenceAnchor(body: string): boolean {
  if (TOOL_RESULT_ID_RE.test(body)) {
    return true;
  }
  return TOOL_NAME_RE.test(body) && TURN_SESSION_RE.test(body);
}

/** True when the rule applies to this comment (handoff/diagnosis tagged). */
export function isHandoffTagged(body: string): boolean {
  return HANDOFF_TAG_RE.test(body);
}

/**
 * Reject a handoff/diagnosis-tagged comment that asserts runtime events
 * without an evidence anchor or the `unobserved:` prefix. Plain comments and
 * compliant comments pass untouched; the error names the rule and both outs.
 */
export function assertObservationAnchor(body: unknown): void {
  const text = normalizeOptionalString(body);
  if (!text || !isHandoffTagged(text)) {
    return;
  }
  if (UNOBSERVED_PREFIX_RE.test(text)) {
    return;
  }
  if (hasEvidenceAnchor(text)) {
    return;
  }
  throw new Error(
    "observation-anchor rule (Craig ADOPTED 2026-10-15, card 64feb4bd): a " +
      "handoff/diagnosis-tagged comment asserting runtime events must carry an " +
      "evidence anchor (toolResult id + tool name + turn/session identifier) " +
      "or prefix the assertion with the literal 'unobserved:'. Re-post with an " +
      "anchor, or mark the unobserved parts with 'unobserved:'.",
  );
}
