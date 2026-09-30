# Changelog

All notable changes to `@sagmans/dsh-auto-compact` are recorded in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) with
the 0.x caveat [RELEASE.md](RELEASE.md) states: while at 0.x a minor bump may
carry a breaking change, and a patch carries only fixes.

## [Unreleased]

## [0.2.0] - 2026-09-30

### Added

- `pnpm run matrix` guards the harness matrix offline, and a scheduled
  [`harness-matrix.yml`](.github/workflows/harness-matrix.yml) reads the
  registry's `latest`. The plugin mounts no harness package, so the rules it
  enforces are the ones this package actually declares: every harness peer
  carries the compatible range, the harness `devDependencies` name exactly one
  verified release, and any mounted package or aliased install names a verified
  release — npm reaches a prerelease only through a range comparator naming that
  exact `X.Y.Z` tuple, so no single range spans two prerelease lines and a row
  serving a newer line has to name it.

### Changed

- The supported harness line is `>=0.1.5-rc.1 <0.3.0`, and
  `dsh.compatibility.dshReleases` names the releases that passed the gates:
  `0.1.5-rc.2`, `0.1.5-rc.3`, `0.1.7-rc.2`, and `0.2.0-rc.2`. The former
  `<0.1.6` ceiling was the one side out of step with the range's own intent: the
  harness refuses to install a plugin whose peers do not cover the running
  release, so a profile on `0.1.5-rc.3` or `0.1.7-rc.2` was told the plugin is
  incompatible and offered only a per-version risk exemption. The engine itself
  needed no change for either line: the 0.1.7 line keeps the same
  `compaction-basic` engine API, so the absolute budget binds there the way it
  does on 0.1.5.
- The range now covers the 0.2.0 line, whose prerelease the harness admits
  because it evaluates peers with `includePrerelease`; `0.2.0-rc.2` passed the
  gates and a dogfood on the published 0.2.0-rc.2 CLI. The harness
  `devDependencies` compile against `0.2.0-rc.2`, the one release npm resolves
  for that line here: npm reaches a prerelease only through a comparator naming
  its exact tuple, so neither this package's range nor a peer can pull it in.
  Every harness peer keeps the width of `dsh.compatibility.dsh` so a consumer
  resolves the framework copy its profile already runs.

### Fixed

- The release helper answers npm 12's metadata shape and npm's browser prompt, so
  every OTP-gated action works on a setup [RELEASE.md](RELEASE.md) calls
  supported. A version-qualified view answers with a one-element list on npm 12
  where npm 11 answers with the object itself, and the metadata check demanded an
  object: a supported npm was refused outright, and the failure read as corrupt
  registry data rather than a shape difference. The PTY that carries npm's
  authentication URL was opened and never written to, while npm prints that URL
  and then waits for a keypress before it polls for approval, so the read stalled
  until the window closed and the operator was never asked. The helper and its
  guards are shared with the sibling plugin packages, so this carries the same
  fix they do rather than a second implementation that would drift from them.

[Unreleased]: https://github.com/sagmans/dsh-auto-compact/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/sagmans/dsh-auto-compact/compare/v0.1.0...v0.2.0
