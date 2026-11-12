# Changelog

## 0.2.0

- Optional scheduled start dates on task creation and updates, using explicit
  calendar dates in the service timezone; deadlines remain read-only.
- Start and deadline readback participates in revisions and preservation checks.
- Scheduled creation records creation and scheduling separately for safe recovery.

Requires explicit qualification of the changed native helper before deployment.
Hosted scheduling acceptance remains pending; refresh task revisions
and client tool metadata after upgrading. See [evidence limits](docs/acceptance.md).

## 0.1.0

Initial source release.

- Owner-only OAuth gateway with scoped access through Cloudflare Access and Tunnel.
- Native Things reads, open Inbox pagination, creation, title and notes edits,
  completion, and reopening.
- Durable operation IDs, revision conflicts, retained mutation outcomes, and
  fail-closed recovery after ambiguous dispatch.
- Explicit Automation setup, background-first startup, and silent task operations.
- Local packaging, journal backup and restore, and verified runtime activation.

Requires macOS, Things 3, Node 26.13.0, and a self-hosted Cloudflare deployment.
See [compatibility and evidence limits](docs/acceptance.md) before installation.
