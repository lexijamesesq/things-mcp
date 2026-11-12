# Installation

This guide installs one owner-controlled deployment. It requires macOS, Things 3,
Node 26.13.0, Apple command-line developer tools (`xcode-select --install`), Python 3
for writing installation files, and `cloudflared`. Install Things at `/Applications/Things3.app`, the supported automatic-startup
location. Use a Cloudflare account with a
DNS zone, Workers, KV, Access, and Tunnel. Complete setup in the Things owner's
logged-in desktop session. The service cannot operate from a logged-out account.

Use your own hostname and identities throughout. `things.example.com`,
`owner@example.com`, and `example.cloudflareaccess.com` below are placeholders.
The public `/mcp` endpoint and protected `/_origin/mcp` path share one hostname.

## 1. Build and package source

Clone and check out the desired annotated release tag as shown in the README.
From that clean checkout:

```sh
npm ci
npm run build:native
npm run typecheck
npm test
node scripts/package-release.mjs 0.1.0
```

Packaging creates `~/Library/Application Support/ThingsMCP/releases/0.1.0`, including
native binaries, dependencies, source, and an integrity manifest. It refuses a
changed Git checkout or an existing destination. Keep this directory immutable.
Run all remaining shell snippets from the checkout in the same terminal unless
instructed otherwise. Set these installation variables:

```sh
export THINGS_BASE="$HOME/Library/Application Support/ThingsMCP"
export THINGS_RELEASE="$THINGS_BASE/releases/0.1.0"
export THINGS_NODE="$(node -p 'process.execPath')"
umask 077
mkdir -p "$THINGS_BASE/state" "$THINGS_BASE/logs" "$HOME/Library/LaunchAgents"
```

The resolved Node executable path must stay available. Do not point the LaunchAgent
at a package-manager shim that silently changes runtime versions.

## 2. Provision the Cloudflare boundary

Create an OAuth KV namespace and a dedicated Tunnel in your account. Configure the
hostname's proxied DNS record to target that Tunnel. Run its connector on this Mac
with `cloudflared`, using an owner-only token file and a separate user LaunchAgent
or your existing service manager. Do not place Tunnel tokens in Git or command-line
arguments. The connector and Things service have independent lifecycles.

Create two Access applications:

| Application | Protected path | Policy |
| --- | --- | --- |
| Owner login | `things.example.com/authorize` | Allow only your owner email through your identity provider |
| Origin | `things.example.com/_origin/*` | Service Auth allowing only a dedicated service token |

Record the owner application's AUD, Access team issuer, and your authenticated
Access identity's subject (`user_uuid` from Access identity). The Worker requires
both the exact email and subject. Record the origin application's separate AUD and
the service token's client ID and secret. Do not interchange the two AUD values.

Configure Tunnel ingress with hostname `things.example.com`, path
`^/_origin/mcp$`, and service `http://127.0.0.1:19763`. Require Access JWT validation
at the connector with your team name and the **origin** AUD. The ingress settings
are equivalent to:

```yaml
ingress:
  - hostname: things.example.com
    path: ^/_origin/mcp$
    service: http://127.0.0.1:19763
    originRequest:
      access:
        required: true
        teamName: example
        audTag:
          - ORIGIN_ACCESS_AUD
  - service: http_status:404
```

For a remotely managed Tunnel, set these values in its ingress configuration; for
a locally managed Tunnel, include its tunnel ID and credentials-file settings in
your private cloudflared configuration. Keep the catch-all 404. Do not expose the
local port on your LAN or add a Worker route covering `/_origin/*`.

The repository's Worker routes cover `/mcp*`, `/authorize*`, `/oauth/*`,
`/register*`, and `/.well-known/*` only. Keep `global_fetch_strictly_public` enabled
so the Worker's origin subrequest traverses the public Access boundary.

## 3. Generate signing keys and local configuration

Generate the request-signing key once. This writes a private JWK and a separate
public JWK outside the checkout and refuses to overwrite either:

```sh
node --input-type=module <<'JS'
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
for (const [name, key] of [['signing-private', privateKey], ['signing-public', publicKey]]) {
  writeFileSync(join(process.env.THINGS_BASE, `${name}.json`),
    JSON.stringify(key.export({ format: 'jwk' })), { flag: 'wx', mode: 0o600 });
}
JS
```

Set your deployment values (the subject is an identifier, not an OAuth token):

