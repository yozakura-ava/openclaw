// Workboard tests cover store plugin behavior.
// Card 202183c5: comment/proof authorship attribution.
//
// The load-bearing cases here are the round-trip tests. `insertChildren`
// DELETEs and re-INSERTs every comment row on every card write, so a fix that
// only stamps attribution on the write path is silently erased by the next
// unrelated mutation of that card.
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import type { AttributedWorkboardComment } from "./actor-attribution.js";
import { normalizeActor } from "./actor-attribution.js";
import { createWorkboardSqliteTestHarness } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";

/**
 * Verbatim replica of Rin's `RIN_ACTOR_RE` (blob 9859f41a486, commit
 * 1115f859). Duplicated here on purpose: Rin's regex is not on this branch yet
 * and this card merges first. If either side is edited, this test is the
 * tripwire - the trailing negative lookahead is what stops `rin-old` and
 * `agent:rinny` from being misread as the reviewer.
 */
const RIN_ACTOR_RE = /^(?:agent:)?rin(?![A-Za-z0-9_.-])/i;

function toolContext(agentId: string): OpenClawPluginToolContext {
  return { agentId } as unknown as OpenClawPluginToolContext;
}

function commentTools(
  store: Parameters<typeof createWorkboardTools>[0]["store"],
  context?: OpenClawPluginToolContext,
) {
  return new Map(createWorkboardTools({ store, context }).map((tool) => [tool.name, tool]));
}

describe("workboard comment attribution", () => {
  it("records the calling agent identity from the tool layer", async () => {
    const store = createWorkboardSqliteTestHarness().store;
    const card = await store.create({ title: "attributed comment" });
    const tools = commentTools(store, toolContext("agent:rin:main"));

    await expectDefined(tools.get("workboard_comment"), "comment tool").execute("c1", {
      id: card.id,
      body: "reviewed and moving on",
    });

    const stored = await store.get(card.id);
    expect(stored?.metadata?.comments).toEqual([
      expect.objectContaining({ actorId: "agent:rin:main", actorKind: "agent" }),
    ]);
  });

  it("writes NULL attribution when no tool context exists (fail-closed)", async () => {
    // createWorkboardTools() with no context is the "agent" fallback path.
    // It must NOT persist "agent" as an identity - that would fabricate
    // authorship for an unknown writer.
    const store = createWorkboardSqliteTestHarness().store;
    const card = await store.create({ title: "unattributed comment" });
    const tools = commentTools(store);

    await expectDefined(tools.get("workboard_comment"), "comment tool").execute("c1", {
      id: card.id,
      body: "no caller identity available",
    });

    const stored = await store.get(card.id);
    const comment = stored?.metadata?.comments?.[0];
    expect(comment).toBeDefined();
    expect(comment).not.toHaveProperty("actorId");
    expect(comment).not.toHaveProperty("actorKind");
  });

  it("rejects partial and unknown-kind identities", async () => {
    const store = createWorkboardSqliteTestHarness().store;
    const card = await store.create({ title: "partial identity" });

    await store.addComment(card.id, { body: "no kind", actorId: "someone", actorKind: undefined });
    await store.addComment(card.id, { body: "bad kind", actorId: "someone", actorKind: "robot" });
    await store.addComment(card.id, { body: "no id", actorId: undefined, actorKind: "agent" });

    const comments = (await store.get(card.id))?.metadata?.comments ?? [];
    for (const comment of comments) {
      expect(comment).not.toHaveProperty("actorId");
      expect(comment).not.toHaveProperty("actorKind");
    }
    expect(comments).toHaveLength(3);
  });

  it("normalizes a complete identity pair", () => {
    expect(normalizeActor({ actorId: "rin", actorKind: "agent" })).toEqual({
      actorId: "rin",
      actorKind: "agent",
    });
    expect(normalizeActor({ actorId: "  ", actorKind: "agent" })).toBeUndefined();
    expect(normalizeActor({ actorId: "bot", actorKind: "SYSTEM" })).toBeUndefined();
  });
});

