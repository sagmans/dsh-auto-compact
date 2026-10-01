# AGENTS.md

`@sagmans/dsh-auto-compact` triggers automatic compaction in DeepSeek Harness.
Behaviour and configuration: [README.md](README.md). Release gates and npm
controls: [RELEASE.md](RELEASE.md).

## Contributing

Work in a feature worktree and land through a reviewed PR; never push directly
to `main`. Use scoped Conventional Commits, signed and DCO-signed. Every PR
adds its `CHANGELOG.md` entry under `## [Unreleased]`.

`pnpm run check` runs typecheck, unit tests, build, built-output tests,
release-helper guards, tarball smoke, and the harness matrix guard.
`pnpm test:release` uses synthetic CLIs and performs no registry publication.
No credentials belong in the repository. Test profiles use a scratch
`DSH_HOME`, never the developer's live home.

## Release and publication

Read [RELEASE.md](RELEASE.md) before preparing a version, pushing a release tag,
publishing, or repairing a release record. Shipping a documentation or code PR
is not approval to publish. Require explicit maintainer approval for publication
and each remote release action; never publish on your own initiative.

1. Land the candidate through a reviewed PR to `main`. Match `package.json`
   `version`, the `vX.Y.Z` tag, and the versioned `CHANGELOG.md` entry.
   Pass the release gates in `RELEASE.md` on the exact merged commit.
2. Create an annotated, signed tag on that commit:
   `git tag -s -a "vX.Y.Z" -m "vX.Y.Z" <merged-sha>`.
   Verify it with `git verify-tag "vX.Y.Z"`. Never use a lightweight or unsigned
   release tag; require GitHub to verify the signature after the approved push.
3. Push only that tag with `git push origin "vX.Y.Z"` after approval.
   `.github/workflows/release.yml` verifies the tag and publishes through npm
   OIDC trusted publishing after the `npm-release` environment approval.
   Wait for success; never substitute a local `npm publish`. The documented
   first-publication bootstrap is a maintainer-only exception, not a retry path.
4. After publication succeeds, create the GitHub release from the existing tag:
   `gh release create "vX.Y.Z" --verify-tag --title "vX.Y.Z" --notes-file <notes-file>`.
   Use that version's changelog entry as notes. Set `--latest=false` when filling
   an older release so it does not replace the current latest release.
5. Read back the npm version, tarball integrity and available provenance, the
   remote tag's verified signature and source commit, and the published GitHub
   release for the same version. A green workflow alone is not completion:
   every npm version requires its own signed tag and GitHub release record.

Published versions and tags are immutable. Never delete, move, or re-sign an
existing release tag, and never republish or unpublish an existing npm version.
For a missing GitHub release, verify the existing signed tag and create only its
release record with `--verify-tag`; do not push another tag or retry publication.
If a tag or signature is missing or invalid, stop and ask the maintainer; do not
invent a source commit from current `main`. Forward-fix broken packages as
`RELEASE.md` directs. Helper mutations require `CONFIRM=<action>`; preview
with `DRY_RUN=1`.
