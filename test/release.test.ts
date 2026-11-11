import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "vitest";
import { artifactHashes } from "../src/artifact.ts";
import { activateRelease } from "../src/release.ts";

function fixture(t: TestContext) {
  const base = mkdtempSync(join(tmpdir(), "things-release-validation-"));
  t.onTestFinished(() => rmSync(base, { recursive: true, force: true }));
  function release(name: string) {
    const directory = join(base, "releases", name);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const files: Record<string, string> = {
      "src/main.ts": `// ${name} main`,
      "src/operator.ts": `console.log(JSON.stringify({release:${JSON.stringify(name)},args:process.argv.slice(2),label:process.env.THINGS_SERVICE_LABEL}));`,
      "src/contract.ts": `// ${name} contract`,
      "build/things-bridge": "qualified bridge",
      "build/Things MCP": "qualified launcher",
      "package.json": JSON.stringify({ name: "things-mcp", type: "module" }),
      "package-lock.json": "{}",
    };
    for (const [path, contents] of Object.entries(files)) {
      const target = join(directory, path);
      mkdirSync(join(target, ".."), { recursive: true, mode: 0o700 });
      writeFileSync(target, contents, { mode: 0o600 });
    }
    mkdirSync(join(directory, "node_modules/example"), { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, "node_modules/example/index.js"), "export default 'original';");
    writeFileSync(
      join(directory, "release.json"),
      JSON.stringify({
        name,
        node: process.version,
        journalSchema: 1,
        hashes: artifactHashes(directory),
      }),
      { mode: 0o600 },
    );
    return directory;
  }
  const old = release("old"),
    next = release("next");
  const config = { nativePath: join(old, "build/things-bridge") };
  const plist = join(base, "service.plist");
  const job = {
    Label: "test.things-mcp",
    ProgramArguments: [
      join(old, "build/Things MCP"),
      join(base, "executor.lock"),
      process.execPath,
      join(old, "src/main.ts"),
      join(base, "config.json"),
    ],
  };
  const converted = spawnSync("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", "--", "-"], {
    input: JSON.stringify(job),
    encoding: "utf8",
  });
  assert.equal(converted.status, 0);
  writeFileSync(plist, converted.stdout, { mode: 0o600 });
  writeFileSync(join(base, "config.json"), "trust configuration sentinel", { mode: 0o600 });
  writeFileSync(join(base, "journal.sqlite"), "journal sentinel", { mode: 0o600 });
  return { base, old, next, config, plist };
}

test("activation switches both runtime pointers and preserves rollback across a retry", (t) => {
  const { base, old, next, config, plist } = fixture(t);
  const before = readFileSync(join(old, "build/things-bridge"), "utf8");
  const selectedMain = (path: string) => {
    const result = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0);
    return JSON.parse(result.stdout).ProgramArguments[3];
  };
  const selectedOperator = () => {
    const result = spawnSync(join(base, "things"), ["status"], { encoding: "utf8" });
    assert.equal(result.status, 0);
    return JSON.parse(result.stdout);
  };
  const previous = join(base, "previous-activation.plist");
  activateRelease(base, "next", config, plist);
  assert.equal(selectedMain(plist), join(next, "src/main.ts"));
  assert.deepEqual(selectedOperator(), {
    release: "next",
    args: ["status"],
    label: "test.things-mcp",
  });
  assert.equal(selectedMain(previous), join(old, "src/main.ts"));
  // An interrupted activation can be retried after the plist already switched.
  // Retrying the same target must not lose the prior runtime pointer.
  activateRelease(base, "next", config, plist);
  assert.equal(selectedMain(previous), join(old, "src/main.ts"));
  activateRelease(base, "old", config, plist);
  assert.equal(selectedMain(plist), join(old, "src/main.ts"));
  assert.deepEqual(selectedOperator(), {
    release: "old",
    args: ["status"],
    label: "test.things-mcp",
  });
  assert.equal(selectedMain(previous), join(next, "src/main.ts"));
  assert.equal(readFileSync(join(old, "build/things-bridge"), "utf8"), before);
  assert.equal(readFileSync(join(base, "config.json"), "utf8"), "trust configuration sentinel");
  assert.equal(readFileSync(join(base, "journal.sqlite"), "utf8"), "journal sentinel");
});

