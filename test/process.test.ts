import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { Journal } from "../src/journal.ts";

test("abrupt death preserves committed dispatch evidence and never authorizes replay", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "things-crash-"));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "journal.sqlite");
  const principal = { owner: "o", client: "c", grant: "g", scopes: ["things.create"] };
  const id = "f3dc661d-6867-40f7-8277-af1a176774ef";
  const source = `import {Journal} from ${JSON.stringify(new URL("../src/journal.ts", import.meta.url).href)};
    const j=new Journal(${JSON.stringify(path)}), p=${JSON.stringify(principal)};
    j.claim(p,${JSON.stringify(id)},{},p.scopes);j.dispatch(p.owner,${JSON.stringify(id)},0);
    j.evidence(p.owner,${JSON.stringify(id)},0,{id:"observed-native-id"});
    console.log("ready");setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.onTestFinished(() => {
    child.kill("SIGKILL");
  });
  await once(child.stdout, "data");
  const stopped = once(child, "exit");
  child.kill("SIGKILL");
  await stopped;
  const j = new Journal(path);
  t.onTestFinished(() => j.close());
  j.recover();
  assert.equal(j.lookup(principal, id)?.outcome, "uncertain");
  assert.deepEqual(j.lookup(principal, id)?.result, { id: "observed-native-id" });
  assert.equal(j.claim(principal, id, {}, principal.scopes).fresh, false);
});

test("a surviving native helper retains the executor lock until it exits", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "things-orphan-lock-"));
  const readyPath = join(dir, "helper-ready");
  const releasePath = join(dir, "release-helper");
  const helperPath = join(dir, "helper.mjs");
  const lockPath = join(dir, "executor.lock");
  const launcher = resolve("build/Things MCP");
  writeFileSync(
    helperPath,
    `#!${process.execPath}
import {existsSync,writeFileSync} from "node:fs";
writeFileSync(${JSON.stringify(readyPath)},String(process.pid));
setInterval(()=>{if(existsSync(${JSON.stringify(releasePath)}))process.exit(0);},10);
`,
    { mode: 0o700 },
  );
  const source = `import {Native} from ${JSON.stringify(new URL("../src/native.ts", import.meta.url).href)};
await new Native(${JSON.stringify(helperPath)}).call({operation:"fake"});`;
  const executor = spawn(
    launcher,
    [lockPath, process.execPath, "--input-type=module", "-e", source],
    { stdio: "ignore" },
  );
  let helperPid: number | undefined;
  t.onTestFinished(() => {
    executor.kill("SIGKILL");
    if (helperPid) {
      try {
        process.kill(helperPid, "SIGKILL");
      } catch {
        /* Already exited. */
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const deadline = Date.now() + 5000;
  while (!existsSync(readyPath) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(existsSync(readyPath), "fake native helper started");
  helperPid = Number(readFileSync(readyPath, "utf8"));
  const stopped = once(executor, "exit");
  executor.kill("SIGKILL");
  await stopped;
  assert.doesNotThrow(() => process.kill(helperPid as number, 0), "helper survives executor death");
  const replacement = () =>
    spawnSync(launcher, [lockPath, process.execPath, "-e", "process.exit(0)"]).status;
  assert.equal(replacement(), 73, "replacement cannot overlap a surviving helper");
  writeFileSync(releasePath, "exit");
  const releaseDeadline = Date.now() + 5000;
  let status = replacement();
  while (status === 73 && Date.now() < releaseDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    status = replacement();
  }
  assert.equal(status, 0, "helper exit releases the inherited lock for a replacement");
  helperPid = undefined;
});
