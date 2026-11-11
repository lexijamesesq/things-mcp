import {
  authorize,
  exact,
  Fault,
  type Principal,
  required,
  revision,
  text,
  uuid,
} from "./contract.ts";
import { type Journal, SerialQueue } from "./journal.ts";
import type { Native, NativeReply } from "./native.ts";
import { Snapshots } from "./pagination.ts";
export class Service {
  accepting = true;
  snapshots = new Snapshots();
  journal: Journal;
  native: Native;
  queue = new SerialQueue();
  timezone: string;
  writesEnabled: boolean;
  latestRead: string | null = null;
  lastError: { code: string; at: string } | null = null;
  constructor(journal: Journal, native: Native, timezone: string, writesEnabled = false) {
    this.journal = journal;
    this.native = native;
    this.timezone = timezone;
    this.writesEnabled = writesEnabled;
    journal.recover();
  }
  capabilities() {
    return {
      schemaVersion: 1,
      version: "native-basic-1",
      timezone: this.timezone,
      operations: {
        get: true,
        list: true,
        create: this.writesEnabled,
        update: this.writesEnabled,
        set_status: this.writesEnabled,
      },
      fields: {
        title: { read: true, set: this.writesEnabled, clear: false },
        notes: { read: true, set: this.writesEnabled, clear: this.writesEnabled },
        status: { read: true, set: this.writesEnabled, clear: false },
        parentId: { read: false, set: false, clear: false },
        tagIds: { read: false, set: false, clear: false },
        start: { read: false, set: false, clear: false },
        deadline: { read: false, set: false, clear: false },
      },
      nativeScopes: ["inbox"],
      recurrence: "unknown",
      unsupportedReason:
        "LaunchAgent, recurring occurrence, date, scope, and lifecycle acceptance gates remain open",
      shortcuts: false,
      startup: {
        automatic: true,
        backgroundPreferred: true,
        visibleStartupAccepted: true,
        taskOperationsSilent: true,
      },
    };
  }
  async ensureRunning() {
    const ready = await this.native.call({ operation: "ensure_running" });
    if (!ready.ok) throw new Fault(ready.error ?? "unavailable");
  }
  async read(id: string): Promise<Record<string, unknown>> {
    const r = await this.native.call({ operation: "get", id });
    if (!r.ok) throw new Fault(r.nativeCode === -1728 ? "not_found" : (r.error ?? "unavailable"));
    const item = r.result;
    if (!item) throw new Fault("invalid_native_output");
    if (
      item.id !== id ||
      typeof item.title !== "string" ||
      typeof item.notes !== "string" ||
      !["open", "completed", "canceled", "unknown"].includes(item.status as string)
    )
      throw new Fault("invalid_native_output");
    this.latestRead = new Date().toISOString();
    return { ...item, revision: revision(item, this.timezone, "native-basic-1") };
  }
  async call(tool: string, args: unknown, p: Principal): Promise<unknown> {
    try {
      return await this.execute(tool, args, p);
    } catch (error) {
      this.lastError = {
        code: error instanceof Fault ? error.code : "internal_error",
        at: new Date().toISOString(),
      };
      throw error;
    }
  }
  private async execute(tool: string, args: unknown, p: Principal): Promise<unknown> {
    if (
      !this.accepting &&
      !["things_status", "things_capabilities", "things_operation_status"].includes(tool)
    )
      throw new Fault("service_unavailable");
    if (tool === "things_operation_status") {
      exact(args, ["operationId"]);
      uuid(args.operationId);
      return this.journal.lookup(p, args.operationId) ?? { error: "not_found" };
    }
    if (!required[tool]) throw new Fault("unknown_tool");
    authorize(p, required[tool]);
    if (tool === "things_capabilities") {
      exact(args, []);
      return this.capabilities();
    }
    if (tool === "things_status") {
      exact(args, []);
      return this.queue.run(async () => {
        const native = await this.native
          .call({ operation: "status" })
          .catch(
            () => ({ ok: false, dispatched: false, error: "native_unavailable" }) as NativeReply,
          );
        let journalAccessible = false;
        try {
          journalAccessible = this.journal.db.prepare("SELECT 1 AS ok").get() !== undefined;
        } catch {}
        const nativeError = native.ok ? null : (native.error ?? "unavailable");
        if (nativeError) this.lastError = { code: nativeError, at: new Date().toISOString() };
        return {
          schemaVersion: 1,
          service: this.accepting ? "running" : "degraded",
          protocol: "MCP",
          writes: {
            ready: this.accepting && this.writesEnabled && native.ok && journalAccessible,
            reason: !this.accepting
              ? "service_unavailable"
              : !this.writesEnabled
                ? "release_gates_pending"
                : !journalAccessible
                  ? "journal_unavailable"
                  : nativeError,
          },
          native: {
            ready: native.ok,
            reason: nativeError,
            ownerSession:
              native.ok || nativeError === "permission_required" || nativeError === "unavailable"
                ? "available"
                : nativeError === "owner_session_unavailable"
                  ? "unavailable"
                  : "not_observed",
            process:
              native.ok || nativeError === "permission_required" ? "running" : "not_observed",
            permission: native.ok
              ? "authorized"
              : nativeError === "permission_required"
                ? "required"
                : "not_observed",
            startupPolicy: "background_first_on_task_access",
          },
          journal: journalAccessible ? "accessible" : "unavailable",
          adapter: { version: "native-basic-1", lastPreflightSucceeded: native.ok },
          gateway: "not_observed",
          tunnel: "not_observed",
          lastError: this.lastError,
          latestSuccessfulRead: this.latestRead,
        };
      });
    }

    if (tool === "things_list") {
      exact(args, ["scope", "limit", "cursor"]);
      const scope = args.scope ?? "inbox",
        limit = args.limit ?? 100;
      if (scope !== "inbox") throw new Fault("unsupported_scope");
      if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 500)
        throw new Fault("invalid_argument");
      if (args.cursor !== undefined) text(args.cursor, 128);
      const query = { scope, limit, status: "open" },
        context = this.timezone + ":native-basic-1";
      // Reject foreign/expired handles before native access or automatic startup.
      const existing = args.cursor
        ? this.snapshots.resume(p, query, args.cursor as string, context)
        : undefined;
      return this.queue.run(async () => {
        await this.ensureRunning();
        let snapshot = existing;
        if (!snapshot) {
          const reply = await this.native.call({ operation: "list_ids", scope });
          if (!reply.ok) throw new Fault(reply.error ?? "unavailable");
          const ids = reply.result?.ids;
          if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string"))
            throw new Fault("invalid_native_output");
          snapshot = this.snapshots.create(p, query, ids, context);
        }
        const items: Record<string, unknown>[] = [],
          disappeared: string[] = [];
        const deadline = Date.now() + 20000;
        while (snapshot.position < snapshot.ids.length && items.length < (limit as number)) {
          if (Date.now() > deadline) throw new Fault("read_deadline");
          const id = snapshot.ids[snapshot.position++];
          try {
            const item = await this.read(id);
            if (item.status === "open") items.push(item);
          } catch (error) {
            if (error instanceof Fault && error.code === "not_found") disappeared.push(id);
            else throw error;
          }
        }
        return {
          items,
          nextCursor: this.snapshots.next(snapshot),
          warnings: disappeared.length ? [{ code: "items_disappeared", ids: disappeared }] : [],
          scope,
          status: "open",
          snapshot: "IDs only; records reflect current state",
        };
      });
    }
    if (tool === "things_get") {
      exact(args, ["id"]);
      text(args.id, 256);
      const id = args.id;
      return this.queue.run(async () => {
        await this.ensureRunning();
        return this.read(id);
      });
    }
    const keys =
      tool === "things_create"
        ? ["operationId", "title", "notes"]
        : tool === "things_update"
          ? ["operationId", "id", "expectedRevision", "title", "notes"]
          : ["operationId", "id", "expectedRevision", "status"];
    exact(args, keys);
    uuid(args.operationId);
    const operationId = args.operationId;
    if (tool === "things_create") text(args.title);
    else {
      text(args.id, 256);
      text(args.expectedRevision, 100);
    }
    if (args.title !== undefined) text(args.title);
    if (args.notes !== undefined && args.notes !== null) text(args.notes, 100000, true);
    if (tool === "things_create" && args.notes === null) throw new Fault("invalid_argument");
    if (tool === "things_update" && args.title === undefined && args.notes === undefined)
      throw new Fault("empty_patch");
    if (tool === "things_set_status" && !["completed", "open"].includes(args.status as string))
      throw new Fault("invalid_argument");
    const request = { tool, version: 1, args };
    const old = this.journal.lookup(p, operationId, request);
    if (old && (old.expired || old.outcome !== "not_dispatched")) return old;
    if (!this.writesEnabled) throw new Fault("release_gates_pending");
    return this.queue.run(
      async () => {
        const ready = await this.native
          .call({ operation: "ensure_running" })
          .catch(() => ({ ok: false, error: "unavailable" }));
        if (!ready.ok) {
          this.journal.finish(p.owner, operationId, "not_dispatched", {
            error: ready.error ?? "unavailable",
          });
          return this.journal.lookup(p, operationId);
        }
        let id = args.id as string | undefined;
        let current: Record<string, unknown> | undefined;
        try {
          if (id) {
            current = await this.read(id);
            if (current.revision !== args.expectedRevision) {
              this.journal.finish(p.owner, operationId, "conflict", current);
              return this.journal.lookup(p, operationId);
            }
          }
          const stages: Record<string, unknown>[] = [];
          if (tool === "things_create")
            stages.push({
              operation: "create",
              title: args.title,
              ...(args.notes === undefined ? {} : { notes: args.notes }),
            });
          if (tool === "things_update") {
            if (args.title !== undefined)
              stages.push({ operation: "set_title", id, value: args.title });
            if (args.notes !== undefined)
              stages.push({ operation: "set_notes", id, value: args.notes ?? "" });
          }
          if (tool === "things_set_status")
            stages.push({ operation: "set_status", id, value: args.status });
          for (let i = 0; i < stages.length; i++) {
            this.journal.dispatch(p.owner, operationId, i);
            let reply: NativeReply;
            try {
              reply = await this.native.call(stages[i]);
            } catch {
              this.journal.finish(p.owner, operationId, "uncertain", { id });
              return this.journal.lookup(p, operationId);
            }
            if (!reply.ok) {
              this.journal.finish(
                p.owner,
                operationId,
                reply.dispatched ? "uncertain" : i ? "partial" : "not_dispatched",
                { id, error: reply.error },
              );
              return this.journal.lookup(p, operationId);
            }
            id = (reply.result?.id ?? id) as string;
            if (!id) throw new Fault("invalid_native_output");
            this.journal.evidence(p.owner, operationId, i, { id });
            const state = await this.read(id);
            const expected =
              stages[i].operation === "set_title"
                ? { title: stages[i].value }
                : stages[i].operation === "set_notes"
                  ? { notes: stages[i].value }
                  : stages[i].operation === "set_status"
                    ? { status: stages[i].value }
                    : {
                        title: args.title,
                        ...(args.notes === undefined ? {} : { notes: args.notes }),
                      };
            const preserved = current
              ? Object.fromEntries(
                  ["title", "notes", "status"]
                    .filter((k) => !(k in expected))
                    .map((k) => [k, current?.[k]]),
                )
              : {};
            if (
              Object.entries({ ...preserved, ...expected }).some(
                ([key, value]) => state[key] !== value,
              )
            ) {
              this.journal.finish(p.owner, operationId, "uncertain", { id });
              return this.journal.lookup(p, operationId);
            }
            // Project before persistence: create-only grants never receive unrelated task content.
            const result =
              tool !== "things_create"
                ? state
                : {
                    id,
                    revision: state.revision,
                    ...Object.fromEntries(
                      Object.keys(args)
                        .filter((k) => ["title", "notes"].includes(k))
                        .map((k) => [k, args[k]]),
                    ),
                  };
            this.journal.observed(p.owner, operationId, i, result, i < stages.length - 1);
            current = state;
          }
        } catch {
          this.journal.finish(p.owner, operationId, "uncertain", { id });
        }
        return this.journal.lookup(p, operationId);
      },
      () => {
        this.journal.claim(p, operationId, request, required[tool]);
      },
    );
  }
}