test("activation rejects a changed runtime dependency before altering installed files", (t) => {
  const { base, next, config, plist } = fixture(t);
  const before = readFileSync(plist, "utf8");
  writeFileSync(join(next, "node_modules/example/index.js"), "export default 'tampered';");
  assert.throws(
    () => activateRelease(base, "next", config, plist),
    /release_changed|invalid_release/,
  );
  assert.equal(readFileSync(plist, "utf8"), before);
});

test("failed activation leaves original native executable and launch configuration intact", (t) => {
  const { base, old, config, plist } = fixture(t);
  const originalBinary = readFileSync(config.nativePath, "utf8");
  const originalPlist = readFileSync(plist, "utf8");
  mkdirSync(`${plist}.next`, { mode: 0o700 });
  assert.throws(() => activateRelease(base, "next", config, plist));
  assert.equal(readFileSync(join(old, "build/things-bridge"), "utf8"), originalBinary);
  assert.equal(readFileSync(plist, "utf8"), originalPlist);
});

test("operator-wrapper staging failure cannot leave the LaunchAgent switched", (t) => {
  const { base, config, plist } = fixture(t);
  const originalPlist = readFileSync(plist, "utf8");
  mkdirSync(join(base, "things.next"), { mode: 0o700 });
  assert.throws(() => activateRelease(base, "next", config, plist));
  assert.equal(readFileSync(plist, "utf8"), originalPlist);
});

test("activation rejects a correctly inventoried but unqualified native binary", (t) => {
  const { base, next, config, plist } = fixture(t);
  const before = readFileSync(plist, "utf8");
  writeFileSync(join(next, "build/things-bridge"), "new native executable");
  const manifestPath = join(next, "release.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.hashes = artifactHashes(next);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(
    () => activateRelease(base, "next", config, plist),
    /native_upgrade_requires_qualification/,
  );
  assert.equal(readFileSync(plist, "utf8"), before);
  assert.equal(readFileSync(config.nativePath, "utf8"), "qualified bridge");
});

test("runtime symlinks cannot hide executable dependencies outside inventoried roots", (t) => {
  const { next } = fixture(t);
  mkdirSync(join(next, "vendor"), { mode: 0o700 });
  writeFileSync(join(next, "vendor/untracked.js"), "export default 'not inventoried';");
  symlinkSync("../../vendor/untracked.js", join(next, "node_modules/example/hidden.js"));
  assert.throws(
    () => artifactHashes(next),
    /external_runtime_symlink|uninventoried_runtime_symlink/,
  );
});

test("runtime inventory accepts internal npm-style links and covers their target bytes", (t) => {
  const { next } = fixture(t);
  mkdirSync(join(next, "node_modules/.bin"), { mode: 0o700 });
  symlinkSync("../example/index.js", join(next, "node_modules/.bin/example"));
  const before = artifactHashes(next);
  assert.ok(before["node_modules/.bin/example"]);
  writeFileSync(join(next, "node_modules/example/index.js"), "export default 'changed target';");
  const after = artifactHashes(next);
  assert.notEqual(after["node_modules/example/index.js"], before["node_modules/example/index.js"]);
});

test("activation rejects incompatible Node or journal versions without changing pointers", (t) => {
  const { base, next, config, plist } = fixture(t);
  const before = readFileSync(plist, "utf8");
  const manifestPath = join(next, "release.json");
  const original = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const incompatible of [
    { ...original, node: "v0.0.0" },
    { ...original, journalSchema: 999 },
  ]) {
    writeFileSync(manifestPath, JSON.stringify(incompatible));
    assert.throws(() => activateRelease(base, "next", config, plist), /release_incompatible/);
    assert.equal(readFileSync(plist, "utf8"), before);
  }
});
