import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { artifactHashes, fileHash } from "./artifact.ts";
import { Fault } from "./contract.ts";

export function activateRelease(
  base: string,
  name: string,
  config: { nativePath: string },
  plist: string,
) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(name)) throw new Fault("invalid_release");
  const release = join(base, "releases", name);
  const st = statSync(release);
  if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0)
    throw new Fault("release_permissions");
  const manifest = JSON.parse(readFileSync(join(release, "release.json"), "utf8"));
  if (manifest.name !== name || manifest.node !== process.version || manifest.journalSchema !== 1)
    throw new Fault("release_incompatible");
  const hashes = artifactHashes(release);
  if (
    !manifest.hashes ||
    Object.keys(hashes).length !== Object.keys(manifest.hashes).length ||
    Object.entries(hashes).some(([path, hash]) => manifest.hashes[path] !== hash)
  )
    throw new Fault("release_changed");
  for (const path of ["src/main.ts", "src/operator.ts", "build/things-bridge", "build/Things MCP"])
    if (!Object.hasOwn(hashes, path)) throw new Fault("invalid_release");
  // Ordinary activation changes the JS runtime only. Native upgrades require an
  // explicit installation qualification; never mutate an immutable old release.
  for (const binary of ["things-bridge", "Things MCP"]) {
    const current = fileHash(join(dirname(config.nativePath), binary));
    if (current !== hashes[`build/${binary}`])
      throw new Fault("native_upgrade_requires_qualification");
  }
  const read = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist], {
    encoding: "utf8",
  });
  if (read.status !== 0) throw new Fault("launchagent_unreadable");
  const job = JSON.parse(read.stdout);
  if (job.ProgramArguments[2] !== process.execPath) throw new Fault("node_identity_mismatch");
  const changingRelease = job.ProgramArguments[3] !== join(release, "src/main.ts");
  job.ProgramArguments[3] = join(release, "src/main.ts");
  const output = spawnSync("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", "--", "-"], {
    input: JSON.stringify(job),
    encoding: "utf8",
  });
  if (output.status !== 0) throw new Fault("launchagent_invalid");
  const cli = join(base, "things"),
    previous = join(base, "previous-activation.plist");
  const oldPlist = readFileSync(plist),
    oldCli = existsSync(cli) ? readFileSync(cli) : null;
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  // Complete both staging writes before changing either active file.
  writeFileSync(`${plist}.next`, output.stdout, { mode: 0o600 });
  writeFileSync(
    `${cli}.next`,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(release, "src/operator.ts"))} "$@"\n`,
    { mode: 0o700 },
  );
  if (changingRelease) {
    copyFileSync(plist, previous);
    chmodSync(previous, 0o600);
  }
  try {
    renameSync(`${plist}.next`, plist);
    renameSync(`${cli}.next`, cli);
  } catch (error) {
    writeFileSync(plist, oldPlist, { mode: 0o600 });
    if (oldCli) writeFileSync(cli, oldCli, { mode: 0o700 });
    throw error;
  }
  return {
    release: name,
    service: "stopped",
    journalPreserved: true,
    next: "Run things start; verify authenticated readiness before use",
  };
}
