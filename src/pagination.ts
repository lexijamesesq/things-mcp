import { randomBytes } from "node:crypto";
import { canonical, Fault, type Principal } from "./contract.ts";

type Snapshot = {
  owner: string;
  client: string;
  query: string;
  ids: string[];
  position: number;
  expires: number;
  context: string;
};
export class Snapshots {
  private entries = new Map<string, Snapshot>();
  private sweep(now: number) {
    for (const [key, value] of this.entries) if (value.expires <= now) this.entries.delete(key);
  }
  create(p: Principal, query: unknown, ids: string[], context: string, now = Date.now()) {
    this.sweep(now);
    const ordered = [...new Set(ids)].sort();
    if (
      ordered.length > 10000 ||
      this.entries.size >= 128 ||
      [...this.entries.values()].reduce((n, s) => n + s.ids.length, 0) + ordered.length > 100000
    )
      throw new Fault("snapshot_limit");
    return {
      owner: p.owner,
      client: p.client,
      query: canonical(query),
      ids: ordered,
      position: 0,
      expires: now + 300000,
      context,
    };
  }
  resume(
    p: Principal,
    query: unknown,
    cursor: string,
    context: string,
    now = Date.now(),
  ): Snapshot {
    this.sweep(now);
    const entry = this.entries.get(cursor);
    if (
      !entry ||
      entry.owner !== p.owner ||
      entry.client !== p.client ||
      entry.query !== canonical(query) ||
      entry.context !== context
    )
      throw new Fault("restart_required");
    return { ...entry };
  }
  next(entry: Snapshot): string | undefined {
    if (entry.position >= entry.ids.length) return undefined;
    this.sweep(Date.now());
    if (
      this.entries.size >= 128 ||
      [...this.entries.values()].reduce((n, s) => n + s.ids.length, 0) + entry.ids.length > 100000
    )
      throw new Fault("snapshot_limit");
    const cursor = randomBytes(32).toString("base64url");
    this.entries.set(cursor, { ...entry });
    return cursor;
  }
}