```sh
export THINGS_PUBLIC_HOST='things.example.com'
export THINGS_OWNER_SUBJECT='YOUR_ACCESS_IDENTITY_SUBJECT'
export THINGS_TIMEZONE='YOUR_MAC_IANA_TIMEZONE'
export THINGS_SIGNING_KID='initial'
```

The configured `timezone` must use the same IANA name as the Mac's system timezone.
Replace the example with your Mac's actual zone; a mismatch fails native access
rather than shifting scheduled dates. Keep the setting aligned after travel or a
system timezone change. The service never changes the Mac's timezone itself.

Create the local configuration with absolute paths. The runtime does not expand
shell variables inside JSON. This command performs expansion before writing:

```sh
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const e = process.env;
const origin = `https://${e.THINGS_PUBLIC_HOST}`;
const config = {
  port: 19763, timezone: e.THINGS_TIMEZONE,
  journal: join(e.THINGS_BASE, 'state/operations.sqlite'),
  nativePath: join(e.THINGS_RELEASE, 'build/things-bridge'),
  originPath: '/_origin/mcp',
  hosts: ['127.0.0.1:19763', e.THINGS_PUBLIC_HOST],
  origins: [origin],
  trust: {
    issuer: origin, audience: 'things-mcp-studio', owner: e.THINGS_OWNER_SUBJECT,
    keys: { [e.THINGS_SIGNING_KID]: JSON.parse(readFileSync(join(e.THINGS_BASE,
      'signing-public.json'), 'utf8')) }
  }
};
writeFileSync(join(e.THINGS_BASE, 'config.json'), JSON.stringify(config, null, 2),
  { flag: 'wx', mode: 0o600 });
