'use strict'

const crypto = require('crypto')
const fs = require('fs/promises')
const os = require('os')
const path = require('path')
const zlib = require('zlib')

const ROOT = path.resolve(__dirname, '..', '..')
const { INDICATOR_REGISTRY, SIGNAL_DESCRIPTIONS } = require(path.join(ROOT, 'lib', 'utils', 'indicator-definitions.js'))
const { hasBuildHint, scanBuildIndicatorsForPackage, detectClues, investigate } = require(path.join(ROOT, 'lib', 'utils', 'indicator-scanner.js'))
const scanPackageScripts = require(path.join(ROOT, 'lib', 'utils', 'script-risk-scanner.js'))
const { findLocalRefs, findBareRefs, findExecPathRefs } = scanPackageScripts

const { writeDefanged, rmReadOnly } = require('./defang')
const { fetchRaw, fetchJson, makeLimiter } = require('./http')
const { wrapWithHash, unwrapVerified, META_HASH_SEED } = require('./integrity')
const { extractLifecycleScripts, parseCommandFile } = require('./lifecycle')

// ---------------------------------------------------------------------------
// Version strings — mixing schema + registry keys → a short hash.
// Increment DEEP_CACHE_SCHEMA when defanging or fetch coverage changes.
// ---------------------------------------------------------------------------

// Increment when defanging or fetch coverage changes (e.g. new file type covered,
// header format changed).  Mixed into both DEEP_FETCH_VERSION and DEEP_SCAN_VERSION.
// defang-v16: resolveRelPosix (deepFetchPackage BFS) now probes .ts/.mts/.cts extensions
//             so TypeScript source files are fetched when a lifecycle script runs them
//             via ts-node/tsx; require.resolve() refs are also followed.
const DEEP_CACHE_SCHEMA = 'defang-v16'

// Bump when scanner implementation changes affect output format or deduplication
// independently of signal patterns or indicator commandPatterns.
// Changes DEEP_SCAN_VERSION only — does NOT trigger a re-fetch of package files.
// scan-impl-v4: findBareRefs and findLocalRefs now strip `import type` /
//               `export type` lines before extracting refs, avoiding wasteful
//               bare-follows for @types/* and type-only re-export barrels.
// scan-impl-v5: `import type from './foo'` (ESM binding-name case) is now
//               correctly preserved — STRIP_TYPE_ONLY_RE uses a lookahead to
//               distinguish TypeScript type-only syntax from valid ESM imports
//               where 'type' is the default binding name.
const SCAN_IMPL_VERSION = 'scan-impl-v5'

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

