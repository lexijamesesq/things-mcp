# Deployment record

The deployment is a read-only acceptance candidate. Production mutations remain disabled.

## Resources

The installation uses one public hostname, a Worker, an OAuth KV namespace, two
Access applications with reusable policies, and a dedicated remotely managed Tunnel.
Resource IDs and the installed configuration are retained in the owner-only local
deployment record, outside Git. workers.dev and preview URLs are disabled.
The signing private key exists only in Worker secrets.

Set `THINGS_CF_ACCOUNT_ID`, `THINGS_OAUTH_KV_ID`, `THINGS_PUBLIC_HOST`,
`THINGS_CF_ZONE`, `THINGS_OWNER_EMAIL`, and `THINGS_ACCESS_ISSUER` when building
for deployment. Defaults are examples for local development, not a live deployment.

The Tunnel routes only `^/_origin/mcp$` to `127.0.0.1:19763`, requires an Access
JWT for the origin application's audience, and returns 404 for everything else.
The gateway signs exact method/path/content-type/body bindings for 30 seconds.
The service additionally checks owner, client, grant, scopes, and signing key.

The Worker uses `global_fetch_strictly_public`. Deployed settings were read back
with logs and traces enabled and `redact_query_string: true`. Public Worker routes
exclude `/_origin/*`. No other existing tunnel or application was modified.

## Studio installation

Runtime: `~/Library/Application Support/ThingsMCP/releases/0.1.0`.
Configuration and state are under the same ThingsMCP directory with owner-only
permissions. The temporary local acceptance signing key has been removed.

LaunchAgent labels are `esq.lexi.things-mcp` and `esq.lexi.things-mcp.tunnel` in
`gui/501`. Node is pinned to Homebrew 26.13.0_2 and cloudflared to 2026.10.7.
The connector reads its credential from a mode-600 file, never a command argument.
The Things MCP launcher holds a kernel lock inherited by every native helper.

## Operator entrypoint

`~/Library/Application Support/ThingsMCP/things` provides:

- `status`, `start`, `stop`, and `logs` for the service LaunchAgent.
- `doctor` checks configuration permissions, SQLite integrity and installation.
- `retention` removes expired results while preserving operation tombstones.
- `backup /absolute/new/path.sqlite` uses SQLite's consistent backup API.
- `restore /absolute/backup.sqlite` merges identities and stage evidence into the
  existing journal, preserves expiry, rejects collisions, and guards retries.
- `reconcile OPERATION_ID` reads only an already-recorded native ID. It reports
  current state without attributing changes or authorizing replay.

Stop the service before retention, backup, restore, or reconciliation. These commands acquire
the same executor lock, so they also refuse access while a surviving helper holds
it. Reconciliation runs under the operator's Automation identity and never prompts
or launches Things. Authenticated `things_status` checks the installed service's
identity and never launches Things.

Restore refuses a missing, truncated, or incomplete live journal. A backup cannot
prove that newer operation identities were not lost. Never replace the live journal
with an older backup. If current tombstones are unrecoverable, keep writes disabled
and investigate rather than manufacturing empty deduplication state.

Rollback must preserve the current journal and trust configuration. Stop both
LaunchAgents, retain the current release, point the service job to a previously
verified compatible release, and restart. Do not downgrade the journal schema or
remove a signing key still needed by in-flight requests. The first release has no
previous verified rollback target; that installed rollback exercise remains open.

## Independent validation

The runtime validator reproduced an orphan-helper overlap after executor SIGKILL.
The fix inherits the lock into helpers. The validator's repository regression now
proves replacement is denied until the helper exits and succeeds afterward.
The validator also exercised real service startup with an eight-day-old synthetic
journal: payloads expired while operation tombstones continued to block replay.

The gateway validator exercised the actual OAuth provider in isolated workerd,
covering consent, PKCE, owner denial, default read scope, cross-client isolation,
refresh, and revocation. Previous refresh tokens remain usable under the provider's
overlap behavior; this implementation does not claim single-use refresh tokens.
Production KV revocation propagation is not established by local-runtime tests.

The validator reproduced a Chrome consent callback blocked by form-action CSP.
The implementation now completes consent with a nonce-protected navigation document
whose callback comes from provider validation. The independent post-fix Chrome test passed approval, denial, adversarial state,
injection controls, no-referrer behavior, and CSP enforcement.
