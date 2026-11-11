# Compatibility and evidence limits

The native integration has been exercised with Things **3.24.2** on macOS. Other
Things versions may work but have not been qualified. The runtime requires Node
**26.13.0**, the Things owner's logged-in, unlocked console session, and Automation
permission for the installed service identity.

## Supported surface

Native and installed MCP fixture checks exercised creation, reads by ID, Inbox
listing, title and notes updates, notes clearing, completion, and reopening.
Hidden-window observations confirmed that normal task operations did not display
a window, change focus, or prompt. A closed-app startup opened Things in the
background. macOS may show UI during startup; silence is required for task events.

A disposable repeating instance was edited, completed, and reopened while another
related item retained its readable fields. This does not establish preservation
of recurrence rules, dates, or additional generated occurrences: the adapter does
not expose them. Target an exact native ID and do not infer template relationships.

Unsupported features include dates, tags, parent changes, moves, ordering, project
or area creation, checklists, reminders, recurrence-rule editing, and list scopes
other than open Inbox. Capability responses explicitly report these limits.

## Verification boundaries

The automated Vitest suite exercises journal recovery and deduplication, conflicts,
retention, process locking, request authentication, OAuth behavior, and release
activation through component interfaces. Controlled OS boundaries exercise native
session checks, permission failures, captured-process identity, noninteractive
Apple Events, and bounded failure handling.

Installed fixture writes used the real native helper and service execution
identity with an isolated journal and restricted fixture access. Public OAuth
read-only calls passed through the deployed gateway and service. These are distinct
checks: live public OAuth mutations have not been measured end to end.

Live locked-screen, logged-out, revoked-permission, and target-process-exit
observations remain unperformed. Production revocation propagation and live signing
key rotation also remain unmeasured. Controlled tests do not establish those live
OS or distributed-system behaviors.

Local release activation and rollback were exercised with the installed service
and an empty production journal. Populated-journal preservation is covered by
isolated tests. A successful activation still requires an authenticated readiness
check before using that installation.
