# Things MCP

Owner-only Things 3 access through an OAuth gateway and a local macOS service.
Things remains the task store. SQLite records durable mutation outcomes and recovery.

## Development

Use Node 26.13.0, `npm ci`, `npm run build:native`, `npm run typecheck`, and `npm test`.
`npm test` runs the existing behavioral suite with Vitest. Manual live-acceptance
scripts are excluded. The native build requires macOS and the Apple command-line
developer tools.

## Status

The qualified runtime supports Inbox listing, reads by native ID, task creation,
title and notes edits, notes clearing, completion, and reopening. Dates, tags,
parent changes, recurrence rules, and broader list scopes remain unsupported.
See [acceptance evidence](docs/acceptance.md) and the
[build specification](docs/build-specification.md).

Task operations remain silent. When Things is closed, the service opens it automatically,
preferring background startup. Visible UI is acceptable during that startup only.
