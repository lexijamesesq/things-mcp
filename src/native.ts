import { spawn } from "node:child_process";
import { Fault } from "./contract.ts";
export type NativeReply = {
  ok: boolean;
  dispatched: boolean;
  result?: Record<string, unknown>;
  error?: string;
  nativeCode?: number;
};
export class Native {
  path: string;
  constructor(path: string) {
    this.path = path;
  }
  call(request: Record<string, unknown>): Promise<NativeReply> {
    return new Promise((resolve, reject) => {
      // Keep the same kernel lock alive until a dispatched helper exits, even if
      // the executor is killed. A replacement executor must wait for that helper.
      const lockFd = Number(process.env.THINGS_EXECUTOR_LOCK_FD);
      const inheritedLock = Number.isInteger(lockFd) && lockFd >= 3 ? [lockFd] : [];
      const child = spawn(this.path, [], {
        stdio: ["pipe", "pipe", "pipe", ...inheritedLock],
        shell: false,
      });
      const { stdin, stdout, stderr } = child;
      if (!stdin || !stdout || !stderr) {
        child.kill("SIGKILL");
        reject(new Fault("native_unavailable"));
        return;
      }
      let size = 0;
      const output: Buffer[] = [];
      let failure: string | undefined;
      const timer = setTimeout(() => {
        failure = "native_timeout";
        child.kill("SIGKILL");
      }, 10000);
      child.on("error", () => {
        clearTimeout(timer);
        reject(new Fault("native_unavailable"));
      });
      stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1048576) {
          failure = "native_output_limit";
          child.kill("SIGKILL");
        } else output.push(chunk);
      });
      stderr.on("data", () => {});
      child.on("close", () => {
        clearTimeout(timer);
        if (failure) {
          reject(new Fault(failure));
          return;
        }
        try {
          const r = JSON.parse(Buffer.concat(output).toString("utf8"));
          if (
            typeof r.ok !== "boolean" ||
            typeof r.dispatched !== "boolean" ||
            (r.ok && (!r.result || typeof r.result !== "object"))
          )
            throw 0;
          resolve(r);
        } catch {
          reject(new Fault("invalid_native_output"));
        }
      });
      stdin.on("error", () => {});
      stdin.end(JSON.stringify(request));
    });
  }
}
