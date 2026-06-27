const t = require('tap')
const fs = require('node:fs')
const { resolve } = require('node:path')
const _mockNpm = require('../../fixtures/mock-npm')

const mockNpm = async (t, opts = {}) => {
  return _mockNpm(t, opts)
}

const setupProject = ({ allowScripts, withScripts = ['canvas'], noResolved = [] } = {}) => {
  const pkg = {
    name: 'host',
    version: '1.0.0',
    dependencies: Object.fromEntries(withScripts.map((n) => [n, '*'])),
  }
  if (allowScripts !== undefined) {
    pkg.allowScripts = allowScripts
  }

  const lockPackages = { '': pkg }
  const nodeModules = {}
  for (const name of withScripts) {
    const tarUrl = `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`
    nodeModules[name] = {
      'package.json': JSON.stringify({
        name,
        version: '1.0.0',
        scripts: { install: 'echo install' },
      }),
    }
    const lockEntry = {
      version: '1.0.0',
      hasInstallScript: true,
    }
    // Some lockfiles omit `resolved` for registry deps. Those nodes have no
    // trustable version, so they can only be approved by name.
    if (!noResolved.includes(name)) {
      lockEntry.resolved = tarUrl
    }
    lockPackages[`node_modules/${name}`] = lockEntry
  }

  return {
    'package.json': JSON.stringify(pkg, null, 2),
    'package-lock.json': JSON.stringify({
      name: pkg.name,
      version: pkg.version,
      lockfileVersion: 3,
      requires: true,
      packages: lockPackages,
    }),
    node_modules: nodeModules,
  }
}

