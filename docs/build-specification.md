# Things MCP build specification — 10 November 2026

## Decision and scope

Build an owner-only Things MCP service in the Things owner's existing logged-in session on the Mac Studio. Use TypeScript, pinned Node LTS and the official MCP SDK for Streamable HTTP. A Cloudflare Worker supplies OAuth and forwards authenticated requests through Cloudflare Tunnel to a loopback Studio service. Things remains the sole task store; SQLite holds operation recovery records, not a task mirror.

This specification is now in implementation under the owner’s build-and-deploy authorization. It is not production qualification. The implementation must establish the gates below before claiming readiness.

Owner clarification (10 November 2026): normal Things reads and writes must produce no visible UI, focus changes, consent prompts or input dialogs. If Things is closed, the service must attempt to open it automatically, preferring background startup; visible UI is accepted for that startup scenario only. Perform one bounded startup attempt before native task dispatch, then capture and verify the running process. Do not require the owner to keep Things open manually. A separate user session, VM or alternate hardware is rejected. Runtime cannot use URL schemes, script the UI, or repair permissions. Preauthorized Automation access remains a prerequisite; missing permissions or a failed startup return a specific unavailable reason without prompting. Status, capabilities and journal-only queries do not launch Things.

Recommended first delivery is the basic native adapter, capability reporting, MCP tools, durable operation journal, Worker OAuth and operational commands. Exclude task replication, background synchronization, delete/bulk mutations, arbitrary scripts, recurrence-rule editing and unproven rich actions.

## Evidence and adapter choice

Experiments used Things 3.24.2/build 32402507 on macOS 27.0.1/build 26A434. With Things already running and its window closed, the owner observed silent read/rename and create/complete/reopen calls. The spike established stable IDs, notes on creation, title-only updates preserving omitted notes, one successful project assignment, distinct start/deadline fields and complete/reopen. Notes patching and general parent/move behavior were not established.

Deadline clearing failed with both JXA null and AppleScript missing value (`-1700`). Same-second edits had identical modification dates. Killing a create caller after dispatch left a created task, demonstrating timeout ambiguity. Global `toDos` returned 61 IDs versus 6,177 explicitly enumerated Logbook IDs; roughly 211 ms measured ID enumeration only, not hydrated records. Interactive nonprompting permission preflight succeeded; LaunchAgent behavior remains untested. Physical Studio identity was not established by the inspected hardware model alone.

A saved Shortcuts Create To-Do fixture with Show When Run off revealed a background Things window without taking focus. **Shortcuts is disabled in v1.** The owner accepts fixed installed workflows only if a later real CLI fixture proves silent execution and exact input/output semantics. Rich metadata exists: inspection found 24 AppIntents and create/edit/query schemas, but no supported general external invocation bypassing Shortcuts was demonstrated. No private database writes, binary injection or undocumented AppIntents invocation is an acceptable fallback. URL execution prompted to enable the disabled scheme and was canceled.

Use a fixed operation-enum/structured-JSON adapter, with validated arguments/output, no shell interpolation, bounded execution time and output. AppleScript is the simplest demonstrated ordinary-operation route, but its production use is conditional on process-targeted, noninteractive dispatch. A name-targeted `tell application` preceded by a running-process check is insufficient. If necessary, add a minimal compiled Objective-C Apple Events helper behind the same interface; do not introduce a separate native daemon or GUI application.

Capture and verify the existing process identity, preflight Automation with `askUserIfNeeded=false`, then dispatch only to that process with noninteractive flags. Never re-resolve a bundle name or retry against a replacement process. Preflight cannot make exit races atomic: if the captured process disappears, return unavailable before dispatch or uncertain after possible dispatch. Do not launch a replacement or replay a task operation within a failed dispatch. A later independent native request may perform the explicit startup step, subject to durable operation deduplication. Timeout/kill of the helper does not establish that the native action failed.

All native access is serialized initially. A call gets one bounded attempt. Installation and permission setup are explicit owner activities; runtime cannot trigger consent. Disposable test artifacts were moved to Trash, the test shortcut removed, and no real tasks or Cloudflare credentials/resources were changed during the spike.

