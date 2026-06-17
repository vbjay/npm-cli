#!/usr/bin/env node
// scripts/build-indicator-suggestions.js
//
// Analyzes the top N npm packages (by popularity) to discover lifecycle
// script patterns not yet covered by indicator-definitions.js.  Outputs a
// structured JSON file designed to be fed to an AI that can then suggest
// new or improved INDICATOR_REGISTRY entries.
//
// Usage (from repo root):
//   node scripts/build-indicator-suggestions.js [--top 1000] [--out indicator-suggestions.json]
//
// Options:
//   --top N       Number of top packages to analyze (default: 1000)
//   --out path    Output JSON path, relative to repo root (default: indicator-suggestions.json)
//   --delay ms    Milliseconds between registry fetches (default: 60)
//
// The script uses only public npm registry APIs — no authentication needed.
// Expect ~5–10 minutes for 1 000 packages at the default delay.

'use strict'

const https = require('https')
const path = require('path')
const fs = require('fs/promises')

const ROOT = path.resolve(__dirname, '..')
const { INDICATOR_REGISTRY } = require(
  path.join(ROOT, 'lib', 'utils', 'indicator-definitions.js')
)

// ---------------------------------------------------------------------------
// Pre-build a flat [{ pattern, file }] table from the registry so we can
// match any lifecycle script command against all known commandPatterns in
// a single O(n) pass.
// ---------------------------------------------------------------------------
const REGISTRY_PATTERNS = []
for (const [file, def] of Object.entries(INDICATOR_REGISTRY)) {
  for (const pat of (def.detect.commandPatterns || [])) {
    REGISTRY_PATTERNS.push({ pattern: pat, file })
  }
}

// ---------------------------------------------------------------------------
// Dependencies (by name) that are strong signals of non-JS compilation.
// Purposefully excludes pure-JS bundlers (webpack, rollup, vite, esbuild)
// and TypeScript (tsc) — those are not security-relevant lifecycle builds.
// ---------------------------------------------------------------------------
const BUILD_DEP_PATTERNS = [
  // GYP family
  /\bnode-gyp\b/,
  /\bnode-pre-gyp\b/,
  /\b@mapbox\/node-pre-gyp\b/,
  /\bprebuild-install\b/,
  /\bprebuildify\b/,
  /\bpkg-prebuilds-verify\b/,
  /\btodesktop-node-gyp-build\b/,
  /\bnode-gyp-build\b/,
  // Rust / WASM
  /\b@napi-rs\/cli\b/,
  /\bneon-cli\b/,
  /\bwasm-pack\b/,
  /\bcargo\b/,
  // CMake / Autoconf
  /\bcmake-js\b/,
  // Android / React Native native modules
  /\bexpo-modules-core\b/,
  /\bexpo-module-scripts\b/,
  /\breact-native-gradle-plugin\b/,
  // Generic foreign compilation tools
  /\bzig\b/,
  /\bffi-napi\b/,
  /\bref-napi\b/,
]

// Script tokens that strongly indicate compiled-code builds (not JS bundling)
const BUILD_SCRIPT_TOKENS = new Set([
  'cmake', 'ninja', 'cargo', 'rustc', 'gcc', 'g++', 'clang', 'clang++',
  'javac', 'kotlinc', 'gradle', 'gradlew', 'zig', 'ndk-build',
  'wasm-pack', 'emcc', 'emcmake', 'emmake', 'xcrun', 'xcodebuild',
  'node-gyp', 'cmake-js', 'node-pre-gyp', 'ndk', 'gyp',
])

// Words too common in shell to be informative build tool signals
const SHELL_NOISE = new Set([
  'node', 'nodejs', 'npm', 'npx', 'sh', 'bash', 'zsh', 'cmd', 'pwsh',
  'if', 'else', 'then', 'fi', 'do', 'done', 'for', 'while', 'in',
  'echo', 'exit', 'true', 'false', 'test', 'eval', 'export', 'set',
  'unset', 'cd', 'ls', 'cp', 'mv', 'rm', 'mkdir', 'chmod', 'chown',
  'cat', 'grep', 'awk', 'sed', 'sort', 'head', 'tail', 'tee', 'xargs',
  'env', 'which', 'find', 'touch', 'read', 'printf', 'source', 'exec',
  'run', 'build', 'install', 'start', 'test', 'check', 'clean', 'all',
  'scripts', 'prebuild', 'postbuild',
])

