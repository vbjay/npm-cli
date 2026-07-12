
const path = require('node:path')
const t = require('tap')
const setup = require('./fixtures/setup.js')

// Load the demo project fixtures from the collocated fixtures folder.
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
  t.ok(report.packages.length > 0, 'report contains pending packages')

  const names = report.packages.map(p => p.name)
  t.ok(names.includes('esbuild'), 'report includes esbuild (direct, child-process)')
  t.ok(names.includes('better-sqlite3'), 'report includes better-sqlite3 (native-build)')
  t.ok(names.includes('sqlite3'), 'report includes sqlite3 (native-build)')
  t.ok(names.includes('kerberos'), 'report includes kerberos (native-build)')

  for (const pkg of report.packages) {
    t.equal(pkg.approvalStatus, 'pending', `${pkg.name}@${pkg.version} is pending`)
  }
})