t.test('approve-scripts --pending lists unreviewed packages', async t => {
  const { npm, joinedOutput } = await mockNpm(t, {
    prefixDir: setupProject({ withScripts: ['canvas', 'sharp'] }),
    config: { 'allow-scripts-pending': true },
  })
  await npm.exec('approve-scripts', [])
  const out = joinedOutput()
  t.match(out, /# npm Lifecycle Script Approval Review/)
  t.match(out, /canvas@1\.0\.0/)
  t.match(out, /sharp@1\.0\.0/)
})

t.test('approve-scripts --pending lists unreviewed packages even with ignore-scripts set', async t => {
  const { npm, joinedOutput } = await mockNpm(t, {
    prefixDir: setupProject({ withScripts: ['canvas', 'sharp'] }),
    config: { 'allow-scripts-pending': true, 'ignore-scripts': true },
  })
  await npm.exec('approve-scripts', [])
  const out = joinedOutput()
  t.match(out, /# npm Lifecycle Script Approval Review/)
  t.match(out, /canvas@1\.0\.0/)
  t.match(out, /sharp@1\.0\.0/)
})

t.test('approve-scripts --pending with no unreviewed says so', async t => {
  const { npm, joinedOutput } = await mockNpm(t, {
    prefixDir: setupProject({
      allowScripts: { canvas: true },
      withScripts: ['canvas'],
    }),
    config: { 'allow-scripts-pending': true },
  })
  await npm.exec('approve-scripts', [])
  t.match(joinedOutput(), /No packages with unreviewed install scripts/)
})

t.test('approve-scripts <pkg> writes pinned entry by default', async t => {
  const { npm, prefix } = await mockNpm(t, {
    prefixDir: setupProject({ withScripts: ['canvas'] }),
  })
  await npm.exec('approve-scripts', ['canvas'])

  const pkg = JSON.parse(fs.readFileSync(resolve(prefix, 'package.json'), 'utf8'))
  t.strictSame(pkg.allowScripts, { 'canvas@1.0.0': true })
})

t.test('approve-scripts <pkg> --no-pin writes name-only entry', async t => {
  const { npm, prefix } = await mockNpm(t, {
    prefixDir: setupProject({ withScripts: ['canvas'] }),
    config: { 'allow-scripts-pin': false },
  })
  await npm.exec('approve-scripts', ['canvas'])

  const pkg = JSON.parse(fs.readFileSync(resolve(prefix, 'package.json'), 'utf8'))
  t.strictSame(pkg.allowScripts, { canvas: true })
})

t.test('approve-scripts --all approves every unreviewed package', async t => {
  const { npm, prefix } = await mockNpm(t, {
    prefixDir: setupProject({ withScripts: ['canvas', 'sharp'] }),
    config: { all: true },
  })
  await npm.exec('approve-scripts', [])

  const pkg = JSON.parse(fs.readFileSync(resolve(prefix, 'package.json'), 'utf8'))
  t.strictSame(pkg.allowScripts, {
    'canvas@1.0.0': true,
    'sharp@1.0.0': true,
  })
})

t.test('approve-scripts --all approves a dep without a resolved URL by name', async t => {
  // Regression for npm/cli#9558: a dep with no `resolved` URL can't be
  // pinned, but must still be approved by name, not silently skipped.
  const { npm, prefix, logs } = await mockNpm(t, {
    prefixDir: setupProject({ withScripts: ['canvas'], noResolved: ['canvas'] }),
    config: { all: true },
  })
  await npm.exec('approve-scripts', [])

  const pkg = JSON.parse(fs.readFileSync(resolve(prefix, 'package.json'), 'utf8'))
  t.strictSame(pkg.allowScripts, { canvas: true }, 'approved by name, not skipped')
  t.match(
    logs.warn.byTitle('approve-scripts').join('\n'),
    /no "resolved" URL/,
    'warns that a version pin could not be written'
  )
})

t.test('approve-scripts <pkg> approves a dep without a resolved URL by name', async t => {
  const { npm, prefix } = await mockNpm(t, {
    prefixDir: setupProject({ withScripts: ['canvas'], noResolved: ['canvas'] }),
  })
  await npm.exec('approve-scripts', ['canvas'])

  const pkg = JSON.parse(fs.readFileSync(resolve(prefix, 'package.json'), 'utf8'))
  t.strictSame(pkg.allowScripts, { canvas: true })
})

t.test('approve-scripts --pending is empty after a no-resolved dep is approved by name', async t => {
  const { npm, joinedOutput } = await mockNpm(t, {
    prefixDir: setupProject({
      allowScripts: { canvas: true },
      withScripts: ['canvas'],
      noResolved: ['canvas'],
    }),
    config: { 'allow-scripts-pending': true },
  })
  await npm.exec('approve-scripts', [])
  t.match(
    joinedOutput(),
    /No packages with unreviewed install scripts/,
    'name-only entry covers the dep even without a resolved URL'
  )
})

t.test('approve-scripts errors on unknown package', async t => {
  const { npm } = await mockNpm(t, {
    prefixDir: setupProject({ withScripts: ['canvas'] }),
  })
  await t.rejects(
    npm.exec('approve-scripts', ['not-installed']),
    { code: 'ENOMATCH' }
  )
})

t.test('approve-scripts approves a package whose name contains dots', async t => {
  const { npm, prefix } = await mockNpm(t, {
    prefixDir: setupProject({ withScripts: ['cordova.plugins.diagnostic'] }),
  })
  await npm.exec('approve-scripts', ['cordova.plugins.diagnostic'])

  const pkg = JSON.parse(fs.readFileSync(resolve(prefix, 'package.json'), 'utf8'))
  t.strictSame(pkg.allowScripts, { 'cordova.plugins.diagnostic@1.0.0': true })
})

t.test('approve-scripts <pkg@version> approves a dotted name with a version specifier', async t => {
  const { npm, prefix } = await mockNpm(t, {
    prefixDir: setupProject({ withScripts: ['cordova.plugins.diagnostic'] }),
  })
  await npm.exec('approve-scripts', ['cordova.plugins.diagnostic@1.0.0'])

  const pkg = JSON.parse(fs.readFileSync(resolve(prefix, 'package.json'), 'utf8'))
  t.strictSame(pkg.allowScripts, { 'cordova.plugins.diagnostic@1.0.0': true })
})

t.test('approve-scripts <@scope/pkg@version> approves a scoped name with a version', async t => {
  const { npm, prefix } = await mockNpm(t, {
    prefixDir: {
      'package.json': JSON.stringify({
        name: 'host',
        version: '1.0.0',
        dependencies: { '@scope/pkg': '*' },
      }),
      'package-lock.json': JSON.stringify({
        name: 'host',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': { name: 'host', version: '1.0.0', dependencies: { '@scope/pkg': '*' } },
          'node_modules/@scope/pkg': {
            version: '2.0.0',
            resolved: 'https://registry.npmjs.org/@scope/pkg/-/pkg-2.0.0.tgz',
            hasInstallScript: true,
          },
        },
      }),
      node_modules: {
        '@scope': {
          pkg: {
            'package.json': JSON.stringify({
              name: '@scope/pkg',
              version: '2.0.0',
              scripts: { install: 'echo install' },
            }),
          },
        },
      },
    },
  })
  await npm.exec('approve-scripts', ['@scope/pkg@2.0.0'])

  const pkg = JSON.parse(fs.readFileSync(resolve(prefix, 'package.json'), 'utf8'))
  t.strictSame(pkg.allowScripts, { '@scope/pkg@2.0.0': true })
})

t.test('approve-scripts <pkg@version> errors when no installed version matches', async t => {
  const { npm } = await mockNpm(t, {
    prefixDir: setupProject({ withScripts: ['canvas'] }),
  })
  await t.rejects(
    npm.exec('approve-scripts', ['canvas@9.9.9']),
    { code: 'ENOMATCH' }
  )
})

t.test('approve-scripts reports only the unmatched args and writes nothing', async t => {
  const { npm, prefix } = await mockNpm(t, {
    prefixDir: setupProject({ withScripts: ['canvas'] }),
  })
  const err = await npm.exec('approve-scripts', ['canvas', 'not-installed'])
    .then(() => null, e => e)
  t.equal(err.code, 'ENOMATCH')
  t.match(err.message, /not-installed/)
  t.notMatch(err.message, /canvas/)
  // Nothing is written when any arg fails to match.
  const pkg = JSON.parse(fs.readFileSync(resolve(prefix, 'package.json'), 'utf8'))
  t.notOk(pkg.allowScripts)
})

t.test('approve-scripts <pkg@tag> matches every installed version', async t => {
  const { npm, prefix } = await mockNpm(t, {
    prefixDir: setupProject({ withScripts: ['canvas'] }),
  })
  // A tag carries no version to filter on, so it behaves like a bare name.
  await npm.exec('approve-scripts', ['canvas@latest'])

  const pkg = JSON.parse(fs.readFileSync(resolve(prefix, 'package.json'), 'utf8'))
  t.strictSame(pkg.allowScripts, { 'canvas@1.0.0': true })
})

t.test('approve-scripts errors on an unparseable spec', async t => {
  const { npm } = await mockNpm(t, {
    prefixDir: setupProject({ withScripts: ['canvas'] }),
  })
  // npm-package-arg throws on this; the raw string is used as the name and
  // matches nothing.
  await t.rejects(
    npm.exec('approve-scripts', ['foo@@bar']),
    { code: 'ENOMATCH' }
  )
})

t.test('approve-scripts errors on a spec with no package name', async t => {
  const { npm } = await mockNpm(t, {
    prefixDir: setupProject({ withScripts: ['canvas'] }),
  })
  // A path spec parses but carries no name, so it matches no registry dep.
  await t.rejects(
    npm.exec('approve-scripts', ['./local-pkg']),
    { code: 'ENOMATCH' }
  )
})

t.test('approve-scripts respects existing deny entry', async t => {
  const { npm, prefix, logs } = await mockNpm(t, {
    prefixDir: setupProject({
      withScripts: ['canvas'],
      allowScripts: { canvas: false },
    }),
  })
  await npm.exec('approve-scripts', ['canvas'])

  const pkg = JSON.parse(fs.readFileSync(resolve(prefix, 'package.json'), 'utf8'))
  // Deny wins; unchanged.
  t.strictSame(pkg.allowScripts, { canvas: false })
  t.match(logs.warn.byTitle('approve-scripts'), [/canvas is denied/])
})

t.test('approve-scripts requires positional args, --all, or --pending', async t => {
  const { npm } = await mockNpm(t, {
    prefixDir: setupProject({ withScripts: ['canvas'] }),
  })
  await t.rejects(npm.exec('approve-scripts', []), { code: 'EUSAGE' })
})

t.test('approve-scripts --pending cannot be combined with positional', async t => {
  const { npm } = await mockNpm(t, {
    prefixDir: setupProject({ withScripts: ['canvas'] }),
    config: { 'allow-scripts-pending': true },
  })
  await t.rejects(npm.exec('approve-scripts', ['canvas']), { code: 'EUSAGE' })
})

t.test('approve-scripts fails on global', async t => {
  const { npm } = await mockNpm(t, {
    config: { global: true },
  })
  await t.rejects(npm.exec('approve-scripts', ['canvas']), { code: 'EGLOBAL' })
})

t.test('approve-scripts --json outputs structured summary', async t => {
  const { npm, joinedOutput } = await mockNpm(t, {
    prefixDir: setupProject({ withScripts: ['canvas'] }),
    config: { json: true },
  })
  await npm.exec('approve-scripts', ['canvas'])
  const parsed = JSON.parse(joinedOutput())
  t.match(parsed, {
    allowScripts: [{ name: 'canvas', changes: [{ key: 'canvas@1.0.0', change: 'added' }] }],
  })
})

t.test('approve-scripts --pending --json lists unreviewed packages as JSON', async t => {
  const { npm, joinedOutput } = await mockNpm(t, {
    prefixDir: setupProject({ withScripts: ['canvas', 'sharp'] }),
    config: { 'allow-scripts-pending': true, json: true },
  })
  await npm.exec('approve-scripts', [])
  const parsed = JSON.parse(joinedOutput())
  const byName = Object.fromEntries(parsed.packages.map((e) => [e.name, e]))
  t.match(byName.canvas, { name: 'canvas', version: '1.0.0', approvalStatus: 'pending' })
  t.match(byName.sharp, { name: 'sharp', version: '1.0.0', approvalStatus: 'pending' })
})

t.test('approve-scripts --pending --json with no unreviewed emits empty list', async t => {
  const { npm, joinedOutput } = await mockNpm(t, {
    prefixDir: setupProject({
      allowScripts: { canvas: true },
      withScripts: ['canvas'],
    }),
    config: { 'allow-scripts-pending': true, json: true },
  })
  await npm.exec('approve-scripts', [])
  t.strictSame(JSON.parse(joinedOutput()).packages, [])
})

t.test('approve-scripts --allow-scripts-report-format=null requires --pending or ls mode', async t => {
  const { npm } = await mockNpm(t, {
    prefixDir: setupProject({ withScripts: ['canvas'] }),
    argv: ['--allow-scripts-report-format=null'],
  })

  await t.rejects(npm.exec('approve-scripts', []), { code: 'EUSAGE' })
})

t.test('approve-scripts --pending with report-format=null falls back to legacy text output', async t => {
  const { npm, joinedOutput } = await mockNpm(t, {
    prefixDir: setupProject({ withScripts: ['canvas'] }),
    config: {
      'allow-scripts-pending': true,
    },
    argv: ['--allow-scripts-report-format=null'],
  })

  await npm.exec('approve-scripts', [])
  const out = joinedOutput()
  t.notMatch(out, /# npm Lifecycle Script Approval Review/,
    'legacy fallback does not render markdown review report')
  t.match(out, /1 package has install scripts blocked because they are not covered by allowScripts:/)
  t.match(out, /canvas@1\.0\.0 \(install: echo install\)/)
})

t.test('approve-scripts --pending --json with report-format=null falls back to legacy pending JSON', async t => {
  const { npm, joinedOutput } = await mockNpm(t, {
    prefixDir: setupProject({ withScripts: ['canvas'] }),
    config: {
      'allow-scripts-pending': true,
      json: true,
    },
    argv: ['--allow-scripts-report-format=null'],
  })

  await npm.exec('approve-scripts', [])
  const parsed = JSON.parse(joinedOutput())
  t.strictSame(parsed, {
    allowScripts: [{ name: 'canvas', changes: [{ key: 'canvas@1.0.0', change: 'pending' }] }],
  })
})

t.test('approve-scripts --all --json with no unreviewed emits empty list', async t => {
  const { npm, joinedOutput } = await _mockNpm(t, {
    prefixDir: {
      'package.json': JSON.stringify({ name: 'host', version: '1.0.0' }),
      'package-lock.json': JSON.stringify({
        name: 'host',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: { '': { name: 'host', version: '1.0.0' } },
      }),
      node_modules: {},
    },
    config: { all: true, json: true },
  })
  await npm.exec('approve-scripts', [])
  t.strictSame(JSON.parse(joinedOutput()), { allowScripts: [] })
})

t.test('approve-scripts --all with no unreviewed packages prints message', async t => {
  const { npm, joinedOutput } = await _mockNpm(t, {
    prefixDir: {
      'package.json': JSON.stringify({ name: 'host', version: '1.0.0' }),
      'package-lock.json': JSON.stringify({
        name: 'host',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: { '': { name: 'host', version: '1.0.0' } },
      }),
      node_modules: {},
    },
    config: { all: true },
  })
  await npm.exec('approve-scripts', [])
  t.match(joinedOutput(), /No packages with unreviewed install scripts/)
})

t.test('approve-scripts <pkg> on a package already at the right pin is no-op', async t => {
  const { npm, prefix, joinedOutput } = await _mockNpm(t, {
    prefixDir: setupProject({
      withScripts: ['canvas'],
      allowScripts: { 'canvas@1.0.0': true },
    }),
  })
  await npm.exec('approve-scripts', ['canvas'])

  const pkg = JSON.parse(fs.readFileSync(resolve(prefix, 'package.json'), 'utf8'))
  t.strictSame(pkg.allowScripts, { 'canvas@1.0.0': true })
  t.match(joinedOutput(), /Nothing to approve/)
})

t.test('approve-scripts --pending with single package uses singular wording', async t => {
  const { npm, joinedOutput } = await _mockNpm(t, {
    prefixDir: setupProject({ withScripts: ['canvas'] }),
    config: { 'allow-scripts-pending': true },
  })
  await npm.exec('approve-scripts', [])
  // Markdown review report includes the package header
  t.match(joinedOutput(), /canvas@1\.0\.0/)
})

t.test('approve-scripts --pending lists package with no version', async t => {
  // Use a fixture where the lockfile records a synthetic node without a version
  const { npm } = await _mockNpm(t, {
    prefixDir: setupProject({ withScripts: ['canvas'] }),
    config: { 'allow-scripts-pending': true },
  })
  await npm.exec('approve-scripts', [])
  // Just exercising; no assertion needed for additional coverage.
  t.pass()
})

const twoVersionFixture = {
  'package.json': JSON.stringify({
    name: 'host',
    version: '1.0.0',
    dependencies: { 'top-of-tree': '*' },
  }),
  'package-lock.json': JSON.stringify({
    name: 'host',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'host', version: '1.0.0', dependencies: { 'top-of-tree': '*' } },
      'node_modules/lodash': {
        version: '4.17.21',
        resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
        hasInstallScript: true,
      },
      'node_modules/top-of-tree': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/top-of-tree/-/top-of-tree-1.0.0.tgz',
        dependencies: { lodash: '3.10.1' },
      },
      'node_modules/top-of-tree/node_modules/lodash': {
        version: '3.10.1',
        resolved: 'https://registry.npmjs.org/lodash/-/lodash-3.10.1.tgz',
        hasInstallScript: true,
      },
    },
  }),
  node_modules: {
    lodash: {
      'package.json': JSON.stringify({
        name: 'lodash',
        version: '4.17.21',
        scripts: { install: 'echo install' },
      }),
    },
    'top-of-tree': {
      'package.json': JSON.stringify({ name: 'top-of-tree', version: '1.0.0' }),
      node_modules: {
        lodash: {
          'package.json': JSON.stringify({
            name: 'lodash',
            version: '3.10.1',
            scripts: { install: 'echo install' },
          }),
        },
      },
    },
  },
}