## Public tool and capability contract

Expose only:

| Tool | Required scopes, all-of |
| --- | --- |
| `things_status`, `things_capabilities`, `things_list`, `things_get` | `things.read` |
| `things_create` | `things.create` |
| `things_update` | `things.read`, `things.update` |
| `things_set_status` | `things.read`, `things.complete` |
| `things_operation_status` | Original operation's required scopes, same owner/client |

`things_create` accepts title and capability-enabled notes, parentId, tagIds, start and deadline. `things_update` accepts only title, notes, tagIds, start and deadline where enabled; parent/move updates require a later explicit capability. `things_set_status` accepts only completed or open (reopen), subject to fixture proof. Reject unknown arguments; `things_update` cannot change status or bypass the complete scope. Reject unknown scopes during consent; missing scopes confer no authority. Read-only is the consent default, not a permission inferred from an absent claim. Status and capabilities work without Things availability; native reads and writes fail when prerequisites are absent. Operation status can return persisted records without Things, provided journal access is healthy.

Publish versioned, machine-readable capabilities: operation support; per-field `read`, `set`, `clear`; native scope coverage; adapter/app version; and unsupported/unverified reasons. A response-schema field does not promise support. Candidate fields are stable ID, kind, title, notes, status, parent ID, tags and start/deadline. Advertise each semantic only after fixture/readback proof. Notes patch, tag assignment, kind mapping and broader parent behavior need tests. Project/area/tag creation, move/reorder, checklists and reminders are not initial promises.

For patches, omitted means unchanged, a value means set, and null means clear only where explicitly supported. Reject unsupported fields or clear requests before mutation. Keep both `clear_start` and `clear_deadline` disabled until independently proven. Never turn clear into omission or substitute a deadline for a start date.

Dates on the wire are strictly `YYYY-MM-DD`, interpreted in the configured Things owner's calendar timezone. Convert native dates in that timezone; do not return raw UTC timestamps for date-only fields. Expose the timezone in capabilities and invalidate date-sensitive revisions/cursors if it changes. Validate calendar dates. Reminder instants/timezones require a separate proven capability.

Recurrence metadata is `known_nonrepeating`, `known_repeating_or_template`, or `unknown`. The installed AppleScript dictionary did not expose recurrence rules or prove template identification. Missing properties, IDs, location and service-created provenance do not establish nonrecurrence. Ordinary existing-item mutations are intended; do not invent a blanket requirement to prove nonrecurrence before every mutation. Disposable recurring-occurrence edit/complete/reopen fixtures are a release gate for advertising those semantics. Until established, describe their behavior as unverified, report unknown where appropriate, and never promise reliable rejection of repeating items. Recurrence-rule/template editing remains unsupported.

## Reads, revisions and pagination

Address items by stable native ID, never title matching. Default reads include open items only. Support explicit inbox/today/upcoming/someday/anytime/project/area/logbook/trash scopes only after native membership and hydrated-read tests. Never infer membership from deadline alone or call the global collection all tasks. Archived/completed search is explicit; search only readable fields, not unavailable checklist text.

Default page limit is 100, maximum 500. Establish deterministic native-ID ordering and materialize an ordered ID snapshot per query. Cursors are cryptographically random opaque handles to bounded in-memory state bound to owner, client, normalized query/scope and snapshot position. TTL is five minutes; restart, expiry, timezone/schema change or missing state returns `restart_required`. Invalid or foreign cursors reveal no snapshot content. Cap snapshot count/size and return unavailable if bounds would be exceeded; never silently truncate a complete-list claim. Hydrate current records by ID, warning about disappeared items. Pagination stabilizes IDs, not item contents.

Before advertising Logbook scope, measure hydrated paging, ordering, disappearance and timeout behavior; the enumeration benchmark is insufficient.

