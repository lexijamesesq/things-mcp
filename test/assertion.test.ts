import assert from "node:assert/strict";
import { test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { binding, verifyAssertion } from "../src/assertion.ts";

test("gateway assertion binds exact bytes, path, method, identity and lifetime", async () => {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA");
  const key = await exportJWK(publicKey);
  const trust = { issuer: "gateway", audience: "studio", owner: "lexi", keys: { one: key } };
  const b = binding("POST", "/mcp", "application/json", Buffer.from('{"x":1}'));
  const sign = (extra: Record<string, unknown> = {}) =>
    new SignJWT({ client: "codex", grant: "g", scopes: ["things.read"], binding: b, ...extra })
      .setProtectedHeader({ alg: "EdDSA", kid: "one" })
      .setIssuer("gateway")
      .setAudience("studio")
      .setSubject("lexi")
      .setIssuedAt()
      .setExpirationTime("30s")
      .sign(privateKey);
  const token = await sign();
  assert.equal((await verifyAssertion(token, trust, b)).client, "codex");
  await assert.rejects(verifyAssertion(token, trust, { ...b, path: "/mcp?changed" }), /denied/);
  await assert.rejects(
    verifyAssertion(
      token,
      trust,
      binding("POST", "/mcp", "application/json", Buffer.from('{"x": 1}')),
    ),
    /denied/,
  );
  await assert.rejects(verifyAssertion(token, { ...trust, owner: "other" }, b), /denied/);
  await assert.rejects(verifyAssertion(token, { ...trust, audience: "other" }, b), /denied/);
  await assert.rejects(verifyAssertion(await sign({ scopes: ["admin"] }), trust, b), /denied/);
});
