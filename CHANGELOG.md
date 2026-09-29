# Changelog

All notable changes to `@sagmans/dsh-auto-compact` are recorded in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) with
the 0.x caveat [RELEASE.md](RELEASE.md) states: while at 0.x a minor bump may
carry a breaking change, and a patch carries only fixes.

## [Unreleased]

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

- The supported harness line is `>=0.1.5-rc.1 <0.2.0`, and
  `dsh.compatibility.dshReleases` names the releases that passed the gates:
  `0.1.5-rc.2`, `0.1.5-rc.3`, and `0.1.7-rc.2`. The former `<0.1.6` ceiling
  was the one side out of step with the range's own intent: the harness refuses
  to install a plugin whose peers do not cover the running release, so a profile
  on `0.1.5-rc.3` or `0.1.7-rc.2` was told the plugin is incompatible and
  offered only a per-version risk exemption. The engine itself needed no change
  for either line: the 0.1.7 line keeps the same `compaction-basic` engine API,
  so the absolute budget binds there the way it does on 0.1.5.
