// Package a checked local candidate; no service or credential changes.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactHashes, RUNTIME_PATHS } from "../src/artifact.ts";

process.umask(0o077);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const name = process.argv[2];
if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(name))
  throw new Error("release_name_required");
if (execFileSync("/usr/bin/git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim())
  throw new Error("commit_candidate_before_packaging");
const destination = join(homedir(), "Library/Application Support/ThingsMCP/releases", name);
if (existsSync(destination)) throw new Error("release_already_exists");
mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
const staging = `${destination}.staging`;
mkdirSync(staging, { recursive: false, mode: 0o700 });
for (const path of RUNTIME_PATHS)
  cpSync(join(root, path), join(staging, path), {
    recursive: true,
    errorOnExist: true,
    force: false,
    verbatimSymlinks: true,
  });
const hashes = artifactHashes(staging);
writeFileSync(
  join(staging, "release.json"),
  JSON.stringify(
    {
      name,
      commit: execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      node: process.version,
      journalSchema: 1,
      hashes,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
renameSync(staging, destination);
console.log(JSON.stringify({ release: name, path: destination }));