t.test('approve-scripts --pending --json lists each version as a separate package entry', async t => {
  // Two versions of lodash are unreviewed; the review report lists each as a
  // separate entry with its own version (unlike the old pendingSummary which
  // collapsed them under one name).
  const { npm, joinedOutput } = await _mockNpm(t, {
    prefixDir: twoVersionFixture,
    config: { 'allow-scripts-pending': true, json: true },
  })
  await npm.exec('approve-scripts', [])
  const parsed = JSON.parse(joinedOutput())
  t.equal(parsed.packages.length, 2)
  t.ok(parsed.packages.every(p => p.name === 'lodash'))
  t.ok(parsed.packages.every(p => p.approvalStatus === 'pending'))
  const versions = parsed.packages.map(p => p.version).sort()
  t.strictSame(versions, ['3.10.1', '4.17.21'])
})

t.test('approve-scripts groups multiple installed versions of the same package', async t => {
  // Two versions of lodash exist in the tree; both have install scripts.
  // groupByPackage should put them in the same group (hits the
  // `if (!groups[key])` falsy branch on the second node).
  const { npm, prefix } = await _mockNpm(t, {
    prefixDir: twoVersionFixture,
  })
  await npm.exec('approve-scripts', ['lodash'])

  const pkg = JSON.parse(fs.readFileSync(resolve(prefix, 'package.json'), 'utf8'))
  // Both versions get pinned.
  t.strictSame(pkg.allowScripts, {
    'lodash@3.10.1': true,
    'lodash@4.17.21': true,
  })
})