// Lifecycle script names that run during `npm install`
const LIFECYCLE_HOOKS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepack']

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Resolve the 'Retry-After' header value to milliseconds.
// Value is either an integer (seconds) or an HTTP-date.
function retryAfterMs (header) {
  if (!header) return null
  const secs = parseInt(header, 10)
  if (!isNaN(secs)) return secs * 1000
  const date = Date.parse(header)
  if (!isNaN(date)) return Math.max(0, date - Date.now())
  return null
}

async function fetchJson (url, retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    let statusCode
    try {
      return await new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'npm-indicator-builder/1.0' } }, res => {
          statusCode = res.statusCode
          let buf = ''
          res.on('data', d => (buf += d))
          res.on('end', () => {
            if (res.statusCode === 404) {
              resolve(null)
            } else if (res.statusCode === 429) {
              // Reject so the retry loop can apply the right backoff
              const ra = retryAfterMs(res.headers['retry-after'])
              reject(Object.assign(new Error(`HTTP 429 for ${url}`), { isRateLimit: true, retryAfterMs: ra }))
            } else if (res.statusCode >= 200 && res.statusCode < 300) {
              try { resolve(JSON.parse(buf)) } catch (e) {
                reject(new Error(`JSON parse error for ${url}: ${e.message}`))
              }
            } else {
              reject(new Error(`HTTP ${res.statusCode} for ${url}`))
            }
          })
          res.on('error', reject)
        })
        req.on('error', reject)
      })
    } catch (err) {
      if (attempt === retries) throw err
      const wait = err.isRateLimit
        ? (err.retryAfterMs ?? 10_000) + 1_000 * attempt  // honour Retry-After + jitter
        : 500 * attempt
      process.stderr.write(`  retry ${attempt}/${retries} (${Math.round(wait / 1000)}s): ${err.message}\n`)
      await sleep(wait)
    }
  }
}

// ---------------------------------------------------------------------------
// npm registry helpers
// ---------------------------------------------------------------------------

// Fetch weekly downloads for a list of packages.
// The npm downloads API does NOT support scoped packages (@scope/name) in
// bulk — they must be fetched one at a time.  Unscoped packages are batched
// in groups of 40 to keep URLs short.
async function getBatchDownloads (names) {
  const result = {}
  const scoped = names.filter(n => n.startsWith('@'))
  const plain = names.filter(n => !n.startsWith('@'))

  // Batch unscoped packages (40 at a time to stay well under URL limits)
  for (let i = 0; i < plain.length; i += 40) {
    const batch = plain.slice(i, i + 40).join(',')
    const url = `https://api.npmjs.org/downloads/point/last-week/${batch}`
    const data = await fetchJson(url)
    if (data) {
      for (const [name, info] of Object.entries(data)) {
        result[name] = info?.downloads || 0
      }
    }
    await sleep(150)
  }

  // Scoped packages one at a time
  for (const name of scoped) {
    const encoded = name.replace(/\//g, '%2F')
    const url = `https://api.npmjs.org/downloads/point/last-week/${encoded}`
    const data = await fetchJson(url)
    if (data) result[name] = data.downloads || 0
    await sleep(100)
  }

  return result
}

// Fetch the latest-version manifest for a single package.
async function getPackageManifest (name) {
  const encoded = name.replace(/\//g, '%2F')
  const data = await fetchJson(`https://registry.npmjs.org/${encoded}/latest`)
  if (!data) return null
  return {
    name: data.name,
    version: data.version,
    scripts: data.scripts || {},
    dependencies: data.dependencies || {},
    devDependencies: data.devDependencies || {},
    optionalDependencies: data.optionalDependencies || {},
    peerDependencies: data.peerDependencies || {},
  }
}

// ---------------------------------------------------------------------------
// Analysis helpers
// ---------------------------------------------------------------------------

function extractLifecycleScripts (scripts) {
  const result = {}
  for (const hook of LIFECYCLE_HOOKS) {
    if (scripts[hook]) result[hook] = scripts[hook]
  }
  return result
}

// Returns the list of indicator-definition files whose commandPatterns match
// anything in the combined lifecycle script text.
function matchExistingDefinitions (lifecycleScripts) {
  const combined = Object.values(lifecycleScripts).join(' ')
  const matches = new Set()
  for (const { pattern, file } of REGISTRY_PATTERNS) {
    // Reset lastIndex to avoid stateful global-flag issues
    if (pattern.global) pattern.lastIndex = 0
    if (pattern.test(combined)) matches.add(file)
  }
  return [...matches]
}

// Pull meaningful tool-like tokens out of lifecycle script text.
function extractCommandTokens (lifecycleScripts) {
  const tokens = new Set()
  for (const src of Object.values(lifecycleScripts)) {
    for (const m of src.matchAll(/\b([a-z][\w.-]{1,})\b/gi)) {
      const tok = m[1].toLowerCase()
      // Skip pure numbers, short words, shell noise
      if (/^\d/.test(tok) || tok.length < 3 || SHELL_NOISE.has(tok)) continue
      // Skip path-like tokens (contain slashes or look like file extensions)
      if (tok.includes('/') || /\.\w{2,4}$/.test(tok)) continue
      tokens.add(tok)
    }
  }
  return [...tokens]
}

// Returns true when the package has non-JS compilation signals.
function isBuildPackage (manifest) {
  const allDeps = Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
  })
  const depStr = allDeps.join('\n')
  if (BUILD_DEP_PATTERNS.some(p => p.test(depStr))) return true

  const scriptStr = Object.values(manifest.scripts).join(' ')
  if (BUILD_SCRIPT_TOKENS.size > 0) {
    for (const tok of extractCommandTokens({ s: scriptStr })) {
      if (BUILD_SCRIPT_TOKENS.has(tok)) return true
    }
  }
  return false
}

