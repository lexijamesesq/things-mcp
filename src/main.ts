import { fstatSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Trust } from "./assertion.ts";
import { exact, Fault, text } from "./contract.ts";
import { httpServer } from "./http.ts";
import { Journal } from "./journal.ts";
import { verifyLock } from "./lock.ts";
import { Native } from "./native.ts";
import { Service } from "./service.ts";

process.umask(0o077);
const configPath = process.argv[2];
if (!configPath || !isAbsolute(configPath)) throw new Fault("absolute_config_path_required");
const st = statSync(configPath);
if (st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) throw new Fault("config_permissions");
const config = JSON.parse(readFileSync(configPath, "utf8"));
exact(config, [
  "port",
  "timezone",
  "journal",
  "nativePath",
  "trust",
  "hosts",
  "origins",
  "originPath",
]);
for (const name of ["timezone", "journal", "nativePath", "originPath"]) text(config[name], 4096);
const timezone = config.timezone as string;
new Intl.DateTimeFormat("en-US", { timeZone: timezone });
if (!isAbsolute(config.journal as string) || !isAbsolute(config.nativePath as string))
  throw new Fault("absolute_path_required");
if (
  !Number.isInteger(config.port) ||
  (config.port as number) < 1024 ||
  (config.port as number) > 65535
)
  throw new Fault("invalid_port");
if (
  !Array.isArray(config.hosts) ||
  !config.hosts.every((h) => typeof h === "string") ||
  !Array.isArray(config.origins) ||
  !config.origins.every((h) => typeof h === "string")
)
  throw new Fault("invalid_hosts");
exact(config.trust, ["issuer", "audience", "owner", "keys"]);
for (const name of ["issuer", "audience", "owner"]) text(config.trust[name]);
if (!config.trust.keys || typeof config.trust.keys !== "object" || Array.isArray(config.trust.keys))
  throw new Fault("invalid_trust");
const lockFd = Number(process.env.THINGS_EXECUTOR_LOCK_FD);
if (!Number.isInteger(lockFd) || lockFd < 3 || !fstatSync(lockFd).isFile())
  throw new Fault("executor_lock_required");
const journalPath = resolve(config.journal as string);
verifyLock(
  join(dirname(config.nativePath as string), "Things MCP"),
  join(dirname(journalPath), "executor.lock"),
);
mkdirSync(dirname(journalPath), { recursive: true, mode: 0o700 });
const journal = new Journal(journalPath, true);
journal.expire();
const retentionTimer = setInterval(() => {
  try {
    journal.expire();
  } catch {
    // Stop admitting work if journal maintenance cannot be completed safely.
    service.accepting = false;
    console.error(JSON.stringify({ event: "journal_maintenance_failed" }));
  }
}, 3600000);
retentionTimer.unref();
// Narrow write surface qualified by installed fixture acceptance and independent
// runtime/auth review. Field-level capabilities still exclude unverified features.
const writesEnabled = true;
const service = new Service(
  journal,
  new Native(config.nativePath as string),
  timezone,
  writesEnabled,
);
const server = httpServer(
  service,
  config.trust as Trust,
  config.hosts,
  config.origins,
  config.originPath as string,
);
server.listen(config.port as number, "127.0.0.1", () =>
  console.log(JSON.stringify({ event: "listening", port: config.port, writes: writesEnabled })),
);
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  service.accepting = false;
  clearInterval(retentionTimer);
  server.close(() => {
    void service.queue.drain().then(() => {
      journal.close();
      process.exit(0);
    });
  });
  setTimeout(() => process.exit(1), 30000).unref();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
