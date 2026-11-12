import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";

test("actual native control flow preserves silent lifecycle guards and scheduling date semantics", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "things-native-boundary-"));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const binary = join(dir, "native-boundary");
  const build = spawnSync(
    "/usr/bin/clang",
    [
      "-fobjc-arc",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-framework",
      "AppKit",
      "-framework",
      "ApplicationServices",
      resolve("test/fixtures/native-boundary.m"),
      "-o",
      binary,
    ],
    { encoding: "utf8" },
  );
  assert.equal(build.status, 0, build.stderr);
  const run = (
    scenario: string,
    request: Record<string, unknown> = {
      operation: "set_title",
      id: "synthetic-fixture",
      value: "synthetic-title",
    },
    exitCode = 1,
  ) => {
    const execution = spawnSync(binary, [scenario], {
      input: JSON.stringify(request),
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(execution.status, exitCode, `${scenario}: ${execution.stderr}`);
    const line = execution.stderr.split("\n").find((value) => value.startsWith("BOUNDARY:"));
    assert.ok(line, execution.stderr);
    const observed = JSON.parse(line.slice("BOUNDARY:".length));
    const reply = JSON.parse(execution.stdout);
    assert.equal(observed.openCalls, 0, `${scenario}: no application launch`);
    assert.equal(observed.askedForPermission, false, `${scenario}: no consent request`);
    assert.equal(
      observed.appLookups <= 1,
      true,
      `${scenario}: never re-resolve replacement target`,
    );
    return { observed, reply };
  };
  for (const scenario of ["locked", "off_console", "wrong_owner"]) {
    const { observed, reply } = run(scenario);
    assert.equal(reply.error, "owner_session_unavailable");
    assert.equal(reply.dispatched, false);
    assert.equal(observed.eventCalls, 0);
  }
  const denied = run("permission_denied");
  assert.equal(denied.reply.error, "permission_required");
  assert.equal(denied.reply.dispatched, false);
  assert.equal(denied.observed.eventCalls, 0);
  for (const scenario of [
    "exited_after_capture",
    "replaced_after_capture",
    "locked_after_capture",
  ]) {
    const { observed, reply } = run(scenario);
    assert.equal(
      reply.error,
      scenario === "locked_after_capture" ? "owner_session_unavailable" : "unavailable",
    );
    assert.equal(reply.dispatched, false);
    assert.equal(observed.eventCalls, 0);
  }
  const failure = run("event_failure");
  assert.equal(failure.reply.error, "native_error");
  assert.equal(failure.reply.dispatched, true);
  assert.equal(failure.observed.eventCalls, 1, "ambiguous event is never retried");
  assert.equal(failure.observed.eventTargetsSelf, true);
  assert.equal(failure.observed.neverInteract, true);
  assert.equal(failure.observed.dontReconnect, true);
  assert.equal(failure.observed.doNotPrompt, true);
  assert.ok(
    failure.observed.timeout > 0 && failure.observed.timeout <= 5,
    "bounded event deadline",
  );
  const schedule = {
    operation: "set_start",
    id: "synthetic-fixture",
    value: "2026-11-12",
    timezone: "America/Phoenix",
  };
  const fourCC = (value: string) => Buffer.from(value).readUInt32BE();
  const scheduled = run("schedule_success", schedule, 0);
  assert.equal(scheduled.reply.ok, true);
  assert.equal(scheduled.observed.eventCalls, 1);
  assert.deepEqual(scheduled.observed.events[0], {
    class: fourCC("THGS"),
    id: fourCC("schd"),
    dateType: fourCC("ldt "),
    dateSeconds: Date.parse("2026-11-12T07:00:00Z") / 1000,
    taskId: "synthetic-fixture",
    property: 0,
  });
  for (const key of ["eventTargetsSelf", "neverInteract", "dontReconnect", "doNotPrompt"])
    assert.equal(scheduled.observed[key], true, key);
  for (const scenario of [
    "locked",
    "permission_denied",
    "exited_after_capture",
    "replaced_after_capture",
    "locked_after_capture",
  ]) {
    const blocked = run(scenario, schedule);
    assert.equal(blocked.reply.dispatched, false);
    assert.equal(blocked.observed.eventCalls, 0);
  }
  const ambiguous = run("event_failure", schedule);
  assert.equal(ambiguous.reply.dispatched, true);
  assert.equal(ambiguous.observed.eventCalls, 1);
  for (const patch of [
    { value: "2026-02-30" },
    { value: "2026-2-03" },
    { value: "1903-12-31" },
    { value: null },
    { timezone: "Not/AZone" },
    { timezone: "" },
    { value: "2011-12-30", timezone: "Pacific/Apia" },
  ]) {
    const invalid = run(
      patch.timezone === "Pacific/Apia" ? "schedule_success_apia" : "schedule_success",
      { ...schedule, ...patch },
    );
    assert.equal(invalid.reply.error, "invalid_argument", JSON.stringify(patch));
    assert.equal(invalid.reply.dispatched, false);
    assert.equal(invalid.observed.appLookups, 0);
    assert.equal(invalid.observed.permissionChecks, 0);
    assert.equal(invalid.observed.eventCalls, 0);
  }
  const get = { operation: "get", id: "synthetic-fixture", timezone: "America/Phoenix" };
  for (const request of [schedule, get, { operation: "status" }, { operation: "ensure_running" }]) {
    const mismatch = run("schedule_success", { ...request, timezone: "Etc/UTC" });
    assert.equal(mismatch.reply.error, "timezone_mismatch", request.operation);
    assert.equal(mismatch.reply.dispatched, false);
    assert.equal(mismatch.observed.appLookups, 0);
    assert.equal(mismatch.observed.permissionChecks, 0);
    assert.equal(mismatch.observed.eventCalls, 0);
    assert.equal(mismatch.observed.openCalls, 0);
  }
  for (const operation of ["status", "ensure_running"]) {
    const matching = run("schedule_success", { operation, timezone: "America/Phoenix" }, 0);
    assert.equal(matching.reply.ok, true);
    assert.equal(matching.observed.eventCalls, 0);
  }
  const dated = run("read_dates", get, 0);
  assert.equal(dated.reply.result.start, "2026-11-11");
  assert.equal(dated.reply.result.deadline, "2026-11-12");
  assert.deepEqual(
    dated.observed.events.map((event: { property: number }) => event.property),
    ["ID  ", "pnam", "note", "tdst", "actd", "dued"].map(fourCC),
  );
  const missing = run("read_missing", get, 0);
  assert.equal(missing.reply.result.start, null);
  assert.equal(missing.reply.result.deadline, null);
  const invalidRead = run("read_invalid", get);
  assert.equal(invalidRead.reply.error, "invalid_native_output");
});
