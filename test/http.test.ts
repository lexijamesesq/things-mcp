import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { test } from "vitest";
import { binding } from "../src/assertion.ts";
import { httpServer } from "../src/http.ts";
import { Journal } from "../src/journal.ts";
import { Native, type NativeReply } from "../src/native.ts";
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
  t.onTestFinished(async () => {
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

test("client disconnect after dispatch does not cancel work or duplicate the mutation on replay", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "things-disconnect-"));
  const journal = new Journal(join(dir, "journal.sqlite"));
  let dispatched!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  const finish = new Promise<void>((resolve) => {
    release = resolve;
  });
  let mutations = 0;
  class GatedNative extends Native {
    override async call(request: Record<string, unknown>): Promise<NativeReply> {
      if (request.operation === "ensure_running")
        return { ok: true, dispatched: false, result: {} };
      if (request.operation === "create") {
        mutations++;
        dispatched();
        await finish;
        return { ok: true, dispatched: true, result: { id: "fixture-id" } };
      }
      assert.equal(request.operation, "get");
      return {
        ok: true,
        dispatched: true,
        result: {
          id: "fixture-id",
          title: "Disposable",
          notes: "",
          status: "open",
          recurrence: "unknown",
        },
      };
    }
  }
  const service = new Service(journal, new GatedNative("/never-executed"), "America/Phoenix", true);
  const { privateKey, publicKey } = await generateKeyPair("EdDSA");
  const trust = {
    issuer: "test-gateway",
    audience: "test-studio",
    owner: "owner",
    keys: { test: await exportJWK(publicKey) },
  };
  const hosts: string[] = [];
  const server = httpServer(service, trust, hosts, []);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  hosts.push(`127.0.0.1:${address.port}`);
  t.onTestFinished(async () => {
    release();
    await service.queue.drain();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const operationId = randomUUID();
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "things_create", arguments: { operationId, title: "Disposable" } },
  });
  const token = await new SignJWT({
    client: "client",
    grant: "grant",
    scopes: ["things.create"],
    binding: binding("POST", "/mcp", "application/json", Buffer.from(body)),
  })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" })
    .setIssuer(trust.issuer)
    .setAudience(trust.audience)
    .setSubject(trust.owner)
    .setIssuedAt()
    .setExpirationTime("30s")
    .sign(privateKey);
  const invoke = (signal?: AbortSignal) =>
    fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
        "x-things-grant": token,
      },
      body,
      signal,
    }).then((response) => response.text());
  const controller = new AbortController();
  const interrupted = invoke(controller.signal).catch((error: unknown) => error);
  await entered;
  controller.abort();
  assert.ok((await interrupted) instanceof Error);
  let drained = false;
  const draining = service.queue.drain().then(() => {
    drained = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(drained, false, "drain waits for the dispatched work after its client disappears");
  assert.equal(mutations, 1);
  release();
  await draining;
  const principal = { owner: "owner", client: "client", grant: "grant", scopes: ["things.create"] };
  assert.equal(journal.lookup(principal, operationId)?.outcome, "applied");
  assert.match(await invoke(), /applied/);
  assert.equal(
    mutations,
    1,
    "a reconnect replays the persisted outcome without another native call",
  );
});
