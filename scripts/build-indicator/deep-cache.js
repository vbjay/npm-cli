'use strict'

const crypto = require('crypto')
const fs     = require('fs/promises')
const path   = require('path')

const ROOT = path.resolve(__dirname, '..', '..')
const { INDICATOR_REGISTRY, SIGNAL_DESCRIPTIONS } = require(path.join(ROOT, 'lib', 'utils', 'indicator-definitions.js'))
const { hasBuildHint, scanBuildIndicatorsForPackage, detectClues, investigate } = require(path.join(ROOT, 'lib', 'utils', 'indicator-scanner.js'))
const scanPackageScripts = require(path.join(ROOT, 'lib', 'utils', 'script-risk-scanner.js'))
const { findLocalRefs, findBareRefs } = scanPackageScripts

const { writeDefanged, rmReadOnly } = require('./defang')
const { fetchRaw, makeLimiter } = require('./http')
const { wrapWithHash, unwrapVerified, META_HASH_SEED } = require('./integrity')
const { extractLifecycleScripts, parseCommandFile } = require('./lifecycle')

// ---------------------------------------------------------------------------
// Version strings — mixing schema + registry keys → a short hash.
// Increment DEEP_CACHE_SCHEMA when defanging or fetch coverage changes.
// ---------------------------------------------------------------------------

// Increment when defanging or fetch coverage changes (e.g. new file type covered,
// header format changed).  Mixed into both DEEP_FETCH_VERSION and DEEP_SCAN_VERSION.
const DEEP_CACHE_SCHEMA = 'defang-v8'

// Two separate cache versions because fetch and scan have different invalidation triggers.
//
// DEEP_FETCH_VERSION — changes only when the on-disk file set needs to change:
//   • DEEP_CACHE_SCHEMA bumped (defanging scheme changed)
//   • INDICATOR_REGISTRY gains or removes a key (a new file to proactively fetch)
// When this changes every package directory is deleted and re-downloaded.
//
// DEEP_SCAN_VERSION — changes any time the scanner logic changes:
//   • DEEP_FETCH_VERSION changes (fetch invalidation implies scan invalidation)
//   • Signal pattern source/flags changed
//   • Any indicator commandPattern source changed (affects clue detection)
//   • Any scanner step pattern changed (affects investigation output)
// When this changes only .meta.json's scan results are stale; files stay on disk.
// The scanner re-runs in place against the existing file tree.
const { SIGNAL_PATTERNS } = scanPackageScripts

function computeDeepFetchVersion () {
  const parts = [DEEP_CACHE_SCHEMA]
  // Only include indicator file keys — these control which files are proactively fetched.
  for (const key of Object.keys(INDICATOR_REGISTRY)) {
    parts.push(key)
  }
  let h = 0
  const str = parts.join('\n')
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}

function computeDeepScanVersion () {
  const parts = [DEEP_CACHE_SCHEMA, computeDeepFetchVersion()]
  // Signal patterns: name + full regex source (flags included)
  for (const [name, pat] of SIGNAL_PATTERNS) {
    const src = pat instanceof RegExp ? pat.source + pat.flags : String(pat)
    parts.push(name + '=' + src)
  }
  // Indicator registry: file key + commandPatterns + scanner step patterns
  for (const [key, entry] of Object.entries(INDICATOR_REGISTRY)) {
    const cmdPats = (entry.detect?.commandPatterns || [])
      .map(p => p instanceof RegExp ? p.source : String(p))
    const stepPats = entry.scanner?.steps
      ? entry.scanner.steps.map(s => s.pattern instanceof RegExp ? s.pattern.source : '')
      : []
    parts.push(key + ':' + [...cmdPats, ...stepPats].join('|'))
  }
  let h = 0
  const str = parts.join('\n')
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}

const DEEP_FETCH_VERSION = computeDeepFetchVersion()
const DEEP_SCAN_VERSION  = computeDeepScanVersion()