Define revision encoding as `v1:<base64url-sha256>`. Hash canonical JSON containing item ID, schema/capability version, timezone, and every reliably read field relevant to supported writes: title, notes, status, parent ID, normalized tag IDs and supported date values. Distinguish unavailable from null; sort unordered collections and keys. The exact enabled field set is part of the capability version. Do not rely on modificationDate. Unsupported native fields cannot be covered by this token.

Update/status calls require `expectedRevision` from a read. Within the serialized worker, reread, compare, apply only explicit changes, then reread and verify. Conflict returns a fresh revision/current readable state. This is not atomic compare-and-swap against simultaneous UI edits: Things supplies no encompassing transaction. Unexpected post-write state produces partial/uncertain results rather than an invented success guarantee.

## Durable dispatch and recovery

Every mutation requires a UUID `operationId`. SQLite uniquely keys `(authenticated owner, operationId)` across clients. Persist originating client ID and grant ID, original required scopes, canonical request hash, timestamps, state, stage records, known native IDs and minimal recovery metadata. Hash tool/version/arguments including expectedRevision and omission/null distinctions. Grant ID is audit context; result authorization requires the current grant's owner, original client ID and original scopes, surviving refresh without making results owner-wide.

A matching request from that client returns stored outcome or `in_progress`; it never queues a second call. Different arguments with the same key reject. A different client colliding on the owner's key receives a generic denial without hash, status, native ID or result. Operation-status follows the same boundary. Owner-wide investigation is a local operator command, not implicit OAuth-client access.

Take a single executor process lock. Queue capacity 32 counts waiting plus active native calls, including reads. Check existing operation keys before admission; a new call is admitted under the local queue mutex, then claimed transactionally. Overload rejects before claim/dispatch. Never hold a SQLite transaction across Apple Events.

Use these persisted operation states:

- `claimed`: durable ownership, no helper invocation permitted yet.
- `queued`: admitted, waiting; still undispatched.
- `dispatching`: committed immediately before invoking the native helper for the current stage. Any crash from this point is potentially effectful, even if invocation may not actually have occurred.
- `applied`, `conflict`, `partial`, `failed`: terminal outcomes persisted before responding. `failed` requires a proven rejection with no possible effects; partial means known completed stages/effects plus a known later failure.
- `uncertain`: possible effects without a sufficiently observed outcome. No automatic retry.
- `not_dispatched`: positively established that no stage invoked the helper; an explicit identical resubmission may transition back to queued after admission and readiness checks.

Native validation rejects before dispatch. A revision mismatch is conflict. On restart, prior `dispatching` becomes uncertain. Claimed/queued with no dispatched stages becomes not_dispatched because the sole executor invokes the helper only after the committed boundary. Never infer no dispatch from elapsed time or missing output.

Prefer atomic native operations and separate create/update calls. If a supported input requires several native stages, it remains one operation with durable stage rows. Commit each stage's dispatching boundary separately; immediately persist successful stage output, native ID, revision and observed state before starting the next stage. Commit stage success and the next stage’s queued state together. Persisted completed stages plus an undispatched later stage recover as partial; any ambiguous stage makes the operation uncertain while retaining completed-stage evidence. Do not resume stages or roll back automatically. Failure to persist a successful create's returned ID can still leave an unrecoverable uncertain create; stage journaling narrows, not eliminates, that window.

Return operationId, outcome, known native ID, verified state/revision and stage results as applicable. Without `things.read`, mutation and operation-status responses expose only the ID, opaque revision, outcome and fields supplied by that caller; they must not reveal preexisting notes or other task content. Apply this projection on every response, including replay/reconciliation, against the current grant. Client disconnect after dispatch neither cancels nor retries the native effect. Known-ID reconciliation can describe present state, explicitly marked reconciled; it cannot prove which actor caused it. Reconciliation is deliberate and bounded, not a background retry loop. Lost-ID creates cannot safely be rediscovered by title or reexecuted. No hidden task-note markers or exactly-once claims.

Keep full result/recovery payloads seven days, then return `result_expired`. Retain compact owner/key/hash/client/scope/outcome tombstones indefinitely in v1; authenticated rate limits bound growth. Expiry never permits reexecution. Journal files have owner-only permissions; backups/restores preserve tombstones before writes resume. Store no task mirror; audit excludes task notes, raw auth headers and tokens.