function computeDeepFetchVersion() {
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

function computeDeepScanVersion() {
  const parts = [DEEP_CACHE_SCHEMA, computeDeepFetchVersion(), SCAN_IMPL_VERSION]
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
const DEEP_SCAN_VERSION = computeDeepScanVersion()

// Maximum files to BFS-scan per package in deep analysis.  Large compiled
// bundles (e.g. node-llama-cpp with 258 JS files) otherwise consume minutes
// of CPU.  100 files covers the vast majority of real-world packages while
// bounding worst-case scan time to ~5s per package.
const MAX_FILES_DEEP_SCAN = 100

// Gunzipped tarball size above which we offload the buffer to a temp file
// rather than keeping it in the heap for the duration of the BFS scan.
// A 10 MB decompressed tarball is already a large package; most are < 2 MB.
const TAR_MEMORY_THRESHOLD = 10 * 1024 * 1024   // 10 MB

// File extensions that are compiled native binaries — not scannable as text.
// When findLocalRefs follows a require('./addon.node') reference, skip the
// HTTP fetch entirely rather than downloading and then discarding on magic-byte
// detection (which would also print a noisy "skipped binary" warning).
const SKIP_FETCH_EXTS = new Set(['.node', '.so', '.dll', '.dylib', '.pyd'])
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
// package.json#exports resolver
//
// Resolves the best CJS entry point from the exports field for the purpose of
// scanning a bare dep's lifecycle-helper code.  Prefers the 'require' condition
// (CJS), then 'node', then 'default', then falls back to #main / index.js.
// Only the root '.' export is consulted — subpath exports are not relevant here.
// ---------------------------------------------------------------------------

// Recursively walk an exports condition node to find a string file path.
// Conditions tried in order: require → node → default → first string found.
function resolveExportsCondition(node) {
  if (typeof node === 'string') return node
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return null
  for (const cond of ['require', 'node', 'default']) {
    if (node[cond] !== undefined) {
      const resolved = resolveExportsCondition(node[cond])
      if (resolved) return resolved
    }
  }
  // Fall through to any remaining condition if none of the preferred ones matched.
  for (const val of Object.values(node)) {
    const resolved = resolveExportsCondition(val)
    if (resolved) return resolved
  }
  return null
}

// Return the best entry-point path string from a parsed package.json.
function resolveExportsEntry(pkgJson) {
  const exportsField = pkgJson.exports
  if (exportsField) {
    // Bare string shorthand: exports = './index.js'
    if (typeof exportsField === 'string') {
      return exportsField
    }
    // Object form: look for the root '.' entry first, then try the object itself
    // as a conditions map (packages that omit the '.' key at the top level).
    const rootNode = (typeof exportsField === 'object' && !Array.isArray(exportsField))
      ? (exportsField['.'] ?? exportsField)
      : null
    if (rootNode) {
      const resolved = resolveExportsCondition(rootNode)
      if (resolved) return resolved
    }
  }
  // Fallback: #main field or index.js
  return (typeof pkgJson.main === 'string' && pkgJson.main) || 'index.js'
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
async function hashDirTree(dir) {
  const entries = []
  async function walk(current) {
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
function deepSafeName(name, version) {
  return name.replace(/\//g, '__') + '@' + version
}

// Parses a versioned fetchedPkgs entry back into { name, version }.
// Entries look like 'pkg@1.2.3' or '@scope__pkg@1.2.3' (slashes already replaced).
// The last '@' separates name from version.
function parseDeepPkgEntry(entry) {
  const at = entry.lastIndexOf('@')
  if (at <= 0) return null  // no version suffix — old-format entry, skip
  return { name: entry.slice(0, at).replace(/__/g, '/'), version: entry.slice(at + 1) }
}

// Fetch the unpkg ?meta directory listing for a path inside a package.
// Returns an array of root-relative posix file paths, or [] on error/not-found.
// Recurses one level into subdirectories to handle the lefthook layout:
//   .lefthook/<hook-name>/<script>.sh
// Used to enumerate git-hook script directories (.husky/, .lefthook/) whose
// file names are not statically known at fetch time.
const GIT_HOOK_FETCH_RE = /\bhusky\b|\blefthook\b/

async function fetchUnpkgDirListing(encoded, version, dirPosix, depth = 0) {
  const url = `https://unpkg.com/${encoded}@${version}/${dirPosix}?meta`
  try {
    // Directory listings are best-effort; use a single attempt so that
    // ECONNRESET / non-2xx responses (dotfile dirs are often absent from
    // published packages) fail silently without noisy retries or backoff.
    const data = await fetchJson(url, 1)
    if (!data || data.type !== 'directory') return []
    const results = []
    for (const f of (data.files || [])) {
      if (f.type === 'file') {
        results.push(f.path.replace(/^\//, ''))   // strip leading slash → relative posix
      } else if (f.type === 'directory' && depth < 1) {
        // Recurse one level for lefthook-style nested hook directories.
        const subPath = f.path.replace(/^\//, '')
        const subFiles = await fetchUnpkgDirListing(encoded, version, subPath, depth + 1)
        results.push(...subFiles)
      }
    }
    return results
  } catch { return [] }
}

// ---------------------------------------------------------------------------
// npm registry tarball fallback
//
// Used when unpkg is unavailable or rate-limiting.  The npm registry serves
// the same package content as a standard .tgz tarball.  We download it once,
// build a path→{offset,size} index, and serve individual file requests from
// the in-memory buffer — avoiding a second network round-trip per file.
//
// npm packs every file under a "package/" top-level directory; the index
// strips that prefix so callers use the same root-relative posix paths as
// the unpkg fetcher (e.g. "package.json", "scripts/build.js").
// ---------------------------------------------------------------------------

// Read a null-terminated string from a Buffer slice.
function readNulStr(buf, start, len) {
  const slice = buf.slice(start, start + len)
  const nul = slice.indexOf(0)
  return (nul === -1 ? slice : slice.slice(0, nul)).toString('utf8')
}

// Parse a gunzipped tar buffer and return a Map<path → {offset, size}>.
// Handles POSIX ustar format (used by node-tar, which npm uses internally).
function buildTarIndex(tarBuf) {
  const index = new Map()
  let offset = 0
  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.slice(offset, offset + 512)
    // Two consecutive all-zero blocks = end of archive
    if (header.every(b => b === 0)) break
    offset += 512  // advance past header

    const rawName = readNulStr(header, 0, 100)
    const prefix = readNulStr(header, 345, 155)  // ustar prefix for long paths
    const fullName = prefix ? `${prefix}/${rawName}` : rawName
    const sizeOctal = readNulStr(header, 124, 12).trim()
    const size = sizeOctal ? parseInt(sizeOctal, 8) : 0
    const typeFlag = String.fromCharCode(header[156])

    // Only index regular files; skip directories, symlinks, pax headers, etc.
    if ((typeFlag === '0' || typeFlag === '\0' || typeFlag === '') && size >= 0) {
      // Strip the "package/" prefix that npm always adds to tarball entries.
      const normalized = fullName.replace(/^package\//, '')
      if (normalized && !normalized.includes('..')) {
        index.set(normalized, { offset, size })
      }
    }
    offset += Math.ceil(Math.max(size, 0) / 512) * 512
  }
  return index
}

// Download, decompress, and index the npm registry tarball for a package.
// Returns the gunzipped Buffer on success, or null on any error.
// Uses 2 retries (vs 3 for unpkg) since this is a fallback path.
async function fetchNpmTarball(name, version) {
  const bare = name.startsWith('@') ? name.split('/')[1] : name
  const encoded = name.replace(/\//g, '%2F')
  const url = `https://registry.npmjs.org/${encoded}/-/${bare}-${version}.tgz`
  try {
    const gz = await fetchRaw(url, 2)
    if (!gz) return null
    return await new Promise((resolve, reject) =>
      zlib.gunzip(gz, (err, buf) => err ? reject(err) : resolve(buf))
    )
  } catch (err) {
    process.stderr.write(`  ⚠️  tarball fallback failed for ${name}@${version}: ${err.message}\n`)
    return null
  }
}

async function deepFetchPackage(manifest, deepDir, limit, opts = {}) {
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
  const fetchedFiles = new Set()

  // Tarball fallback state — populated in step 1b if unpkg misses package.json.
  // When the decompressed tarball exceeds TAR_MEMORY_THRESHOLD it is written to
  // a temp file (tarTempPath) and served via an open file descriptor (tarFd) so
  // the heap is freed; tarIndex is always in memory (just offsets + sizes, tiny).
  // The temp file path is registered in opts.tempFilesSet so it appears in the
  // next checkpoint save — allowing cleanup on resume after an interrupted run.
  let tarBuf = null    // Buffer when small enough to keep in heap
  let tarFd = null     // fs.FileHandle when offloaded to temp file
  let tarTempPath = null   // absolute path of temp file (null when in-heap)
  let tarIndex = null  // Map<path → {offset,size}>, always in memory
  let tarballAttempted = false  // true once step 1b triggers the tarball fallback

  const tarFetch = async (relPosix) => {
    if (!tarBuf && !tarFd) return null
    const entry = tarIndex?.get(relPosix)
    if (!entry) return null
    if (tarBuf) return tarBuf.slice(entry.offset, entry.offset + entry.size)
    // Large-tarball mode: read the exact byte range from the temp file.
    const chunk = Buffer.allocUnsafe(entry.size)
    const { bytesRead } = await tarFd.read(chunk, 0, entry.size, entry.offset)
    return bytesRead > 0 ? chunk.slice(0, bytesRead) : null
  }

  const fetchOne = async (relPosix) => {
    // Priority: unpkg (with its full internal retry budget) → tarball fallback.
    // Once tarBuf/tarFd is set we know unpkg is already unavailable for this
    // package, so skip the unpkg round-trips and go straight to the tarball.
    let buf
    if (tarBuf || tarFd) {
      buf = await tarFetch(relPosix)
    } else {
      const url = `https://unpkg.com/${encoded}@${manifest.version}/${relPosix}`
      buf = await fetchRaw(url)       // exhausts all unpkg retries before returning null
    }
    if (!buf) return false
    const dest = path.join(pkgCacheDir, ...relPosix.split('/'))
    await fs.mkdir(path.dirname(dest), { recursive: true })
    if (!await writeDefanged(dest, relPosix, buf)) {
      process.stderr.write(`  ⚠️  skipped binary: ${manifest.name}/${relPosix}\n`)
      return false
    }
    fetchedFiles.add(relPosix)
    return true
  }

  // Step 1: Fetch indicator files (binding.gyp, Cargo.toml, …) + package.json.
  // package.json is always cached so version-map resolution works for bare follows.
  await Promise.all([
    limit(() => fetchOne('package.json')),
    ...Object.keys(INDICATOR_REGISTRY).map(file => limit(() => fetchOne(file))),
  ])

  // Step 1b: If unpkg didn't serve package.json, try the npm registry tarball.
  // Download once, build an in-memory index, then retry all step-1 files that
  // are still missing — the same fetchOne closure picks up tarBuf automatically.
  if (!fetchedFiles.has('package.json')) {
    tarballAttempted = true
    process.stderr.write(`  ↩️  ${manifest.name}@${manifest.version}: unpkg miss — trying registry tarball\n`)
    tarBuf = await fetchNpmTarball(manifest.name, manifest.version)
    if (tarBuf) {
      // Build the index while the buffer is in memory (single O(n) parse).
      tarIndex = buildTarIndex(tarBuf)
      const tarBufSize = tarBuf.length
      // Offload to temp file if the decompressed tarball exceeds the threshold.
      if (tarBufSize > TAR_MEMORY_THRESHOLD) {
        tarTempPath = path.join(os.tmpdir(),
          `npm-deep-${process.pid}-${Date.now()}.tar`)
        try {
          await fs.writeFile(tarTempPath, tarBuf)
          tarFd = await fs.open(tarTempPath, 'r')
          opts?.tempFilesSet?.add(tarTempPath)   // register for checkpoint tracking
          tarBuf = null  // release heap; fd + index take over
          process.stderr.write(
            `  📦  large tarball (${(tarBufSize / 1024 / 1024).toFixed(1)} MB) offloaded to temp file\n`)
        } catch {
          // Temp-file write failed — keep the buffer in heap and continue.
          tarTempPath = null
        }
      }
      const step1Files = ['package.json', ...Object.keys(INDICATOR_REGISTRY)]
      await Promise.all(
        step1Files
          .filter(f => !fetchedFiles.has(f))
          .map(f => limit(() => fetchOne(f)))
      )
    }
  }

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
  // Pre-populate with step-1 files so the BFS never re-fetches them.
  const fetched = new Set(fetchedFiles)
  // Bare package refs collected during BFS — outer worker pool resolves and enqueues them
  const bareFollowsMap = new Map()  // bare name → {name, versionSpec}

  const resolveRelPosix = async (absPath) => {
    const exts = ['', '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']
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
    // Skip known compiled-binary extensions — not scannable and would only
    // produce a "skipped binary" warning after a wasted HTTP round-trip.
    if (SKIP_FETCH_EXTS.has(path.extname(relPosix).toLowerCase())) return
    fetched.add(relPosix)

    const ok = await limit(() => fetchOne(relPosix))
    if (!ok) return

    try {
      const content = await fs.readFile(path.join(pkgCacheDir, ...relPosix.split('/')), 'utf8')
      const refs = findLocalRefs(content)
      const bareRefs = findBareRefs(content)
      const execPathRefs = findExecPathRefs(content)
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
        // spawn(Sync)(process.execPath, ['path']) refs — paths are relative to the
        // package root (cwd used by spawn), not to the current file's directory.
        ...execPathRefs.map(async (ref) => {
          const abs = path.resolve(pkgCacheDir, ref)
          const resolved = await resolveRelPosix(abs)
          if (resolved) {
            await fetchWithRefs(resolved, depth + 1)
          } else {
            const rel = path.relative(pkgCacheDir, abs).split(path.sep).join('/')
            if (!rel.startsWith('..')) {
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

    // For git-hook manager invocations, enumerate and fetch the hook script
    // directories from unpkg so the scanner can analyse hook file content.
    // Husky hooks live in .husky/; lefthook local hooks live in .lefthook/.
    if (GIT_HOOK_FETCH_RE.test(cmd)) {
      const hookDirs = []
      if (/\bhusky\b/.test(cmd)) hookDirs.push('.husky')
      if (/\blefthook\b/.test(cmd)) hookDirs.push('.lefthook')
      for (const dir of hookDirs) {
        const hookFiles = await fetchUnpkgDirListing(encoded, manifest.version, dir)
        for (const relPosix of hookFiles) {
          await fetchWithRefs(relPosix, 0)
        }
      }
    }
  }

  // Step 3: Release temp tarball resources now that all BFS fetches are done.
  // Remove from tempFilesSet FIRST so the next checkpoint save no longer lists
  // this path, then close the fd and delete the file.
  if (tarFd) { await tarFd.close().catch(() => { }); tarFd = null }
  if (tarTempPath) {
    opts?.tempFilesSet?.delete(tarTempPath)
    await fs.unlink(tarTempPath).catch(() => { })
    tarTempPath = null
  }

  // package.json is always attempted (step 1 above). If it wasn't fetched, every
  // file request failed — unpkg was unreachable or rate-limiting.  Write state
  // 'failed' so the cache-validity check treats this as stale and re-fetches on
  // the next run, rather than locking in an empty cache that looks valid forever.
  const pkgJsonFetched = fetchedFiles.has('package.json')
  const fetchState = pkgJsonFetched ? 'fetched' : 'failed'
  if (!pkgJsonFetched) {
    process.stderr.write(`  ⚠️  ${manifest.name}@${manifest.version}: package.json unreachable on unpkg${tarballAttempted ? ' and registry tarball' : ''} — marked failed, will retry next run\n`)
  }

  // Hash is computed AFTER all writeDefanged() calls above complete, so it
  // reflects defanged file sizes on disk — not the original fetched content.
  const filesHash = await hashDirTree(pkgCacheDir)
  await fs.writeFile(metaPath, JSON.stringify(wrapWithHash(META_HASH_SEED, {
    fetchVersion: DEEP_FETCH_VERSION,
    filesHash,
    fetchedFiles: [...fetchedFiles].sort(),
    bareFollows: [...bareFollowsMap.values()],
    fetchedPkgs: [],
    state: fetchState,
  }), null, 2) + '\n')

  return { fetchedFiles: [...fetchedFiles].sort(), bareFollows: [...bareFollowsMap.values()], resolvedFollows: null, fromCache: false }
}

async function deepAnalyzePackage(manifest, deepDir) {
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
      const main = resolveExportsEntry(pkgJson)
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

  // Re-compute filesHash so the stored value always reflects the current on-disk
  // state.  If the pre-check or a prior re-scan left a stale hash in meta (e.g.
  // via a ...meta spread that preserved an outdated value), using the fresh hash
  // here breaks the perpetual-invalidation cycle: next run's pre-check will find
  // the stored hash == actual hash and skip the re-fetch.
  const filesHash = await hashDirTree(pkgCacheDir)
  await fs.writeFile(metaPath, JSON.stringify(wrapWithHash(META_HASH_SEED, {
    ...meta,
    filesHash,
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