// Maximum files to BFS-scan per package in deep analysis.  Large compiled
// bundles (e.g. node-llama-cpp with 258 JS files) otherwise consume minutes
// of CPU.  100 files covers the vast majority of real-world packages while
// bounding worst-case scan time to ~5s per package.
const MAX_FILES_DEEP_SCAN = 100
const INDICATOR_COUNT = Object.keys(INDICATOR_REGISTRY).length

// Node.js built-in module names.  Bare require()s of these are never npm
// packages and should not be fetched or scanned.
const NODE_BUILTIN_MODULES = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain',
  'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net',
  'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring',
  'readline', 'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls',
  'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads',
  'zlib',
])

// Minimal npm package-name validator.  Rejects names that are clearly not npm
// packages: spaces, '=', uppercase-only identifiers from embedded C++ comments
// (e.g. `LLM_TENSOR_NAMES`), C/C++ header filenames (e.g. `llama.h`), etc.
// Valid names: lowercase + digits + [-._] with optional @scope/ prefix.
const VALID_NPM_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const isValidNpmPackageName = (name) => {
  if (typeof name !== 'string' || name.length === 0 || name.length > 214) return false
  if (!VALID_NPM_NAME_RE.test(name)) return false
  // Reject names with 2+ dots in the package portion — these look like hostnames
  // (e.g. registry.npmjs.org) not npm packages.  Legitimate packages with dots
  // (core.js, socket.io, highlight.js) have at most one dot.
  const bare = name.startsWith('@') ? (name.split('/')[1] || '') : name
  return (bare.match(/\./g) || []).length < 2
}

// ---------------------------------------------------------------------------
// Deep-scan one package via unpkg — selective file fetch, NOT a whole-package
// download.  Only two categories of files are pulled per package:
//   1. Indicator files (binding.gyp, Cargo.toml, …) — fetched by exact name.
//   2. JS/MJS/CJS files referenced in lifecycle scripts (e.g. "node install.js")
//      and their transitive local require() / import dependencies (up to MAX_FETCH_DEPTH).
// Cross-package bare require('pkg') calls and ESM imports (import … from 'pkg' / import('pkg'))
// are followed to discover new candidate packages, but only their package entry file is fetched.
// Results are cached by name@version in deepDir; re-runs read from cache.
// ---------------------------------------------------------------------------

// Compute a short hash of all files (path relative to dir + size in bytes)
// present inside dir, excluding .meta.json.  Sorted for determinism.
// Used as a file-tree integrity check: if any file is added, removed, or
// resized since the cache was written, the hash changes and the cache is
// considered invalid.
async function hashDirTree (dir) {
  const entries = []
  async function walk (current) {
    let items
    try { items = await fs.readdir(current, { withFileTypes: true }) } catch { return }
    for (const item of items) {
      const full = path.join(current, item.name)
      if (item.isDirectory()) {
        await walk(full)
      } else if (item.name !== '.meta.json') {
        const rel = path.relative(dir, full).split(path.sep).join('/')
        const { size } = await fs.stat(full).catch(() => ({ size: 0 }))
        entries.push(`${rel}:${size}`)
      }
    }
  }
  await walk(dir)
  entries.sort()
  return crypto.createHash('sha256').update(entries.join('\n')).digest('hex').slice(0, 16)
}

