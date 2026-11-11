// Explicit local installation command. Never reachable through an MCP tool.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const child = spawn(config.nativePath, ["--authorize-setup"], {
  stdio: ["pipe", "inherit", "inherit"],
  shell: false,
});
child.stdin.end(JSON.stringify({ operation: "status" }));
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
