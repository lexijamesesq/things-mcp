import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type TestContext, test } from "node:test";
import { Journal } from "../src/journal.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "things-operator-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = join(root, "Library/Application Support/ThingsMCP");
  mkdirSync(join(base, "state"), { recursive: true });
  mkdirSync(join(base, "releases/0.1.0/build"), { recursive: true });
  const launcher = join(base, "releases/0.1.0/build/Things MCP");
  symlinkSync(resolve("build/Things MCP"), launcher);
  const journalPath = join(base, "state/journal.sqlite");
  const lockPath = join(base, "state/executor.lock");
  writeFileSync(
    join(base, "config.json"),
    JSON.stringify({
      journal: journalPath,
      nativePath: "/usr/bin/false",
      trust: { owner: "fixture" },
    }),
    { mode: 0o600 },
  );
  const preload = join(root, "isolate.mjs");
  // Isolate the actual operator entrypoint without changing HOME or live files.
  writeFileSync(
    preload,
    `import os from "node:os";import {syncBuiltinESMExports} from "node:module";os.homedir=()=>${JSON.stringify(root)};syncBuiltinESMExports();`,
  );
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: `--import=${preload}` };
  delete env.THINGS_EXECUTOR_LOCK_FD;
  const operator = resolve("src/operator.ts");
  return { root, launcher, journalPath, lockPath, env, operator };
}

test("operator rejects spoofed lock environment and independent descriptors while service holds lock", async (t) => {
  const f = fixture(t);
  const journal = new Journal(f.journalPath);
  journal.close();
  const holder = spawn(
    f.launcher,
    [f.lockPath, process.execPath, "-e", 'console.log("ready");setInterval(()=>{},1000)'],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(() => holder.kill("SIGKILL"));
  await once(holder.stdout, "data");
  const invoke = (env = f.env) =>
    spawnSync(process.execPath, [f.operator, "retention"], { env, encoding: "utf8" });
  assert.equal(invoke().status, 73);
  const invalid = invoke({ ...f.env, THINGS_EXECUTOR_LOCK_FD: "99999" });
  assert.notEqual(invalid.status, 0);
  assert.doesNotMatch(invalid.stdout, /Retention complete/);
  const independentFd = openSync(f.lockPath, "r+");
  try {
    const forged = spawnSync(process.execPath, [f.operator, "retention"], {
      env: { ...f.env, THINGS_EXECUTOR_LOCK_FD: "3" },
      stdio: ["ignore", "pipe", "pipe", independentFd],
      encoding: "utf8",
    });
    assert.notEqual(
      forged.status,
      0,
      "same inode with a separately opened descriptor cannot borrow the service lock",
    );
  } finally {
    closeSync(independentFd);
  }
  const exited = once(holder, "exit");
  holder.kill("SIGKILL");
  await exited;
  const permitted = invoke();
  assert.equal(permitted.status, 0, permitted.stderr);
  assert.match(permitted.stdout, /Retention complete/);
});

test("backup refuses absent and truncated journals instead of silently creating dedupe state", (t) => {
  const f = fixture(t);
  for (const state of ["missing", "truncated"] as const) {
    if (state === "truncated") writeFileSync(f.journalPath, "", { mode: 0o600 });
    const backup = join(f.root, `${state}-backup.sqlite`);
    const result = spawnSync(process.execPath, [f.operator, "backup", backup], {
      env: f.env,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0, `${state} journal must fail closed`);
    assert.equal(existsSync(backup), false);
    if (state === "missing") assert.equal(existsSync(f.journalPath), false);
  }
  assert.throws(() => new Journal(f.journalPath, true), /journal_schema_missing/);
});

test("require-existing journal refuses missing safety tables", (t) => {
  const f = fixture(t);
  const journal = new Journal(f.journalPath);
  journal.db.exec("DROP TABLE stages");
  journal.close();
  assert.throws(() => new Journal(f.journalPath, true), /no such table: stages/);
});

test("restore refuses a valid backup when the current journal is missing", (t) => {
  const f = fixture(t);
  const backupPath = join(f.root, "valid-backup.sqlite");
  const backup = new Journal(backupPath);
  backup.close();
  const result = spawnSync(process.execPath, [f.operator, "restore", backupPath], {
    env: f.env,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.equal(
    existsSync(f.journalPath),
    false,
    "restore cannot infer missing post-backup tombstones",
  );
});
