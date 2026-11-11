import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { Journal, SerialQueue } from "../src/journal.ts";

const p = { owner: "owner", client: "client", grant: "grant", scopes: ["things.create"] };
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "things-journal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "journal.sqlite");
}
test("durable owner-global dedupe and client boundary survive reopen and grant rotation", (t) => {
  const path = fixture(t),
    id = randomUUID();
  let j = new Journal(path);
  assert.equal(j.claim(p, id, { title: "A" }, p.scopes).fresh, true);
  assert.equal(j.claim(p, id, { title: "A" }, p.scopes).fresh, false);
  assert.throws(() => j.claim(p, id, { title: "B" }, p.scopes), /operation_id_reused/);
  assert.throws(() => j.lookup({ ...p, client: "other" }, id), /denied/);
  assert.throws(() => j.lookup({ ...p, scopes: [] }, id), /denied/);
  j.dispatch(p.owner, id, 0);
  j.observed(p.owner, id, 0, { id: "native" }, false);
  j.close();
  j = new Journal(path);
  assert.equal(j.lookup({ ...p, grant: "rotated" }, id)?.outcome, "applied");
  j.close();
});
test("startup distinguishes undispatched, ambiguous, and completed earlier stages", (t) => {
  const path = fixture(t);
  let j = new Journal(path);
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  for (const id of ids) j.claim(p, id, {}, p.scopes);
  j.dispatch(p.owner, ids[1], 0);
  j.dispatch(p.owner, ids[2], 0);
  j.observed(p.owner, ids[2], 0, { id: "known" }, true);
  j.close();
  j = new Journal(path);
  j.recover();
  assert.deepEqual(
    ids.map((id) => j.lookup(p, id)?.outcome),
    ["not_dispatched", "uncertain", "partial"],
  );
  j.close();
});
test("retention removes payload but retains collision tombstones forever", (t) => {
  const j = new Journal(fixture(t)),
    id = randomUUID();
  j.claim(p, id, {}, p.scopes);
  j.dispatch(p.owner, id, 0);
  j.observed(p.owner, id, 0, { id: "sensitive" }, false);
  j.expire(Date.now() + 8 * 86400000);
  assert.deepEqual(j.lookup(p, id)?.result, { error: "result_expired" });
  assert.equal(j.claim(p, id, {}, p.scopes).fresh, false);
  assert.throws(() => j.claim(p, id, { title: "changed" }, p.scopes));
  j.close();
});
test("queue serializes native execution and caps active plus waiting at 32", async () => {
  const q = new SerialQueue();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let active = 0,
    max = 0;
  const jobs = Array.from({ length: 32 }, () =>
    q.run(async () => {
      max = Math.max(max, ++active);
      await gate;
      active--;
      return 1;
    }),
  );
  assert.throws(() => q.run(async () => 0), /overloaded/);
  release();
  await Promise.all(jobs);
  assert.equal(max, 1);
});
