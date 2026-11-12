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
import { type TestContext, test } from "vitest";
import { Journal } from "../src/journal.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "things-operator-test-"));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const base = join(root, "Library/Application Support/ThingsMCP");
  mkdirSync(join(base, "custom-state"), { recursive: true });
  mkdirSync(join(base, "releases/test-version/build"), { recursive: true });
  const launcher = join(base, "releases/test-version/build/Things MCP");
  symlinkSync(resolve("build/Things MCP"), launcher);
  const journalPath = join(base, "custom-state/journal.sqlite");
  const lockPath = join(base, "custom-state/executor.lock");
  writeFileSync(
    join(base, "config.json"),
    JSON.stringify({
      journal: journalPath,
      timezone: "America/Phoenix",
      nativePath: join(base, "releases/test-version/build/things-bridge"),
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
  t.onTestFinished(() => {
    holder.kill("SIGKILL");
  });
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

test("reconciliation reads the retained task using the configured timezone without redispatch", (t) => {
  const f = fixture(t);
  const journal = new Journal(f.journalPath);
  const principal = {
    owner: "fixture",
    client: "client",
    grant: "grant",
    scopes: ["things.create"],
  };
  const operationId = "019a7234-4580-7000-8000-000000000001";
  journal.claim(principal, operationId, { tool: "things_create" }, ["things.create"]);
  journal.finish(principal.owner, operationId, "uncertain", { id: "retained-task" });
  journal.close();
  const helper = join(
    f.root,
    "Library/Application Support/ThingsMCP/releases/test-version/build/things-bridge",
  );
  writeFileSync(
    helper,
    `#!${process.execPath}
let input="";process.stdin.on("data",part=>input+=part);process.stdin.on("end",()=>{
const r=JSON.parse(input);
console.log(JSON.stringify(r.operation==="get"&&r.id==="retained-task"&&r.timezone==="America/Phoenix"
?{ok:true,dispatched:true,result:{id:r.id,start:"2032-02-29",deadline:null}}
:{ok:false,dispatched:false,error:"invalid_argument"}));});`,
    { mode: 0o700 },
  );
  const result = spawnSync(process.execPath, [f.operator, "reconcile", operationId], {
    env: f.env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.reconciled, true);
  assert.equal(observed.outcome, "uncertain");
  assert.equal(observed.provesOriginalEffect, false);
  assert.equal(observed.current.result.start, "2032-02-29");
});