## OAuth, transport and origin trust

Client → public Worker `/mcp` → service-authenticated Tunnel origin → `127.0.0.1` Studio service → native adapter.

Use Parcel PR17's Worker OAuth design as the starting point, pinned to commit `664f008b78c6444373ca17250f70740a74cf78be`. Its current design applies human Cloudflare Access to interactive `/authorize`, not to the whole client-facing MCP host. Public metadata/401 behavior and merged code were inspected; no production login/refresh cycle was verified.

The maintained provider handles PKCE, redirect validation, browser-bound consent and token lifecycle. Worker validates the Access identity and explicit owner allowlist at authorization; registration or any other Access principal does not confer ownership. Consent names client, redirect host and scopes. Bound DCR/authorization payloads and rates. Start with Parcel's one-hour access tokens and rotating refresh tokens with a sliding 90-day idle expiry, not an absolute 90-day lifetime. Test actual provider replay/revocation semantics; do not claim instantaneous revocation through unmeasured caches.

Validate Worker-issued OAuth credentials on every request. Strip caller identity/scope headers. Authorize tools against granted scopes at Worker and independently at Studio. Use a distinct origin hostname with Access service authentication restricted to the Worker credential. Disable alternative unprotected routes and workers.dev exposure. No public Mac listener/router port.

Access enforces the origin machine credential; Studio independently verifies a signed gateway grant assertion. Neither substitutes for the other. Do not assume an Access JWT reaches Studio; if it does, independently verified signature/issuer/audience is defense in depth only.

Use a fixed assertion schema: issuer, Studio audience, owner subject, client/grant IDs, granted scopes, issued/expiry times, `kid`, and request binding. Allowlist algorithm and configured public keys; reject unknown keys/owners/issuers/audiences. Lifetime ≤30 seconds, clock skew ≤5 seconds. Bind uppercase method, exact forwarded path/query, normalized content type and SHA256 of exact body bytes. Worker forwards bytes unchanged after hashing. Reads may replay during this window; every write passes durable operation dedupe, so no second persistent assertion-replay cache is needed. Worker never automatically retries mutations.

Store Worker signing key and service credential in Worker secrets; local credentials outside source with owner-only permissions. Studio stores no client refresh tokens. Rotate by installing the next public key, switching Worker signing key, retaining the old public key through expiry/skew, then removing it. On compromise, disable writes, revoke affected machine/signing credentials, replace trust configuration and prove denial before resuming.

Use stateless Streamable HTTP through the official SDK: no durable MCP sessions or server-initiated subscriptions. Authenticate POST and any GET/DELETE attempts; unsupported transport methods return the SDK-consistent response without side effects. Preserve protocol/version, Accept/content-type, response status/challenge headers and streaming POST responses through Worker/Tunnel. Reject JSON-RPC batches at both layers. Enforce Host/Origin policy locally; absent Origin is permitted for authenticated nonbrowser clients. Initial body cap 256 KiB, native output cap 1 MiB. Establish bounded request/native deadlines from hydrated-read measurements before release.

## Readiness, operation and build stack

Start not-ready. Acquire process lock, check/migrate SQLite, classify every nonterminal operation, and load/probe adapter configuration before admitting writes. Recovery classifies uncertainty without automatic native replay. Native readiness additionally requires the correct logged-in owner session, a captured Things process (after bounded background-first startup when closed) and nonprompting permission preflight. Status/capabilities remain available in degraded mode; native calls fail unavailable or permission_required. No offline queue.

Expose schema-versioned status dimensions: service/protocol, write readiness/reason, gateway/tunnel reachability where actually observed, owner-session suitability, Things process, permission, adapter/capabilities, journal health, latest successful native read and sanitized last error. Never claim external reachability from local process health or launch Things in health checks.

