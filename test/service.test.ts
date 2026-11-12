import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "vitest";
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
    start: null,
    deadline: "2030-03-04",
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
    if (r.operation === "set_start") {
      assert.equal(r.id, this.item.id);
      assert.equal(r.timezone, "America/Phoenix");
      this.item.start = r.value;
    }
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
  t.onTestFinished(() => {
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

test("two-field update preserves its first stage and never replays after second-stage failure", async (t) => {
  for (const ambiguous of [false, true]) {
    const { service, native, j } = fixture(t);
    const originalCall = native.call.bind(native);
    let titleCalls = 0,
      notesCalls = 0;
    native.call = async (request) => {
      if (request.operation === "set_title") titleCalls++;
      if (request.operation === "set_notes") {
        notesCalls++;
        if (ambiguous) throw new Error("response lost after possible notes change");
        return { ok: false, dispatched: false, error: "unavailable" };
      }
      return originalCall(request);
    };
    const current = await service.read("native-id");
    const args = {
      operationId: randomUUID(),
      id: "native-id",
      expectedRevision: current.revision,
      title: "First stage applied",
      notes: "Second stage",
    };
    const outcome = (await service.call("things_update", args, owner)) as { outcome: string };
    assert.equal(outcome.outcome, ambiguous ? "uncertain" : "partial");
    assert.equal(native.item.title, args.title);
    const stages = j.db
      .prepare("SELECT number,state FROM stages WHERE operation_id=? ORDER BY number")
      .all(args.operationId);
    assert.deepEqual(stages, [
      { number: 0, state: "applied" },
      { number: 1, state: ambiguous ? "uncertain" : "not_dispatched" },
    ]);
    const replay = (await service.call("things_update", args, owner)) as { outcome: string };
    assert.equal(replay.outcome, outcome.outcome);
    assert.equal(titleCalls, 1);
    assert.equal(notesCalls, 1);
    const status = (await service.call(
      "things_operation_status",
      { operationId: args.operationId },
      owner,
    )) as { stages: { number: number; outcome: string; result: { title?: string } }[] };
    assert.equal(status.stages[0].outcome, "applied");
    assert.equal(status.stages[0].result.title, args.title);
  }
});

test("scheduling create and update preserves deadlines and uses fresh date revisions", async (t) => {
  const { service, native } = fixture(t);
  const create = { operationId: randomUUID(), title: "Scheduled", start: "2032-02-29" };
  const result = await service.call("things_create", create, {
    ...owner,
    scopes: ["things.create"],
  });
  assert.equal((result as { outcome: string }).outcome, "applied");
  assert.match(JSON.stringify(result), /2032-02-29/);
  assert.doesNotMatch(JSON.stringify(result), /2030-03-04/);
  assert.equal(native.item.start, create.start);
  assert.equal(native.item.deadline, "2030-03-04");
  const before = await service.read("native-id");
  const update = {
    operationId: randomUUID(),
    id: "native-id",
    expectedRevision: before.revision,
    start: "2032-03-01",
  };
  assert.equal(
    ((await service.call("things_update", update, owner)) as { outcome: string }).outcome,
    "applied",
  );
  assert.equal(native.item.start, update.start);
  assert.equal(native.item.deadline, "2030-03-04");
  assert.equal(native.item.title, "Scheduled");
  assert.equal(
    (
      (await service.call(
        "things_update",
        { ...update, operationId: randomUUID(), start: "2032-03-02" },
        owner,
      )) as { outcome: string }
    ).outcome,
    "conflict",
  );
});

test("invalid scheduled dates and deadline writes are rejected before any mutation", async (t) => {
  const { service, native } = fixture(t);
  for (const start of [
    "2031-02-29",
    "2030-13-01",
    "today",
    "2030-01-01T00:00:00Z",
    "1903-12-31",
    null,
  ]) {
    await assert.rejects(
      service.call("things_create", { operationId: randomUUID(), title: "Invalid", start }, owner),
      /invalid_start_date/,
    );
  }
  await assert.rejects(
    service.call(
      "things_update",
      {
        operationId: randomUUID(),
        id: "native-id",
        expectedRevision: "v1:unused",
        deadline: "2030-01-01",
      },
      owner,
    ),
    /invalid_argument/,
  );
  assert.equal(native.writes, 0);
});

test("scheduled creation retains the created ID on partial failure without claiming or replaying scheduling", async (t) => {
  const { service, native } = fixture(t);
  const original = native.call.bind(native);
  native.call = async (request) =>
    request.operation === "set_start"
      ? { ok: false, dispatched: false, error: "unavailable" }
      : original(request);
  const args = { operationId: randomUUID(), title: "Created before schedule", start: "2032-01-01" };
  const result = await service.call("things_create", args, owner);
  assert.equal((result as { outcome: string }).outcome, "partial");
  assert.match(JSON.stringify(result), /native-id/);
  assert.doesNotMatch(JSON.stringify(result), /2032-01-01/);
  assert.deepEqual(await service.call("things_create", args, owner), result);
  assert.equal(native.writes, 1);
});

test("scheduling that alters a deadline is uncertain and never replayed", async (t) => {
  const { service, native } = fixture(t);
  const original = native.call.bind(native);
  native.call = async (request) => {
    const result = await original(request);
    if (request.operation === "set_start") native.item.deadline = null;
    return result;
  };
  const before = await service.read("native-id");
  const args = {
    operationId: randomUUID(),
    id: "native-id",
    expectedRevision: before.revision,
    start: "2032-01-01",
  };
  assert.equal(
    ((await service.call("things_update", args, owner)) as { outcome: string }).outcome,
    "uncertain",
  );
  await service.call("things_update", args, owner);
  assert.equal(native.writes, 1);
});
