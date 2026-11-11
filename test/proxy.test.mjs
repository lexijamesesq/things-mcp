import assert from "node:assert/strict";
import { test } from "node:test";
import { exportJWK, generateKeyPair, jwtVerify } from "jose";
import { forward } from "../worker/proxy.ts";

test("gateway strips caller identity, binds exact payload, and never retries a failed origin", async () => {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true });
  const env = {
    OWNER_RATE: { limit: async () => ({ success: true }) },
    SIGNING_JWK: JSON.stringify(await exportJWK(privateKey)),
    SIGNING_KID: "test",
    PUBLIC_ORIGIN: "https://things.example",
    ORIGIN_PATH: "/_origin/mcp",
    STUDIO_AUDIENCE: "studio",
    CF_ACCESS_CLIENT_ID: "service-id",
    CF_ACCESS_CLIENT_SECRET: "service-secret",
  };
  const grant = {
    owner: "owner",
    client: "client",
    grant: "grant",
    scopes: ["things.read", "things.update"],
  };
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "things_update", arguments: {} },
  });
  const request = () =>
    new Request("https://things.example/mcp", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer caller",
        "x-things-grant": "forged",
        "cf-access-jwt-assertion": "forged",
        "x-owner": "forged",
        "CF-Access-Client-Secret": "forged",
      },
    });
  let attempts = 0;
  const send = async (url, init) => {
    attempts++;
    assert.equal(url, "https://things.example/_origin/mcp");
    assert.equal(init.redirect, "manual");
    assert.equal(init.headers.get("authorization"), null);
    assert.equal(init.headers.get("cf-access-jwt-assertion"), null);
    assert.equal(init.headers.get("x-owner"), null);
    assert.equal(init.headers.get("CF-Access-Client-Secret"), "service-secret");
    const { payload } = await jwtVerify(init.headers.get("x-things-grant"), publicKey, {
      issuer: env.PUBLIC_ORIGIN,
      audience: env.STUDIO_AUDIENCE,
    });
    assert.equal(payload.sub, grant.owner);
    assert.equal(payload.client, grant.client);
    assert.deepEqual(payload.scopes, grant.scopes);
    assert.equal(
      payload.binding.bodySha256,
      Buffer.from(await crypto.subtle.digest("SHA-256", init.body)).toString("base64url"),
    );
    assert.equal(new TextDecoder().decode(init.body), body);
    throw new Error("ambiguous origin failure");
  };
  await assert.rejects(forward(request(), env, grant, send), /ambiguous/);
  assert.equal(attempts, 1);
  const denied = await forward(request(), env, { ...grant, scopes: ["things.update"] }, send);
  assert.equal(denied.status, 403);
  assert.equal(attempts, 1);
  const batch = await forward(
    new Request("https://things.example/mcp", { method: "POST", body: "[]" }),
    env,
    grant,
    send,
  );
  assert.equal(batch.status, 400);
  assert.equal(attempts, 1);
});
