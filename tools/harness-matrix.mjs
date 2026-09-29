#!/usr/bin/env node
/**
 * Harness matrix guard.
 *
 * This plugin's peers accept the whole compatible range so a profile resolves
 * the harness copy it already runs, while its dev tree compiles against one
 * verified release: a tree whose peers, devDependencies, and verified list
 * disagree is how a profile ends up mounting a copy from a line the plugin was
 * never proven against. The default mode checks that matrix offline;
 * --check-registry also reads the registry's latest dist-tag and fails when the
 * harness has moved past the verified list.
 *
 * --manifest checks a copy instead of this repository's manifest, which is how
 * the rule tests exercise a matrix that must fail.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf('--' + name)
  return index >= 0 ? args[index + 1] : undefined
}
const manifestPath = resolve(ROOT, option('manifest') ?? 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const compatibility = manifest.dsh?.compatibility?.dsh
const releases = Object.keys(manifest.dsh?.compatibility?.dshReleases ?? {})
const problems = []

/** The harness itself and its packages; the CLI's own name matches no dash. */
const HARNESS = /^@deepseek-ai\/dsh(-|$)/u
const harnessEntries = (table) => Object.entries(table ?? {}).filter(([name]) => HARNESS.test(name))

/** Orders X.Y.Z[-tag.N] with semver's rule that a prerelease precedes its release. */
function compareVersions(left, right) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?$/u.exec(value ?? '')
    if (match === null) throw new Error('unsupported version: ' + String(value))
    return {
      numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
      prerelease: match[4] === undefined ? null : [match[4], Number(match[5])],
    }
  }
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < a.numbers.length; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index]
  }
  if (a.prerelease === null) return b.prerelease === null ? 0 : 1
  if (b.prerelease === null) return -1
  if (a.prerelease[0] !== b.prerelease[0]) return a.prerelease[0] < b.prerelease[0] ? -1 : 1
  return a.prerelease[1] - b.prerelease[1]
}

const range = /^>=(\S+) <(\S+)$/u.exec(compatibility ?? '')
if (range === null) {
  problems.push('dsh.compatibility.dsh must declare a ">=lower <upper" range, found ' + String(compatibility))
}
if (releases.length === 0) {
  problems.push('dsh.compatibility.dshReleases must name at least one verified release')
}
if (range !== null) {
  for (const release of releases) {
    if (compareVersions(release, range[1]) < 0 || compareVersions(release, range[2]) >= 0) {
      problems.push('verified release ' + release + ' lies outside the compatible range ' + compatibility)
    }
  }
}

// A peer accepts the whole line rather than one release: the profile resolves a
// single harness copy for the host and this plugin, and a peer narrower than the
// range would resolve the private duplicate the range exists to prevent.
for (const [name, declared] of harnessEntries(manifest.peerDependencies)) {
  if (declared !== compatibility) {
    problems.push('peer ' + name + ' declares ' + declared + ', not the compatible range ' + String(compatibility))
  }
}

// A mounted package either accepts the whole compatible line or names one
// verified release, because npm admits a prerelease only through a range
// comparator naming that exact X.Y.Z tuple: ">=0.1.5-rc.1 <0.3.0" resolves
// 0.1.5-rc.3 and never 0.2.0-rc.2, so a row that serves the newer line has to
// name it the way the harness's own bundles pin.
for (const [name, declared] of harnessEntries(manifest.dependencies)) {
  if (declared !== compatibility && !releases.includes(declared)) {
    problems.push('mounted package ' + name + ' declares ' + declared
      + ', which is neither the compatible range ' + String(compatibility) + ' nor a verified release')
  }
}

// An aliased install carries the release of the line no range can reach.
for (const [name, declared] of Object.entries(manifest.dependencies ?? {})) {
  if (!String(declared).startsWith('npm:')) continue
  const aliased = /^npm:(.+)@([^@]+)$/u.exec(String(declared))
  if (aliased === null || !releases.includes(aliased[2])) {
    problems.push('aliased dependency ' + name + ' declares ' + declared + ', whose version is not a verified release')
  }
}

const compiled = harnessEntries(manifest.devDependencies)
if (compiled.length === 0) {
  problems.push('the manifest compiles against no harness package')
}
const compiledVersions = new Set(compiled.map(([, declared]) => declared))
if (compiledVersions.size > 1) {
  problems.push('the harness devDependencies name ' + compiledVersions.size + ' versions, not one')
}
for (const version of compiledVersions) {
  if (!releases.includes(version)) {
    problems.push('the harness devDependencies compile against ' + version + ', which is not a verified release')
  }
}

if (args.includes('--check-registry')) {
  const response = await fetch('https://registry.npmjs.org/@deepseek-ai%2Fdsh')
  if (!response.ok) {
    problems.push('the registry read failed with HTTP ' + response.status)
  } else {
    const metadata = await response.json()
    const latest = metadata['dist-tags']?.latest
    if (typeof latest !== 'string') {
      problems.push('the registry answered no latest dist-tag')
    } else if (!releases.includes(latest)) {
      problems.push('the harness publishes ' + latest + ' as latest, which is not a verified release')
      console.error('harness-matrix: add it to dsh.compatibility.dshReleases, raise the harness devDependencies and mounted packages, then dogfood; RELEASE.md owns the procedure')
    } else {
      console.log('harness-matrix: registry latest ' + latest + ' is verified')
    }
  }
}

if (problems.length > 0) {
  console.error('harness-matrix: the matrix is inconsistent')
  for (const problem of problems) console.error('  - ' + problem)
  process.exit(1)
}
console.log('harness-matrix: ok (' + releases.length + ' verified, compiled '
  + [...compiledVersions].join(', ') + ', peers ' + String(compatibility) + ')')
