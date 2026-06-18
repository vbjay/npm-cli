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
  /@mapbox\/node-pre-gyp\b/,
  /@xprofiler\/node-pre-gyp\b/,
  /\bprebuild-install\b/,
  /\bprebuildify\b/,
  /\bpkg-prebuilds-verify\b/,
  /\btodesktop-node-gyp-build\b/,
  /\bnode-gyp-build\b/,
  // Rust / WASM
  /@napi-rs\/cli\b/,
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
  // Binary downloader helpers — packages that fetch prebuilt binaries at install time
  /\binstall-binary\b/,
  /\bdownload-binary\b/,
  /\bbin-wrapper\b/,
  /\bnode-bin-setup\b/,
]

// Maps dependency name patterns to the indicator-definition file they imply.
// Used by matchExistingDefinitions to classify packages whose lifecycle scripts
// don't mention a native build tool directly (e.g. install: "node ./install.js").
// Uses ecosystem-level framework deps, not specific package names.
const DEP_TO_DEFINITION = [
  {
    pattern: /\bnode-gyp\b|\bnode-pre-gyp\b|@mapbox\/node-pre-gyp\b|@xprofiler\/node-pre-gyp\b|\bprebuildify\b|\bprebuild-install\b|\bnode-gyp-build\b|\bpkg-prebuilds-verify\b|\btodesktop-node-gyp-build\b/,
    file: 'binding.gyp',
  },
  {
    pattern: /\bcmake-js\b/,
    file: 'CMakeLists.txt',
  },
  {
    pattern: /@napi-rs\/cli\b|\bneon-cli\b|\bwasm-pack\b/,
    file: 'Cargo.toml',
  },
  {
    // Capacitor native plugin — any plugin with @capacitor/core has platform-native code.
    // react-native-gradle-plugin is the RN Gradle plugin dep for React Native modules.
    // react-native (exact name, not react-native-*) means it's an RN native module.
    pattern: /@capacitor\/core\b|\bexpo-modules-core\b|\bexpo-module-scripts\b|\breact-native-gradle-plugin\b/,
    file: 'android/build.gradle',
  },
  {
    // Exact package name 'react-native' as a dependency means this is an RN native module.
    // Using multiline ^ $ so react-native-xxx doesn't match.
    pattern: /^react-native$/m,
    file: 'android/build.gradle',
  },
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
  'yarn', 'pnpm', 'bun', 'lerna', 'turbo', 'nx', 'rush',  // package managers / monorepo tools
  'husky',   // git hook installer — not a build tool
  'gitignore', 'eslintrc', 'prettierrc', 'editorconfig',  // dotfile names from rm/cleanup cmds
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

// Global rate-limit state.  When ANY request receives a 429, ALL subsequent
// requests (new ones AND retries) wait here until the cooldown expires.
// This prevents the pipeline from hammering the API while one request backs off.
let _cooldownUntil = 0
let _consecutiveRateLimits = 0

async function waitForCooldown (label) {
  const remaining = _cooldownUntil - Date.now()
  if (remaining > 0) {
    process.stderr.write(
      `  ⏳ rate-limit cooldown: waiting ${Math.ceil(remaining / 1000)}s` +
      (label ? ` (${label})` : '') + '\n'
    )
    await sleep(remaining + 100) // +100ms buffer past the deadline
  }
}

// Resolve the 'Retry-After' header value to milliseconds.
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
    // Always honour the global cooldown before firing any request
    await waitForCooldown()

    try {
      const result = await new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'npm-indicator-builder/1.0' } }, res => {
          let buf = ''
          res.on('data', d => (buf += d))
          res.on('end', () => {
            if (res.statusCode === 404) {
              resolve(null)
            } else if (res.statusCode === 429) {
              // Apply exponential global cooldown — ALL requests will wait,
              // not just retries of this one.
              _consecutiveRateLimits++
              const serverWait = retryAfterMs(res.headers['retry-after']) ?? 0
              // Base: 30s minimum, doubling with each consecutive 429, cap 5min
              const base = Math.max(30_000, serverWait)
              const backoff = Math.min(300_000, base * Math.pow(2, _consecutiveRateLimits - 1))
              _cooldownUntil = Math.max(_cooldownUntil, Date.now() + backoff)
              reject(Object.assign(
                new Error(`HTTP 429 — cooldown ${Math.ceil(backoff / 1000)}s`),
                { isRateLimit: true }
              ))
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
      // Successful response — reset consecutive rate-limit counter
      _consecutiveRateLimits = 0
      return result
    } catch (err) {
      if (attempt === retries) throw err
      if (!err.isRateLimit) {
        // Non-429 error: short fixed backoff
        await sleep(500 * attempt)
      }
      // 429: no extra sleep here — waitForCooldown() at the top of the next
      // attempt already enforces the global cooldown set above.
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
// anything in the package's scripts, or whose associated build deps appear in
// the manifest.  Scans ALL scripts (not just lifecycle hooks) so that packages
// like lru-native2 ("build":"node-gyp rebuild") or @azure/msal-node-extensions
// ("compile":"node-gyp rebuild") are classified correctly even though their
// lifecycle script is just "install":"npm run build".
function matchExistingDefinitions (lifecycleScripts, manifest) {
  // Union of lifecycle script values + all other script values from the manifest
  const allScriptValues = [
    ...Object.values(lifecycleScripts),
    ...Object.values((manifest && manifest.scripts) || {}),
  ]
  const combined = allScriptValues.join(' ')
  const matches = new Set()
  for (const { pattern, file } of REGISTRY_PATTERNS) {
    // Reset lastIndex to avoid stateful global-flag issues
    if (pattern.global) pattern.lastIndex = 0
    if (pattern.test(combined)) matches.add(file)
  }
  if (manifest) {
    const depStr = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.optionalDependencies,
    }).join('\n')
    for (const { pattern, file } of DEP_TO_DEFINITION) {
      if (pattern.test(depStr)) matches.add(file)
    }
  }
  return [...matches]
}

// Pull meaningful tool-like tokens out of lifecycle script text.
function extractCommandTokens (lifecycleScripts) {
  const tokens = new Set()
  for (const src of Object.values(lifecycleScripts)) {
    for (const m of src.matchAll(/\b([a-z][\w.-]{1,})\b/gi)) {
      const tok = m[1].toLowerCase()
      // Skip pure numbers, short words, shell noise, and dotfile names
      if (/^\d/.test(tok) || tok.length < 3 || SHELL_NOISE.has(tok)) continue
      // Skip path-like tokens (contain slashes or look like file extensions)
      if (tok.includes('/') || /\.\w{2,4}$/.test(tok)) continue
      // Skip tokens that are dotfile names (.gitignore, .eslintrc, etc.)
      if (tok.startsWith('.')) continue
      tokens.add(tok)
    }
  }
  return [...tokens]
}

// Returns true when the package has non-JS compilation or binary-download signals.
// Requires at least one concrete signal — a matching dep name OR a build/download
// token in the lifecycle scripts.  Packages with only generic scripts like
// `prepare: "husky"` or `postinstall: "node scripts/postinstall.js"` return false.
function isBuildPackage (manifest) {
  const allDeps = Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
  })
  const depStr = allDeps.join('\n')
  if (BUILD_DEP_PATTERNS.some(p => p.test(depStr))) return true

  const scriptStr = Object.values(manifest.scripts).join(' ')
  for (const tok of extractCommandTokens({ s: scriptStr })) {
    if (BUILD_SCRIPT_TOKENS.has(tok)) return true
  }

  // Binary downloader patterns in script content (fetch/download prebuilt binaries)
  if (/\binstall.?binary\b|\bdownload.?binary\b|\bbin.?wrapper\b|\bffmpeg.install\b/i.test(scriptStr)) {
    return true
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

  if (/\bnode-gyp\b|\bnode-pre-gyp\b|@mapbox\/node-pre-gyp\b|@xprofiler\/node-pre-gyp\b|\bnode-gyp-build\b|\bprebuild/.test(combined)) {
    inferred.push('binding.gyp')
  }
  if (/\bneon-cli\b|\bwasm-pack\b|\bcargo\s+(?:build|install|test|run)\b/.test(combined) ||
      /@napi-rs\/cli/.test(allDeps)) {
    inferred.push('Cargo.toml')
  }
  if (/\bcmake-js\b|\bcmake\b/.test(combined)) {
    inferred.push('CMakeLists.txt')
  }
  if (/\bexpo-module\b|\bgradlew\b|\breact-native\b|@capacitor\/core\b/.test(combined) ||
      /^react-native$/m.test(allDeps)) {
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
      // Simple name list provided by user — seed packages to always include
      return { names: raw, manifests: null, seen: null, discoveryState: null }
    }
    if (raw.packages && Array.isArray(raw.packages)) {
      return {
        names: null,
        manifests: raw.packages,
        seen: new Set(raw.seenNames || raw.packages.map(p => p.name)),
        discoveryState: raw.discoveryState || null,
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      process.stderr.write(`  Warning: could not read cache ${filePath}: ${err.message}\n`)
    }
  }
  return { names: null, manifests: null, seen: null, discoveryState: null }
}

async function savePackageCache (filePath, manifests, seen, discoveryState) {
  const data = {
    generatedAt: new Date().toISOString(),
    count: manifests.length,
    discoveryState,   // { queryIndex, queryFrom } — where to resume scanning
    seenNames: [...seen], // all names already fetched (kept + rejected), avoids re-scanning
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

  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`
Usage: node scripts/build-indicator-suggestions.js [options]

Scans popular npm packages for native-build lifecycle scripts and suggests
missing entries for indicator-definitions.js.

Options:
  --top <n>          Number of new packages to collect per run  (default: 1000)
  --delay <ms>       Delay between npm registry requests in ms  (default: 60)
  --out <file>       Output JSON path                           (default: indicator-suggestions.json)
  --packages <file>  Seed package-name list instead of permanent store
  --reset            Delete both cache files and start from scratch
  -h, --help         Show this help message

Cache files (written next to --out, gitignored):
  *.packages.json    Permanent manifest store — survives successful runs
  *.tmp.json         Resume cache — deleted on successful completion

`)
    process.exit(0)
  }

  const topN = +flag('--top', 1000)
  const delayMs = +flag('--delay', 60)
  const outFile = flag('--out', 'indicator-suggestions.json')
  const outPath = path.isAbsolute(outFile) ? outFile : path.join(ROOT, outFile)
  const doReset = args.includes('--reset')

  // Two cache files serve different purposes:
  //   .packages.json  — permanent manifest store; saved on every successful run;
  //                     never auto-deleted; loaded first on startup so re-analysis
  //                     with updated definitions is instant (no network needed).
  //   .tmp.json       — resume cache for interrupted runs; checkpointed every 100
  //                     packages; deleted on successful completion.
  // --packages <file> overrides the permanent store path (e.g. to seed with a
  //                     hand-crafted name list).
  // --reset           — delete both cache files and start from scratch.
  const pkgFile          = flag('--packages', null)
  const manifestStorePath = outPath.replace(/\.json$/, '.packages.json')
  const resumeCachePath   = outPath.replace(/\.json$/, '.tmp.json')
  const pkgPath = pkgFile
    ? (path.isAbsolute(pkgFile) ? pkgFile : path.join(ROOT, pkgFile))
    : manifestStorePath

  if (doReset) {
    await fs.unlink(manifestStorePath).catch(() => {})
    await fs.unlink(resumeCachePath).catch(() => {})
    process.stderr.write(`  ⚠️  --reset: deleted ${manifestStorePath} and ${resumeCachePath}\n\n`)
  }

  process.stderr.write(`\n📦 npm indicator-suggestions builder\n`)
  process.stderr.write(`   out:      ${outPath}\n`)
  process.stderr.write(`   packages: ${pkgPath}${pkgFile ? ' (user-provided)' : ' (permanent store)'}\n`)
  process.stderr.write(`   resume:   ${resumeCachePath}  (deleted on success)\n\n`)

  // ---------------------------------------------------------------------------
  // Load manifests: permanent store first, fall back to resume cache.
  // ---------------------------------------------------------------------------
  const manifests = []
  const seen = new Set()
  let resumeQueryIndex = 0
  let resumeQueryFrom = 0

  process.stderr.write('Loading package data...\n')

  // Try permanent store first (from a previous successful run)
  let loaded = await loadPackageCache(pkgPath)
  let resumeMergeCount = 0

  // If permanent store empty or missing, try the resume cache
  if (!loaded.manifests && !loaded.names) {
    loaded = await loadPackageCache(resumeCachePath)
    if (loaded.manifests || loaded.names) {
      process.stderr.write(`  (permanent store empty, loaded from resume cache)\n`)
    }
  } else {
    // Permanent store has data — also check if there's a newer resume cache
    // (from an interrupted run) to merge its additional packages and discovery state.
    const resume = await loadPackageCache(resumeCachePath)
    if (resume.manifests && resume.manifests.length > (loaded.manifests?.length ?? 0)) {
      resumeMergeCount = resume.manifests.length - (loaded.manifests?.length ?? 0)
      process.stderr.write(`  (merging resume cache: ${resumeMergeCount} additional packages)\n`)
      // Prefer the resume cache's discovery state (it's more recent)
      loaded = {
        ...loaded,
        manifests: resume.manifests,
        seen: resume.seen,
        discoveryState: resume.discoveryState ?? loaded.discoveryState,
      }
    }
  }

  const { names, manifests: cached, seen: cachedSeen, discoveryState } = loaded

  if (cached) {
    for (const m of cached) manifests.push(m)
    for (const n of (cachedSeen || [])) seen.add(n)
    if (discoveryState) {
      resumeQueryIndex = discoveryState.queryIndex || 0
      resumeQueryFrom  = discoveryState.queryFrom  || 0
    }

    // Startup summary — show what's loaded and what we're doing
    const withDl = manifests.filter(m => m.weeklyDownloads > 0)
    const sorted = [...withDl].sort((a, b) => b.weeklyDownloads - a.weeklyDownloads)
    const dlMax  = sorted[0]?.weeklyDownloads ?? 0
    const dlMin  = sorted[sorted.length - 1]?.weeklyDownloads ?? 0

    process.stderr.write(`  ✓ loaded ${manifests.length} packages (${seen.size} names scanned)\n`)
    if (withDl.length > 0) {
      process.stderr.write(
        `     download range: ${dlMin.toLocaleString()}–${dlMax.toLocaleString()}/wk` +
        ` (${withDl.length} with counts)\n`
      )
      if (sorted.length >= 3) {
        const top3 = sorted.slice(0, 3).map(m => `${m.name} (${m.weeklyDownloads.toLocaleString()})`).join(', ')
        process.stderr.write(`     top by downloads: ${top3}\n`)
      }
    }
    const remaining = topN - resumeMergeCount
    let resumeHint = ''
    if (discoveryState) {
      const qOrder = discoveryState.queryOrder || []
      const qName = (qOrder[resumeQueryIndex] || '').replace('keywords:', '')
      const pos = resumeQueryFrom > 0 ? `, position ${resumeQueryFrom}` : ''
      resumeHint = ` (resuming at "${qName}"${pos})`
    }
    process.stderr.write(
      `     collecting ${remaining} more → will have ${manifests.length + remaining} total` +
      resumeHint +
      '\n\n'
    )
  } else if (names) {
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
  } else {
    process.stderr.write(`  (no existing data — fresh run, targeting ${topN} packages)\n\n`)
  }

  // ---------------------------------------------------------------------------
  // Steps 1–3: fan out across popularity-sorted search queries, deduplicate,
  // fetch manifests, keep only those with lifecycle scripts.
  // Packages already loaded from cache are pre-seeded in manifests/seen above.
  // ---------------------------------------------------------------------------
  const DISCOVERY_QUERIES_BASE = [
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

  // Shuffle on a fresh run so different executions surface different packages.
  // The order is saved in the cache and restored on resume so qi indices stay stable.
  const savedOrder = discoveryState?.queryOrder || null
  const DISCOVERY_QUERIES = savedOrder
    ? savedOrder  // resuming — use the same order checkpointed earlier
    : [...DISCOVERY_QUERIES_BASE].sort(() => Math.random() - 0.5)

  if (!savedOrder) {
    process.stderr.write(`  query order: ${DISCOVERY_QUERIES.map(q => q.replace('keywords:', '')).join(', ')}\n`)
  }

  process.stderr.write('Steps 1–3: Scanning popular packages for lifecycle scripts...\n')
  process.stderr.write(`  (collecting ${topN - resumeMergeCount} new packages with lifecycle scripts)\n`)
  process.stderr.write(`  (skipping ${seen.size} already-scanned names)\n\n`)

  let scanned = 0
  let newThisRun = resumeMergeCount  // count packages merged from interrupted run toward the --top target
  let done = false
  let finalDiscoveryState = { queryOrder: DISCOVERY_QUERIES, queryIndex: resumeQueryIndex, queryFrom: resumeQueryFrom }

  for (let qi = resumeQueryIndex; qi < DISCOVERY_QUERIES.length; qi++) {
    if (done) break
    const query = DISCOVERY_QUERIES[qi]
    let from = (qi === resumeQueryIndex) ? resumeQueryFrom : 0
    const size = 250
    process.stderr.write(`  query: ${query}${from > 0 ? ` (resuming from=${from})` : ''}\n`)

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
            newThisRun++
            if (newThisRun % 50 === 0 || newThisRun <= 3) {
              process.stderr.write(
                `    found ${newThisRun}/${topN} new (${manifests.length} total)` +
                ` (scanned ${scanned}, last: ${name})\n`
              )
            }
            if (newThisRun >= topN) done = true
            // Checkpoint save every 100 new packages (resume cache)
            if (newThisRun % 100 === 0) {
              await savePackageCache(resumeCachePath, manifests, seen, { queryOrder: DISCOVERY_QUERIES, queryIndex: qi, queryFrom: from })
            }
          }
        }
        finalDiscoveryState = { queryOrder: DISCOVERY_QUERIES, queryIndex: qi, queryFrom: from }
        if (delayMs > 0) await sleep(delayMs)
      }

      if (from >= 2000) break
    }

    // Save resume cache at query boundary so switching keywords is a clean resume point
    const nextQi = qi + 1
    const nextFrom = 0
    process.stderr.write(`  checkpoint: ${manifests.length} packages, ${seen.size} seen — saved\n`)
    await savePackageCache(resumeCachePath, manifests, seen, { queryOrder: DISCOVERY_QUERIES, queryIndex: nextQi, queryFrom: nextFrom })
  }

  process.stderr.write(
    `\n  ✓ collected ${newThisRun} new packages (${manifests.length} total)` +
    ` (scanned ${scanned} new across ${seen.size} unique names)\n\n`
  )

  // Fetch weekly download counts only for the packages we kept.
  // Skip packages that already have download counts from a previous run
  // (weeklyDownloads > 0 means they were fetched before).
  process.stderr.write('Step 4/5: Fetching weekly download counts...\n')
  const needDownloads = manifests.filter(m => !m.weeklyDownloads)
  if (needDownloads.length < manifests.length) {
    process.stderr.write(`  (${manifests.length - needDownloads.length} already cached, fetching ${needDownloads.length} new)\n`)
  }

  const dlScoped = needDownloads.filter(m => m.name.startsWith('@'))
  const dlPlain  = needDownloads.filter(m => !m.name.startsWith('@'))
  let dlFetched  = manifests.length - needDownloads.length  // already had counts

  // Unscoped — batches of 40, save cache after each batch
  for (let i = 0; i < dlPlain.length; i += 40) {
    const batch = dlPlain.slice(i, i + 40)
    const url = `https://api.npmjs.org/downloads/point/last-week/${batch.map(m => m.name).join(',')}`
    const data = await fetchJson(url)
    if (data) {
      for (const m of batch) m.weeklyDownloads = data[m.name]?.downloads || 0
    }
    dlFetched += batch.length
    process.stderr.write(`  [${dlFetched}/${manifests.length}] download counts fetched\n`)
    await savePackageCache(resumeCachePath, manifests, seen, null)
    await sleep(150)
  }

  // Scoped — one at a time, save resume cache every 20
  for (let i = 0; i < dlScoped.length; i++) {
    const m = dlScoped[i]
    const encoded = m.name.replace(/\//g, '%2F')
    const data = await fetchJson(`https://api.npmjs.org/downloads/point/last-week/${encoded}`)
    if (data) m.weeklyDownloads = data.downloads || 0
    dlFetched++
    if (i % 20 === 19 || i === dlScoped.length - 1) {
      process.stderr.write(`  [${dlFetched}/${manifests.length}] download counts fetched\n`)
      await savePackageCache(resumeCachePath, manifests, seen, null)
    }
    await sleep(500)  // 500ms between scoped fetches — avoids 429s at 100ms
  }

  process.stderr.write(`  ✓ all download counts fetched\n\n`)

  // Save final manifests to permanent store with the last known discovery position,
  // so --top <larger N> can continue from where this run stopped without re-paging.
  await savePackageCache(pkgPath, manifests, seen, finalDiscoveryState)
  process.stderr.write(`  ✓ manifests saved to ${pkgPath}\n\n`)
  await fs.unlink(resumeCachePath).catch(() => {})

  // Step 5/5: Analyze
  process.stderr.write('Step 5/5: Analyzing...\n')

  const categorized = {} // indicatorFile → packageName[]
  const uncategorized = [] // packages with build signals but no definition match

  // token → { packages: string[], totalDownloads: number }
  const gapTokens = {}

  for (const manifest of manifests) {
    const lc = extractLifecycleScripts(manifest.scripts)

    const matches = matchExistingDefinitions(lc, manifest)
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
  process.stderr.write(`   New this run:         ${newThisRun}\n`)
  process.stderr.write(`   Total in store:       ${manifests.length}\n`)
  process.stderr.write(`   Matched (existing):   ${output.coverage.matchedByExistingDefinitions}\n`)
  process.stderr.write(`   Uncategorized builds: ${output.coverage.uncategorizedBuildPackages}\n`)
  process.stderr.write(`   Pattern gaps found:   ${commandPatternGaps.length}\n`)
  process.stderr.write(`\n   Written to: ${outPath}\n\n`)
}

main().catch(err => {
  process.stderr.write(`\nFatal: ${err.message}\n${err.stack}\n`)
  process.exit(1)
})
