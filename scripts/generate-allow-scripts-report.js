#!/usr/bin/env node
// Generates an allow-scripts pending-approval report for the
// smoke-tests/test/fixtures/approve-scripts-report demo project and writes
// both Markdown and JSON output files next to the package.json.
//
// Usage (from the repository root):
//   node scripts/generate-allow-scripts-report.js
//
// Prerequisites:
//   node scripts/resetdeps.js          # sets up workspace symlinks
//   npm ci --ignore-scripts --prefix smoke-tests/test/fixtures/approve-scripts-report

'use strict'

const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')

const prefixIdx = process.argv.indexOf('--prefix')
const prefixArg = prefixIdx !== -1 ? process.argv[prefixIdx + 1] : null
if (prefixIdx !== -1 && !prefixArg) {
  console.error('Usage: node scripts/generate-allow-scripts-report.js [--prefix <path>]')
  process.exit(1)
}

const DEMO_DIR = prefixArg
  ? path.resolve(prefixArg)
  : path.join(ROOT, 'smoke-tests', 'test', 'fixtures', 'approve-scripts-report')
// Resolve workspace modules relative to the repo root so this script works
// both locally (after resetdeps.js) and in CI.
const Arborist = require(path.join(ROOT, 'workspaces', 'arborist'))
const { collectUnreviewedScripts } =
  require(path.join(ROOT, 'workspaces', 'arborist', 'lib', 'unreviewed-scripts.js'))
const getDepPaths = require(path.join(ROOT, 'lib', 'utils', 'dep-path-walker.js'))
const classifyScriptChange =
  require(path.join(ROOT, 'lib', 'utils', 'script-change-classifier.js'))
const scanPackageScripts = require(path.join(ROOT, 'lib', 'utils', 'script-risk-scanner.js'))
const { hasBuildHint, scanBuildIndicatorsForPackage } =
  require(path.join(ROOT, 'lib', 'utils', 'indicator-scanner.js'))
const { formatMarkdown, formatJson } =
  require(path.join(ROOT, 'lib', 'utils', 'review-report-formatter.js'))

async function main () {
  console.error('Loading dependency tree from', DEMO_DIR, '...')
  const arb = new Arborist({ path: DEMO_DIR })
  await arb.loadActual()

  // Read the existing allowScripts policy from the project (if any) so that
  // deny entries are reflected in the changeClassification output.
  const pkgContent = JSON.parse(fs.readFileSync(path.join(DEMO_DIR, 'package.json'), 'utf-8'))
  const allowScripts = (pkgContent.allowScripts && typeof pkgContent.allowScripts === 'object')
    ? pkgContent.allowScripts
    : {}

  const unreviewed = await collectUnreviewedScripts({
    tree: arb.actualTree,
    policy: allowScripts,
    ignoreScripts: false,
    dangerouslyAllowAllScripts: false,
    includeWhenIgnored: true,
  })

  if (unreviewed.length === 0) {
    const mdOut = '# npm Lifecycle Script Approval Review\n\n✅ **All packages with lifecycle scripts have been approved.** No pending approvals.\n'
    const jsonOut = JSON.stringify({ packages: [], status: 'all-approved' }, null, 2)
    const mdPath = path.join(DEMO_DIR, 'report.md')
    const jsonPath = path.join(DEMO_DIR, 'report.json')
    fs.writeFileSync(mdPath, mdOut)
    fs.writeFileSync(jsonPath, jsonOut)
    console.error('All packages approved — nothing pending.')
    console.log(mdOut)
    return
  }

  console.error(`Found ${unreviewed.length} package(s) with pending lifecycle scripts. Scanning...`)

  const packages = []
  for (const { node, scripts } of unreviewed) {
    const displayName = node.packageName || node.name || '<unknown>'
    const displayVersion = node.version || null
    const { dependencyType, introducedBy } = getDepPaths(node)
    const changeClassification = classifyScriptChange(node, allowScripts)
    const referencedFiles = node.path
      ? await scanPackageScripts(node.path, scripts)
      : []

    const pkg = node.package || {}
    const deps = Object.keys({
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
      ...pkg.devDependencies,
    })

    const buildInfo = node.path && hasBuildHint(scripts, referencedFiles, undefined, deps)
      ? await scanBuildIndicatorsForPackage(node.path, scripts, referencedFiles)
      : null

    packages.push({
      name: displayName,
      version: displayVersion,
      location: node.location || `node_modules/${displayName}`,
      approvalStatus: 'pending',
      dependencyType,
      introducedBy,
      lifecycleScripts: scripts,
      referencedFiles,
      buildInfo,
      changeClassification,
    })
  }

  const md = formatMarkdown(packages)
  const json = formatJson(packages)

  const mdPath = path.join(DEMO_DIR, 'report.md')
  const jsonPath = path.join(DEMO_DIR, 'report.json')

  fs.writeFileSync(mdPath, md)
  fs.writeFileSync(jsonPath, json)

  console.error(`Wrote Markdown report → ${mdPath}`)
  console.error(`Wrote JSON report    → ${jsonPath}`)
  console.log(md)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
