import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { binding } from "../src/assertion.ts";
import { httpServer } from "../src/http.ts";
import { Journal } from "../src/journal.ts";
import { Native } from "../src/native.ts";
import { Service } from "../src/service.ts";

test("real HTTP MCP denies unsigned requests and serves scoped stateless tool calls", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "things-http-"));
  const journal = new Journal(join(dir, "journal.sqlite"));
  const { privateKey, publicKey } = await generateKeyPair("EdDSA");
  const trust = {
    issuer: "gateway",
    audience: "studio",
    owner: "owner",
    keys: { one: await exportJWK(publicKey) },
  };
  const service = new Service(journal, new Native("/no-native-helper"), "America/Phoenix");
  const hosts: string[] = [];
  const server = httpServer(service, trust, hosts, []);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  hosts.push(`127.0.0.1:${address.port}`);
  const url = `http://127.0.0.1:${address.port}/mcp`;
  t.after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const invoke = async (scopes: string[], message: unknown, signed = true) => {
    const body = JSON.stringify(message);
    const token = await new SignJWT({
      client: "codex",
      grant: "g",
      scopes,
      binding: binding("POST", "/mcp", "application/json", Buffer.from(body)),
    })
      .setProtectedHeader({ alg: "EdDSA", kid: "one" })
      .setIssuer("gateway")
      .setAudience("studio")
      .setSubject("owner")
      .setIssuedAt()
      .setExpirationTime("30s")
      .sign(privateKey);
    return fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
        ...(signed ? { "x-things-grant": token } : {}),
      },
      body,
    });
  };
  const call = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "things_status", arguments: {} },
  };
  assert.equal((await invoke(["things.read"], call, false)).status, 401);
  const good = await invoke(["things.read"], call);
  assert.equal(good.status, 200);
  assert.match(await good.text(), /release_gates_pending/);
  const denied = await invoke([], call);
  assert.match(await denied.text(), /denied/);
  assert.equal((await invoke(["things.read"], [call])).status, 400);
});
