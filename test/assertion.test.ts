import assert from "node:assert/strict";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { test } from "vitest";
import { binding, verifyAssertion } from "../src/assertion.ts";

test("assertions reject unrecognized authority and expired or overlong lifetimes", async () => {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA");
  const key = await exportJWK(publicKey);
  const trust = { issuer: "gateway", audience: "studio", owner: "lexi", keys: { one: key } };
  const b = binding("POST", "/mcp", "application/json", Buffer.from('{"x":1}'));
  const sign = (extra: Record<string, unknown> = {}, expiration: string | number = "30s") =>
    new SignJWT({ client: "codex", grant: "g", scopes: ["things.read"], binding: b, ...extra })
      .setProtectedHeader({ alg: "EdDSA", kid: "one" })
      .setIssuer("gateway")
      .setAudience("studio")
      .setSubject("lexi")
      .setIssuedAt()
      .setExpirationTime(expiration)
      .sign(privateKey);
  const token = await sign();
  assert.equal((await verifyAssertion(token, trust, b)).client, "codex");
  await assert.rejects(verifyAssertion(await sign({ scopes: ["admin"] }), trust, b), /denied/);
  await assert.rejects(verifyAssertion(await sign({}, 1), trust, b), /denied/);
  await assert.rejects(verifyAssertion(await sign({}, "1h"), trust, b), /denied/);
});
