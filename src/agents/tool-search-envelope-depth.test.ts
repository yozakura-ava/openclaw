// Regression matrix for card 79306758-f47d-4308-bcb2-7de7c1eaa4c1.
//
// Table-driven over envelope forms x representative core and plugin tool shapes.
// Depth cases assert on ERROR TEXT, not just call outcome: the honest message
// naming where the field was found is the behavioral fix, and an assertion that
// only checked "it threw" would pass against the original bug.
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { mcpTool } from "./code-mode.test-support.js";
import { readToolSearchCallArgs } from "./tool-search-request.js";
import {
  createToolSearchCatalogRef,
  createToolSearchTools,
  registerHeadlessToolSearchCatalog,
  resolveToolSearchConfig,
  TOOL_CALL_RAW_TOOL_NAME,
} from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

function fakeTool(name: string, parameters = Type.Object({})): AnyAgentTool {
  return {
    name,
    label: name,
    description: `Run ${name}`,
    parameters,
    execute: vi.fn(async (_toolCallId, input) => jsonResult({ input })),
  };
}

function createHarness(tools: AnyAgentTool[]) {
  const catalogRef = createToolSearchCatalogRef();
  registerHeadlessToolSearchCatalog({ catalogRef, tools });
  const config = { tools: { toolSearch: { enabled: true, mode: "tools" } } } as never;
  return {
    catalog: catalogRef.current,
    callTool: createToolSearchTools({
      catalogRef,
      config: resolveToolSearchConfig(config),
    }).find((tool) => tool.name === TOOL_CALL_RAW_TOOL_NAME),
  };
}

// Representative shapes across the blast radius: one core tool per Mode A family
// (sessions_send/message, message/action, automations/action, sessions_spawn/task)
// and the plugin shape actually reproduced on 2026-10-17 (workboard_comment, whose
// first required property is a card UUID — i.e. the Mode B collision itself).
const CARD_UUID = "3242ea23-650d-45a0-8cc6-85c867b040b9";

const TOOL_SHAPES = [
  {
    label: "sessions_send (core, required property 'message')",
    name: "sessions_send",
    parameters: Type.Object({ message: Type.String() }, { additionalProperties: false }),
    payload: { message: "hello" },
    required: ["message"],
  },
  {
    label: "message (core, required property 'action')",
    name: "message",
    parameters: Type.Object({ action: Type.String() }, { additionalProperties: false }),
    payload: { action: "send" },
    required: ["action"],
  },
  {
    label: "automations (core, required property 'action')",
    name: "automations",
    parameters: Type.Object({ action: Type.String() }, { additionalProperties: false }),
    payload: { action: "run" },
    required: ["action"],
  },
  {
    label: "sessions_spawn (core, required property 'task')",
    name: "sessions_spawn",
    parameters: Type.Object({ task: Type.String() }, { additionalProperties: false }),
    payload: { task: "do the thing" },
    required: ["task"],
  },
  {
    // The reproduced Mode B shape: the first required property IS a card UUID,
    // indistinguishable from a routing selector key.
    label: "workboard_comment (plugin, required property 'id' = card UUID)",
    name: "workboard_comment",
    parameters: Type.Object(
      { id: Type.String(), body: Type.String() },
      {
        additionalProperties: false,
      },
    ),
    payload: { id: CARD_UUID, body: "note" },
    required: ["id", "body"],
  },
] as const;

// For a tool whose required property is `id`, route with `toolId` so the card
// UUID in the payload is not consumed as the routing selector.
function routingCall(shape: (typeof TOOL_SHAPES)[number], payload: Record<string, unknown>) {
  return shape.required[0] === "id"
    ? { toolId: shape.name, ...payload }
    : { id: shape.name, ...payload };
}