JS
```

`hosts` contains exact HTTP Host values; `origins` contains exact permitted browser
Origin values. The Worker also permits only its public origin when an Origin
header is present; adding a local origin alone does not enable cross-origin browser
clients. An absent Origin header is permitted. The audience string must
match `STUDIO_AUDIENCE` in the Worker configuration. The key-map name must match
`THINGS_SIGNING_KID`; the public JWK must match the Worker's private JWK.

Initialize the journal **only for a new installation**:

```sh
node --input-type=module <<'JS'
import { closeSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { Journal } from './src/journal.ts';
const path = join(process.env.THINGS_BASE, 'state/operations.sqlite');
closeSync(openSync(path, 'wx', 0o600));
new Journal(path).close();
JS
```

This refuses an existing file. Runtime startup deliberately refuses a missing or
uninitialized journal; silently recreating it would lose replay protection. If
initial setup fails after file creation, inspect the failure before removing an
unused empty file. Never reinitialize a journal from an existing installation.

## 4. Install and authorize the LaunchAgent

Create a LaunchAgent for the logged-in owner. The default label is
`org.things-mcp.service`; an existing installation can retain a different label by
setting `THINGS_SERVICE_LABEL` for operator commands. The generated operator wrapper
preserves the label from the plist.

```sh
python3 - <<'PYTHON'
import os, pathlib, plistlib
base = pathlib.Path(os.environ['THINGS_BASE'])
release = pathlib.Path(os.environ['THINGS_RELEASE'])
job = {
  'Label': 'org.things-mcp.service',
  'ProgramArguments': [str(release / 'build/Things MCP'),
    str(base / 'state/executor.lock'), os.environ['THINGS_NODE'],
    str(release / 'src/main.ts'), str(base / 'config.json')],
  'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 30,
  'ExitTimeOut': 35, 'LimitLoadToSessionType': 'Aqua',
  'StandardOutPath': str(base / 'logs/service.log'),
  'StandardErrorPath': str(base / 'logs/error.log')
}
path = pathlib.Path.home() / 'Library/LaunchAgents/org.things-mcp.service.plist'
with path.open('xb') as f:
  plistlib.dump(job, f)
path.chmod(0o600)
PYTHON
```

Authorize Automation using this same launcher, Node path, and LaunchAgent identity.
Open Things first: the setup status probe requires it already running. Do this
explicitly during installation, while you can respond to a macOS prompt.
Temporarily switch the plist to the one-shot setup entrypoint and disable KeepAlive:

```sh
export THINGS_PLIST="$HOME/Library/LaunchAgents/org.things-mcp.service.plist"
cp "$THINGS_PLIST" "$THINGS_BASE/runtime.plist"
/usr/libexec/PlistBuddy -c "Set :ProgramArguments:3 $THINGS_RELEASE/src/authorize-setup.ts" "$THINGS_PLIST"
/usr/libexec/PlistBuddy -c 'Set :KeepAlive false' "$THINGS_PLIST"
launchctl bootstrap "gui/$(id -u)" "$THINGS_PLIST"
```

Approve control of Things if prompted. Inspect `logs/service.log` and
`logs/error.log` for the setup result. Wait for the one-shot process to exit before
continuing. Running the helper from a terminal instead would qualify a different
Automation identity. After successful authorization, restore the runtime plist:

```sh
launchctl bootout "gui/$(id -u)/org.things-mcp.service"
cp "$THINGS_BASE/runtime.plist" "$THINGS_PLIST"
"$THINGS_NODE" "$THINGS_RELEASE/src/operator.ts" activate 0.1.0
"$THINGS_BASE/things" start
"$THINGS_BASE/things" doctor
```

Normal runtime requests cannot prompt for Automation consent. A macOS background
activity notification may name the service launcher during installation. `doctor`
checks files, journal integrity, and whether the job is loaded; it does not prove
live native authorization. Verify that through authenticated `things_status` after
the gateway is deployed.

## 5. Configure and deploy the Worker

Set these build-time variables before building or deploying:

| Variable | Value |
| --- | --- |
| `THINGS_CF_ACCOUNT_ID` | Cloudflare account ID |
| `THINGS_OAUTH_KV_ID` | OAuth KV namespace ID |
| `THINGS_PUBLIC_HOST` | Hostname without scheme or path |
| `THINGS_CF_ZONE` | DNS zone name |
| `THINGS_OWNER_EMAIL` | Exact owner email from Access |
| `THINGS_ACCESS_ISSUER` | `https://YOUR_TEAM.cloudflareaccess.com` |
| `THINGS_SIGNING_KID` | Key ID in local `trust.keys`, initially `initial` |

The pinned `cf` CLI reads `cloudflare.config.ts`. The signing key ID is required
even for local build checks, so an omitted value cannot silently change an existing
installation's signer. The other placeholder defaults are not deployable production
settings. Use `npx cf auth login` for
interactive Cloudflare administration, or supply `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` through your secret manager for CI. The token needs permission
to deploy this Worker's configured resources.

Prepare an owner-only JSON secrets file outside Git. Its keys and values are:

| Secret | Value |
| --- | --- |
| `ACCESS_AUD` | Owner-login Access application's AUD |
| `OWNER_SUBJECT` | Same subject as local `trust.owner` |
| `SIGNING_JWK` | JSON **string** containing the private JWK generated above |
| `CF_ACCESS_CLIENT_ID` | Origin service token client ID |
| `CF_ACCESS_CLIENT_SECRET` | Origin service token secret |

Use your secret manager or editor to populate it without putting secret values in
shell arguments or command history. `SIGNING_JWK` is a string inside the outer JSON
object, not a nested object. For example its shape is
`"SIGNING_JWK": "{\"kty\":\"OKP\",...}"`. Keep a recoverable protected copy of
all deployment credentials. Then build and deploy:

```sh
npm run build:worker
npx cf deploy --prebuilt --mode production --secrets-file "$THINGS_BASE/worker-secrets.json"
```

For a credential-free build check, use `npx cf deploy --dry-run`. Consult the pinned
CLI's `--help` and [Cloudflare CI guidance](https://developers.cloudflare.com/cf/ci/)
when adapting deployment to your own automation. The repository's release job
publishes source only; it does not provision Cloudflare resources or credentials.

## 6. Verify and connect

Confirm OAuth metadata is publicly reachable at
`https://YOUR_HOST/.well-known/oauth-authorization-server`. An unauthenticated
`/mcp` call must require OAuth. Direct `/_origin/mcp` access must be denied without
the service credential; the credential alone must still fail without a valid
request signature. Unmatched Tunnel paths must return 404.

Add the remote `/mcp` endpoint in your chosen OAuth-capable client. Approve a
read-only grant first, then call `things_status`, `things_capabilities`, and
`things_list`. Status should report native and journal readiness; a loaded
LaunchAgent or reachable OAuth page alone is insufficient.

If you want writes, grant the needed scopes explicitly and test only a disposable
task: create, read, edit, complete, then inspect its recorded operation outcome.
Observe silence with Things hidden and another app active. Never infer write
acceptance from a read-only grant. Retain backups and follow the
[operations guide](operations.md) before upgrades.
