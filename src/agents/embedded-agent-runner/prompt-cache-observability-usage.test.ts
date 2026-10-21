import { describe, expect, it } from "vitest";
import {
  beginPromptCacheObservation,
  completePromptCacheObservation,
} from "./prompt-cache-observability.js";

let testScope = 0;

describe("prompt cache observability usage", () => {
  it("ignores missing usage and preserves the previous cache-read baseline", () => {
    const sessionId = `session:${++testScope}`;
    const sessionKey = `agent:main:${testScope}`;
    beginPromptCacheObservation({
      sessionId,
      sessionKey,
      messages: [],
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      streamStrategy: "boundary-aware:openai-responses",
      systemPrompt: "stable system",
      tools: [{ name: "read" }],
      cacheRetention: "long",
      transport: "sse",
    });
    completePromptCacheObservation({ sessionId, sessionKey, usage: { cacheRead: 8_000 } });

    beginPromptCacheObservation({
      sessionId,
      sessionKey,
      messages: [],
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      streamStrategy: "boundary-aware:openai-responses",
      systemPrompt: "stable system with hook change",
      tools: [{ name: "read" }],
      cacheRetention: "short",
      transport: "websocket",
    });
    expect(completePromptCacheObservation({ sessionId, sessionKey })).toBeNull();

    const resumed = beginPromptCacheObservation({
      sessionId,
      sessionKey,
      messages: [],
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      streamStrategy: "boundary-aware:openai-responses",
      systemPrompt: "stable system with hook change",
      tools: [{ name: "read" }],
      cacheRetention: "short",
      transport: "websocket",
    });
    expect(resumed.previousCacheRead).toBe(8_000);
    expect(resumed.changes).toBeNull();

    expect(
      completePromptCacheObservation({ sessionId, sessionKey, usage: { cacheRead: 2_000 } }),
    ).toEqual({ previousCacheRead: 8_000, cacheRead: 2_000, changes: null });
  });
});
