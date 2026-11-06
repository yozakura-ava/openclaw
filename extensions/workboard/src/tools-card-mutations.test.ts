// Tests for the workboard_complete tool schema surface carrying
// consumer_surface_evidence through to the store (yozakura-ava/openclaw#120).
import { describe, expect, it, vi } from "vitest";
import type { WorkboardStore } from "./store.js";
import {
  consumerSurfaceEvidenceField,
  createWorkboardCardMutations,
} from "./tools-card-mutations.js";

describe("consumerSurfaceEvidenceField schema", () => {
  it("is optional with additionalProperties=false and the evidence properties", () => {
    const field = consumerSurfaceEvidenceField();
    expect(field).toBeDefined();
    const schema = field as unknown as { properties: Record<string, unknown> };
    for (const key of ["kind", "repoPath", "commitSha", "filePath", "consumerId"]) {
      expect(schema.properties[key]).toBeDefined();
    }
    const objectSchema = field as unknown as { additionalProperties?: boolean };
    expect(objectSchema.additionalProperties).toBe(false);
  });
});

describe("workboard_complete pass-through", () => {
  it("forwards consumer_surface_evidence from tool params to store.complete", async () => {
    const evidence = { kind: "code", repoPath: "/repo", commitSha: "abc123" };
    const complete = vi.fn<WorkboardStore["complete"]>(async () => ({
      id: "card-1",
      title: "t",
      status: "done" as const,
      priority: "normal" as const,
      labels: ["[BUILD]"],
      position: 1,
      createdAt: 1,
      updatedAt: 2,
    }));
    const fakeStore = {
      get: vi.fn(async () => ({
        id: "card-1",
        title: "t",
        status: "running",
        labels: [],
        position: 1,
        createdAt: 1,
        updatedAt: 2,
        metadata: { claim: { ownerId: "tester", token: "tok", claimedAt: 1 } },
      })),
      complete,
    } as unknown as WorkboardStore;
    const { claimedCardMutation } = createWorkboardCardMutations(fakeStore, "tester");
    const execute = claimedCardMutation((id, record, scope) =>
      fakeStore.complete(
        id,
        record as Parameters<WorkboardStore["complete"]>[1],
        scope as Parameters<WorkboardStore["complete"]>[2],
      ),
    );
    await execute("call-1", {
      id: "card-1",
      summary: "done",
      consumer_surface_evidence: evidence,
    });
    expect(complete).toHaveBeenCalledTimes(1);
    const passedRecord = complete.mock.calls[0]![1] as Record<string, unknown>;
    expect(passedRecord.consumer_surface_evidence).toEqual(evidence);
  });
});
