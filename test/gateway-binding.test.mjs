import assert from "node:assert/strict";
import { exportJWK, generateKeyPair } from "jose";
import { test } from "vitest";
import { binding, verifyAssertion } from "../src/assertion.ts";
import { forward } from "../worker/proxy.ts";

test("actual gateway signer and Studio verifier reject request and trust substitution", async () => {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const env = {
    OWNER_RATE: { limit: async () => ({ success: true }) },
    SIGNING_JWK: JSON.stringify(await exportJWK(privateKey)),
    SIGNING_KID: "test",
    PUBLIC_ORIGIN: "https://things.example",
    ORIGIN_PATH: "/_origin/mcp",
    STUDIO_AUDIENCE: "studio",
    CF_ACCESS_CLIENT_ID: "synthetic",
    CF_ACCESS_CLIENT_SECRET: "synthetic",
  };
  const principal = {
    owner: "owner",
    client: "codex",
    grant: "grant",
    scopes: ["things.read", "things.update"],
  };
  const trust = {
    issuer: env.PUBLIC_ORIGIN,
    audience: env.STUDIO_AUDIENCE,
    owner: principal.owner,
    keys: { test: publicJwk },
  };
  const raw = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "things_update",
      arguments: {
        operationId: "31b68f38-c7f1-4f70-a04e-e55d1f27fbde",
        id: "synthetic",
        expectedRevision: "synthetic",
        title: "After",
      },
    },
  });
  let forwarded = 0;
  await forward(
    new Request(`${env.PUBLIC_ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
    }),
    env,
    principal,
    async (url, init) => {
      forwarded++;
      // Exercise the production implementations together with ephemeral keys.
      // The injected fetcher never sends a network request or calls Things.
      const actual = binding(
        init.method,
        new URL(url).pathname,
        init.headers.get("content-type"),
        init.body,
      );
      const token = init.headers.get("x-things-grant");
      assert.deepEqual(await verifyAssertion(token, trust, actual), principal);
      for (const altered of [
        { ...actual, method: "DELETE" },
        { ...actual, path: "/_origin/mcp?changed=1" },
        { ...actual, contentType: "text/plain" },
        binding("POST", "/_origin/mcp", "application/json", Buffer.from(`${raw} `)),
      ]) {
        await assert.rejects(verifyAssertion(token, trust, altered), /denied/);
      }
      for (const changedTrust of [
        { ...trust, issuer: "https://other.example" },
        { ...trust, audience: "other" },
        { ...trust, owner: "other" },
        { ...trust, keys: { other: publicJwk } },
      ]) {
        await assert.rejects(verifyAssertion(token, changedTrust, actual), /denied/);
      }
      return new Response(null, { status: 204 });
    },
  );
  assert.equal(forwarded, 1);
});