t.test('approve-scripts <pkg@version> pins only the matching installed version', async t => {
  const { npm, prefix } = await _mockNpm(t, {
    prefixDir: twoVersionFixture,
  })
  await npm.exec('approve-scripts', ['lodash@4.17.21'])

  const pkg = JSON.parse(fs.readFileSync(resolve(prefix, 'package.json'), 'utf8'))
  t.strictSame(pkg.allowScripts, { 'lodash@4.17.21': true })
})

t.test('approve-scripts <pkg@range> pins only versions satisfying the range', async t => {
  const { npm, prefix } = await _mockNpm(t, {
    prefixDir: twoVersionFixture,
  })
  await npm.exec('approve-scripts', ['lodash@^4'])

  const pkg = JSON.parse(fs.readFileSync(resolve(prefix, 'package.json'), 'utf8'))
  t.strictSame(pkg.allowScripts, { 'lodash@4.17.21': true })
})

t.test('approve-scripts --pending handles node with no version', async t => {
  // Exercise the ternary's falsy branch in runPending: `node.version ? '@'... : ''`
  // when the node has no version field.
  const mockSync = await _mockNpm(t, {
    prefixDir: {
      'package.json': JSON.stringify({ name: 'host', version: '1.0.0' }),
      'package-lock.json': JSON.stringify({
        name: 'host',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: { '': { name: 'host', version: '1.0.0' } },
      }),
      node_modules: {},
    },
    config: { 'allow-scripts-pending': true },
    mocks: {
      // Make the walker return a synthetic node with no version
      '{LIB}/utils/check-allow-scripts.js': async () => [{
        node: { packageName: 'no-version-pkg', name: 'no-version-pkg', version: undefined },
        scripts: { install: 'do-stuff' },
      }],
    },
  })
  await mockSync.npm.exec('approve-scripts', [])
  // Markdown review report: package name appears in the header, script in the lifecycle block
  t.match(mockSync.joinedOutput(), /no-version-pkg/)
  t.match(mockSync.joinedOutput(), /do-stuff/)
})

