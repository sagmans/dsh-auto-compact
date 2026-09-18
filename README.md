# dsh-auto-compact

A DeepSeek Harness compaction backend that adds an absolute token budget to the
shipped window-ratio trigger. It condenses at a fixed price on large-window
models, while every model whose window is already smaller than that budget keeps
its proportional trigger.

```
trigger = min(thresholdTokens, floor(contextWindow x thresholdRatio))
```

Published on npm as [`@sagmans/dsh-auto-compact`](https://www.npmjs.com/package/@sagmans/dsh-auto-compact); every release carries a provenance attestation built by the tag workflow, and no npm token is stored. The code is [MIT licensed](LICENSE).

## Requirements

- Node.js 24 LTS (verified with 24.20.0).
- pnpm 11.21.0 for this repository.
- A DeepSeek Harness install on the supported line: `>=0.1.5-rc.1 <0.1.6` (verified against `0.1.5-rc.2`). The plugin declares that range as a peer dependency, so a profile resolves the harness copy it already has rather than a second framework instance.

## Configuration

Every shipped setting keeps its meaning; this backend adds two fields and one
per-route override.

| Field | Default | Meaning |
|---|---|---|
| `thresholdTokens` | — | Absolute trigger budget in tokens. Omitted means the ratio trigger alone. |
| `retainShare` | `0.2` | Retained tail as a fraction of the derived trigger, applied only when the budget is what triggers condensation. |
| `modelPolicies[].thresholdTokens` | — | Budget for one exact `provider`/`model` route. |
| `thresholdRatio`, `retainRatio`, `retainTokens`, `summarizationProvider`, `summarizationModel`, `maxTokens`, `compactionRetries`, `maxOverflowRetries`, `modelPolicies`, `auto` | shipped | Unchanged; see the shipped backend documentation. |

```yaml
- id: auto-compact
  name: '@sagmans/dsh-auto-compact'
  config:
    thresholdTokens: 200000
    modelPolicies:
      - provider: opencode-go-session
        model: deepseek-flash
        thresholdTokens: 120000
```

## Trigger examples

| Context window | `thresholdRatio` | `thresholdTokens` | Trigger |
|---|---|---|---|
| 1,000,000 | 0.8 | 200,000 | **200,000** (budget) |
| 262,144 | 0.8 | 200,000 | **200,000** (budget) |
| 131,072 | 0.8 | 200,000 | 104,857 (ratio) |
| 1,000,000 | 0.8 | — | 800,000 (ratio only) |

## Install

The bundle patch disables the shipped `compaction-basic` row and inserts this
backend in its place, so the profile keeps exactly one compaction service.

```sh
dsh plugin --profile tui add link:/path/to/dsh-auto-compact
dsh --profile tui --dump-config | grep -A3 'id: auto-compact'
```

Profile-specific tuning belongs in `$DSH_HOME/profiles/<name>/cordis.patch.yml`,
which the profile watches:

```yaml
- id: auto-compact
  config:
    thresholdTokens: 200000
```

Restart the profile after a bundle change. Tune the patch file afterwards
without a restart.

## Where the engine runs

The TUI and Web bundles disable the host-plane compaction rows so that each
agent preset owns an engine in its own realm. This bundle provides the service
on the host plane, which serves every agent because an unscoped listener
receives all agent events. A preset that still mounts the shipped backend keeps
it as a later listener: that engine can only condense after this one already
did, or at its own wider ratio trigger, so it stays inert.

Two consequences are worth knowing:

- The host plane mounts no tool-result pruner in those profiles, so
  condensation here summarizes without the model-free prune pass. Insert a
  `tool-result-pruner` row at the host plane if you want that pass.
- A deployment that wants exactly one engine can instead copy the agent preset
  it uses, point that copy's `compaction-basic` row at this package, and select
  the copy as the default preset. The copy is a snapshot and drifts from the
  shipped preset.

## How it works

The absolute budget cannot be expressed as a shipped setting, so the engine
subclasses the shipped backend and overrides `compactIfNeeded` for the pressure
trigger only:

1. Read the durable route and the budget for it. Below the budget, delegate
   unchanged and make no capacity lookup.
2. Read the routed model's context window from the adapter.
3. Derive the trigger and the retained tail, then run the shipped transaction
   under that policy.

The shipped engine resolves its policy from a frozen instance field, so the
derived policy is placed on a per-call receiver that shares the engine's
context and state. A field swap would leak between agents condensing
concurrently on different routes.

Provider-confirmed context overflow, `/compact`, and `auto: false` keep their
shipped behaviour. Overflow recovery never consults a threshold.

## Verification

Unit tests cover the decision surface, including the boundary where the budget
stops binding and the point where the derived trigger must carry the decision
past the shipped ratio check.

A controlled pair of real sessions proves the trigger end to end. Both runs used
the same task, the same route, and a reported window of 1,000,000 tokens, where
the shipped ratio trigger is 800,000:

| Run | `thresholdTokens` | Compaction events |
|---|---|---|
| A | 8,000 | 4 starts, 3 summaries, 1 prune |
| B | — | none |

Reproduce it with a scratch profile:

```sh
dsh --profile autocompact-dogfood --from-default-profile headless --dump-config
dsh plugin --profile autocompact-dogfood add link:/path/to/dsh-auto-compact
# patch the profile with the route rows and a small thresholdTokens, then:
cd /tmp/dsh-auto-compact-dogfood
dsh --profile autocompact-dogfood "cat big-a.md big-b.md, then report the character count"
zstd -dc ~/.dsh/sessions/--private-tmp-dsh-auto-compact-dogfood--/*/session.v3.jsonl.zstd \
  | grep -oE '"type":"compaction/[a-z]+"' | sort | uniq -c
```

Remove `thresholdTokens` and the same run must report no compaction events.

## Limits

- The adapter must report a context window. A route without one keeps the
  shipped warn-once failure and no capacity is guessed.
- Token pressure comes from the shipped meter (four characters per token, with
  provider usage when available), so a budget is as accurate as that meter.
- Per-route overrides match exactly; there is no wildcard matcher.
- A budget below the fixed request envelope (system prompt plus tool schemas)
  cannot be satisfied. The shipped retry policy then warns and continues the
  turn.

## Development

```sh
pnpm install
pnpm run check   # typecheck, unit tests, build, built-artifact tests, release guards, pack smoke
```

The profile loads `dist/index.js`, so rebuild and restart the profile after a
source change.

## Releasing

Published artefacts carry a provenance attestation, which only a CI provider can issue, so releases ship from the tag workflow rather than a laptop.

1. Bump `version` in `package.json`, land it on `main` through a reviewed PR, and wait for CI to pass on the merged SHA.
2. Tag that SHA with a signed tag and push it. The tag ruleset admits repository admins only.
3. [`.github/workflows/release.yml`](.github/workflows/release.yml) re-runs the checks and the package smoke; the publish job then waits for a maintainer's approval on the `npm-release` environment before it publishes with OIDC trusted publishing and automatic provenance.

The workflow stores no npm token: the registry trusts `release.yml` on the `npm-release` environment, and [`scripts/npm/release.py`](scripts/npm/release.py) creates both the environment and that trust. The full runbook is [RELEASE.md](RELEASE.md).

## License

MIT
