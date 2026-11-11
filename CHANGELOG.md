# Changelog

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
