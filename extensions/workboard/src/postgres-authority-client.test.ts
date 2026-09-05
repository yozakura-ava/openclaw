import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HttpWorkboardAuthorityClient } from "./postgres-authority-client.js";

describe("Workboard PostgreSQL authority client", () => {
  it("signs requests and retries transient authority failures", async () => {
    let attempts = 0;
    const client = new HttpWorkboardAuthorityClient({
      baseUrl: "http://127.0.0.1:8787",
      secret: "test-secret",
      retries: 1,
      fetchImpl: async (input, init) => {
        attempts += 1;
        expect(input).toBe("http://127.0.0.1:8787/v1/workboard/write");
        expect(init?.method).toBe("POST");
        expect(typeof init?.body).toBe("string");
        const body = typeof init?.body === "string" ? init.body : "";
        const headers = new Headers(init?.headers);
        const expected = createHmac("sha256", "test-secret")
          .update(
            `POST\n/v1/workboard/write\n${headers.get("x-dbos-timestamp")}\n${headers.get("x-dbos-nonce")}\n${body}`,
          )
          .digest("hex");
        expect(headers.get("x-dbos-signature")).toBe(expected);
        if (attempts === 1) {
          return new Response(JSON.stringify({ error: "temporary authority failure" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            result: {
              applied: true,
              result: "updated",
              record: { found: true, deleted: false, value: { ok: true }, updatedAt: 2 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    await expect(
      client.write({
        operationId: "workboard:test",
        namespace: "cards",
        key: "card-1",
        value: { ok: true },
        mode: "upsert",
      }),
    ).resolves.toMatchObject({ applied: true });
    expect(attempts).toBe(2);
  });
});
