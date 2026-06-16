
const path = require('node:path')
const t = require('tap')
const setup = require('./fixtures/setup.js')

// Fixture is based on the real lerna monorepo package.json
// (https://raw.githubusercontent.com/lerna/lerna/refs/heads/main/package.json)
// with the workspace / file: self-reference stripped so it resolves standalone.
const getFixture = (p) => require(path.join(__dirname, 'fixtures', 'approve-scripts-report', p))

t.test('approve-scripts report', async t => {
  const { npm, spawn, readFile, paths } = await setup(t, {
    // This test installs real packages from the production registry, the same
    // way the large-install test does.
    mockRegistry: false,
    testdir: {
      project: {
        'package.json': getFixture('package.json'),
        'package-lock.json': getFixture('package-lock.json'),
      },
    },
  })

  // Install without running any lifecycle scripts — the whole point of the
  // workflow is to review them before allowing them to execute.
  await npm('ci', '--ignore-scripts', '--no-audit', '--no-fund')

  // Run the report generator against the freshly installed project.
  const scriptPath = path.join(setup.CLI_ROOT, 'scripts', 'generate-allow-scripts-report.js')
  await spawn(
    process.execPath,
    [scriptPath, '--prefix', paths.project],
    { cwd: setup.CLI_ROOT }
  )

  // Use the JSON sidecar written to the project dir for all assertions.
  const report = await readFile('report.json')

  // lerna's deps produce 6 pending entries: nx appears three times at
  // different locations (top-level nx@22, and two copies of nx@20 nested
  // inside lerna's own subtree), plus @swc/core, esbuild, and unrs-resolver.
  t.equal(report.packages.length, 6, 'report contains exactly 6 pending packages')

  const names = report.packages.map(p => p.name)
  t.ok(names.includes('nx'), 'report includes nx (postinstall, multiple copies)')
  t.ok(names.includes('@swc/core'), 'report includes @swc/core (direct, native binding download)')
  t.ok(names.includes('esbuild'), 'report includes esbuild (direct, network binary download)')
  t.ok(names.includes('unrs-resolver'), 'report includes unrs-resolver (transitive, native resolver)')

  const nxEntries = report.packages.filter(p => p.name === 'nx')
  t.equal(nxEntries.length, 3, 'nx appears 3 times (top-level + 2 nested lerna copies)')

  const esbuildPkg = report.packages.find(p => p.name === 'esbuild')
  t.equal(esbuildPkg.dependencyType, 'direct', 'esbuild is a direct dependency')

  const swcPkg = report.packages.find(p => p.name === '@swc/core')
  t.equal(swcPkg.dependencyType, 'direct', '@swc/core is a direct dependency')

  const unrsPkg = report.packages.find(p => p.name === 'unrs-resolver')
  t.equal(unrsPkg.dependencyType, 'transitive', 'unrs-resolver is a transitive dependency')

  for (const pkg of report.packages) {
    t.equal(pkg.approvalStatus, 'pending', `${pkg.name}@${pkg.version} is pending`)
  }
})