// Infer which indicator files a package likely has, based on deps and scripts.
// These are heuristic — they help the AI propose a realistic indicatorFile key.
function inferIndicatorFiles (manifest) {
  const allDeps = Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
  }).join('\n')
  const scriptStr = Object.values(manifest.scripts).join(' ')
  const combined = `${allDeps}\n${scriptStr}`
  const inferred = []

  if (/\bnode-gyp\b|\bnode-pre-gyp\b|\bnode-gyp-build\b|\bprebuild/.test(combined)) {
    inferred.push('binding.gyp')
  }
  if (/\b@napi-rs\b|\bneon-cli\b|\bwasm-pack\b|\bcargo\b/.test(combined)) {
    inferred.push('Cargo.toml')
  }
  if (/\bcmake-js\b|\bcmake\b/.test(combined)) {
    inferred.push('CMakeLists.txt')
  }
  if (/\bexpo-module\b|\bgradlew\b|\breact-native\b/.test(combined)) {
    inferred.push('android/build.gradle')
  }
  if (/\bmake\b/.test(scriptStr)) {
    inferred.push('Makefile')
  }
  if (/\.\/configure\b|\bautoconf\b|\bautomake\b/.test(scriptStr)) {
    inferred.push('configure.ac')
  }
  return inferred
}

// Suggest the most specific classifier signal for an uncategorized package.
function suggestSignal (tokens, inferredFiles) {
  if (inferredFiles.includes('android/build.gradle')) return 'android-native'
  if (tokens.includes('emcc') || tokens.includes('emcmake') || tokens.includes('emmake')) {
    return 'wasm-build'
  }
  if (inferredFiles.includes('Cargo.toml')) return 'rust-native'
  if (tokens.includes('wasm-pack')) return 'wasm-build'
  if (inferredFiles.includes('binding.gyp') || inferredFiles.includes('CMakeLists.txt')) {
    return 'native-build'
  }
  if (inferredFiles.includes('Makefile') || tokens.includes('make')) return 'make-build'
  return null
}

// ---------------------------------------------------------------------------
// Package cache — load / save collected manifests so a run can be resumed
// after a crash without re-fetching everything from scratch.
//
// Two formats are accepted on load:
//   Rich (written by this script):  { packages: [...manifest objects...] }
//   Simple name list (user-provided):  ["lodash", "@babel/core", ...]
// ---------------------------------------------------------------------------

