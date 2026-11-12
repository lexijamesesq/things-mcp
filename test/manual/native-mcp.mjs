// Explicit native acceptance runner. Not part of unattended npm test.
// Run under the installed launcher after stopping the normal service.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { binding } from "../../src/assertion.ts";
import { httpServer } from "../../src/http.ts";
import { Journal } from "../../src/journal.ts";
import { verifyLock } from "../../src/lock.ts";
import { Native } from "../../src/native.ts";
import { Service } from "../../src/service.ts";

process.umask(0o077);
const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
// Optional candidate helper, without changing the installed configuration.
if (process.argv[3]) config.nativePath = process.argv[3];
verifyLock(
  join(dirname(config.nativePath), "Things MCP"),
  join(dirname(config.journal), "executor.lock"),
);
const directory = mkdtempSync(join(dirname(config.journal), "native-acceptance-"));
const title = `Things MCP write-path acceptance ${randomUUID()}`;
const known = new Set();
const counts = {};
class FixtureNative extends Native {
  async call(request) {
    const op = request.operation;
    assert.ok(
      [
        "status",
        "ensure_running",
        "create",
        "get",
        "set_title",
        "set_notes",
        "set_start",
        "set_status",
      ].includes(op),
    );
    if (op === "create") assert.equal(request.title, title);
    if (request.id) assert.ok(known.has(request.id), "Only this run’s fixture may be accessed");
    counts[op] = (counts[op] ?? 0) + 1;
    if (op === "create")
      assert.equal(
        counts.create,
        1,
        "At most one native create attempt, including ambiguous attempts",
      );
    const reply = await super.call(request);
    if (op === "create" && reply.ok && typeof reply.result?.id === "string")
      known.add(reply.result.id);
    return reply;
  }
}
const journal = new Journal(join(directory, "operations.sqlite"));
const native = new FixtureNative(config.nativePath);
const service = new Service(journal, native, config.timezone, true);
const { privateKey, publicKey } = await generateKeyPair("EdDSA");
const trust = {
  issuer: "isolated-acceptance",
  audience: "isolated-acceptance",
  owner: "acceptance",
  keys: { test: await exportJWK(publicKey) },
};
const hosts = [];
const server = httpServer(service, trust, hosts, []);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
hosts.push(`127.0.0.1:${port}`);
let sequence = 0;
const evidence = [];
async function call(
  name,
  args,
  scopes = ["things.read", "things.create", "things.update", "things.complete"],
  client = "acceptance-client",
) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: ++sequence,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const token = await new SignJWT({
    client,
    grant: "acceptance-grant",
    scopes,
    binding: binding("POST", "/mcp", "application/json", Buffer.from(body)),
  })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" })
    .setIssuer(trust.issuer)
    .setAudience(trust.audience)
    .setSubject(trust.owner)
    .setIssuedAt()
    .setExpirationTime("30s")
    .sign(privateKey);
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
      "x-things-grant": token,
    },
    body,
  });
  assert.equal(response.status, 200);
  const raw = await response.text();
  const rpc = JSON.parse(
    raw.startsWith("event:")
      ? raw
          .split("\n")
          .find((line) => line.startsWith("data:"))
          .slice(5)
      : raw,
  );
  assert.ok(rpc.result?.content?.[0]?.text, "Expected MCP tool response");
  const value = JSON.parse(rpc.result.content[0].text);
  evidence.push({
    tool: name,
    operationId: args.operationId,
    outcome: value.outcome,
    error: value.error,
  });
  return value;
}
let fixture;
try {
  const status = await call("things_status", {});
  assert.equal(status.native.permission, "authorized");
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const future = new Date(`${today}T12:00:00Z`);
  future.setUTCDate(future.getUTCDate() + 7);
  const start = future.toISOString().slice(0, 10);
  const create = { operationId: randomUUID(), title, notes: "Disposable acceptance notes", start };
  await Promise.all(Array.from({ length: 5 }, () => call("things_create", create)));
  const created = await call("things_create", create);
  assert.equal(created.outcome, "applied");
  assert.equal(counts.create, 1);
  fixture = created.result.id;
  assert.ok(known.has(fixture));
  let current = await call("things_get", { id: fixture });
  assert.equal(current.start, start);
  const originalDeadline = current.deadline;
  const scheduled = await call("things_update", {
    operationId: randomUUID(),
    id: fixture,
    expectedRevision: current.revision,
    start: today,
  });
  assert.equal(scheduled.outcome, "applied");
  assert.equal(scheduled.result.start, today);
  assert.equal(scheduled.result.deadline, originalDeadline);
  current = scheduled.result;
  const originalRevision = current.revision;
  const update = {
    operationId: randomUUID(),
    id: fixture,
    expectedRevision: current.revision,
    title: `${title} edited`,
  };
  let changed = await call("things_update", update);
  assert.equal(changed.outcome, "applied");
  assert.equal(changed.result.notes, create.notes);
  assert.equal((await call("things_update", update)).outcome, "applied");
  assert.equal(counts.set_title, 1);
  assert.equal(
    (await call("things_update", { ...update, title: "different" })).error,
    "operation_id_reused",
  );
  assert.equal(
    (
      await call("things_update", {
        ...update,
        operationId: randomUUID(),
        expectedRevision: originalRevision,
      })
    ).outcome,
    "conflict",
  );
  assert.equal(
    (await call("things_update", { ...update, operationId: randomUUID() }, ["things.update"]))
      .error,
    "denied",
  );
  current = changed.result;
  changed = await call("things_update", {
    operationId: randomUUID(),
    id: fixture,
    expectedRevision: current.revision,
    notes: null,
  });
  assert.equal(changed.outcome, "applied");
  assert.equal(changed.result.notes, "");
  for (const status of ["completed", "open", "completed"]) {
    changed = await call("things_set_status", {
      operationId: randomUUID(),
      id: fixture,
      expectedRevision: changed.result.revision,
      status,
    });
    assert.equal(changed.outcome, "applied");
    assert.equal(changed.result.status, status);
  }
  assert.equal(
    (
      await call(
        "things_operation_status",
        { operationId: create.operationId },
        ["things.create"],
        "different-client",
      )
    ).error,
    "denied",
  );
  const restricted = await call("things_create", create, ["things.create"]);
  assert.equal(restricted.result.notes, create.notes);
  assert.equal(counts.create, 1);
  const report = {
    passed: true,
    fixture,
    finalStatus: "completed",
    calls: evidence.length,
    nativeCounts: counts,
    evidence,
    scope:
      "Isolated loopback MCP transport, real native adapter, installed launcher identity; not public OAuth mutation acceptance",
  };
  writeFileSync(join(directory, "evidence.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  const report = { passed: false, fixture, nativeCounts: counts, evidence, error: error.message };
  writeFileSync(join(directory, "evidence.json"), JSON.stringify(report, null, 2));
  console.error(JSON.stringify(report));
  process.exitCode = 1;
} finally {
  await new Promise((resolve) => server.close(resolve));
  journal.close();
}