describe("workboard comment attribution round-trip", () => {
  it("survives an unrelated card mutation performed after the comment", async () => {
    // THE REGRESSION THIS CARD EXISTS TO PREVENT: insertChildren rewrites all
    // comment rows on every card write. A tool-layer-only stamp would be gone
    // after the next unrelated edit to the card.
    const store = createWorkboardSqliteTestHarness().store;
    const card = await store.create({ title: "round trip" });

    await store.addComment(card.id, {
      body: "authored by rin",
      actorId: "rin",
      actorKind: "agent",
    });
    // An unrelated mutation, authored by nobody in particular.
    await store.addLink(card.id, { url: "https://example.com/related", title: "related" });

    const comments = (await store.get(card.id))?.metadata?.comments ?? [];
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      body: "authored by rin",
      actorId: "rin",
      actorKind: "agent",
    });
  });

  it("WIPE-REGRESSION: a system row written straight to sqlite survives a plugin write", async () => {
    // System bots (admission-prep-bot, alert-bridge, cron-auto-bq, dispatcher)
    // write straight to sqlite and bypass the plugin entirely. The plugin's
    // rewrite must preserve what they wrote rather than nulling it out.
    const { store, dbPath } = createWorkboardSqliteTestHarness();
    const card = await store.create({ title: "system writer" });

    const raw = new DatabaseSync(dbPath);
    raw
      .prepare(
        `INSERT INTO workboard_card_comments
           (id, card_id, ordinal, body, actor_id, actor_kind, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "system-row-1",
        card.id,
        0,
        "written directly by admission-prep-bot",
        "admission-prep-bot",
        "system",
        1,
        null,
      );
    raw.close();

    // A plugin-mediated write must round-trip the out-of-band row intact.
    await store.addLink(card.id, { url: "https://example.com/after", title: "after" });

    const comments = (await store.get(card.id))?.metadata?.comments ?? [];
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      body: "written directly by admission-prep-bot",
      actorId: "admission-prep-bot",
      actorKind: "system",
    });
  });

  it("WIPE-REGRESSION: a system proof row written straight to sqlite survives a plugin write", async () => {
    // Same hazard, same out-of-band writers, different child table. Proof rows
    // are rebuilt from workboard_card_proof on every read, so an out-of-band
    // proof row would be nulled out by the next plugin write just as a comment
    // row would.
    const { store, dbPath } = createWorkboardSqliteTestHarness();
    const card = await store.create({ title: "system proof writer" });

    const raw = new DatabaseSync(dbPath);
    raw
      .prepare(
        `INSERT INTO workboard_card_proof
           (id, card_id, ordinal, status, label, command, url, note, actor_id, actor_kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "system-proof-1",
        card.id,
        0,
        "passed",
        "alert-bridge proof",
        null,
        null,
        "written directly by alert-bridge",
        "alert-bridge",
        "system",
        1,
      );
    raw.close();

    await store.addLink(card.id, { url: "https://example.com/after", title: "after" });

    const proofs = (await store.get(card.id))?.metadata?.proof ?? [];
    expect(proofs).toHaveLength(1);
    expect(proofs[0]).toMatchObject({
      id: "system-proof-1",
      note: "written directly by alert-bridge",
      actorId: "alert-bridge",
      actorKind: "system",
    });
  });

  it("preserves attribution across an oversized split comment", async () => {
    const store = createWorkboardSqliteTestHarness().store;
    const card = await store.create({ title: "oversized" });
    // Large enough to split into several rows, small enough to stay inside the
    // 50-row comment budget (the preflight rejects an over-budget split).
    const body = "chunk ".repeat(1_500);

    await store.addComment(card.id, { body, actorId: "rin", actorKind: "agent" });
    await store.addLink(card.id, { url: "https://example.com/after-split", title: "after" });

    const comments = (await store.get(card.id))?.metadata?.comments ?? [];
    expect(comments.length).toBeGreaterThan(1);
    for (const comment of comments) {
      expect(comment).toMatchObject({ actorId: "rin", actorKind: "agent" });
    }
  });
});

describe("workboard proof attribution", () => {
  it("round-trips proof authorship through metadata.proof", async () => {
    const store = createWorkboardSqliteTestHarness().store;
    const card = await store.create({ title: "proof actor" });

    await store.addProof(card.id, {
      status: "passed",
      label: "scoped tests",
      actorId: "rin",
      actorKind: "agent",
    });

    const proof = (await store.get(card.id))?.metadata?.proof?.[0];
    expect(proof).toMatchObject({ actorId: "rin", actorKind: "agent", label: "scoped tests" });
  });

  it("omits attribution on an unattributed proof", async () => {
    const store = createWorkboardSqliteTestHarness().store;
    const card = await store.create({ title: "proof no actor" });

    await store.addProof(card.id, { status: "passed", label: "unattributed" });

    const proof = (await store.get(card.id))?.metadata?.proof?.[0];
    expect(proof).toBeDefined();
    expect(proof).not.toHaveProperty("actorId");
    expect(proof).not.toHaveProperty("actorKind");
  });
});

describe("actor id form compatibility", () => {
  it("emits ids that Rin can attribute", async () => {
    // Every id form the tool layer can emit must match Rin's regex. These are
    // the forms contextOwner() produces across session kinds.
    const emitted = [
      "rin",
      "agent:rin:main",
      "agent:rin:subagent:0f9c1d2e-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
    ];

    for (const actorId of emitted) {
      expect(RIN_ACTOR_RE.test(actorId)).toBe(true);
    }
  });

  it("does not match near-miss ids", () => {
    // Guards the negative lookahead: these must NOT be attributed to Rin.
    for (const actorId of ["rinny", "rin-bot", "agent:rin-old", "rin.ok", "rin_1"]) {
      expect(RIN_ACTOR_RE.test(actorId)).toBe(false);
    }
  });

  it("attributes every Rin-shaped id written through the tool layer", async () => {
    const store = createWorkboardSqliteTestHarness().store;
    for (const agentId of ["rin", "agent:rin:main"]) {
      const card = await store.create({ title: `rin ${agentId}` });
      const tools = new Map(
        createWorkboardTools({ store, context: toolContext(agentId) }).map((tool) => [
          tool.name,
          tool,
        ]),
      );
      await expectDefined(tools.get("workboard_comment"), "comment tool").execute("rin", {
        id: card.id,
        body: "rin comment",
      });
      // The shared contract types `WorkboardComment` without actor fields and
      // is deliberately not widened by this card (scope is
      // extensions/workboard/**), so the read site needs the local
      // intersection. Runtime carries the fields; only the type does not.
      const comment = (await store.get(card.id))?.metadata?.comments?.[0] as
        | AttributedWorkboardComment
        | undefined;
      expect(comment?.actorId).toBe(agentId);
      expect(RIN_ACTOR_RE.test(String(comment?.actorId))).toBe(true);
    }
  });
});
