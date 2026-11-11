import assert from "node:assert/strict";
import { test } from "vitest";
import { Snapshots } from "../src/pagination.ts";

const p = { owner: "o", client: "c", grant: "g", scopes: ["things.read"] };
test("pagination stabilizes ordered IDs and binds opaque handles to client, query and timezone", () => {
  const cache = new Snapshots(),
    query = { scope: "inbox", limit: 1 };
  const s = cache.create(p, query, ["z", "a", "a"], "Phoenix");
  assert.deepEqual(s.ids, ["a", "z"]);
  s.position = 1;
  const cursor = cache.next(s);
  assert.ok(cursor);
  assert.equal(cache.resume(p, query, cursor, "Phoenix").position, 1);
  for (const attempt of [
    () => cache.resume({ ...p, client: "other" }, query, cursor, "Phoenix"),
    () => cache.resume(p, { scope: "inbox", limit: 2 }, cursor, "Phoenix"),
    () => cache.resume(p, query, cursor, "UTC"),
    () => cache.resume(p, query, cursor + "x", "Phoenix"),
    () => new Snapshots().resume(p, query, cursor, "Phoenix"),
    () => cache.resume(p, query, cursor, "Phoenix", Date.now() + 300001),
  ])
    assert.throws(attempt, /restart_required/);
});
test("oversized snapshots fail instead of truncating", () => {
  assert.throws(
    () =>
      new Snapshots().create(
        p,
        {},
        Array.from({ length: 10001 }, (_, i) => String(i)),
        "x",
      ),
    /snapshot_limit/,
  );
});

test("continuation handles cannot bypass the total retained-ID budget", () => {
  const cache = new Snapshots();
  const snapshot = cache.create(
    p,
    {},
    Array.from({ length: 10000 }, (_, i) => String(i)),
    "x",
  );
  snapshot.position = 1;
  for (let i = 0; i < 10; i++) assert.ok(cache.next(snapshot));
  assert.throws(() => cache.next(snapshot), /snapshot_limit/);
});
