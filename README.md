# Things MCP

Things MCP connects an OAuth-capable MCP client to your Things 3 tasks on a Mac.
It supports reading tasks, listing the Inbox, creating tasks, editing titles and
notes, and completing or reopening tasks. You host a Cloudflare gateway and a
local macOS service; each deployment serves one Things owner.

## Installation

You need a Mac running Things 3 in your logged-in account, Node **26.13.0**, Apple
command-line developer tools, and a Cloudflare account with a domain, Workers,
KV, Access, and Tunnel. The Mac must remain available for task access.

Clone a [release](https://github.com/lexijamesesq/things-mcp/releases), then install
and build on the Mac that will run the service:

```sh
git clone https://github.com/lexijamesesq/things-mcp.git
cd things-mcp
git checkout things-mcp--v0.1.0
npm ci
npm run build:native
```

Follow the [installation guide](docs/deployment.md) to configure the gateway,
create the local journal and LaunchAgent, and authorize Automation once. Releases
ship source; the native helper and SQLite dependency are built for your Mac.
There is no hosted service or prebuilt, notarized application to download.

### Required configuration

| Field | Location | What to set |
| --- | --- | --- |
| Public hostname and Cloudflare resources | Build environment | Your domain, account, zone, and OAuth KV namespace |
| Owner identity | Worker secrets and local configuration | Your Access identity subject; Worker also checks your email |
| Signing key | Worker secret; public key in local configuration | An Ed25519 key pair for request-bound grants |
| Tunnel service credential | Worker secrets | A service token allowed only through the origin Access application |
| Native executable, journal, timezone | Local `config.json` | Absolute paths and an IANA timezone |

The [configuration tables and setup commands](docs/deployment.md) describe every
required value. Keep credentials and installation files outside this repository.

## What's Included

| Component | What it does |
| --- | --- |
| Cloudflare Worker | Authenticates the owner, issues OAuth tokens, and forwards authorized MCP requests |
| macOS service | Exposes tools, serializes writes, checks revisions, and records mutation outcomes |
| Native helper | Sends bounded, noninteractive Apple Events to Things |
| Operator CLI | Controls the service, backs up the journal, reconciles outcomes, and activates local releases |

## Usage

### Connect an MCP client

Add `https://YOUR_HOST/mcp` as a remote Streamable HTTP MCP endpoint in a client
that supports OAuth. Sign in as the configured owner and approve the requested
scopes. The default grant is `things.read`; write tools require explicit additional
scopes. Client configuration and consent are your choice and are not installed by
the server.

### Read and change tasks

| Tool | Purpose | Required scopes |
| --- | --- | --- |
| `things_status` | Inspect native and journal readiness | `things.read` |
| `things_capabilities` | Discover supported fields and operations | `things.read` |
| `things_list` | Page through open Inbox tasks | `things.read` |
| `things_get` | Read a task by its native ID | `things.read` |
| `things_create` | Create an Inbox task | `things.create` |
| `things_update` | Change title or notes | `things.read`, `things.update` |
| `things_set_status` | Complete or reopen a task | `things.read`, `things.complete` |
| `things_operation_status` | Recover a recorded mutation outcome | Original operation's scopes and client |

For example, read a task with `things_get`, then pass its returned revision to an
update. Generate one UUID per intended mutation and retain it for recovery:

```json
{
  "operationId": "019a7234-4580-7000-8000-000000000001",
  "id": "NATIVE_TASK_ID",
  "expectedRevision": "REVISION_FROM_THINGS_GET",
  "notes": null
}
```

This `things_update` call clears notes. Omitted fields stay unchanged. Do not reuse
the example UUID for separate operations. See the [tool contract](docs/tools.md)
for arguments, pagination, conflicts, and uncertain outcomes.

Dates, tags, moves, projects, areas, checklists, reminders, recurrence rules, and
lists other than Inbox are unsupported. Read-by-ID can reach tasks outside Inbox.
The service cannot identify a repeating template's relationship to its instances.
See [compatibility and evidence limits](docs/acceptance.md).

### Operate the service

```sh
"$HOME/Library/Application Support/ThingsMCP/things" status
"$HOME/Library/Application Support/ThingsMCP/things" doctor
"$HOME/Library/Application Support/ThingsMCP/things" logs
```

The [operations guide](docs/operations.md) covers backups, upgrades, rollback,
permission failures, and recovery after an interrupted write.

## How It Works

The client authenticates to the Worker using OAuth with PKCE. Cloudflare Access
protects the owner sign-in route. The Worker forwards each authorized request
through Tunnel with a short-lived signature bound to its method, path, content
type, body, owner, client, and scopes. The origin also requires a service Access
credential. One hostname carries both the public endpoints and protected origin.

The local service listens only on loopback. A SQLite journal records mutation IDs
and outcomes before dispatch. Writes are serialized and compare a fresh task
revision with the client's revision. Results expire after seven days; deduplication
records remain so an old request cannot silently become a new write.

Task operations do not open windows or request permission. If Things is closed,
the service attempts background startup; macOS may display a window during that
startup. The owner must be logged in with an unlocked console session. Health
checks do not launch Things. Automation permission is granted explicitly during
installation.

## Security

Deploy for one owner. The journal can contain task content and needs the same
protection as your Things data. Cloudflare handles OAuth state and request traffic;
review that trust boundary before deployment. Keep private signing keys, service
tokens, Tunnel credentials, and backups outside Git with owner-only permissions.

A revision check is not an atomic transaction with Things: an external edit can
race a write. An ambiguous native result is recorded as uncertain and is never
automatically retried. Request signing and the service credential are both required
even when a caller can reach the origin.

## Development

```sh
npm run typecheck
npm test
npm run build:worker
```

Tests use Vitest and isolated fixtures; manual live acceptance scripts are excluded
from the default suite. See [release maintenance](docs/releases.md) for versioning,
reviewed source tags, and the distinction between publishing and deployment.

## License

MIT. See [LICENSE](LICENSE).