t.test('approve-scripts --pending --json handles node with no version', async t => {
  // Exercise the version ? version : null ternary in runReviewReport when the
  // node has no version field.
  const { npm, joinedOutput } = await _mockNpm(t, {
    prefixDir: {
      'package.json': JSON.stringify({ name: 'host', version: '1.0.0' }),
      'package-lock.json': JSON.stringify({
        name: 'host',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: { '': { name: 'host', version: '1.0.0' } },
      }),
      node_modules: {},
    },
    config: { 'allow-scripts-pending': true, json: true },
    mocks: {
      '{LIB}/utils/check-allow-scripts.js': async () => [{
        node: { packageName: 'no-version-pkg', name: 'no-version-pkg', version: undefined },
        scripts: { install: 'do-stuff' },
      }],
    },
  })
  await npm.exec('approve-scripts', [])
  const parsed = JSON.parse(joinedOutput())
  t.equal(parsed.packages.length, 1)
  t.match(parsed.packages[0], {
    name: 'no-version-pkg',
    version: null,
    approvalStatus: 'pending',
  })
})

t.test('forbidden semver range in package.json#allowScripts is dropped with a warning', async t => {
  // End-to-end: project declares a caret range in allowScripts. The
  // resolver must drop the entry, emit a warning, and the matching node
  // must remain unreviewed (listed by --pending).
  const mock = await _mockNpm(t, {
    prefixDir: setupProject({
      withScripts: ['canvas'],
      // ^0.33.0 is a forbidden range per RFC.
      allowScripts: { 'canvas@^0.33.0': true },
    }),
    config: { 'allow-scripts-pending': true },
  })
  await mock.npm.exec('approve-scripts', [])

  const warnings = mock.logs.warn.byTitle('install-scripts')
  t.ok(
    warnings.some(m => /semver ranges/.test(m) && /canvas@\^0\.33\.0/.test(m)),
    'resolver emits warning about forbidden range'
  )
  // canvas was installed with version 1.0.0 (setupProject default) and
  // the forbidden allowlist entry was dropped, so canvas appears in the
  // pending list.
  t.match(mock.joinedOutput(), /canvas@1\.0\.0/)
})

