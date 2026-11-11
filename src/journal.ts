import { chmodSync } from "node:fs";
import Database from "better-sqlite3";
import { authorize, Fault, hash, type Principal, uuid } from "./contract.ts";
export type State =
  | "claimed"
  | "queued"
  | "dispatching"
  | "applied"
  | "conflict"
  | "partial"
  | "failed"
  | "uncertain"
  | "not_dispatched";
type Row = {
  owner: string;
  operation_id: string;
  client: string;
  grant_id: string;
  scopes: string;
  request_hash: string;
  state: State;
  updated: number;
  result: string | null;
  expired: number;
};
export class Journal {
  db: Database.Database;
  constructor(path: string, mustExist = false) {
    this.db = new Database(path, { fileMustExist: mustExist });
    chmodSync(path, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("busy_timeout = 5000");
    const version = this.db.pragma("user_version", { simple: true });
    if (version !== 0 && version !== 1) throw new Fault("journal_schema_unsupported");
    if (mustExist) {
      if (version !== 1) throw new Fault("journal_schema_missing");
      this.db
        .prepare(
          "SELECT owner,operation_id,client,grant_id,scopes,request_hash,state,created,updated,result,expired FROM operations LIMIT 0",
        )
        .all();
      this.db.prepare("SELECT owner,operation_id,number,state,result FROM stages LIMIT 0").all();
      if (this.db.pragma("quick_check", { simple: true }) !== "ok")
        throw new Fault("journal_corrupt");
      return;
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS operations(owner TEXT NOT NULL,operation_id TEXT NOT NULL,client TEXT NOT NULL,grant_id TEXT NOT NULL,scopes TEXT NOT NULL,request_hash TEXT NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,result TEXT,expired INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(owner,operation_id));
  CREATE TABLE IF NOT EXISTS stages(owner TEXT NOT NULL,operation_id TEXT NOT NULL,number INTEGER NOT NULL,state TEXT NOT NULL,result TEXT,PRIMARY KEY(owner,operation_id,number)); PRAGMA user_version=1;`);
  }
  private row(owner: string, id: string) {
    return this.db
      .prepare("SELECT * FROM operations WHERE owner=? AND operation_id=?")
      .get(owner, id) as Row | undefined;
  }
  lookup(p: Principal, id: string, request?: unknown) {
    uuid(id);
    const r = this.row(p.owner, id);
    if (!r) return undefined;
    if (r.client !== p.client) throw new Fault("denied");
    authorize(p, JSON.parse(r.scopes));
    if (request !== undefined && hash(request) !== r.request_hash)
      throw new Fault("operation_id_reused");
    return {
      operationId: id,
      outcome: r.state,
      expired: Boolean(r.expired),
      result: r.expired ? { error: "result_expired" } : r.result ? JSON.parse(r.result) : null,
    };
  }
  claim(p: Principal, id: string, request: unknown, needed: string[]) {
    uuid(id);
    authorize(p, needed);
    return this.db.transaction(() => {
      const old = this.lookup(p, id, request);
      if (old) {
        if (old.expired || old.outcome !== "not_dispatched") return { fresh: false, ...old };
        this.db
          .prepare(
            "UPDATE operations SET state='queued',updated=? WHERE owner=? AND operation_id=?",
          )
          .run(Date.now(), p.owner, id);
        this.db.prepare("DELETE FROM stages WHERE owner=? AND operation_id=?").run(p.owner, id);
        return { fresh: true, ...old, outcome: "queued" as State };
      }
      const now = Date.now();
      this.db
        .prepare(
          "INSERT INTO operations(owner,operation_id,client,grant_id,scopes,request_hash,state,created,updated) VALUES(?,?,?,?,?,?,'queued',?,?)",
        )
        .run(p.owner, id, p.client, p.grant, JSON.stringify(needed), hash(request), now, now);
      return { fresh: true, operationId: id, outcome: "queued" as State, result: null };
    })();
  }
  dispatch(owner: string, id: string, stage: number) {
    this.db.transaction(() => {
      const r = this.row(owner, id);
      if (!r || !["queued"].includes(r.state)) throw new Fault("invalid_transition");
      this.db.prepare("INSERT INTO stages VALUES(?,?,?,'dispatching',NULL)").run(owner, id, stage);
      this.db
        .prepare(
          "UPDATE operations SET state='dispatching',updated=? WHERE owner=? AND operation_id=?",
        )
        .run(Date.now(), owner, id);
    })();
  }
  evidence(owner: string, id: string, stage: number, result: unknown) {
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE stages SET result=? WHERE owner=? AND operation_id=? AND number=? AND state='dispatching'",
        )
        .run(JSON.stringify(result), owner, id, stage);
      this.db
        .prepare(
          "UPDATE operations SET result=?,updated=? WHERE owner=? AND operation_id=? AND state='dispatching'",
        )
        .run(JSON.stringify(result), Date.now(), owner, id);
    })();
  }
  observed(owner: string, id: string, stage: number, result: unknown, more: boolean) {
    this.db.transaction(() => {
      const update = this.db
        .prepare(
          "UPDATE stages SET state='applied',result=? WHERE owner=? AND operation_id=? AND number=? AND state='dispatching'",
        )
        .run(JSON.stringify(result), owner, id, stage);
      if (update.changes !== 1) throw new Fault("invalid_transition");
      this.db
        .prepare(
          "UPDATE operations SET state=?,result=?,updated=? WHERE owner=? AND operation_id=?",
        )
        .run(more ? "queued" : "applied", JSON.stringify(result), Date.now(), owner, id);
    })();
  }
  finish(owner: string, id: string, state: State, result: unknown) {
    if (!["conflict", "partial", "failed", "uncertain", "not_dispatched"].includes(state))
      throw new Fault("invalid_transition");
    this.db
      .prepare("UPDATE operations SET state=?,result=?,updated=? WHERE owner=? AND operation_id=?")
      .run(state, JSON.stringify(result), Date.now(), owner, id);
  }
  recover() {
    this.db.transaction(() => {
      const rows = this.db
        .prepare("SELECT * FROM operations WHERE state IN ('claimed','queued','dispatching')")
        .all() as Row[];
      for (const r of rows) {
        const stages = this.db
          .prepare("SELECT state FROM stages WHERE owner=? AND operation_id=?")
          .all(r.owner, r.operation_id) as { state: string }[];
        const state =
          r.state === "dispatching" || stages.some((s) => s.state === "dispatching")
            ? "uncertain"
            : stages.some((s) => s.state === "applied")
              ? "partial"
              : "not_dispatched";
        this.db
          .prepare("UPDATE operations SET state=?,updated=? WHERE owner=? AND operation_id=?")
          .run(state, Date.now(), r.owner, r.operation_id);
      }
    })();
  }
  expire(now = Date.now()) {
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE operations SET result=NULL,expired=1 WHERE updated<? AND state NOT IN ('claimed','queued','dispatching')",
        )
        .run(now - 7 * 86400000);
      this.db.exec(
        "UPDATE stages SET result=NULL WHERE EXISTS (SELECT 1 FROM operations o WHERE o.owner=stages.owner AND o.operation_id=stages.operation_id AND o.expired=1)",
      );
    })();
  }
  close() {
    this.db.close();
  }
}
export class SerialQueue {
  private count = 0;
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(work: () => Promise<T>, admit: () => void = () => {}): Promise<T> {
    if (this.count >= 32) throw new Fault("overloaded");
    this.count++;
    try {
      admit();
    } catch (error) {
      this.count--;
      throw error;
    }
    const next = this.tail.then(work);
    this.tail = next
      .catch(() => {})
      .finally(() => {
        this.count--;
      });
    return next;
  }
  async drain() {
    await this.tail;
  }
  get size() {
    return this.count;
  }
}
