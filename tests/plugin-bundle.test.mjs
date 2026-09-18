import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const PACKAGE_NAME = '@sagmans/dsh-auto-compact'
const CLI_PACKAGE = '@deepseek-ai/dsh'
const ROOT = fileURLToPath(new URL('../', import.meta.url))
// The profile mechanics under test belong to the CLI that ships to users, so
// the suite drives the registry build rather than a source checkout; the bin
// path comes from that package's own manifest instead of a guessed layout.
const CLI_MANIFEST = JSON.parse(readFileSync(join(ROOT, 'node_modules', CLI_PACKAGE, 'package.json'), 'utf8'))
const CLI = join(ROOT, 'node_modules', CLI_PACKAGE, CLI_MANIFEST.bin.dsh)
// The Web and TUI surfaces each compose their own host plane, so the swap has
// to hold in both rather than in whichever one is convenient.
const PROFILES = ['web', 'tui']
const TIMEOUT_MS = 30_000
const PLUGIN_ROW = /^\s*-?\s*name:\s*['"]?@sagmans\/dsh-auto-compact['"]?\s*$/gm
const OWN_ROW = 'auto-compact'
const SHIPPED_ROW = 'compaction-basic'
const SHIPPED_BUDGET = 200_000
const OVERRIDE_BUDGET = 12_000
const OVERRIDE = `- id: ${OWN_ROW}\n  config:\n    thresholdTokens: ${OVERRIDE_BUDGET}\n`

/**
 * Index a `--dump-config` document by its `- id:` rows.
 *
 * The document carries `!!js` tags no plain YAML parser accepts, and only the
 * row boundaries carry meaning here, so the text is split rather than parsed.
 */
function rows(dump) {
  const indexed = new Map()
  for (const block of dump.split(/^- id: /m).slice(1)) {
    indexed.set(block.slice(0, block.indexOf('\n')).trim(), block)
  }
  return indexed
}

for (const profile of PROFILES) {
  test(`CLI add/remove owns activation and the engine swap in the ${profile} profile`, () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-auto-compact-bundle-'))
    const run = (...args) => {
      const result = spawnSync(process.execPath, [CLI, ...args], {
        cwd: ROOT,
        env: {
          ...process.env,
          DSH_HOME: home,
          DSH_TELEMETRY_DISABLED: '1',
          npm_config_offline: 'true',
          npm_config_ignore_scripts: 'true',
        },
        encoding: 'utf8',
        timeout: TIMEOUT_MS,
      })
      assert.equal(result.status, 0, result.stderr || result.error?.message)
      return result.stdout
    }
    const add = () => run('plugin', '--profile', profile, 'add', '--offline', '--ignore-scripts', `link:${ROOT}`)
    const dump = () => rows(run('--profile', profile, '--dump-config'))
    const manifest = () => JSON.parse(readFileSync(join(home, 'profiles', profile, 'package.json'), 'utf8'))
    const activations = () => manifest().dsh.profile.bundles.filter((name) => name === PACKAGE_NAME).length
    try {
      add()
      assert.equal(activations(), 1)

      let plan = dump()
      assert.equal([...run('--profile', profile, '--dump-config').matchAll(PLUGIN_ROW)].length, 1)
      // Two providers of one service fail the mount rather than degrade, so the
      // bundle is only inert-safe once the shipped row is actually displaced.
      assert.match(plan.get(SHIPPED_ROW), /disabled: true/)
      assert.doesNotMatch(plan.get(OWN_ROW), /disabled: true/)
      assert.match(plan.get(OWN_ROW), new RegExp(`thresholdTokens: ${SHIPPED_BUDGET}`))

      writeFileSync(join(home, 'profiles', profile, 'cordis.patch.yml'), OVERRIDE)
      plan = dump()
      assert.match(plan.get(OWN_ROW), new RegExp(`thresholdTokens: ${OVERRIDE_BUDGET}`))

      add()
      assert.equal(activations(), 1)

      run('plugin', '--profile', profile, 'remove', PACKAGE_NAME)
      assert.equal(activations(), 0)
      // Only this bundle's own contribution is asserted here: whichever bundle
      // remains may still own the shipped row's state, so its post-removal
      // value is not this package's to claim.
      assert.equal([...run('--profile', profile, '--dump-config').matchAll(PLUGIN_ROW)].length, 0)

      add()
      assert.equal([...run('--profile', profile, '--dump-config').matchAll(PLUGIN_ROW)].length, 1)
      assert.match(dump().get(SHIPPED_ROW), /disabled: true/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
}
