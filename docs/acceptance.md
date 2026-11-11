# Acceptance evidence

## Proven in the interactive owner session

- Owner confirmed the execution host is her Mac Studio, account lexi, America/Phoenix.
- Things 3.24.2 was read through a captured PID using noninteractive Apple Events.
- Disposable fixture NfrKWFBPLpfQ1XGAKDhxCR passed create, hydrated read, title patch
  preserving notes, notes patch, complete, reopen, and final completion. The owner
  observed no visible UI, prompt, or focus change during all eleven calls.
- A stopped-app version probe returned unavailable without sending an event or
  launching Things. This verifies task dispatch itself has no implicit launch path.
- Following the owner's clarified startup policy, the explicit startup operation
  opened Things from closed, without task dispatch, and a subsequent version read
  succeeded. The owner confirmed background opening caused no interruption.
- Local tests exercise durable dedupe, cross-client denial, refresh identity,
  revision conflicts, timeout uncertainty, retention tombstones, queue bounds,
  signed-byte binding and real stateless MCP HTTP authentication.

## Recurring fixture verification

The owner supplied Today instance `2szuodrWeLeVUavDMWP3CY` and Upcoming item
`QkEq3WRbXkof4a6c8tG1jD`, both named Things MCP recurring acceptance. The owner
identifies Upcoming as the repeating template and Today as its instance; the
native adapter cannot independently expose that relationship.

Two runs of twelve native calls each read both items, changed the Today title,
restored its title, completed Today, and reopened it. Readback verified the Today
changes and preserved notes. Upcoming retained its title, notes, and open status
throughout. Both items ended with their original readable fields.

For the second run, the owner explicitly hid Things and switched away before
execution, then confirmed no window, focus change, or prompt. The first run was
performed with Things active and supplies no evidence about focus behavior.
These are native-helper checks, not end-to-end deployed MCP mutation checks.
Dates, the recurrence rule, and additional generated occurrences were not exposed
by this adapter, so this does not establish that those remained unchanged.

## Evidence limits and remaining delivery

Real locked-screen, logged-out, revoked-permission, and target-exit observations
have not been performed. The owner declined interruption for a lock test. Tests
compile the actual native bridge with controlled OS boundaries to verify session
checks, permission handling, captured-process identity, noninteractive event flags,
and bounded failures. Independent runtime review found no blocking defect for the
narrow title, notes, and status surface; these controlled checks do not claim a
live OS observation.

Dates, tags, parents, recurrence-rule editing, and broader list scopes remain
unsupported. Recurrence schedule and extra-occurrence inventory are not exposed.
Public OAuth mutation acceptance, production revocation propagation, and live key
rotation remain unmeasured. The existing Codex development grant stays read-only.
Estate repository enrollment, environment provisioning, and protections remain
unfinished; those are separate from the qualified runtime deployment.

## Architecture clarification

Use one hostname, the configured public hostname, with public OAuth/MCP endpoints and a
service-protected /_origin/mcp path. Explicit global_fetch_strictly_public and a
Worker route exclusion preserve public Access evaluation on origin subrequests.
Require origin-AUD Access JWT validation at cloudflared as well as the local
request-bound signed grant. The topology supports the qualified runtime surface. Public discovery,
MCP challenges, direct-origin denial, and unmatched-path denial passed. Authenticated
Codex development reads passed before and after a service restart. See [deployment record](deployment.md).

## Baseline source

Dotty v2026.11.10, commit 773bf5bf00400883904975575b92d92640215708.
The installed new-repo skill's plugin-update commands failed because system is not
registered in this Claude environment. Canonical native assets were read directly
from the verified published release; no alternate author identity was substituted.

## Independent milestone validation

The runtime validator reproduced a surviving-helper overlap after executor death.
The helper now inherits the executor lock; an independent process regression proves
replacement is blocked until that helper exits. Real startup retention was also
verified against an eight-day-old synthetic journal with replay tombstones preserved.

The gateway validator exercised the actual provider in isolated workerd, then found
and reproduced a Chrome CSP callback failure. After the fix, actual generated
approval and denial pages reached the callback; adversarial client markup remained
inert, with no referrer leakage or CSP violations.

The existing behavioral suite passes under Vitest, including isolated OAuth,
HTTP, journal recovery, process locking, native lifecycle, and release activation
checks. TypeScript checks pass. The runner migration adds no test cases. Browser
reproductions live under `test/manual/` and are excluded from the default suite.
Controlled tests do not replace the installed observations described here.

## Installed native MCP writes

A one-shot LaunchAgent used the installed launcher, pinned Node, real native helper,
and production executor lock while the normal service was stopped. An isolated
loopback MCP server used an ephemeral signing key and separate journal. Its adapter
allowed one create attempt and restricted all subsequent task access to that ID.

Nineteen MCP calls passed: five concurrent creates produced one task, replay did
not repeat the title edit, mismatched operation payloads and insufficient scopes
were rejected, stale revision conflicted, notes cleared, and complete/reopen/final
completion succeeded. The fixture was left completed. The one-shot job was removed
and the normal service restored. This proves the installed native write path;
it does not constitute public OAuth mutation acceptance or a new UI observation.

An independent HTTP regression additionally proves that client disconnect after
dispatch does not cancel the effect, shutdown draining waits for it, and replay
returns the persisted outcome without a second mutation.

## Scope correction

The owner explicitly prohibited unsolicited client installation and authorization
windows. Claude Code configuration and credentials were removed and its pending
login canceled. Codex remains authorized for development. Other agent rollout is
outside this implementation's acceptance scope. No further client connections or
browser authorization flows may be initiated without a new owner instruction.

## Recovery and release validation

Independent review verified journal fail-closed behavior, retained stage evidence,
expiry across restore, and refusal to replay ambiguous mutations. Actual gateway
signatures are checked by the Studio verifier in the isolated integration suite.
Live origin checks rejected a valid machine credential without a grant and with a
forged grant; the temporary credential was removed afterward.

Release activation verifies the runtime inventory, dependencies, Node version,
journal schema, and native binary compatibility before switching service files.
Independent release review covered tampering, staging failures, incompatible
native changes, and symlink escape. Ordinary activation preserves the journal,
trust configuration, and qualified native executable identity.