describe("envelope depth unwrapping (Mode A) — per shape", () => {
  for (const shape of TOOL_SHAPES) {
    describe(shape.label, () => {
      const p = shape.payload;
      const forms = [
        { label: "flat", build: (v: typeof p) => ({ ...v }) },
        { label: "single envelope", build: (v: typeof p) => ({ args: { ...v } }) },
        {
          label: "double envelope (at the cap)",
          build: (v: typeof p) => ({ args: { args: { ...v } } }),
        },
        {
          label: "dotted keys",
          build: (v: typeof p) =>
            Object.fromEntries(Object.entries(v).map(([k, val]) => [`args.${k}`, val])),
        },
        {
          label: "empty wrapper with flattened arguments",
          build: (v: typeof p) => ({ args: {}, ...v }),
        },
        {
          label: "empty input wrapper with flattened arguments",
          build: (v: typeof p) => ({ input: {}, ...v }),
        },
      ];

      it.each(forms)("dispatches $label to the target tool", async ({ build }) => {
        const target = fakeTool(shape.name, shape.parameters);
        const { callTool } = createHarness([target]);
        expect(callTool).toBeDefined();

        await callTool!.execute(`${shape.name}-call`, routingCall(shape, build(p)));

        expect(target.execute).toHaveBeenCalledOnce();
        // The payload must land at the TOP level, not stay nested one level down.
        expect(vi.mocked(target.execute).mock.calls[0]?.[1]).toEqual(shape.payload);
      });

      // Depth rejections assert on ERROR TEXT: an error that says only "missing
      // property" is true about the object received and false about the caller's
      // intent, which is what drives the retry storm. The message must name the
      // depth and the dotted path where the next wrapper was found.
      it("rejects a triple-nested envelope naming the depth and the path", async () => {
        const target = fakeTool(shape.name, shape.parameters);
        const { callTool } = createHarness([target]);

        const failure = await callTool!
          .execute("too-deep", {
            ...routingCall(shape, { args: { args: { args: { ...p } } } } as never),
          })
          .then(() => undefined)
          .catch((error: unknown) => error as Error);

        expect(failure).toBeInstanceOf(Error);
        expect(failure?.message).toContain("found at args.args");
        expect(failure?.message).toMatch(/depth 3/);
        expect(target.execute).not.toHaveBeenCalled();
      });

      // A fourth level is rejected at the FIRST wrapper past the cap, not after
      // walking the whole nest: the point of the message is to name the exact
      // place the payload stopped being visible, so it must stay stable no matter
      // how much deeper the caller keeps nesting.
      it("rejects a four-level envelope at the first wrapper past the cap", async () => {
        const target = fakeTool(shape.name, shape.parameters);
        const { callTool } = createHarness([target]);

        const failure = await callTool!
          .execute("too-deep", {
            ...routingCall(shape, { args: { args: { args: { args: { ...p } } } } } as never),
          })
          .then(() => undefined)
          .catch((error: unknown) => error as Error);

        expect(failure).toBeInstanceOf(Error);
        expect(failure?.message).toMatch(/maximum of 2 levels/);
        expect(failure?.message).toContain("found at args.args.args");
        expect(failure?.message).toMatch(/depth 3/);
        expect(target.execute).not.toHaveBeenCalled();
      });
    });
  }
});

describe("envelope purity gate (arch review F1)", () => {
  // F1: at cap 2 the loop used to descend into any level holding a record-valued
  // args/input key, silently deleting a payload's OWN `input` field. These tests
  // are the regression net for that silent field loss.

  it("keeps a payload's own record-valued input field when a sibling key is present", async () => {
    // Pre-patch this call delivered {input:{query:'x'}, other:2} intact. The
    // post-cap-2 loop descended a second time and delivered {query:'x', other:2},
    // deleting `input` with no error.
    const target = fakeTool(
      "envelope_probe",
      Type.Object(
        { input: Type.Object({ query: Type.String() }), other: Type.Number() },
        { additionalProperties: false },
      ),
    );
    const { callTool } = createHarness([target]);
    expect(callTool).toBeDefined();

    await callTool!.execute("f1-payload-input", {
      id: "envelope_probe",
      args: { input: { query: "x" }, other: 2 },
    });

    expect(target.execute).toHaveBeenCalledOnce();
    // Exact equality: anything "fixed" by dropping a field fails here.
    expect(vi.mocked(target.execute).mock.calls[0]?.[1]).toEqual({
      input: { query: "x" },
      other: 2,
    });
  });

  it("drops nothing from a mixed envelope-plus-payload level", async () => {
    const target = fakeTool(
      "mixed_probe",
      Type.Object(
        { args: Type.Object({ m: Type.String() }), other: Type.Number() },
        { additionalProperties: false },
      ),
    );
    const { callTool } = createHarness([target]);
    expect(callTool).toBeDefined();

    await callTool!.execute("f1-mixed", {
      id: "mixed_probe",
      args: { args: { m: "x" }, other: 1 },
    });

    expect(target.execute).toHaveBeenCalledOnce();
    // A mixed level is payload, not an envelope: both keys survive.
    expect(vi.mocked(target.execute).mock.calls[0]?.[1]).toEqual({
      args: { m: "x" },
      other: 1,
    });
  });

  it("leaves an mcp-source tool's input property unmutated (no validation net)", async () => {
    // tool-search-runtime.ts gates input validation on `entry.source ===
    // "openclaw"`, so an MCP tool gets no schema check downstream. This is the
    // path where silent field loss would reach an external tool uncaught.
    const executeSpy = vi.fn(async (_toolCallId, input) => jsonResult({ input }));
    const target = mcpTool({
      name: "remote_envelope_probe",
      serverName: "remote",
      toolName: "envelope_probe",
      parameters: Type.Object(
        { input: Type.Object({ query: Type.String() }), limit: Type.Number() },
        { additionalProperties: false },
      ),
      execute: executeSpy,
    });
    const { callTool, catalog } = createHarness([target]);
    const entry = catalog?.entries[0];
    expect(entry?.source).toBe("mcp");
    if (!entry) {
      throw new Error("expected an mcp catalog entry");
    }

    await callTool!.execute("f1-mcp", {
      id: entry.id,
      args: { input: { query: "x" }, limit: 5 },
    });

    expect(executeSpy).toHaveBeenCalledOnce();
    expect(executeSpy.mock.calls[0]?.[1]).toEqual({ input: { query: "x" }, limit: 5 });
  });
});

