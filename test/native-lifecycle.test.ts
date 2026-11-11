import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";

test("actual native control flow rejects unsuitable sessions, permission denial and target loss without UI or retries", (t) => {
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
  const run = (scenario: string) => {
    const execution = spawnSync(binary, [scenario], {
      input: JSON.stringify({
        operation: "set_title",
        id: "synthetic-fixture",
        value: "synthetic-title",
      }),
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(execution.status, 1, `${scenario}: ${execution.stderr}`);
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
});
