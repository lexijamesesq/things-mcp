import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { Fault } from "./contract.ts";

export function artifactHashes(root: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  const actualRoot = realpathSync(root);
  function collect(path: string) {
    const file = join(root, path);
    const stat = lstatSync(file);
    if (stat.isDirectory()) {
      for (const name of readdirSync(file).sort()) collect(join(path, name));
      return;
    }
    const digest = createHash("sha256");
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(file),
        resolved = relative(actualRoot, realpathSync(file));
      const inventoriedTarget =
        ["src", "build", "node_modules"].some(
          (prefix) => resolved === prefix || resolved.startsWith(`${prefix}/`),
        ) || ["package.json", "package-lock.json"].includes(resolved);
      if (
        isAbsolute(target) ||
        resolved.startsWith("..") ||
        isAbsolute(resolved) ||
        !inventoriedTarget
      )
        throw new Fault("external_runtime_symlink");
      digest.update("link\0").update(target);
    } else if (stat.isFile()) digest.update("file\0").update(readFileSync(file));
    else throw new Fault("invalid_runtime_file");
    hashes[path] = digest.digest("hex");
  }
  for (const path of ["src", "build", "node_modules", "package.json", "package-lock.json"])
    collect(path);
  return hashes;
}