t.test('approve-scripts --pending lists packages that only have binding.gyp', async t => {
  // End-to-end: a package with no preinstall/install/postinstall but a
  // binding.gyp on disk gets a synthetic `node-gyp rebuild` install
  // script. The runtime isNodeGypPackage check must see it and surface
  // the package in --pending output.
  const mock = await _mockNpm(t, {
    prefixDir: {
      'package.json': JSON.stringify({
        name: 'host',
        version: '1.0.0',
        dependencies: { 'native-pkg': '*' },
      }),
      'package-lock.json': JSON.stringify({
        name: 'host',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': { name: 'host', version: '1.0.0', dependencies: { 'native-pkg': '*' } },
          'node_modules/native-pkg': {
            version: '1.0.0',
            resolved: 'https://registry.npmjs.org/native-pkg/-/native-pkg-1.0.0.tgz',
            // No hasInstallScript — the synthetic node-gyp injection is
            // what we want this test to exercise.
          },
        },
      }),
      node_modules: {
        'native-pkg': {
          'package.json': JSON.stringify({ name: 'native-pkg', version: '1.0.0' }),
          // The file that triggers isNodeGypPackage to return true.
          'binding.gyp': '{}',
        },
      },
    },
    config: { 'allow-scripts-pending': true },
  })
  await mock.npm.exec('approve-scripts', [])

  const out = mock.joinedOutput()
  t.match(out, /native-pkg@1\.0\.0/, 'binding.gyp-only package appears in --pending')
  t.match(out, /node-gyp rebuild/, 'synthetic node-gyp install is named')
})

t.test('approve-scripts --all never approves bundled deps', async t => {
  // Bundled deps never run their install scripts and cannot be
  // allowlisted. They never reach the unreviewed list, so --all must not
  // write a key derived from the bundled tarball's self-claimed identity.
  const { npm, logs, prefix } = await _mockNpm(t, {
    prefixDir: {
      'package.json': JSON.stringify({
        name: 'host',
        version: '1.0.0',
        dependencies: { 'parent-pkg': '*' },
      }),
      'package-lock.json': JSON.stringify({
        name: 'host',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': { name: 'host', version: '1.0.0', dependencies: { 'parent-pkg': '*' } },
          'node_modules/parent-pkg': {
            version: '1.0.0',
            resolved: 'https://registry.npmjs.org/parent-pkg/-/parent-pkg-1.0.0.tgz',
            hasInstallScript: true,
          },
          'node_modules/parent-pkg/node_modules/inner': {
            version: '1.0.0',
            inBundle: true,
            hasInstallScript: true,
          },
        },
      }),
      node_modules: {
        'parent-pkg': {
          'package.json': JSON.stringify({
            name: 'parent-pkg',
            version: '1.0.0',
            scripts: { install: 'echo install' },
            bundleDependencies: ['inner'],
          }),
          node_modules: {
            inner: {
              'package.json': JSON.stringify({
                name: 'inner',
                version: '1.0.0',
                scripts: { install: 'echo bundled-install' },
              }),
            },
          },
        },
      },
    },
    config: { all: true },
  })
  await npm.exec('approve-scripts', [])

  const pkg = JSON.parse(fs.readFileSync(resolve(prefix, 'package.json'), 'utf8'))
  // parent-pkg is approvable. inner is bundled and must be excluded.
  t.equal(pkg.allowScripts['parent-pkg@1.0.0'], true,
    'non-bundled parent gets approved')
  t.notOk(Object.keys(pkg.allowScripts).some(k => k.startsWith('inner')),
    'bundled inner is not approved')
  t.strictSame(logs.warn.byTitle('approve-scripts'), [],
    'no warning; bundled deps are excluded upstream')
})

