# Workboard

Track agent work with boards and cards in the Control UI. Workboard provides a
dedicated page, navigation entries, session accessories, and dashboard widgets,
alongside tools for creating, assigning, and completing work. Cards can link to
agent sessions and retain notes, proof, and run history.

## Get started

Enable the bundled plugin and open the dashboard:

```bash
openclaw plugins enable workboard
openclaw dashboard
```

Open **Workboard** from navigation to create a board and cards. No
plugin-specific configuration is required. Agent tools remain subject to your
tool policy and workspace permissions.

Workboard tracks work on one Gateway. See the [Workboard guide](https://docs.openclaw.ai/plugins/workboard)
for card workflows, worker dispatch, and sharing boundaries.

## Observation-anchor rule (comments)

Adopted by Craig 2026-10-15 (decision card `64feb4bd`), enforced at the
comment write path since card `88d5c5b5`.

A comment that carries a handoff/diagnosis tag (`[build-handoff]`,
`[handoff]`, `[review-handoff]`, `[ops-handoff]`, `[dispatch-handoff]`,
`[diagnosis]` — case-insensitive) and asserts a runtime event must carry
exactly one of:

1. **An evidence anchor** — a toolResult/tool-call id (e.g. `toolu_01…`,
   `call_…`), or a tool name plus a turn/session/run identifier
   (e.g. `workboard_read session agent:tsubaki:main`); or
2. **The literal prefix `unobserved:`** — marking the assertion as not
   observed by the author.

Non-compliant comments are rejected at `addComment` with an error naming
this rule. Plain (untagged) comments are unaffected; storage schema is
unchanged.
