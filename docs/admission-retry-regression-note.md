# Admission-retry port: source-level regression note

Branch: `build/session-history-admission-retry` (card 07579577)

## What proves the fix

- `src/config/sessions/session-transcript-admission-retry.test.ts` — 5/5 vitest
  passing. These tests exercise the **overload path** directly: a transient
  admission failure during transcript append is retried against the refreshed
  session state instead of surfacing as a hard error, matching the upstream
  retry semantics.
- The regression is pinned at source level: the tests target
  `session-transcript-admission-retry.ts` in `src/config/sessions/`, the exact
  module that carries the ported retry behavior, so any future change that
  removes or weakens the retry/overload path fails this file.

## Upstream linkage

This port mitigates the admission failure mode tracked upstream in
openclaw/openclaw#195316: transcript entry admission could fail transiently
(concurrent reclamation/rewrite windows) and lose the append. The retry path
ported here makes those transient failures self-healing; the 5 overload-path
tests reproduce the failing-then-succeeding admission sequence that #195316
describes and assert the entry lands after retry.