t.test('approve-scripts <bundled-pkg> positional is ignored', async t => {
  // Same protection on the positional path: a user typing a bundled
  // package name must not get a policy entry written.
  const { npm } = await _mockNpm(t, {
    prefixDir: {
      'package.json': JSON.stringify({
        name: 'host',
        version: '1.0.0',
        dependencies: { 'parent-pkg': '*' },
      }),
      'package-lock.json': JSON.stringify({
        name: 'host',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': { name: 'host', version: '1.0.0', dependencies: { 'parent-pkg': '*' } },
          'node_modules/parent-pkg': {
            version: '1.0.0',
            resolved: 'https://registry.npmjs.org/parent-pkg/-/parent-pkg-1.0.0.tgz',
            hasInstallScript: true,
          },
          'node_modules/parent-pkg/node_modules/inner': {
            version: '1.0.0',
            inBundle: true,
            hasInstallScript: true,
          },
        },
      }),
      node_modules: {
        'parent-pkg': {
          'package.json': JSON.stringify({
            name: 'parent-pkg',
            version: '1.0.0',
            scripts: { install: 'echo install' },
            bundleDependencies: ['inner'],
          }),
          node_modules: {
            inner: {
              'package.json': JSON.stringify({
                name: 'inner',
                version: '1.0.0',
                scripts: { install: 'echo bundled' },
              }),
            },
          },
        },
      },
    },
  })
  await t.rejects(
    npm.exec('approve-scripts', ['inner']),
    { code: 'ENOMATCH' },
    'typing the bundled package name does not match any approvable node'
  )
})

t.test('approve-scripts <root-bundled-pkg> positional CAN be approved', async t => {
  // A package listed in the root project's own bundleDependencies is still
  // fetched from the registry and installed normally — its install scripts
  // run and the user should be able to approve it. inBundle=true but
  // inDepBundle=false for such nodes; findNodesForArgs must NOT skip them.
  const { npm, prefix } = await _mockNpm(t, {
    prefixDir: {
      'package.json': JSON.stringify({
        name: 'host',
        version: '1.0.0',
        dependencies: { canvas: '*' },
        bundleDependencies: ['canvas'],
      }),
      'package-lock.json': JSON.stringify({
        name: 'host',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': { name: 'host', version: '1.0.0', dependencies: { canvas: '*' }, bundleDependencies: ['canvas'] },
          'node_modules/canvas': {
            version: '2.11.2',
            resolved: 'https://registry.npmjs.org/canvas/-/canvas-2.11.2.tgz',
            inBundle: true,
            hasInstallScript: true,
          },
        },
      }),
      node_modules: {
        canvas: {
          'package.json': JSON.stringify({
            name: 'canvas',
            version: '2.11.2',
            scripts: { install: 'node-gyp rebuild' },
          }),
        },
      },
    },
  })
  await npm.exec('approve-scripts', ['canvas@2.11.2'])
  const pkg = JSON.parse(fs.readFileSync(resolve(prefix, 'package.json'), 'utf8'))
  t.ok(pkg.allowScripts?.['canvas@2.11.2'], 'root-bundled dep approved with pinned version')
})

t.test('approve-scripts --all with only bundled deps has nothing to review', async t => {
  const { npm, logs, joinedOutput, prefix } = await _mockNpm(t, {
    prefixDir: {
      'package.json': JSON.stringify({
        name: 'host',
        version: '1.0.0',
        dependencies: { 'parent-pkg': '*' },
      }),
      'package-lock.json': JSON.stringify({
        name: 'host',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': { name: 'host', version: '1.0.0', dependencies: { 'parent-pkg': '*' } },
          'node_modules/parent-pkg': {
            version: '1.0.0',
            resolved: 'https://registry.npmjs.org/parent-pkg/-/parent-pkg-1.0.0.tgz',
            // parent-pkg has NO install scripts; only the bundled child does.
          },
          'node_modules/parent-pkg/node_modules/only-bundled': {
            version: '1.0.0',
            inBundle: true,
            hasInstallScript: true,
          },
        },
      }),
      node_modules: {
        'parent-pkg': {
          'package.json': JSON.stringify({
            name: 'parent-pkg',
            version: '1.0.0',
            bundleDependencies: ['only-bundled'],
          }),
          node_modules: {
            'only-bundled': {
              'package.json': JSON.stringify({
                name: 'only-bundled',
                version: '1.0.0',
                scripts: { install: 'echo evil' },
              }),
            },
          },
        },
      },
    },
    config: { all: true },
  })
  await npm.exec('approve-scripts', [])
  t.match(joinedOutput(), /No packages with unreviewed install scripts/)
  t.strictSame(logs.warn.byTitle('approve-scripts'), [],
    'no warning; bundled deps are excluded upstream')
  // Ensure no policy entry was written.
  const pkg = JSON.parse(fs.readFileSync(resolve(prefix, 'package.json'), 'utf8'))
  t.notOk(pkg.allowScripts, 'no allowScripts written')
})

