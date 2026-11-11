# Release maintenance

Releases use the same trusted-main pattern as
[eve-plus](https://github.com/lexijamesesq/eve-plus/blob/main/.github/scripts/tag-package-release.sh):
an annotated, immutable `<package>--v<version>` tag and a GitHub Release for that
tag's source. This repository has one package, so its first tag is
`things-mcp--v0.1.0`. GitHub supplies source archives; no cross-platform binary or
npm publication is implied.

## Prepare and review

Update `package.json`, the root package version in `package-lock.json`, and the MCP
server version in `src/http.ts` together. Record user-visible changes and upgrade
limits in `CHANGELOG.md`. Use semantic versions; breaking changes before 1.0 use a
minor-version increment. Local installation directory labels are not public
release versions.

Run `npm run typecheck`, the relevant existing Vitest suites, `npm run build:native`
on macOS, and `npm run build:worker`. Validate changes through the normal pull
request checks and independent review. Release automation runs only after the
reviewed change reaches `main`; it does not merge pull requests or bypass branch
protections.

## Publish

The `release-tag` job in `.github/workflows/ci.yml` reads the package version after
each main push. It runs the existing release script against the root package,
creates an annotated tag if missing, and creates generated GitHub release notes.
Only this job receives `contents: write`. An existing tag is never moved: retries
resolve its own commit and finish the release for that source.

Inspect the successful workflow, tag target, and release at
[GitHub Releases](https://github.com/lexijamesesq/things-mcp/releases). If publication
fails after tagging, rerun the failed workflow. Do not delete or retag a version;
fix source through a new reviewed version. A main push without a version change
leaves the existing release attached to its original source.

## Deploy separately

Publishing source does not install it on any Mac or change a Cloudflare Worker.
Follow [installation](deployment.md) for a new deployment and
[operations](operations.md) for upgrades. The local packaging manifest inventories
the built runtime and records the source commit. It is an installation integrity
check, not a publisher signature or a substitute for checking the source tag.

Native binaries and Node's executable path are part of the macOS Automation
identity. Ordinary activation retains that identity and rejects changed native
binaries. Qualify native or Node upgrades explicitly before changing an installed
service. Never authorize a different identity merely to make an upgrade pass.
