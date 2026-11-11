import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import Database from "better-sqlite3";
import { Journal } from "./journal.ts";
import { verifyLock } from "./lock.ts";
import { Native } from "./native.ts";
import { activateRelease } from "./release.ts";
import { mergeBackup } from "./restore.ts";

process.umask(0o077);
const base = join(homedir(), "Library/Application Support/ThingsMCP");
const configPath = join(base, "config.json");
const serviceLabel = process.env.THINGS_SERVICE_LABEL ?? "org.things-mcp.service";
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(serviceLabel))
  throw new Error("invalid_service_label");
const plist = join(homedir(), "Library/LaunchAgents", `${serviceLabel}.plist`);
const domain = `gui/${process.getuid?.()}`;
const label = `${domain}/${serviceLabel}`;
const [command, argument] = process.argv.slice(2);
function run(executable: string, args: string[]) {
  const result = spawnSync(executable, args, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
if (command === "start") run("/bin/launchctl", ["bootstrap", domain, plist]);
if (command === "stop") run("/bin/launchctl", ["bootout", label]);
if (command === "status") run("/bin/launchctl", ["print", label]);
if (command === "logs")
  run("/usr/bin/tail", ["-n", "80", join(base, "logs/service.log"), join(base, "logs/error.log")]);
const st = statSync(configPath);
if (st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) throw new Error("config_permissions");
const config = JSON.parse(readFileSync(configPath, "utf8"));
if (command === "doctor") {
  const db = new Database(config.journal, { readonly: true, fileMustExist: true });
  try {
    const check = db.pragma("quick_check", { simple: true });
    const service = spawnSync("/bin/launchctl", ["print", label], { encoding: "utf8" });
    console.log(
      JSON.stringify(
        {
          configuration: "owner_only",
          journal: check === "ok" ? "healthy" : "check_failed",
          launchAgent: service.status === 0 ? "loaded" : "not_loaded",
          nativeExecutable: existsSync(config.nativePath),
          writeReadiness: "Use authenticated things_status for live readiness",
          nativeReadiness:
            "Use authenticated things_status for the actual service Automation identity",
        },
        null,
        2,
      ),
    );
  } finally {
    db.close();
  }
} else if (["retention", "backup", "reconcile", "restore", "activate"].includes(command)) {
  // Maintenance is exclusive with the service and surviving native helpers.
  if (!process.env.THINGS_EXECUTOR_LOCK_FD) {
    run(join(dirname(config.nativePath), "Things MCP"), [
      join(dirname(config.journal), "executor.lock"),
      process.execPath,
      process.argv[1],
      command,
      ...(argument ? [argument] : []),
    ]);
  }
  verifyLock(
    join(dirname(config.nativePath), "Things MCP"),
    join(dirname(config.journal), "executor.lock"),
  );
  const journal = new Journal(config.journal, true);
  try {
    if (command === "activate") {
      if (!argument) throw new Error("release_name_required");
      console.log(JSON.stringify(activateRelease(base, argument, config, plist)));
    }
    if (command === "restore") {
      if (!argument || !isAbsolute(argument) || argument === config.journal)
        throw new Error("separate_absolute_backup_path_required");
      console.log(JSON.stringify(mergeBackup(journal, argument, config.trust.owner)));
      journal.expire();
    }
    if (command === "retention") {
      journal.expire();
      console.log("Retention complete; operation tombstones preserved.");
    }
    if (command === "backup") {
      if (!argument || !isAbsolute(argument) || existsSync(argument))
        throw new Error("new_absolute_backup_path_required");
      await journal.db.backup(argument);
      chmodSync(argument, 0o600);
      console.log("Consistent journal backup created; includes operation tombstones.");
    }
    if (command === "reconcile") {
      if (!argument) throw new Error("operation_id_required");
      const row = journal.db
        .prepare("SELECT state,result,expired FROM operations WHERE owner=? AND operation_id=?")
        .get(config.trust.owner, argument) as
        | { state: string; result: string | null; expired: number }
        | undefined;
      if (!row || row.expired || !row.result) throw new Error("no_retained_known_id");
      const result = JSON.parse(row.result);
      if (typeof result.id !== "string") throw new Error("no_known_native_id");
      const reply = await new Native(config.nativePath).call({ operation: "get", id: result.id });
      // This is current state only, never attribution or permission to redispatch.
      console.log(
        JSON.stringify(
          {
            operationId: argument,
            outcome: row.state,
            reconciled: reply.ok,
            provesOriginalEffect: false,
            current: reply,
          },
          null,
          2,
        ),
      );
    }
  } finally {
    journal.close();
  }
} else {
  throw new Error(
    "usage: things status|start|stop|logs|doctor|retention|backup ABSOLUTE_NEW_PATH|restore ABSOLUTE_BACKUP_PATH|reconcile OPERATION_ID|activate RELEASE",
  );
}
