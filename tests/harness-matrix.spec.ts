/**
 * Harness-matrix guard tests: the manifest rules this package declares, and the
 * failures the guard has to report before a profile installs the plugin against
 * a harness line no gate has seen.
 *
 * The tool reads a manifest path, so a case can break one rule at a time
 * without touching the real manifest.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const TOOL = join(ROOT, 'tools', 'harness-matrix.mjs')
/** The peer range this plugin accepts, wider than the releases its gates ran on. */
const RANGE = '>=0.1.5-rc.1 <0.3.0'
/** The releases the gates passed against; each one is a distinct line of evidence. */
const VERIFIED = ['0.1.5-rc.2', '0.1.5-rc.3', '0.1.7-rc.2', '0.2.0-rc.2']
/** A release no gate has seen: neither a verified release nor the range's first candidate. */
const UNVERIFIED = '0.1.5-rc.1'

const shipped = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** The manifest fields the guard reads; every other field is ignored. */
interface Manifest {
  name: string
  dsh: { compatibility: { dsh: string; dshReleases: Record<string, string> } }
  peerDependencies: Record<string, string>
  devDependencies: Record<string, string>
  dependencies?: Record<string, string>
  scripts?: Record<string, string>
}

/** A matrix that passes, so each case can break exactly one rule. */
function matrix(overrides: Partial<Manifest> = {}): Manifest {
  const base: Manifest = {
    name: '@sagmans/dsh-auto-compact',
    dsh: {
      compatibility: {
        dsh: RANGE,
        dshReleases: Object.fromEntries(VERIFIED.map(release => [release, 'compatible'])),
      },
    },
    peerDependencies: { '@deepseek-ai/dsh-agent': RANGE },
    devDependencies: { '@deepseek-ai/dsh': VERIFIED[0], '@deepseek-ai/dsh-agent': VERIFIED[0] },
  }
  return Object.assign(base, overrides)
}

/** Run the guard against one manifest and report its exit code with its output. */
function guard(manifest: Manifest) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-auto-compact-matrix-'))
  try {
    const path = join(home, 'package.json')
    writeFileSync(path, JSON.stringify(manifest, null, 2))
    const result = spawnSync(process.execPath, [TOOL, '--manifest', path], { encoding: 'utf8' })
    assert.equal(result.error, undefined)
    return { code: result.status, output: result.stdout + result.stderr }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

describe('harness matrix', () => {
  it('accepts a matrix that names the range, one verified release, and that release\'s peers', () => {
    const { code, output } = guard(matrix())
    assert.equal(code, 0, output)
    assert.match(output, /harness-matrix: ok \(4 verified, compiled 0\.1\.5-rc\.2, peers >=0\.1\.5-rc\.1 <0\.3\.0\)/)
  })

  it('declares the wider line, the verified releases, and the guard in this manifest', () => {
    const compatibility = shipped.dsh.compatibility
    assert.equal(compatibility.dsh, RANGE)
    for (const release of VERIFIED) {
      assert.equal(compatibility.dshReleases[release], 'compatible', release + ' must be verified')
    }
    for (const [name, declared] of Object.entries(shipped.peerDependencies)) {
      if (name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')) {
        assert.equal(declared, RANGE, name + ' must accept the whole compatible range')
      }
    }
    assert.match(shipped.scripts.check, /pnpm run matrix/,
      'the guard is only a gate when the check script runs it')
    const { code, output } = guard(shipped)
    assert.equal(code, 0, output)
  })

  it('rejects a verified release outside the range', () => {
    const broken = matrix()
    broken.dsh.compatibility.dshReleases['0.3.0'] = 'compatible'
    const { code, output } = guard(broken)
    assert.equal(code, 1)
    assert.match(output, /verified release 0\.3\.0 lies outside the compatible range/)
  })

  it('rejects a peer that names one release instead of the range', () => {
    const broken = matrix({ peerDependencies: { '@deepseek-ai/dsh-agent': VERIFIED[2] } })
    const { code, output } = guard(broken)
    assert.equal(code, 1)
    assert.match(output, /peer @deepseek-ai\/dsh-agent declares 0\.1\.7-rc\.2, not the compatible range/)
  })

  it('rejects harness devDependencies that name more than one release', () => {
    const broken = matrix({
      devDependencies: { '@deepseek-ai/dsh': VERIFIED[0], '@deepseek-ai/dsh-agent': VERIFIED[2] },
    })
    const { code, output } = guard(broken)
    assert.equal(code, 1)
    assert.match(output, /the harness devDependencies name 2 versions, not one/)
  })

  it('rejects harness devDependencies that name an unverified release', () => {
    const broken = matrix({
      devDependencies: { '@deepseek-ai/dsh': UNVERIFIED, '@deepseek-ai/dsh-agent': UNVERIFIED },
    })
    const { code, output } = guard(broken)
    assert.equal(code, 1)
    assert.match(output, /the harness devDependencies compile against 0\.1\.5-rc\.1, which is not a verified release/)
  })

  it('accepts a mounted row that accepts the range, and rejects one that names an unverified release', () => {
    const ranged = guard(matrix({ dependencies: { '@deepseek-ai/dsh-token-meter': RANGE } }))
    assert.equal(ranged.code, 0, ranged.output)

    const pinned = guard(matrix({ dependencies: { '@deepseek-ai/dsh-token-meter': '0.1.8-rc.1' } }))
    assert.equal(pinned.code, 1)
    assert.match(pinned.output,
      /mounted package @deepseek-ai\/dsh-token-meter declares 0\.1\.8-rc\.1, which is neither the compatible range/)
  })

  it('rejects an aliased install whose version is not a verified release', () => {
    const broken = matrix({
      dependencies: { '@sagmans/dsh-token-meter-017': 'npm:@deepseek-ai/dsh-token-meter@0.1.8-rc.1' },
    })
    const { code, output } = guard(broken)
    assert.equal(code, 1)
    assert.match(output, /aliased dependency @sagmans\/dsh-token-meter-017 declares npm:@deepseek-ai\/dsh-token-meter@0\.1\.8-rc\.1, whose version is not a verified release/)
  })
})
