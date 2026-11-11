# Operations and recovery

The examples use the installed operator at
`$HOME/Library/Application Support/ThingsMCP/things`. Run it as the Things owner.
The service, journal, configuration, keys, logs, and backups belong to that user.
Do not run a second executor against the same Things account.

```sh
export THINGS_BASE="$HOME/Library/Application Support/ThingsMCP"
"$THINGS_BASE/things" status
"$THINGS_BASE/things" doctor
"$THINGS_BASE/things" logs
```

`status` inspects launchd. `doctor` checks configuration ownership, journal
integrity, executable presence, and job loading. Use authenticated `things_status`
for live native readiness and `things_capabilities` for the supported surface.
The local service cannot independently attest to gateway or Tunnel health.

## Backup and retention

Maintenance requires the executor lock and refuses to run while the service or a
surviving native helper holds it. Stop the service first:

```sh
"$THINGS_BASE/things" stop
"$THINGS_BASE/things" backup "$THINGS_BASE/state/manual-backup.sqlite"
"$THINGS_BASE/things" start
```

Choose a new absolute backup filename each time. The backup is a consistent SQLite
copy containing replay-prevention records. Protect and copy it to your normal
backup system. Do not copy only a live SQLite main file while ignoring its WAL.
Back up the owner configuration and keys separately with equivalent protection.

The service expires result payloads after seven days at startup and hourly. It
retains deduplication records. `things retention` performs the same maintenance
while stopped; it does not reclaim operation IDs for reuse.

## Upgrade and rollback

Check out a reviewed release tag and rebuild dependencies and native helpers on
the target Mac. Run the relevant checks, then package the clean source under a new
local directory label. Set `THINGS_SERVICE_LABEL` to the label of the existing
LaunchAgent, which may differ from the new-install default below. Read its pinned
Node path from that plist:

```sh
export THINGS_SERVICE_LABEL='org.things-mcp.service'
export THINGS_PLIST="$HOME/Library/LaunchAgents/$THINGS_SERVICE_LABEL.plist"
export THINGS_NODE="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:2' "$THINGS_PLIST")"
"$THINGS_NODE" scripts/package-release.mjs NEW_RELEASE_LABEL
"$THINGS_BASE/things" stop
"$THINGS_BASE/things" backup "$THINGS_BASE/state/before-upgrade.sqlite"
"$THINGS_NODE" "$THINGS_BASE/releases/NEW_RELEASE_LABEL/src/operator.ts" activate NEW_RELEASE_LABEL
"$THINGS_BASE/things" start
```

Use actual new names in place of the example release labels. Invoke the **candidate
operator** for activation, as above: older installed operators generated wrappers
without the service label. Calling an old `things activate` during this transition
can leave the new operator targeting the wrong LaunchAgent. The candidate operator
uses the explicit existing label and writes it into the new wrapper.

Verify authenticated readiness
before further task access. Activation verifies the inventory, exact Node version,
journal schema, and byte-identical native binaries. It updates the JavaScript
entrypoint and operator wrapper while preserving configuration, journal, and the
existing native executable path. A first installation can use any release label;
maintenance derives its native launcher and lock from configuration.

If activation reports `native_upgrade_requires_qualification`, ordinary activation
cannot install that build. Keep the service stopped or restart the existing
version. Qualify the new native identity explicitly as an installation change;
do not overwrite the retained helper, patch the manifest, or bypass the check.
The same applies to a changed pinned Node executable path.

To roll back, stop, activate the retained compatible release label, start, and
verify. **Do not roll back the journal with the code.** An old journal could forget
already dispatched operations. Keep the release directory containing the configured
native helper even when a newer JavaScript release is active.

Activation stages the plist and wrapper before replacement, but the two renames
are not crash-atomic together. After interruption, leave the service stopped,
inspect both paths, and rerun activation of the intended verified release. The
`previous-activation.plist` is for inspection; it is not a journal backup. Repeating
activation of the same release preserves the previous-release pointer.

Worker upgrades are separate: build from the intended tag with the installation's
build variables and deploy with its protected secrets file as in the installation
guide. Preserve the signer key ID and matching local public key. A new default in
source must not silently replace an installed trust value. Builds require
`THINGS_SIGNING_KID` explicitly; use the installed value, not the documentation's
local-build placeholder.

## Interrupted writes and journal recovery

Query `things_operation_status` with the original UUID and client. Do not retry an
uncertain operation under a new UUID. A stopped-service reconciliation can read the
current state of a retained known task ID:

```sh
"$THINGS_BASE/things" stop
"$THINGS_BASE/things" reconcile OPERATION_UUID
"$THINGS_BASE/things" start
```

Reconciliation is a read and does not prove attribution or redispatch the mutation.
It cannot find an ambiguous create with no known native ID. In that case inspect
Things manually. Do not guess identity from a matching title and auto-replay.

`things restore ABSOLUTE_BACKUP_PATH` merges a compatible backup into the current
journal while stopped, preserving current records and deduplication protection.
It requires an existing valid current journal; it is not a missing-file bootstrap.
If the journal is missing or corrupt, stop and recover the latest consistent state
under explicit operator control. Do not create an empty replacement and resume
writes. Restoring an older backup alone cannot prove that later operations did not
happen.

## Troubleshooting and containment

| Symptom | Check or action |
| --- | --- |
| Native unavailable | Things installation, logged-in unlocked owner session, service Automation permission |
| Things is closed | Task access attempts background startup; status alone does not launch it |
| Permission denied | Stop and repeat explicit setup under the installed identity; runtime never prompts |
| Service not loaded | Inspect error log, pinned Node path, configuration permissions, and existing journal |
| Maintenance refuses lock | Stop service; allow surviving helper to exit; do not delete the lock file to bypass it |
| Public reads fail, local files healthy | Inspect Tunnel connection, Worker routes, both Access applications, grant scopes, issuer, audience, key ID, and clock |
| Cursor expired | Start a new listing; cursors are short-lived and lost on restart |
| Conflict | Read again and review the task before intending a new mutation |
| Payload expired | Outcome tombstone remains; task content cannot be reconstructed from it |

For immediate containment, stop the local service. Revoke compromised OAuth grants
through the provider's advertised revocation endpoint using the client's secure
credential handling. Local client logout alone does not prove server-side
revocation; production propagation latency has not been measured. Rotate a leaked
origin service token separately from OAuth grants.

For signing-key rotation, add the new public verification key locally before
switching the Worker's private key and `THINGS_SIGNING_KID`. Retain the previous
public key through in-flight assertion expiry and clock tolerance, verify access,
then remove it. Back up configuration before changing it. Live rotation has not
been qualified; perform it as a deliberate maintenance operation.