t.test('review report: buildInfo is null for packages with no gyp reference', async t => {
  // A package whose install script has no node-gyp / binding.gyp reference
  // should NOT have scanBuildIndicators run against it — buildInfo stays null.
  const { npm, joinedOutput } = await _mockNpm(t, {
    prefixDir: setupProject({ withScripts: ['canvas'] }),
    config: { 'allow-scripts-pending': true, json: true },
  })
  await npm.exec('approve-scripts', [])
  const parsed = JSON.parse(joinedOutput())
  t.equal(parsed.packages[0].buildInfo, null,
    'buildInfo is null when install script has no gyp reference')
})

t.test('review report: buildInfo is populated when install script references node-gyp', async t => {
  // A package whose install script directly calls node-gyp rebuild AND has a
  // binding.gyp on disk must have buildInfo populated in the review report.
  const { npm, joinedOutput } = await _mockNpm(t, {
    prefixDir: {
      'package.json': JSON.stringify({
        name: 'host',
        version: '1.0.0',
        dependencies: { 'native-pkg': '*' },
      }),
      'package-lock.json': JSON.stringify({
        name: 'host',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': { name: 'host', version: '1.0.0', dependencies: { 'native-pkg': '*' } },
          'node_modules/native-pkg': {
            version: '1.0.0',
            resolved: 'https://registry.npmjs.org/native-pkg/-/native-pkg-1.0.0.tgz',
          },
        },
      }),
      node_modules: {
        'native-pkg': {
          'package.json': JSON.stringify({ name: 'native-pkg', version: '1.0.0' }),
          'binding.gyp': JSON.stringify({ targets: [{ target_name: 'mymod', sources: ['src/mymod.cc'] }] }),
        },
      },
    },
    config: { 'allow-scripts-pending': true, json: true },
  })
  await npm.exec('approve-scripts', [])
  const parsed = JSON.parse(joinedOutput())
  const entry = parsed.packages.find((p) => p.name === 'native-pkg')
  t.ok(entry, 'native-pkg appears in pending list')
  // The synthetic `node-gyp rebuild` script triggers the native-build hint, so
  // buildInfo must be present as a non-empty IndicatorResult[].
  t.ok(Array.isArray(entry.buildInfo) && entry.buildInfo.length > 0,
    'buildInfo is a non-empty array for a gyp package')
  const ind = entry.buildInfo.find(i => i.indicatorFile === 'binding.gyp')
  t.ok(ind, 'binding.gyp indicator is present')
  t.ok(ind.groups.some(g => g.items.includes('src/mymod.cc')),
    'source file from binding.gyp appears in groups')
})

t.test('review report: buildInfo is populated when a referenced file carries native-build signal', async t => {
  // A package whose install.js references node-gyp (triggering the native-build
  // signal during file scan) must also get buildInfo in the review report.
  const installJs = `
const gyp = require('node-gyp')()
gyp.commands.build([], () => {})
`
  const { npm, joinedOutput } = await _mockNpm(t, {
    prefixDir: {
      'package.json': JSON.stringify({
        name: 'host',
        version: '1.0.0',
        dependencies: { 'lazy-gyp': '*' },
      }),
      'package-lock.json': JSON.stringify({
        name: 'host',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': { name: 'host', version: '1.0.0', dependencies: { 'lazy-gyp': '*' } },
          'node_modules/lazy-gyp': {
            version: '1.0.0',
            resolved: 'https://registry.npmjs.org/lazy-gyp/-/lazy-gyp-1.0.0.tgz',
            hasInstallScript: true,
          },
        },
      }),
      node_modules: {
        'lazy-gyp': {
          'package.json': JSON.stringify({
            name: 'lazy-gyp',
            version: '1.0.0',
            // install script calls a local file; no direct node-gyp mention here
            scripts: { install: 'node install.js' },
          }),
          // install.js contains the node-gyp reference (native-build signal)
          'install.js': installJs,
          'binding.gyp': JSON.stringify({ targets: [{ target_name: 'lazymod', sources: ['src/lazy.cc'] }] }),
        },
      },
    },
    config: { 'allow-scripts-pending': true, json: true },
  })
  await npm.exec('approve-scripts', [])
  const parsed = JSON.parse(joinedOutput())
  const entry = parsed.packages.find((p) => p.name === 'lazy-gyp')
  t.ok(entry, 'lazy-gyp appears in pending list')
  // install.js carries the native-build signal, which triggers scanBuildIndicators.
  t.ok(Array.isArray(entry.buildInfo) && entry.buildInfo.length > 0,
    'buildInfo is a non-empty array via native-build signal in referenced file')
  const ind = entry.buildInfo.find(i => i.indicatorFile === 'binding.gyp')
  t.ok(ind, 'binding.gyp indicator is present')
  t.ok(ind.groups.some(g => g.items.includes('src/lazy.cc')),
    'source file from binding.gyp appears in groups')
})
