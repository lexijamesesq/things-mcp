import { spawnSync } from "node:child_process";
import { Fault } from "./contract.ts";

export function verifyLock(launcher: string, lockPath: string) {
  const fd = Number(process.env.THINGS_EXECUTOR_LOCK_FD);
  if (!Number.isInteger(fd) || fd < 3) throw new Fault("executor_lock_required");
  // Pass the inherited open-file description, not a newly opened lock file.
  // The native verifier checks inode, owner, permissions and nonblocking flock.
  const result = spawnSync(launcher, ["--verify-lock", lockPath, "3"], {
    stdio: ["ignore", "ignore", "ignore", fd],
    shell: false,
  });
  if (result.error || result.status !== 0) throw new Fault("executor_lock_required");
}
