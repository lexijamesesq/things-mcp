import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { Journal } from "../src/journal.ts";
import { Native, type NativeReply } from "../src/native.ts";
import { Service } from "../src/service.ts";

class FakeNative extends Native {
  item: Record<string, unknown> = {
    id: "native-id",
    title: "Before",
    notes: "Secret notes",
    status: "open",
    recurrence: "unknown",
  };
  writes = 0;
  timeout = false;
  constructor() {
    super("/unused");
  }
  override async call(r: Record<string, unknown>): Promise<NativeReply> {
    if (r.operation === "status" || r.operation === "ensure_running")
      return { ok: true, dispatched: false, result: {} };
    if (r.operation === "get") return { ok: true, dispatched: true, result: { ...this.item } };
    this.writes++;
    if (this.timeout) throw new Error("caller killed after possible effect");
    if (r.operation === "create")
      this.item = { ...this.item, title: r.title, notes: r.notes ?? "" };
    if (r.operation === "set_title") this.item.title = r.value;
    if (r.operation === "set_notes") this.item.notes = r.value;
    if (r.operation === "set_status") this.item.status = r.value;
    return { ok: true, dispatched: true, result: { id: "native-id" } };
  }
}
const owner = {
  owner: "owner",
  client: "client",
  grant: "grant",
  scopes: ["things.read", "things.create", "things.update", "things.complete"],
};
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "things-service-"));
  const j = new Journal(join(dir, "journal.sqlite"));
  t.after(() => {
    j.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const native = new FakeNative();
  return { service: new Service(j, native, "America/Phoenix", true), native, j };
}
test("concurrent identical operations dispatch once, even after grant refresh", async (t) => {
  const { service, native } = fixture(t);
  const args = { operationId: randomUUID(), title: "Created" };
  await Promise.all(Array.from({ length: 20 }, () => service.call("things_create", args, owner)));
  await service.call("things_create", args, { ...owner, grant: "new" });
  assert.equal(native.writes, 1);
});
test("create replay and status never expose preexisting content after read scope is removed", async (t) => {
  const { service, native } = fixture(t);
  const args = { operationId: randomUUID(), title: "Created" };
  await service.call("things_create", args, owner);
  native.item.notes = "Other actor private note";
  const p = { ...owner, scopes: ["things.create"] };
  const replay = await service.call("things_create", args, p);
  const status = await service.call(
    "things_operation_status",
    { operationId: args.operationId },
    p,
  );
  assert.doesNotMatch(JSON.stringify([replay, status]), /Secret|Other actor|notes/);
  await assert.rejects(
    service.call(
      "things_operation_status",
      { operationId: args.operationId },
      { ...p, client: "foreign" },
    ),
    /denied/,
  );
});
test("fresh revision conflict detects changes regardless of modification timestamp", async (t) => {
  const { service, native } = fixture(t);
  const initial = await service.read("native-id");
  native.item.notes = "Changed immediately";
  const result = await service.call(
    "things_update",
    {
      operationId: randomUUID(),
      id: "native-id",
      expectedRevision: initial.revision,
      title: "After",
    },
    owner,
  );
  assert.equal((result as { outcome: string }).outcome, "conflict");
  assert.equal(native.writes, 0);
});
test("timeout remains uncertain and identical resubmission never dispatches again", async (t) => {
  const { service, native } = fixture(t);
  native.timeout = true;
  const args = { operationId: randomUUID(), title: "Ambiguous" };
  const result = await service.call("things_create", args, owner);
  assert.equal((result as { outcome: string }).outcome, "uncertain");
  await service.call("things_create", args, owner);
  assert.equal(native.writes, 1);
});
test("update cannot smuggle status and both update scopes are required", async (t) => {
  const { service, native } = fixture(t);
  const initial = await service.read("native-id");
  const args = {
    operationId: randomUUID(),
    id: "native-id",
    expectedRevision: initial.revision,
    title: "After",
  };
  await assert.rejects(
    service.call("things_update", { ...args, status: "completed" }, owner),
    /invalid_argument/,
  );
  await assert.rejects(
    service.call("things_update", args, { ...owner, scopes: ["things.update"] }),
    /denied/,
  );
  assert.equal(native.writes, 0);
});

test("expired undispatched operations remain tombstones and cannot execute", async (t) => {
  const { service, native, j } = fixture(t);
  const args = { operationId: randomUUID(), title: "Expired" };
  const request = { tool: "things_create", version: 1, args };
  j.claim(owner, args.operationId, request, ["things.create"]);
  j.finish(owner.owner, args.operationId, "not_dispatched", { error: "unavailable" });
  j.expire(Date.now() + 8 * 86400000);
  assert.equal(j.claim(owner, args.operationId, request, ["things.create"]).fresh, false);
  const result = await service.call("things_create", args, owner);
  assert.match(JSON.stringify(result), /result_expired/);
  assert.equal(native.writes, 0);
});

test("readiness observes unavailable native access without starting Things", async (t) => {
  const { service, native } = fixture(t);
  const operations: unknown[] = [];
  native.call = async (request) => {
    operations.push(request.operation);
    return { ok: false, dispatched: false, error: "permission_required" };
  };
  const result = (await service.call("things_status", {}, owner)) as {
    writes: { ready: boolean };
    native: { permission: string };
    journal: string;
  };
  assert.deepEqual(operations, ["status"]);
  assert.equal(result.writes.ready, false);
  assert.equal(result.native.permission, "required");
  assert.equal(result.journal, "accessible");
});

test("degraded service preserves diagnostics while rejecting task admission", async (t) => {
  const { service, native } = fixture(t);
  service.accepting = false;
  const status = (await service.call("things_status", {}, owner)) as {
    service: string;
    writes: { ready: boolean };
  };
  assert.equal(status.service, "degraded");
  assert.equal(status.writes.ready, false);
  await service.call("things_capabilities", {}, owner);
  await assert.rejects(
    service.call("things_create", { operationId: randomUUID(), title: "blocked" }, owner),
    /service_unavailable/,
  );
  assert.equal(native.writes, 0);
});