describe("selector/payload id collision (Mode B)", () => {
  const CARD = "3242ea23-650d-45a0-8cc6-85c867b040b9";

  it("keeps a card UUID in the payload when the selector names the tool", () => {
    const catalogRef = createToolSearchCatalogRef();
    registerHeadlessToolSearchCatalog({ catalogRef, tools: [fakeTool("workboard_comment")] });
    const params = Type.Object({ id: Type.String(), body: Type.String() });

    // Routed by `toolId`/`name` while the real required `id` stays in the payload.
    const { id, input } = readToolSearchCallArgs(
      { toolId: "workboard_comment", id: CARD, body: "note" },
      catalogRef.current,
    );

    expect(id).toBe("workboard_comment");
    expect(input).toMatchObject({ id: CARD, body: "note" });
    void params;
  });

  it("delivers the card UUID to a plugin tool through the full dispatcher", async () => {
    const target = fakeTool(
      "workboard_comment",
      Type.Object({ id: Type.String(), body: Type.String() }, { additionalProperties: false }),
    );
    const { callTool } = createHarness([target]);
    expect(callTool).toBeDefined();

    await callTool!.execute("mode-b", {
      toolId: "workboard_comment",
      id: CARD,
      body: "note",
    });

    expect(target.execute).toHaveBeenCalledOnce();
    expect(vi.mocked(target.execute).mock.calls[0]?.[1]).toEqual({ id: CARD, body: "note" });
  });

  it("delivers the card UUID through the exact reproduced envelope call", async () => {
    const target = fakeTool(
      "workboard_comment",
      Type.Object({ id: Type.String(), body: Type.String() }, { additionalProperties: false }),
    );
    const { callTool } = createHarness([target]);
    expect(callTool).toBeDefined();

    // {id:'workboard_comment', args:{id:'<card-uuid>', body:'x'}} — the live repro.
    await callTool!.execute("mode-b-repro", {
      id: "workboard_comment",
      args: { id: CARD, body: "x" },
    });

    expect(target.execute).toHaveBeenCalledOnce();
    expect(vi.mocked(target.execute).mock.calls[0]?.[1]).toEqual({ id: CARD, body: "x" });
  });

  // Library-level argument composition only, NOT dispatch coverage: an unmatched
  // selector never reaches payload composition in a real dispatch, because
  // findEntry resolves the tool before anything validates or executes. This test
  // pins the no-catalog composition delta for direct library callers.
  it("keeps a card UUID on the no-catalog-match fallback path (library-level composition)", () => {
    // No catalog: nothing confirmed `id` as routing metadata, so it stays payload.
    const { id, input } = readToolSearchCallArgs({ id: CARD, body: "note" });

    expect(id).toBe(CARD);
    expect(input).toEqual({ id: CARD, body: "note" });
  });

  it("still rejects genuinely ambiguous selectors", () => {
    const catalogRef = createToolSearchCatalogRef();
    registerHeadlessToolSearchCatalog({
      catalogRef,
      tools: [fakeTool("inspect_resource"), fakeTool("search")],
    });

    expect(() =>
      readToolSearchCallArgs({ name: "inspect_resource", id: "search" }, catalogRef.current),
    ).toThrow("Ambiguous tool selectors");
  });
});
