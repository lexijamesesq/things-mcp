import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { Fault } from "./contract.ts";

export const RUNTIME_PATHS = [
  "src",
  "build",
  "node_modules",
  "package.json",
  "package-lock.json",
] as const;

export function fileHash(path: string): string {
  return createHash("sha256").update("file\0").update(readFileSync(path)).digest("hex");
}

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
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(file),
        resolved = relative(actualRoot, realpathSync(file));
      const inventoriedTarget = RUNTIME_PATHS.some(
        (prefix) => resolved === prefix || resolved.startsWith(`${prefix}/`),
      );
      if (
        isAbsolute(target) ||
        resolved.startsWith("..") ||
        isAbsolute(resolved) ||
        !inventoriedTarget
      )
        throw new Fault("external_runtime_symlink");
      hashes[path] = createHash("sha256").update("link\0").update(target).digest("hex");
    } else if (stat.isFile()) hashes[path] = fileHash(file);
    else throw new Fault("invalid_runtime_file");
  }
  for (const path of RUNTIME_PATHS) collect(path);
  return hashes;
}
