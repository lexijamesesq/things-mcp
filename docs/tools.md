# Tool contract

All tools reject unknown arguments. Native IDs come from `things_list`,
`things_get`, or the `id` query parameter in a Things Copy Link URL. Supply the ID,
not the whole URL. OAuth scopes are checked at both the gateway and local service.

| Tool | Arguments |
| --- | --- |
| `things_status` | `{}` |
| `things_capabilities` | `{}` |
| `things_list` | Optional `scope: "inbox"`, `limit` (1–500, default 100), `cursor` |
| `things_get` | `id` |
| `things_create` | UUID `operationId`, nonempty `title`, optional string `notes` and `start` date |
| `things_update` | UUID `operationId`, `id`, `expectedRevision`, at least one of `title`, `notes`, or `start` |
| `things_set_status` | UUID `operationId`, `id`, `expectedRevision`, `status: "open"` or `"completed"` |
| `things_operation_status` | UUID `operationId` |

Titles allow up to 1,000 JavaScript string units; notes allow up to 100,000.
The complete HTTP request must fit within 256 KiB. An empty title is invalid.
For updates, `notes: null` or an empty string clears notes; an omitted field is
preserved. Creation does not accept null notes. Status is a separate operation.

## Scheduling

`start` is a scheduled calendar date in `YYYY-MM-DD` form (years 1904–9999),
interpreted in the service's IANA timezone from `things_capabilities`. The configured
timezone name must match the Mac system timezone that Things uses. Native access
fails with `timezone_mismatch` when they differ; readiness and creation preflight
check this before task mutations. Update configuration deliberately if the Mac
timezone changes; the service does not change system settings. To schedule
for Today, supply the current calendar date in that timezone. Timestamps, relative
strings such as `"today"`, invalid dates, and null are rejected. An omitted `start`
leaves scheduling unchanged; clearing a start date is not supported. A civil date
that does not exist in the configured timezone is rejected by the native helper.

This sets Things' scheduled/activation date through its native `schedule` command.
It does not set a deadline. Reads return `start` and `deadline` as date strings or
null; deadlines remain read-only. Both fields participate in revision checks and
preservation checks. Fetch a new revision after upgrading to this adapter.

Creation first creates an Inbox task, then schedules that exact returned ID;
scheduling can move it out of Inbox. The operations are separate journaled stages,
not an atomic transaction. A failed scheduling stage retains the created ID and
its observed result, without claiming that scheduling succeeded. Inspect partial
or uncertain outcomes before taking any further action; never create a replacement
as an automatic retry. No new authorization scopes are required.

Today-list placement and silent scheduling passed local disposable-fixture checks.
Hosted scheduling remains unverified; see [evidence limits](acceptance.md).

## Reads and pagination

Task reads expose ID, title, notes, status, start date, deadline, and an opaque revision. Read status may
also be `canceled` or `unknown`; neither is an accepted write target. Capabilities
describe the supported surface, while status describes current readiness.

Inbox pagination snapshots the ordered IDs, then reads their current contents.
It is not a point-in-time snapshot of every field. Reuse the same scope and limit
with the returned cursor. Cursors are bound to client, query, and timezone, expire
after five minutes, and do not survive service restart. On `restart_required`,
start a new listing. Tasks missing during hydration produce warnings.

## Mutations and recovery

Generate a UUID for each intended mutation. Persist it with the exact arguments
before sending. Repeating that request from the same OAuth client returns the
recorded outcome, except that an unexpired `not_dispatched` operation can be queued
again with the same UUID and arguments because no mutation was dispatched. Expired
records and ambiguous outcomes are never requeued. Using a UUID with different
arguments fails. Another client
cannot read or reuse the operation even if it belongs to the same owner.

Updates and status changes require the revision returned by a fresh read. A stale
revision produces a conflict without dispatching the requested mutation. Read
again, review the intervening change, and use a new UUID for a newly intended edit.
The revision covers the fields this adapter can read, not unsupported metadata.

If a connection fails, query `things_operation_status` with the original UUID.
The lookup requires the original operation's scopes; a read-only grant cannot
retrieve a write operation. It can work while Things is unavailable. Refreshing
a grant for the same client does not create a new client identity.

Outcomes include `claimed`, `queued`, `dispatching`, `applied`, `conflict`,
`partial`, `failed`, `uncertain`, and `not_dispatched`. Inspect the returned result
and stage evidence. `partial` can mean an earlier field change succeeded before a
later stage failed. `uncertain` means dispatch may have taken effect. Neither is
permission to repeat the mutation with a new UUID. Reconcile current state by
known task ID; current state alone cannot prove which request caused it.

Results and stage content expire after seven days. The retained operation record
still prevents replay, but an expired record cannot reconstruct the original task
content. Never delete or replace the journal to clear an uncertain operation.
