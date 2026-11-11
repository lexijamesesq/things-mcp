# Agent working contract

The existing estate Git template installs pre-commit, pre-push, commit-msg and
prepare-commit-msg entrypoints in new agent clones and initializations. Linked
worktrees share their repository's hook directory. Checks run at ordinary Git
events; no session-start setup is needed. Pre-commit installs and caches managed
hook environments when first used.

For an existing checkout missing its native hooks, install them once from its
root:

```sh
pre-commit validate-config .pre-commit-config.yaml
pre-commit install --hook-type pre-commit --hook-type pre-push \
  --hook-type commit-msg --hook-type prepare-commit-msg
```

Preserve custom hooks and `core.hooksPath`; integrate their owner rather than
unsetting or overwriting it. Native hook installation does not install system
binaries. Existing host provisioning owns them, including Vale for prose checks;
the established Homebrew declaration supplies Vale through normal package
verification. Repository-native setup owns project dependencies and required files. Missing
prerequisites must fail clearly through the applicable hook or project command.
Do not run project tests merely to install hooks, or rerun installation each
session. `DOTTY_CHECKOUT` selects maintained reviewed source for shared commands.

Use the native hook stages and repository commands. Do not bypass checks with
`--no-verify`, `SKIP`, altered hook paths, or disabled scanners. Correct the finding
and retry. Keep staged-content, commit-message and outgoing-history scans active;
never expose scanner findings containing confidential content. Before every PR create or body edit, validate the exact body file with
`python3 "$DOTTY_CHECKOUT/.github/scripts/pr-body-check.py" --template .github/pull_request_template.md --body-file <body-file>`
(or `--body-file -` for stdin). Publish that same file with `gh pr create --body-file`
or `gh pr edit --body-file`. This validates
structure; retain applicable content/confidentiality scanning too.

Finish the candidate and relevant local checks before publication. For a new PR,
push successfully, then create it once with the complete title and validated
body. Do not publish a placeholder and immediately replace it, or edit
descriptions just to add CI progress or run links visible on GitHub.

For an existing PR, finish the local changes and prepare any necessary description
update before pushing. Identify the outgoing commit and only checks already
completed; do not claim a future push or hook result. Validate and scan the exact
body file as above. After the normal push succeeds, publish the necessary edit
once, immediately, before polling CI or drafting further prose. Combine title and
body changes in that edit. If the push fails, resolve it and revalidate any changed
candidate or body before publication. Read back the final head, title and body,
then follow CI and Margot through completion.

Keep scope, risk and verification claims accurate for the published head. A push
and a description edit are separate GitHub events; a prompt edit gives native
cancellation an earlier opportunity to stop superseded work but cannot guarantee
zero wasted runner time. Preserve description-triggered scanning, classification
and review, and the existing cancellation behavior.

Test changed behavior through its real interface using the narrowest relevant
existing suite. Do not add implementation-mirroring assertions, test-count quotas
or a new fleet suite. A new regression assertion needs a meaningful negative
control or red/green result; invalid imports or broken fixtures do not count.
Fixture repositories must clear inherited Git routing so tests cannot mutate the
caller's object store. Distinguish source tests from actual installed-agent proof.

Author Git and GitHub work with the identity the environment already provides: the operator’s own in sessions she drives, an autonomous agent’s own for that agent.

## Things MCP

Use Node 26.13.0. Install with `npm ci`, compile the macOS helper with
`npm run build:native`, and run `npm run typecheck` and `npm test` for affected
runtime behavior. `npm test` uses Vitest; extend existing behavioral coverage only
for a demonstrated gap. Manual acceptance scripts are outside the default suite.
The native helper requires macOS and the logged-in Things owner.

Normal task access must be silent. If Things is closed, use bounded background-first
startup; the owner accepts visible UI for startup only. Never prompt for Automation
permission during runtime. Never retry an ambiguous mutation.

The specification is in `docs/build-specification.md`. The narrow title/notes/status write surface is qualified; retain the evidence limits
and unsupported fields described in `docs/acceptance.md`.