Use a user LaunchAgent with absolute pinned executable/config paths, restart backoff and on-demand Things startup before native task access; no background launch loop or automatic mutation replay. Shutdown stops admission, finishes or marks active dispatch uncertain, and classifies undispatched calls safely. Provide `things doctor`, `status/start/stop/logs`, bounded reconciliation/retention maintenance, versioned install/rollback, revoke and secure journal/config restore instructions. Updates must not silently change Automation identity. Alerts require an owner-selected destination; no monitoring platform is needed.

Candidate versions smoke-tested locally: Node 26.13.0, `@modelcontextprotocol/server` 2.4.0, `@modelcontextprotocol/node` 2.1.2, `jose` 6.2.15 and `better-sqlite3` 13.0.3. Imports, SQLite rollback/crash persistence and wrong-audience JWT rejection passed; duplicate claims were tested sequentially only. OAuth provider 1.2.4 was registry-verified, not runtime-tested. Verify current LTS/platform compatibility, pin a lockfile and rerun on Studio. Prefer the maintained SQLite binding over release-candidate `node:sqlite` or custom JSONL recovery.

## Acceptance and reviewer disposition

Build order: native adapter/no-UI gate → local MCP/journal → Worker/Tunnel → real client acceptance → operator handoff. Failed capabilities remain disabled; failed core no-UI/auth/journal gates block release.

1. Under the actual LaunchAgent identity on the confirmed Studio, test Things running/window closed, closed-to-running startup, exiting mid-call, missing/denied Automation, locked screen and logged-out session. Normal task operations must remain silent. Background-first startup must work when Things is closed; visible startup UI is permitted. An exit during a task operation must not cause a replacement launch or replay within that operation. Logged-out/unsuitable states fail unavailable.
2. Disposable fixtures prove every advertised read/set/clear and operation, notes patch separately, date round trips at non-UTC offsets/across DST, hydrated scopes/Logbook, revision conflicts and recurring-occurrence behavior. Never use real tasks for routine mutation tests.
3. Test concurrent identical/different-key claims, cross-client collisions, every stage crash boundary, timeout/disconnect, uncertain create, startup readiness, overload, cursor tampering/expiry/restart and restored tombstones. No duplicate native dispatch.
4. Test OAuth discovery/challenges, owner allowlist, PKCE/consent, all-of scope enforcement, invalid/expired/Access-only credentials, refresh rotation/replay, revocation and key rotation. Prove direct-origin/alternate-host denial, valid machine credential without grant denial, and body/path substitution denial through the real Worker/Tunnel path.
5. Codex, Claude Code and eve each receive separate grants and complete login, scoped read/write, restart and refresh. Grok Bot support is conditional on its actual transport/OAuth capabilities; document any gap or later explicit compatible adapter. No static-token bypass.

Review dispositions: auth findings resolved with exact scopes, byte binding, bounded assertions/dedupe, separate origin verification and key rotation. Native findings resolved with date-only values, disabled clears, conditional PID-targeted dispatch, explicit evidence limits and field-level capabilities. Operations findings resolved with dispatch states, client-bound owner-global keys, stage persistence, cursor lifecycle and startup readiness. These are specified resolutions; acceptance tests still must prove implementation.

Tradeoffs: AppleScript/basic Apple Events minimizes installation but offers narrower fields; a tiny helper may be necessary for the no-UI guarantee. Fixed Shortcuts adds richer potential actions and workflow maintenance but currently fails the requirement. Worker OAuth adds one maintained component while providing standard client grants and revocation; whole-host Access is not the current recommended design. This bounded architecture is ready to build, with production readiness contingent on the listed gates.

Primary references: [Things AppleScript](https://culturedcode.com/things/support/articles/2803572/), [Apple Shortcuts CLI](https://support.apple.com/guide/shortcuts-mac/run-shortcuts-from-the-command-line-apd455c82f02/mac), [official MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), [Parcel PR17](https://github.com/lexijamesesq/parcel-mcp/pull/17), [pinned Parcel source](https://github.com/lexijamesesq/parcel-mcp/tree/664f008b78c6444373ca17250f70740a74cf78be).
