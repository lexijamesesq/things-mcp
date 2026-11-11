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

## Open release gates

Locked and logged-out sessions;
exit during native dispatch; recurrence schedule/occurrence inventory; native list scopes,
pagination and dates; remaining multistage crash/disconnect boundaries; live
Access/Tunnel authenticated denial matrix; independent client grants, refresh and
revocation; installed operator commands, backup, restore and rollback; estate
repository enrollment and protections. Production writes remain disabled.

## Architecture clarification

Use one hostname, the configured public hostname, with public OAuth/MCP endpoints and a
service-protected /_origin/mcp path. Explicit global_fetch_strictly_public and a
Worker route exclusion preserve public Access evaluation on origin subrequests.
Require origin-AUD Access JWT validation at cloudflared as well as the local
request-bound signed grant. The topology is deployed as a read-only acceptance candidate. Public discovery,
MCP challenges, direct-origin denial, and unmatched-path denial passed. Authenticated
end-to-end acceptance remains open. See [deployment record](deployment.md).

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

The current complete suite passes 21 tests. TypeScript checks and the native build
pass. Browser reproductions live under `test/manual/`. These results do not replace
live identity, origin-denial, real-client, or installed mutation acceptance.