// Returns a filesystem-safe directory name for a versioned package cache entry.
// Scoped packages: '@scope/pkg@1.2.3' → '@scope__pkg@1.2.3'
function deepSafeName (name, version) {
  return name.replace(/\//g, '__') + '@' + version
}

// Parses a versioned fetchedPkgs entry back into { name, version }.
// Entries look like 'pkg@1.2.3' or '@scope__pkg@1.2.3' (slashes already replaced).
// The last '@' separates name from version.
function parseDeepPkgEntry (entry) {
  const at = entry.lastIndexOf('@')
  if (at <= 0) return null  // no version suffix — old-format entry, skip
  return { name: entry.slice(0, at).replace(/__/g, '/'), version: entry.slice(at + 1) }
}

async function deepFetchPackage (manifest, deepDir, limit, opts = {}) {
  const pkgCacheDir = path.join(deepDir, deepSafeName(manifest.name, manifest.version))
  const metaPath = path.join(pkgCacheDir, '.meta.json')

  // Cache hit: directory name already encodes the version, so only check schema + file tree.
  const dirExists = await fs.access(pkgCacheDir).then(() => true, () => false)
  if (dirExists) {
    try {
      const envelope = JSON.parse(await fs.readFile(metaPath, 'utf-8'))
      const meta = (envelope?.hash !== undefined) ? unwrapVerified(META_HASH_SEED, envelope, metaPath) : envelope
      if (meta) {
        const stateOk = meta.state === 'fetched' || meta.state === 'scanned'
        if (stateOk && meta.fetchVersion === DEEP_FETCH_VERSION) {
          const currentTreeHash = await hashDirTree(pkgCacheDir)
          if (currentTreeHash === meta.filesHash) {
            return { fetchedFiles: meta.fetchedFiles || [], bareFollows: meta.bareFollows || [], resolvedFollows: meta.resolvedFollows || null, fromCache: true }
          }
          if (!opts?.quietTreeWarning) {
            process.stderr.write(`  🗑️  file tree changed for ${manifest.name}@${manifest.version} (${meta.filesHash} → ${currentTreeHash}) — invalidating cache\n`)
          }
        }
      }
    } catch { /* .meta.json missing or corrupt — treat as stale */ }
    await rmReadOnly(pkgCacheDir)
  }

  await fs.mkdir(pkgCacheDir, { recursive: true })

  const encoded = manifest.name.replace(/\//g, '%2F')
  const fetchedFiles = []

  const fetchOne = async (relPosix) => {
    const url = `https://unpkg.com/${encoded}@${manifest.version}/${relPosix}`
    const buf = await fetchRaw(url)
    if (!buf) return false
    const dest = path.join(pkgCacheDir, ...relPosix.split('/'))
    await fs.mkdir(path.dirname(dest), { recursive: true })
    if (!await writeDefanged(dest, relPosix, buf)) {
      process.stderr.write(`  ⚠️  skipped binary: ${manifest.name}/${relPosix}\n`)
      return false
    }
    fetchedFiles.push(relPosix)
    return true
  }

  // Step 1: Fetch indicator files (binding.gyp, Cargo.toml, …) + package.json.
  // package.json is always cached so version-map resolution works for bare follows.
  await Promise.all([
    limit(() => fetchOne('package.json')),
    ...Object.keys(INDICATOR_REGISTRY).map(file => limit(() => fetchOne(file))),
  ])

  // Build version map from manifest deps so bare require()/import calls resolve to the
  // version the package actually declared, not just unpkg latest.
  const parentVersionMap = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  }

  // Step 2: BFS fetch of lifecycle JS files and their require() deps.
  const MAX_FETCH_DEPTH = 10
  const fetched = new Set()
  // Bare package refs collected during BFS — outer worker pool resolves and enqueues them
  const bareFollowsMap = new Map()  // bare name → {name, versionSpec}

  const resolveRelPosix = async (absPath) => {
    const exts = ['', '.js', '.mjs', '.cjs']
    for (const ext of exts) {
      const candidate = absPath + ext
      const rel = path.relative(pkgCacheDir, candidate)
      if (rel.startsWith('..')) continue
      const relPosix = rel.split(path.sep).join('/')
      if (fetched.has(relPosix)) return relPosix
      try { await fs.lstat(candidate); return relPosix } catch { /* not on disk yet */ }
    }
    // If the path already has a non-JS extension (e.g. .json, .ts, .yaml),
    // it won't be found by the loop above when not yet on disk.
    // Return the bare relative path so fetchWithRefs can fetch it.
    const bareRel = path.relative(pkgCacheDir, absPath)
    if (!bareRel.startsWith('..') && path.extname(absPath) !== '') {
      return bareRel.split(path.sep).join('/')
    }
    return null
  }

  const fetchWithRefs = async (relPosix, depth) => {
    if (depth > MAX_FETCH_DEPTH || fetched.has(relPosix)) return
    fetched.add(relPosix)

    const ok = await limit(() => fetchOne(relPosix))
    if (!ok) return

    try {
      const content = await fs.readFile(path.join(pkgCacheDir, ...relPosix.split('/')), 'utf8')
      const refs = findLocalRefs(content)
      const bareRefs = findBareRefs(content)
      const fileDir = path.dirname(path.join(pkgCacheDir, ...relPosix.split('/')))
      await Promise.all([
        ...refs.map(async (ref) => {
          const abs = path.resolve(fileDir, ref)
          const resolved = await resolveRelPosix(abs)
          if (resolved) {
            await fetchWithRefs(resolved, depth + 1)
          } else {
            const rel = path.relative(pkgCacheDir, abs).split(path.sep).join('/')
            if (!rel.startsWith('..')) {
              // If the ref already carries a file extension (e.g. "../package.json"),
              // use it as-is; only append .js for extension-less module specifiers.
              const hasExt = path.extname(rel) !== ''
              const toFetch = hasExt ? rel : rel + '.js'
              if (!fetched.has(toFetch)) {
                await fetchWithRefs(toFetch, depth + 1)
              }
            }
          }
        }),
      ])
      // Collect bare package refs (require()/import) — do NOT follow inline; outer worker pool handles them
      for (const pkg of bareRefs) {
        if (!NODE_BUILTIN_MODULES.has(pkg) && isValidNpmPackageName(pkg) && !bareFollowsMap.has(pkg)) {
          bareFollowsMap.set(pkg, { name: pkg, versionSpec: parentVersionMap[pkg] || null })
        }
      }
    } catch { /* file unreadable or ref resolution failed — skip */ }
  }

  const lifecycleScripts = extractLifecycleScripts(manifest.scripts)
  for (const cmd of Object.values(lifecycleScripts)) {
    for (const { filePath } of parseCommandFile(cmd, pkgCacheDir)) {
      const rel = path.relative(pkgCacheDir, filePath)
      if (!rel.startsWith('..')) {
        await fetchWithRefs(rel.split(path.sep).join('/'), 0)
      }
    }
  }

  // Hash is computed AFTER all writeDefanged() calls above complete, so it
  // reflects defanged file sizes on disk — not the original fetched content.
  const filesHash = await hashDirTree(pkgCacheDir)
  await fs.writeFile(metaPath, JSON.stringify(wrapWithHash(META_HASH_SEED, {
    fetchVersion: DEEP_FETCH_VERSION,
    filesHash,
    fetchedFiles,
    bareFollows: [...bareFollowsMap.values()],
    fetchedPkgs: [],
    state: 'fetched',
  }), null, 2) + '\n')

  return { fetchedFiles, bareFollows: [...bareFollowsMap.values()], resolvedFollows: null, fromCache: false }
}

async function deepAnalyzePackage (manifest, deepDir) {
  const pkgCacheDir = path.join(deepDir, deepSafeName(manifest.name, manifest.version))
  const metaPath = path.join(pkgCacheDir, '.meta.json')

  let meta
  try {
    const envelope = JSON.parse(await fs.readFile(metaPath, 'utf-8'))
    meta = (envelope?.hash !== undefined)
      ? unwrapVerified(META_HASH_SEED, envelope, metaPath)
      : envelope  // legacy unwrapped
    if (!meta) return { results: [], referencedFiles: [], fromCache: false }
  } catch { return { results: [], referencedFiles: [], fromCache: false } }

  // Full cache hit: scan results valid only if scan version matches.
  if (meta.state === 'scanned' && meta.scanVersion === DEEP_SCAN_VERSION) {
    const currentTreeHash = await hashDirTree(pkgCacheDir)
    if (currentTreeHash === meta.filesHash) {
      return { results: meta.results, referencedFiles: meta.referencedFiles || [], fromCache: true }
    }
  }

  // Files must be present (state 'fetched' or 'scanned') to run scan
  if (meta.state !== 'fetched' && meta.state !== 'scanned') {
    return { results: [], referencedFiles: [], fromCache: false }
  }

  const lifecycleScripts = extractLifecycleScripts(manifest.scripts)
  process.stderr.write(`      [deepScan] ${manifest.name}: scanning JS files...\n`)
  const referencedFiles = await scanPackageScripts(pkgCacheDir, lifecycleScripts, { maxFiles: MAX_FILES_DEEP_SCAN })
  process.stderr.write(`      [deepScan] ${manifest.name}: JS scan done (${referencedFiles.length} refs) — detecting clues...\n`)

  for (const pkgEntry of (meta.fetchedPkgs || [])) {
    // Old-format entries are 'name@version' strings from pre-v6 deep-fetch caches.
    const parsed = parseDeepPkgEntry(pkgEntry)
    if (!parsed) continue  // old-format bare name entry — skip
    const { name: depName, version: depVersion } = parsed
    // Skip the package itself (self-reference causes double-scanning of all files).
    if (depName === manifest.name) continue
    // Skip Node built-ins and malformed names that slipped past validation.
    if (NODE_BUILTIN_MODULES.has(depName) || !isValidNpmPackageName(depName)) continue
    const pkgDir = path.join(deepDir, deepSafeName(depName, depVersion))
    try {
      const pkgJsonBuf = await fs.readFile(path.join(pkgDir, 'package.json'), 'utf8')
      const pkgJson = JSON.parse(pkgJsonBuf)
      const main = (typeof pkgJson.main === 'string' && pkgJson.main) || 'index.js'
      const mainRel = main.startsWith('./') ? main.slice(2) : main
      // Skip large compiler/bundler main entries (e.g. typescript.js at 9MB) that
      // are not lifecycle helpers and would block the event loop for minutes.
      const mainAbs = path.join(pkgDir, ...mainRel.split('/'))
      const mainStat = await fs.stat(mainAbs).catch(() => null)
      if (mainStat && mainStat.size > 256 * 1024) continue  // >256 KB — skip
      const depRefs = await scanPackageScripts(pkgDir, { postinstall: `node ${mainRel}` }, { maxFiles: MAX_FILES_DEEP_SCAN })
      referencedFiles.push(...depRefs)
    } catch { /* not fully fetched — skip */ }
  }

  process.stderr.write(`      [deepScan] ${manifest.name}: checking ${manifest.name}@${manifest.version} against ${INDICATOR_COUNT} indicators...\n`)
  const clues = await detectClues(pkgCacheDir, manifest.scripts || {}, referencedFiles, INDICATOR_REGISTRY)
  process.stderr.write(`      [deepScan] ${manifest.name}: ${clues.size} clue(s) found — investigating...\n`)
  const results = []
  for (const file of clues) {
    process.stderr.write(`      [deepScan] ${manifest.name}: investigating ${file}...\n`)
    const r = await investigate(file, INDICATOR_REGISTRY[file], pkgCacheDir)
    results.push(r)
    process.stderr.write(`      [deepScan] ${manifest.name}: ${file} done\n`)
  }

  await fs.writeFile(metaPath, JSON.stringify(wrapWithHash(META_HASH_SEED, {
    ...meta,
    scanVersion: DEEP_SCAN_VERSION,
    results,
    referencedFiles,
    scannedAt: new Date().toISOString(),
    state: 'scanned',
  }), null, 2) + '\n')

  return { results, referencedFiles, fromCache: false }
}

module.exports = {
  DEEP_CACHE_SCHEMA,
  DEEP_FETCH_VERSION,
  DEEP_SCAN_VERSION,
  MAX_FILES_DEEP_SCAN,
  INDICATOR_COUNT,
  NODE_BUILTIN_MODULES,
  VALID_NPM_NAME_RE,
  isValidNpmPackageName,
  hashDirTree,
  deepSafeName,
  parseDeepPkgEntry,
  deepFetchPackage,
  deepAnalyzePackage,
  // Re-export scanner references needed by main
  INDICATOR_REGISTRY,
  SIGNAL_DESCRIPTIONS,
  hasBuildHint,
  scanBuildIndicatorsForPackage,
}