async function loadPackageCache (filePath) {
  try {
    const raw = JSON.parse(await fs.readFile(filePath, 'utf-8'))
    if (Array.isArray(raw)) {
      // Simple name list — caller must fetch manifests for these
      return { names: raw, manifests: null }
    }
    if (raw.packages && Array.isArray(raw.packages)) {
      return { names: null, manifests: raw.packages }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      process.stderr.write(`  Warning: could not read cache ${filePath}: ${err.message}\n`)
    }
  }
  return { names: null, manifests: null }
}

async function savePackageCache (filePath, manifests) {
  const data = {
    generatedAt: new Date().toISOString(),
    count: manifests.length,
    // Store only the fields needed to resume: scripts + dependencies for analysis,
    // plus weeklyDownloads if already fetched (0 means not yet fetched).
    packages: manifests.map(m => ({
      name: m.name,
      version: m.version,
      scripts: m.scripts,
      dependencies: m.dependencies,
      devDependencies: m.devDependencies,
      optionalDependencies: m.optionalDependencies,
      peerDependencies: m.peerDependencies,
      weeklyDownloads: m.weeklyDownloads || 0,
    })),
  }
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main () {
  const args = process.argv.slice(2)
  const flag = (name, def) => {
    const i = args.indexOf(name)
    return i !== -1 ? args[i + 1] : def
  }

  const topN = +flag('--top', 1000)
  const delayMs = +flag('--delay', 60)
  const outFile = flag('--out', 'indicator-suggestions.json')
  const outPath = path.isAbsolute(outFile) ? outFile : path.join(ROOT, outFile)
  const pkgFile = flag('--packages', null)
  const pkgPath = pkgFile
    ? (path.isAbsolute(pkgFile) ? pkgFile : path.join(ROOT, pkgFile))
    : null

  process.stderr.write(`\n📦 npm indicator-suggestions builder\n`)
  process.stderr.write(`   Top N: ${topN}  |  delay: ${delayMs}ms  |  out: ${outPath}\n`)
  if (pkgPath) process.stderr.write(`   packages: ${pkgPath}\n`)
  process.stderr.write('\n')

  // ---------------------------------------------------------------------------
  // Load existing package cache (if --packages file provided)
  // ---------------------------------------------------------------------------
  const manifests = []
  const seen = new Set()

  if (pkgPath) {
    process.stderr.write('Loading package cache...\n')
    const { names, manifests: cached } = await loadPackageCache(pkgPath)

    if (cached) {
      // Rich cache — use manifests directly, no re-fetching needed
      for (const m of cached) {
        manifests.push(m)
        seen.add(m.name)
      }
      process.stderr.write(`  ✓ loaded ${manifests.length} packages from cache\n\n`)
    } else if (names) {
      // Simple name list — fetch manifests now
      process.stderr.write(`  fetching manifests for ${names.length} seed packages...\n`)
      for (const name of names) {
        seen.add(name)
        const manifest = await getPackageManifest(name)
        if (manifest) {
          const lc = extractLifecycleScripts(manifest.scripts)
          if (Object.keys(lc).length > 0) manifests.push(manifest)
        }
        if (delayMs > 0) await sleep(delayMs)
      }
      process.stderr.write(`  ✓ ${manifests.length} seed packages with lifecycle scripts\n\n`)
    }
  }

  // ---------------------------------------------------------------------------
  // Steps 1–3: fan out across popularity-sorted search queries, deduplicate,
  // fetch manifests, keep only those with lifecycle scripts.
  // Packages already loaded from cache are pre-seeded in manifests/seen above.
  // ---------------------------------------------------------------------------
  const DISCOVERY_QUERIES = [
    'keywords:javascript',  // ~58K — broad; tslib, @babel/parser, typescript, …
    'keywords:node',        // ~36K — Node.js ecosystem; resolve, axios, …
    'keywords:npm',         // ~36K — npm tooling; execa, npm-run-path, …
    'keywords:cli',         // CLIs often have install scripts
    'keywords:native',      // native addons
    'keywords:addon',       // Node.js addons
    'keywords:rust',        // Rust/napi packages
    'keywords:wasm',        // WebAssembly
    'keywords:build',       // build tools
    'keywords:android',     // Android native modules
    'keywords:react-native', // React Native packages (often have install scripts)
  ]

  process.stderr.write('Steps 1–3: Scanning popular packages for lifecycle scripts...\n')
  process.stderr.write(`  (will stop once ${topN} packages with lifecycle scripts are found)\n`)
  process.stderr.write(`  (starting from ${manifests.length} cached; need ${Math.max(0, topN - manifests.length)} more)\n\n`)

  let scanned = 0
  let done = manifests.length >= topN

  for (const query of DISCOVERY_QUERIES) {
    if (done) break
    let from = 0
    const size = 250
    process.stderr.write(`  query: ${query}\n`)

    while (!done) {
      const enc = encodeURIComponent(query)
      const url =
        `https://registry.npmjs.org/-/v1/search` +
        `?text=${enc}&popularity=1.0&quality=0.0&maintenance=0.0` +
        `&size=${size}&from=${from}`
      const page = await fetchJson(url)
      if (!page || !page.objects || page.objects.length === 0) break

      const pageNames = page.objects.map(o => o.package.name).filter(n => !seen.has(n))
      for (const n of pageNames) seen.add(n)
      from += page.objects.length

      for (const name of pageNames) {
        if (done) break
        const manifest = await getPackageManifest(name)
        scanned++
        if (manifest) {
          const lc = extractLifecycleScripts(manifest.scripts)
          if (Object.keys(lc).length > 0) {
            manifests.push(manifest)
            if (manifests.length % 50 === 0 || manifests.length <= 3) {
              process.stderr.write(
                `    found ${manifests.length}/${topN} with scripts` +
                ` (scanned ${scanned}, last: ${name})\n`
              )
            }
            if (manifests.length >= topN) done = true
            // Checkpoint save every 100 new packages so a crash loses minimal work
            if (pkgPath && manifests.length % 100 === 0) {
              await savePackageCache(pkgPath, manifests)
            }
          }
        }
        if (delayMs > 0) await sleep(delayMs)
      }

      // Stop paging this query once results thin out (popularity score drops
      // significantly) or we've gone deep enough to find diminishing returns.
      if (from >= 2000) break
    }
  }

  process.stderr.write(
    `\n  ✓ collected ${manifests.length} packages with lifecycle scripts` +
    ` (scanned ${scanned} total across ${seen.size} unique names)\n\n`
  )

  // Fetch weekly download counts only for the packages we kept.
  // Skip packages that already have download counts from a previous run
  // (weeklyDownloads > 0 means they were fetched before).
  process.stderr.write('Step 4/5: Fetching weekly download counts...\n')
  const needDownloads = manifests.filter(m => !m.weeklyDownloads)
  if (needDownloads.length < manifests.length) {
    process.stderr.write(`  (${manifests.length - needDownloads.length} already cached, fetching ${needDownloads.length} new)\n`)
  }
  const downloads = await getBatchDownloads(needDownloads.map(m => m.name))
  for (const m of needDownloads) m.weeklyDownloads = downloads[m.name] || 0
  process.stderr.write(`  ✓ download counts fetched\n\n`)

  // Save final package cache (with download counts) so the next run is fast
  if (pkgPath) {
    await savePackageCache(pkgPath, manifests)
    process.stderr.write(`  ✓ package cache saved to ${pkgPath}\n\n`)
  }

  // Step 5/5: Analyze
  process.stderr.write('Step 5/5: Analyzing...\n')

  const categorized = {} // indicatorFile → packageName[]
  const uncategorized = [] // packages with build signals but no definition match

  // token → { packages: string[], totalDownloads: number }
  const gapTokens = {}

  for (const manifest of manifests) {
    const lc = extractLifecycleScripts(manifest.scripts)

    const matches = matchExistingDefinitions(lc)
    if (matches.length > 0) {
      for (const m of matches) {
        if (!categorized[m]) categorized[m] = []
        categorized[m].push(manifest.name)
      }
      continue // already handled by existing definitions
    }

    // Not matched — is it a build package at all?
    if (!isBuildPackage(manifest)) continue

    const tokens = extractCommandTokens(lc)
    const inferred = inferIndicatorFiles(manifest)
    const signal = suggestSignal(tokens, inferred)

    const buildDeps = [
      ...Object.keys(manifest.dependencies),
      ...Object.keys(manifest.devDependencies),
      ...Object.keys(manifest.optionalDependencies),
    ].filter(d => BUILD_DEP_PATTERNS.some(p => p.test(d)))

    uncategorized.push({
      name: manifest.name,
      version: manifest.version,
      weeklyDownloads: manifest.weeklyDownloads,
      lifecycleScripts: lc,
      buildDependencies: buildDeps,
      commandTokens: tokens,
      inferredIndicatorFiles: inferred,
      suggestedSignal: signal,
    })

    // Accumulate tokens for gap analysis (skip noise + very short)
    for (const tok of tokens) {
      if (tok.length < 3 || SHELL_NOISE.has(tok)) continue
      if (!gapTokens[tok]) gapTokens[tok] = { packages: [], totalDownloads: 0 }
      gapTokens[tok].packages.push(manifest.name)
      gapTokens[tok].totalDownloads += manifest.weeklyDownloads
    }
  }

  // Sort uncategorized by weekly downloads (highest first)
  uncategorized.sort((a, b) => b.weeklyDownloads - a.weeklyDownloads)

  // Produce gap table — only tokens that appear in 2+ uncategorized packages,
  // sorted by total download weight (most impactful gaps first).
  const commandPatternGaps = Object.entries(gapTokens)
    .filter(([, v]) => v.packages.length >= 2)
    .sort((a, b) => b[1].totalDownloads - a[1].totalDownloads)
    .map(([token, v]) => ({
      token,
      frequency: v.packages.length,
      weeklyDownloadTotal: v.totalDownloads,
      packages: v.packages,
      suggestedCommandPattern: `\\b${token}\\b`,
    }))

  const output = {
    meta: {
      generatedAt: new Date().toISOString(),
      topN,
      registryDefinitions: Object.keys(INDICATOR_REGISTRY),
      purpose: [
        'Feed this file to an AI with the prompt:',
        '"Review commandPatternGaps and uncategorizedPackages.',
        ' For each gap with frequency >= 3 or weeklyDownloadTotal >= 50000,',
        ' propose a new INDICATOR_REGISTRY entry (indicatorFile, label,',
        ' commandPatterns, signals, scanner steps) for indicator-definitions.js.',
        ' For gaps that fit an existing definition, propose adding to its',
        ' commandPatterns array instead."',
      ].join(' '),
    },
    coverage: {
      totalScanned: scanned,
      uniqueNamesConsidered: seen.size,
      withLifecycleScripts: manifests.length,
      matchedByExistingDefinitions: Object.values(categorized).flat().length,
      uncategorizedBuildPackages: uncategorized.length,
    },
    // How well each existing definition matches real packages
    existingDefinitionCoverage: Object.fromEntries(
      Object.entries(categorized)
        .sort((a, b) => b[1].length - a[1].length)
        .map(([file, pkgs]) => [
          file,
          { matchedCount: pkgs.length, packages: pkgs.sort() },
        ])
    ),
    // Packages with build signals that no definition covers — highest-value gaps
    uncategorizedPackages: uncategorized,
    // Tokens appearing in multiple uncategorized build packages — candidates
    // for new commandPatterns entries; sorted by total weekly downloads
    commandPatternGaps,
  }

  await fs.writeFile(outPath, JSON.stringify(output, null, 2) + '\n', 'utf-8')

  process.stderr.write(`\n✅ Done!\n`)
  process.stderr.write(`   Total scanned:        ${scanned}\n`)
  process.stderr.write(`   With lifecycle hooks: ${manifests.length}\n`)
  process.stderr.write(`   Matched (existing):   ${output.coverage.matchedByExistingDefinitions}\n`)
  process.stderr.write(`   Uncategorized builds: ${output.coverage.uncategorizedBuildPackages}\n`)
  process.stderr.write(`   Pattern gaps found:   ${commandPatternGaps.length}\n`)
  process.stderr.write(`\n   Written to: ${outPath}\n\n`)
}

main().catch(err => {
  process.stderr.write(`\nFatal: ${err.message}\n${err.stack}\n`)
  process.exit(1)
})
