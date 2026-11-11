import { statSync } from "node:fs";
import Database from "better-sqlite3";
import { Fault } from "./contract.ts";
import type { Journal } from "./journal.ts";

// Union operation identities; never replace the live journal with an older file.
// All restored retryable/nonterminal outcomes become uncertain, never replayable.
export function mergeBackup(journal: Journal, backupPath: string, owner: string) {
  const st = statSync(backupPath);
  if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0)
    throw new Fault("backup_permissions");
  const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    if (
      backup.pragma("user_version", { simple: true }) !== 1 ||
      backup.pragma("quick_check", { simple: true }) !== "ok"
    )
      throw new Fault("backup_invalid");
    const rows = backup.prepare("SELECT * FROM operations").all() as Record<
      string,
      string | number | null
    >[];
    return journal.db.transaction(() => {
      let inserted = 0;
      for (const row of rows) {
        if (row.owner !== owner) throw new Fault("backup_owner_mismatch");
        const current = journal.db
          .prepare(
            "SELECT request_hash,client,scopes FROM operations WHERE owner=? AND operation_id=?",
          )
          .get(row.owner, row.operation_id) as
          | { request_hash: string; client: string; scopes: string }
          | undefined;
        if (current) {
          if (
            current.request_hash !== row.request_hash ||
            current.client !== row.client ||
            current.scopes !== row.scopes
          )
            throw new Fault("backup_collision");
          if (row.expired)
            journal.db
              .prepare(
                "UPDATE operations SET expired=1,result=NULL WHERE owner=? AND operation_id=?",
              )
              .run(row.owner, row.operation_id);
          continue;
        }
        const state = ["claimed", "queued", "dispatching", "not_dispatched"].includes(
          String(row.state),
        )
          ? "uncertain"
          : row.state;
        if (!["applied", "conflict", "partial", "failed", "uncertain"].includes(String(state)))
          throw new Fault("backup_invalid");
        journal.db
          .prepare(
            "INSERT INTO operations(owner,operation_id,client,grant_id,scopes,request_hash,state,created,updated,result,expired) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            row.owner,
            row.operation_id,
            row.client,
            row.grant_id,
            row.scopes,
            row.request_hash,
            state,
            row.created,
            row.updated,
            row.expired ? null : row.result,
            row.expired,
          );
        inserted++;
      }
      const stages = backup
        .prepare("SELECT owner,operation_id,number,state,result FROM stages")
        .all() as Record<string, string | number | null>[];
      for (const stage of stages) {
        if (
          stage.owner !== owner ||
          !Number.isInteger(stage.number) ||
          Number(stage.number) < 0 ||
          !["dispatching", "applied", "not_dispatched", "uncertain"].includes(String(stage.state))
        )
          throw new Fault("backup_invalid");
        const parent = journal.db
          .prepare("SELECT expired FROM operations WHERE owner=? AND operation_id=?")
          .get(stage.owner, stage.operation_id) as { expired: number } | undefined;
        if (!parent) throw new Fault("backup_invalid");
        journal.db
          .prepare(
            "INSERT OR IGNORE INTO stages(owner,operation_id,number,state,result) VALUES(?,?,?,?,?)",
          )
          .run(
            stage.owner,
            stage.operation_id,
            stage.number,
            stage.state,
            parent.expired ? null : stage.result,
          );
      }
      journal.db.exec(
        "UPDATE stages SET result=NULL WHERE EXISTS (SELECT 1 FROM operations o WHERE o.owner=stages.owner AND o.operation_id=stages.operation_id AND o.expired=1)",
      );
      // Even a currently undispatched outcome may have an unknown later history
      // in a restore scenario. Preserve its identity but require reconciliation.
      const guarded = journal.db
        .prepare(
          "UPDATE operations SET state='uncertain' WHERE state IN ('claimed','queued','dispatching','not_dispatched')",
        )
        .run().changes;
      return { inserted, preserved: rows.length - inserted, guarded };
    })();
  } finally {
    backup.close();
  }
}
