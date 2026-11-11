import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { Journal } from "../src/journal.ts";
import { mergeBackup } from "../src/restore.ts";

test("restore unions tombstones, cannot regress current outcomes, and guards retries", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "things-restore-"));
  const live = new Journal(join(dir, "live.sqlite")),
    backup = new Journal(join(dir, "backup.sqlite"));
  t.onTestFinished(() => {
    live.close();
    backup.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const p = { owner: "o", client: "c", grant: "g", scopes: ["things.create"] };
  const existing = randomUUID(),
    newer = randomUUID(),
    old = randomUUID();
  for (const [journal, id] of [
    [live, existing],
    [live, newer],
    [backup, existing],
    [backup, old],
  ] as const) {
    journal.claim(p, id, {}, p.scopes);
    journal.finish(p.owner, id, "not_dispatched", {});
  }
  live.claim(p, existing, {}, p.scopes);
  live.dispatch(p.owner, existing, 0);
  live.observed(p.owner, existing, 0, { id: "native" }, false);
  const merged = mergeBackup(live, join(dir, "backup.sqlite"), p.owner);
  assert.equal(merged.inserted, 1);
  assert.equal(live.lookup(p, existing)?.outcome, "applied");
  for (const id of [existing, newer, old])
    assert.equal(live.claim(p, id, {}, p.scopes).fresh, false);
  assert.equal(mergeBackup(live, join(dir, "backup.sqlite"), p.owner).inserted, 0);
  backup.db
    .prepare("UPDATE operations SET request_hash='different' WHERE operation_id=?")
    .run(existing);
  assert.throws(() => mergeBackup(live, join(dir, "backup.sqlite"), p.owner), /backup_collision/);
});

test("restore preserves stage evidence and never resurrects expired payloads", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "things-restore-evidence-"));
  const live = new Journal(join(dir, "live.sqlite")),
    backup = new Journal(join(dir, "backup.sqlite"));
  t.onTestFinished(() => {
    live.close();
    backup.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const p = { owner: "o", client: "c", grant: "g", scopes: ["things.create"] };
  const expired = randomUUID(),
    staged = randomUUID();
  for (const j of [live, backup]) {
    j.claim(p, expired, {}, p.scopes);
    j.dispatch(p.owner, expired, 0);
    j.observed(p.owner, expired, 0, { id: "known", notes: "synthetic" }, false);
  }
  backup.expire(Date.now() + 8 * 86400000);
  backup.claim(p, staged, {}, p.scopes);
  backup.dispatch(p.owner, staged, 0);
  backup.observed(p.owner, staged, 0, { id: "known-stage", title: "first effect" }, true);
  backup.dispatch(p.owner, staged, 1);
  backup.finish(p.owner, staged, "uncertain", { id: "known-stage" });
  mergeBackup(live, join(dir, "backup.sqlite"), p.owner);
  assert.equal(live.lookup(p, expired)?.expired, true);
  assert.deepEqual(live.lookup(p, expired)?.result, { error: "result_expired" });
  assert.deepEqual(live.db.prepare("SELECT result FROM stages WHERE operation_id=?").all(expired), [
    { result: null },
  ]);
  assert.deepEqual(
    live.db
      .prepare("SELECT number,state,result FROM stages WHERE operation_id=? ORDER BY number")
      .all(staged),
    backup.db
      .prepare("SELECT number,state,result FROM stages WHERE operation_id=? ORDER BY number")
      .all(staged),
  );
  assert.equal(live.lookup(p, staged)?.outcome, "uncertain");
  assert.equal(live.claim(p, staged, {}, p.scopes).fresh, false);
  mergeBackup(live, join(dir, "backup.sqlite"), p.owner);
  assert.equal(live.claim(p, expired, {}, p.scopes).fresh, false);
});
