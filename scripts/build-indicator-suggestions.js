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

const crypto = require('crypto')
const http = require('http')
const https = require('https')
const path = require('path')
const fs = require('fs/promises')
const { unlinkSync } = require('fs')

const ROOT = path.resolve(__dirname, '..')
const { version: PKG_VERSION } = require(path.join(ROOT, 'package.json'))
const USER_AGENT = `npm/${PKG_VERSION} npm-indicator-suggestions (https://github.com/npm/cli)`
const { INDICATOR_REGISTRY } = require(
  path.join(ROOT, 'lib', 'utils', 'indicator-definitions.js')
)
const { hasBuildHint, scanBuildIndicatorsForPackage } = require(
  path.join(ROOT, 'lib', 'utils', 'indicator-scanner.js')
)
const scanPackageScripts = require(
  path.join(ROOT, 'lib', 'utils', 'script-risk-scanner.js')
)
const { parseCommandFile, findLocalRefs, findBareRefs, SIGNAL_PATTERNS } = scanPackageScripts
const { classifyUrl } = require(
  path.join(ROOT, 'lib', 'utils', 'url-classifier.js')
)

// Cache schema version — hash of every signal name+regex and every indicator
// Increment when the on-disk file format changes (e.g. defang scheme, meta fields).
// Mixed into DEEP_CACHE_VERSION so old caches are automatically invalidated.
const DEEP_CACHE_SCHEMA = 'defang-v4'

// registry key+commandPattern so that ANY change to signals or indicators
// automatically invalidates all deep-scan cache entries and forces a rescan.
function computeDeepCacheVersion () {
  const parts = [DEEP_CACHE_SCHEMA]
  // Signal patterns: name + full regex source (flags included)
  for (const [name, pat] of SIGNAL_PATTERNS) {
    const src = pat instanceof RegExp ? pat.source + pat.flags : String(pat)
    parts.push(name + '=' + src)
  }
  // Indicator registry: file key + each command-pattern source
  for (const [key, entry] of Object.entries(INDICATOR_REGISTRY)) {
    const pats = (entry.detect?.commandPatterns || [])
      .map(p => p instanceof RegExp ? p.source : String(p))
    parts.push(key + ':' + pats.join('|'))
  }
  let h = 0
  const str = parts.join('\n')
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}
const DEEP_CACHE_VERSION = computeDeepCacheVersion()

// Default TTL for the per-keyword result cursor.  Within this window a new run
// continues FROM the last result offset rather than re-walking results 0–2000.
// Once the cursor expires the keyword restarts at offset 0 so newly-popular
// packages (which appear near the top) are not missed.
// Override with --search-ttl <hours>; set to 0 to force page-0 restart for all
// keywords without --reset (which also wipes the package store).
const DEFAULT_CURSOR_TTL_HOURS = 168  // 7 days

// ---------------------------------------------------------------------------
// Concurrency limiter — run at most `max` async tasks simultaneously
// ---------------------------------------------------------------------------

const MANIFEST_CONCURRENCY = 5   // npm's own tooling (make-fetch-happen) uses 5 sockets
const MANIFEST_DELAY_MS    = 150  // small inter-request stagger to avoid burst detection

const DrainMode = Object.freeze({
  Candidates: 'Candidates',
  DeepFetch:  'DeepFetch',
  DeepScan:   'DeepScan',
})

// Null byte at position 0 causes SyntaxError in all Node.js versions, preventing
// accidental execution of cached JS files while leaving text content intact for
// static analysis (regex matching is unaffected).
const DEFANG_MSG    = 'DEFANGED: static-analysis cache — do not execute'
const DEFANG_SHEBANG = `#!/usr/bin/env false  # ${DEFANG_MSG}`

// Binary executable magic bytes — these files are skipped entirely (defangBuf returns null).
const BINARY_MAGIC = [
  Buffer.from([0x4d, 0x5a]),             // MZ   — Windows PE (.exe .dll .node)
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]), // ELF  — Linux/Android native
  Buffer.from([0xca, 0xfe, 0xba, 0xbe]), // Mach-O fat binary
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), // Mach-O 64-bit LE
  Buffer.from([0xce, 0xfa, 0xed, 0xfe]), // Mach-O 32-bit LE
]

/**
 * Overwrite any existing shebang (or prepend one) with #!/usr/bin/env false,
 * then inject killLine immediately after it.
 * #!/usr/bin/env false causes OS-level execution to exit 1 before the interpreter
 * ever sees the file content; killLine handles interpreter-direct invocation.
 */
function defangWithShebang (str, killLine) {
  const nlIdx = str.indexOf('\n')
  const afterFirst = nlIdx >= 0 ? str.slice(nlIdx + 1) : ''
  return `${DEFANG_SHEBANG}\n# ${DEFANG_MSG}\n${killLine}\n${afterFirst}`
}

/**
 * Defang a downloaded file so it cannot be accidentally executed.
 * Returns null for binary executables (caller should skip writing).
 * Returns a modified Buffer with an inert header for script/build-tool types.
 * Returns the original buf unchanged for safe data types (JSON, TOML, .rs, …).
 */
function defangBuf (relPath, buf) {
  // 1. Binary executable → skip entirely
  if (BINARY_MAGIC.some(m => buf.length >= m.length && buf.slice(0, m.length).equals(m))) {
    return null
  }

  const ext  = path.extname(relPath).toLowerCase()
  const base = path.basename(relPath).toLowerCase()

  // 2. JS/TS: null byte → SyntaxError; also overwrite any shebang
  if (['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'].includes(ext)) {
    let str = buf.toString('utf8')
    if (str.startsWith('#!')) {
      const nl = str.indexOf('\n')
      str = `${DEFANG_SHEBANG}\n` + (nl >= 0 ? str.slice(nl + 1) : '')
    }
    return Buffer.concat([Buffer.from(`\x00/* ${DEFANG_MSG} */\n`), Buffer.from(str)])
  }

  // 3. Shell scripts — defanged shebang + exit 1
  if (['.sh', '.bash', '.zsh', '.ksh', '.fish'].includes(ext)) {
    return Buffer.from(defangWithShebang(buf.toString('utf8'), 'exit 1'))
  }

  // 4. Windows batch — no shebang concept; prepend @exit
  if (['.bat', '.cmd'].includes(ext)) {
    return Buffer.from(`@rem ${DEFANG_MSG}\r\n@exit /b 1\r\n${buf.toString('utf8')}`)
  }

  // 5. PowerShell — # comment + throw (shebang is harmless as a comment in PS)
  if (['.ps1', '.psm1', '.psd1'].includes(ext)) {
    return Buffer.from(defangWithShebang(buf.toString('utf8'), `throw '${DEFANG_MSG}'`))
  }

  // 6. Python — defanged shebang + sys.exit
  if (['.py', '.pyw'].includes(ext)) {
    return Buffer.from(defangWithShebang(buf.toString('utf8'), `import sys; sys.exit('${DEFANG_MSG}')`))
  }

  // 7. Ruby — defanged shebang + abort
  if (['.rb'].includes(ext)) {
    return Buffer.from(defangWithShebang(buf.toString('utf8'), `abort '${DEFANG_MSG}'`))
  }

  // 8. Perl — defanged shebang + die
  if (['.pl', '.pm'].includes(ext)) {
    return Buffer.from(defangWithShebang(buf.toString('utf8'), `die '${DEFANG_MSG}';`))
  }

  // 9. Makefile variants — override every common target + .DEFAULT to exit 1
  if (['makefile', 'gnumakefile', 'bsdmakefile'].includes(base) || ['.mk', '.make'].includes(ext)) {
    return Buffer.from(
      `# ${DEFANG_MSG}\n` +
      `.PHONY: all install build clean test configure\n` +
      `all install build clean test configure: ; @exit 1\n` +
      `.DEFAULT: ; @exit 1\n\n` +
      buf.toString('utf8')
    )
  }

  // 10. Gradle / Kotlin build scripts — Groovy throw
  if (['.gradle', '.gradle.kts'].includes(ext)) {
    return Buffer.from(`// ${DEFANG_MSG}\nthrow new Exception('${DEFANG_MSG}')\n${buf.toString('utf8')}`)
  }

  // 11. GYP/GYPI — Python comment marker
  if (['.gyp', '.gypi'].includes(ext)) {
    return Buffer.from(`# ${DEFANG_MSG}\n${buf.toString('utf8')}`)
  }

  // 12. Content-based detection for extensionless / unrecognized extensions
  const head = buf.slice(0, 512).toString('utf8')
  if (head.startsWith('#!')) {
    // Shebang present — check interpreter
    const shebangLine = head.slice(0, head.indexOf('\n'))
    if (/node|deno/.test(shebangLine)) {
      // Node shebang script → JS defang (null byte + overwrite shebang)
      const str = `${DEFANG_SHEBANG}\n` + head.slice(head.indexOf('\n') + 1)
      return Buffer.concat([Buffer.from(`\x00/* ${DEFANG_MSG} */\n`), Buffer.from(str)])
    }
    if (/python/.test(shebangLine)) {
      return Buffer.from(defangWithShebang(head, `import sys; sys.exit('${DEFANG_MSG}')`))
    }
    if (/ruby/.test(shebangLine)) {
      return Buffer.from(defangWithShebang(head, `abort '${DEFANG_MSG}'`))
    }
    if (/perl/.test(shebangLine)) {
      return Buffer.from(defangWithShebang(head, `die '${DEFANG_MSG}';`))
    }
    // Unknown interpreter — defanged shebang + exit 1 covers sh, env, etc.
    return Buffer.from(defangWithShebang(buf.toString('utf8'), 'exit 1'))
  }

  // JS content without recognized extension (e.g. underscore-contrib .arity/.builders,
  // appium extensionless modules, etc.)
  if (/^["']use strict["']/.test(head) ||
      /^\/\//.test(head) ||
      /^\(function/.test(head) ||
      /^(?:var |const |let |function |class |module\.exports|exports\.)/.test(head)) {
    return Buffer.concat([Buffer.from(`\x00/* ${DEFANG_MSG} */\n`), buf])
  }

  return buf  // safe data files (JSON, TOML, .rs, .c, CMakeLists.txt, …)
}

/**
 * Write a defanged buffer to disk and strip execute permissions on non-Windows.
 * Returns false if the file should be skipped (binary executable).
 */
async function writeDefanged (dest, relPath, buf) {
  const safe = defangBuf(relPath, buf)
  if (!safe) return false
  await fs.writeFile(dest, safe)
  if (process.platform !== 'win32') {
    await fs.chmod(dest, 0o444).catch(() => { /* best-effort */ })
  }
  return true
}

/**
 * Remove a directory tree, clearing read-only flags first on non-Windows so
 * that files chmod'd to 0o444 by writeDefanged can be deleted.
 */
async function rmReadOnly (dir) {
  if (process.platform !== 'win32') {
    // Walk and restore write permission before removal
    const restoreWrite = async (p) => {
      try {
        const entries = await fs.readdir(p, { withFileTypes: true })
        await Promise.all(entries.map(e => {
          const full = path.join(p, e.name)
          return e.isDirectory() ? restoreWrite(full) : fs.chmod(full, 0o644).catch(() => {})
        }))
      } catch { /* ignore */ }
    }
    await restoreWrite(dir)
  }
  await fs.rm(dir, { recursive: true, force: true })
}

function makeLimiter (max, delayMs = 0) {
  let running = 0
  const queue = []
  return async function limit (fn) {
    if (running >= max) await new Promise(r => queue.push(r))
    running++
    if (delayMs > 0) await sleep(delayMs)
    try {
      return await fn()
    } finally {
      running--
      if (queue.length) queue.shift()()
    }
  }
}

// ---------------------------------------------------------------------------
// Deep-scan one package via unpkg: fetch known indicator files, run the
// production scanner, cache results keyed by name@version.
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

async function deepFetchPackage (manifest, deepDir, limit) {
  const safeName = manifest.name.replace(/\//g, '__')
  const pkgCacheDir = path.join(deepDir, safeName)
  const metaPath = path.join(pkgCacheDir, '.meta.json')

  // Cache hit: files already on disk and version matches (state 'fetched' or 'scanned')
  const dirExists = await fs.access(pkgCacheDir).then(() => true, () => false)
  if (dirExists) {
    try {
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'))
      const stateOk = meta.state === 'fetched' || meta.state === 'scanned'
      if (stateOk && meta.version === manifest.version && meta.schemaVersion === DEEP_CACHE_VERSION) {
        const currentTreeHash = await hashDirTree(pkgCacheDir)
        if (currentTreeHash === meta.filesHash) {
          return { fetchedFiles: meta.fetchedFiles || [], fetchedPkgs: meta.fetchedPkgs || [], discoveredManifests: [], fromCache: true }
        }
        process.stderr.write(`  🗑️  file tree changed for ${manifest.name} (${meta.filesHash} → ${currentTreeHash}) — invalidating cache\n`)
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

  // Step 1: Fetch indicator files (binding.gyp, Cargo.toml, …)
  await Promise.all(Object.keys(INDICATOR_REGISTRY).map(file =>
    limit(() => fetchOne(file))
  ))

  // Step 2: BFS fetch of lifecycle JS files and their require() deps.
  const MAX_FETCH_DEPTH = 10
  const fetched = new Set()
  const fetchedPkgs = new Set()
  const discoveredManifests = []

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
    return null
  }

  const fetchBarePackage = async (pkgName, depth) => {
    if (depth > MAX_FETCH_DEPTH || fetchedPkgs.has(pkgName)) return
    fetchedPkgs.add(pkgName)
    fetchedFiles.push(`→ ${pkgName}`)

    const safePkg = pkgName.replace(/\//g, '__')
    const pkgDir = path.join(deepDir, safePkg)
    await fs.mkdir(pkgDir, { recursive: true })

    const enc = pkgName.replace(/\//g, '%2F')
    const pkgJsonBuf = await limit(() => fetchRaw(`https://unpkg.com/${enc}/package.json`))
    if (!pkgJsonBuf) return

    let pkgJson
    try { pkgJson = JSON.parse(pkgJsonBuf.toString('utf8')) } catch { return }

    await fs.writeFile(path.join(pkgDir, 'package.json'), JSON.stringify(pkgJson, null, 2) + '\n')

    // Record this package — caller will add all discoveries to candidates (unfiltered)
    discoveredManifests.push({
      name: pkgJson.name || pkgName,
      version: pkgJson.version || '0.0.0',
      scripts: pkgJson.scripts || {},
      dependencies: pkgJson.dependencies || {},
      devDependencies: pkgJson.devDependencies || {},
      optionalDependencies: pkgJson.optionalDependencies || {},
      peerDependencies: pkgJson.peerDependencies || {},
    })

    const resolveExportsEntry = (exp) => {
      if (!exp) return null
      const dot = exp['.'] ?? exp
      if (typeof dot === 'string') return dot
      if (typeof dot === 'object') {
        for (const cond of ['require', 'node', 'import', 'default']) {
          if (typeof dot[cond] === 'string') return dot[cond]
          if (typeof dot[cond] === 'object') {
            const nested = resolveExportsEntry(dot[cond])
            if (nested) return nested
          }
        }
      }
      return null
    }

    const exportsEntry = resolveExportsEntry(pkgJson.exports)
    const rawEntry = exportsEntry
      || (typeof pkgJson.module === 'string' && pkgJson.module)
      || (typeof pkgJson.main === 'string' && pkgJson.main)
      || 'index.js'
    const entryRel = rawEntry.replace(/^\.\//, '')
    const hasExt = /\.[cm]?js$/.test(entryRel)
    const extsToTry = hasExt ? [entryRel] : [entryRel, entryRel + '.js', entryRel + '.mjs', entryRel + '.cjs']

    for (const candidate of extsToTry) {
      const buf = await limit(() => fetchRaw(`https://unpkg.com/${enc}/${candidate}`))
      if (!buf) continue
      const dest = path.join(pkgDir, ...candidate.split('/'))
      await fs.mkdir(path.dirname(dest), { recursive: true })
      if (!await writeDefanged(dest, candidate, buf)) break  // binary entry — skip
      try {
        const content = buf.toString('utf8')  // parse original for refs before defanging
        const localRefs = findLocalRefs(content)
        const fileDir = path.dirname(dest)
        await Promise.all(localRefs.map(async (ref) => {
          const abs = path.resolve(fileDir, ref)
          const rel = path.relative(pkgDir, abs)
          if (rel.startsWith('..')) return
          const relPosix = rel.split(path.sep).join('/')
          const exts2 = ['', '.js', '.mjs', '.cjs']
          for (const ext of exts2) {
            const buf2 = await limit(() => fetchRaw(`https://unpkg.com/${enc}/${relPosix + ext}`))
            if (!buf2) continue
            const dest2 = path.join(pkgDir, ...(`${relPosix}${ext}`).split('/'))
            await fs.mkdir(path.dirname(dest2), { recursive: true })
            if (!await writeDefanged(dest2, relPosix + ext, buf2)) break  // binary ref — skip
            break
          }
        }))
      } catch { /* skip */ }
      break
    }
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
            if (!rel.startsWith('..') && !fetched.has(rel + '.js')) {
              await fetchWithRefs(rel + '.js', depth + 1)
            }
          }
        }),
        ...bareRefs.map(pkg => fetchBarePackage(pkg, depth + 1)),
      ])
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

  // Write fetch-phase meta (no results yet)
  const filesHash = await hashDirTree(pkgCacheDir)
  await fs.writeFile(metaPath, JSON.stringify({
    version: manifest.version,
    schemaVersion: DEEP_CACHE_VERSION,
    filesHash,
    fetchedFiles,
    fetchedPkgs: [...fetchedPkgs],
    state: 'fetched',
  }, null, 2) + '\n')

  return { fetchedFiles, fetchedPkgs: [...fetchedPkgs], discoveredManifests, fromCache: false }
}

async function deepAnalyzePackage (manifest, deepDir) {
  const safeName = manifest.name.replace(/\//g, '__')
  const pkgCacheDir = path.join(deepDir, safeName)
  const metaPath = path.join(pkgCacheDir, '.meta.json')

  let meta
  try { meta = JSON.parse(await fs.readFile(metaPath, 'utf-8')) } catch { return { results: [], referencedFiles: [], fromCache: false } }

  // Full cache hit: already scanned at this version
  if (meta.state === 'scanned' && meta.version === manifest.version && meta.schemaVersion === DEEP_CACHE_VERSION) {
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
  const referencedFiles = await scanPackageScripts(pkgCacheDir, lifecycleScripts)

  for (const pkgName of (meta.fetchedPkgs || [])) {
    const safePkg = pkgName.replace(/\//g, '__')
    const pkgDir = path.join(deepDir, safePkg)
    try {
      const pkgJsonBuf = await fs.readFile(path.join(pkgDir, 'package.json'), 'utf8')
      const pkgJson = JSON.parse(pkgJsonBuf)
      const main = (typeof pkgJson.main === 'string' && pkgJson.main) || 'index.js'
      const mainRel = main.startsWith('./') ? main.slice(2) : main
      const depRefs = await scanPackageScripts(pkgDir, { postinstall: `node ${mainRel}` })
      referencedFiles.push(...depRefs)
    } catch { /* not fully fetched — skip */ }
  }

  const results = await scanBuildIndicatorsForPackage(pkgCacheDir, manifest.scripts || {}, referencedFiles)

  await fs.writeFile(metaPath, JSON.stringify({
    ...meta,
    results,
    referencedFiles,
    scannedAt: new Date().toISOString(),
    state: 'scanned',
  }, null, 2) + '\n')

  return { results, referencedFiles, fromCache: false }
}

// Pre-build a flat [{ pattern, file }] table from the registry so we can
// match any lifecycle script command against all known commandPatterns in
// a single O(n) pass.
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
  // Common path-segment directory names that appear in script paths like
  // "node hooks/postinstall.js" or "node src/install/postinstall.mjs".
  // These are not meaningful command tokens — just directory components.
  'hooks', 'src', 'lib', 'dist', 'bin', 'cli', 'utils', 'core',
  'init', 'setup', 'tools', 'helpers', 'common', 'shared',
])

// Lifecycle script names that run during `npm install`
const LIFECYCLE_HOOKS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepack']

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Circuit-breaker rate-limit state.
//
// Problem: 10 concurrent requests all hit 429 → each increments
// _consecutiveRateLimits → exponential backoff stacks to 5+ minutes.
//
// Fix: only escalate the backoff multiplier once per WAVE (a wave = a fresh
// 429 received when NOT already in a cooldown window). Concurrent requests
// that hit 429 inside an existing cooldown window share that window's level
// and don't push the multiplier further.
//
// After CIRCUIT_OPEN_THRESHOLD consecutive waves the circuit opens so the
// drain saves a clean checkpoint and exits rather than accumulating more wait.
// ---------------------------------------------------------------------------

const CIRCUIT_OPEN_THRESHOLD = 4  // waves before circuit opens (~30+60+120+240 = 7.5 min max)
const MAX_BACKOFF_MS = 120_000    // cap individual backoff at 2 min (not 5)
const DRAIN_CHECKPOINT_EVERY = 50 // checkpoint to both stores every N manifest resolutions

let _cooldownUntil = 0
let _consecutiveRateLimits = 0
let _circuitOpen = false
let _cooldownTimerId = null  // single interval printing countdown updates every 20s

class CircuitOpenError extends Error {
  constructor () { super('Circuit breaker open — rate limit waves exceeded'); this.isCircuitOpen = true }
}

// Start (or restart) the per-wave countdown ticker.
// Fires every 20s and prints remaining seconds until the cooldown expires.
// Self-clears when the cooldown window passes.
function startCooldownCountdown () {
  if (_cooldownTimerId) clearInterval(_cooldownTimerId)
  _cooldownTimerId = setInterval(() => {
    const remaining = Math.ceil((_cooldownUntil - Date.now()) / 1000)
    if (remaining <= 0) {
      clearInterval(_cooldownTimerId)
      _cooldownTimerId = null
    } else {
      process.stderr.write(`  ⏳ cooldown: ${humanDuration(remaining)} remaining\n`)
    }
  }, 20_000)
}

// Centralized 429 handler — call once per response that returns 429.
// Only a NEW wave (first 429 outside an existing cooldown window) increments
// the counter and prints a log line. Concurrent 429s in the same window are
// silently absorbed — this prevents 10 concurrent requests from each bumping
// the wave counter.
// Wait time: server's retry-after if present, otherwise linear fallback 30→60→90→120s.
function handle429 (headers, url) {
  if (Date.now() >= _cooldownUntil) {
    // New wave
    _consecutiveRateLimits++
    const serverWait = retryAfterMs(headers['retry-after']) ?? 0
    const fallback = Math.min(MAX_BACKOFF_MS, 30_000 * _consecutiveRateLimits)
    const waitMs = serverWait > 0 ? serverWait : fallback
    const source = serverWait > 0 ? 'server' : `fallback ${Math.ceil(fallback / 1000)}s`
    _cooldownUntil = Date.now() + waitMs
    if (_consecutiveRateLimits >= CIRCUIT_OPEN_THRESHOLD) _circuitOpen = true
    process.stderr.write(
      `  🚦 HTTP 429 ${url} — ${humanDuration(Math.ceil(waitMs / 1000))}` +
      ` (wave ${_consecutiveRateLimits}, ${source}${_circuitOpen ? ', circuit OPEN' : ''})\n`
    )
    startCooldownCountdown()
  }
  // else: concurrent 429 in same cooldown window — silently absorbed
}

async function waitForCooldown () {
  if (_circuitOpen) throw new CircuitOpenError()
  const remaining = _cooldownUntil - Date.now()
  if (remaining > 0) await sleep(remaining + 100) // +100ms buffer past the deadline
  if (_circuitOpen) throw new CircuitOpenError()
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

// Format a duration in seconds as human-readable: 30s, 1m 30s, 2h 5m
function humanDuration (totalSecs) {
  const h = Math.floor(totalSecs / 3600)
  const m = Math.floor((totalSecs % 3600) / 60)
  const s = totalSecs % 60
  if (h > 0) return `${h}h${m > 0 ? ` ${m}m` : ''}`
  if (m > 0) return `${m}m${s > 0 ? ` ${s}s` : ''}`
  return `${s}s`
}

// ---------------------------------------------------------------------------
// Raw HTTP fetch — returns Buffer on 200, null on 404 / error.
// Shares the global 429 cooldown with fetchJson so a rate-limit from unpkg
// backs off all requests, not just JSON ones.
// ---------------------------------------------------------------------------
// Low-level HTTP GET with redirect following (up to MAX_REDIRECTS hops).
// Returns { statusCode, headers, body: Buffer } on success, or throws on
// network/timeout errors.  Caller is responsible for handling non-2xx codes.
// ---------------------------------------------------------------------------

const MAX_REDIRECTS = 5

async function httpGet (url, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const transport = parsed.protocol === 'https:' ? https : http
    const req = transport.get(url, { headers: { 'User-Agent': USER_AGENT } }, res => {
      // Follow 3xx redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        if (redirectsLeft <= 0) {
          return reject(new Error(`Too many redirects for ${url}`))
        }
        const next = new URL(res.headers.location, url).href
        process.stderr.write(`  ↩️  HTTP ${res.statusCode} → ${next}\n`)
        return httpGet(next, redirectsLeft - 1).then(resolve, reject)
      }
      const chunks = []
      res.on('data', d => chunks.push(d))
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(15_000, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)) })
  })
}

// ---------------------------------------------------------------------------

async function fetchRaw (url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    await waitForCooldown(url)
    let res
    try {
      res = await httpGet(url)
    } catch (err) {
      process.stderr.write(`  ⚠️  request error (raw) attempt ${attempt}/${retries} ${url}: ${err.message}\n`)
      continue
    }
    const { statusCode, headers, body } = res
    if (statusCode === 429) {
      handle429(headers, url)
      continue
    }
    if (statusCode !== 200 && statusCode !== 404) {
      process.stderr.write(`  ⚠️  HTTP ${statusCode} (raw) attempt ${attempt}/${retries} ${url}\n`)
    }
    _consecutiveRateLimits = 0
    _circuitOpen = false
    return statusCode === 200 ? body : null
  }
  return null
}

async function fetchJson (url, retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    await waitForCooldown()
    let res
    try {
      res = await httpGet(url)
    } catch (err) {
      if (attempt === retries) throw err
      process.stderr.write(`  ⚠️  request error (json) attempt ${attempt}/${retries} ${url}: ${err.message}\n`)
      await sleep(500 * attempt)
      continue
    }
    const { statusCode, headers, body } = res
    if (statusCode === 404) {
      _consecutiveRateLimits = 0
      _circuitOpen = false
      return null
    }
    if (statusCode === 429) {
      handle429(headers, url)
      continue
    }
    if (statusCode >= 200 && statusCode < 300) {
      _consecutiveRateLimits = 0
      _circuitOpen = false
      const text = body.toString('utf8')
      try { return JSON.parse(text) } catch (e) {
        throw new Error(`JSON parse error for ${url}: ${e.message}`)
      }
    }
    // Other error status — attach statusCode so callers can distinguish HTTP failures from network errors
    process.stderr.write(`  ⚠️  HTTP ${statusCode} (json) attempt ${attempt}/${retries} ${url}\n`)
    if (attempt === retries) {
      const err = new Error(`HTTP ${statusCode} for ${url}`)
      err.statusCode = statusCode
      throw err
    }
    await sleep(500 * attempt)
  }
}

// ---------------------------------------------------------------------------
// npm registry helpers
// ---------------------------------------------------------------------------

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

// Package state machine:
//   candidate  → name found in search, manifest not yet fetched
//   failed     → manifest fetch returned 4xx/5xx after all retries; retry next run
//   seen       → manifest fetched, no lifecycle scripts (confirmed)
//   lifecycle  → has lifecycle scripts, download count not yet fetched
//   ready      → has lifecycle scripts + download count fetched (complete)
//
// Save format:
//   seenOnlyNames: string[]     — compact list of 'seen' names (no lifecycle data)
//   packages: PackageEntry[]    — candidate | failed | lifecycle | ready entries with state field
//
// 'failed' entries are reloaded as candidates on the next run for retry.
// The snapshot in savePackageCache is built synchronously before any await so
// concurrent closures inside Promise.all cannot produce a torn state.

async function loadPackageCache (filePath) {
  try {
    const raw = JSON.parse(await fs.readFile(filePath, 'utf-8'))
    if (Array.isArray(raw)) {
      return { names: raw, manifests: null, seen: null, discoveryState: null, pendingCandidates: [] }
    }
    if (raw.packages && Array.isArray(raw.packages)) {
      const manifests = []
      const seenSet = new Set()
      const pendingCandidates = []

      // Detect format: new entries have a 'state' field; old entries don't.
      const hasStateField = raw.packages.length === 0 || raw.packages[0].state != null

      if (hasStateField) {
        for (const entry of raw.packages) {
          seenSet.add(entry.name)
        if (entry.state === 'candidate' || entry.state === 'failed') {
          pendingCandidates.push(entry.name)  // failed = retry as candidate next run
          } else if (entry.state === 'lifecycle' || entry.state === 'ready') {
            manifests.push(entry)
          }
          // state === 'seen' entries only need their name in seenSet
        }
        for (const name of (raw.seenOnlyNames || [])) seenSet.add(name)
      } else {
        // Old format: packages[] = lifecycle only (no state), seenNames[] = all examined
        for (const entry of raw.packages) {
          manifests.push({ ...entry, state: entry.weeklyDownloads > 0 ? 'ready' : 'lifecycle' })
          seenSet.add(entry.name)
        }
        for (const name of (raw.seenNames || [])) seenSet.add(name)
        // Old pendingCandidates field (pre-state-machine format)
        for (const name of (raw.pendingCandidates || [])) {
          if (!seenSet.has(name)) {
            pendingCandidates.push(name)
            seenSet.add(name)
          }
        }
      }

      return {
        names: null,
        manifests,
        seen: seenSet,
        discoveryState: raw.discoveryState || null,
        pendingCandidates,
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      process.stderr.write(`  Warning: could not read cache ${filePath}: ${err.message}\n`)
    }
  }
  return { names: null, manifests: null, seen: null, discoveryState: null, pendingCandidates: [] }
}

// Build snapshot synchronously before any await so concurrent Promise.all closures
// cannot produce a torn checkpoint.  State for each package is derived from which
// array it lives in (manifests = lifecycle|ready, candidates = candidate, rest = seen).
async function savePackageCache (filePath, manifests, seen, discoveryState, candidates = [], failedFetches = new Set()) {
  const candidateSet = new Set(candidates)
  const lifecycleSet = new Set(manifests.map(m => m.name))

  // Non-lifecycle, non-candidate, non-failed names are "seen" — store compactly as strings.
  const seenOnlyNames = []
  for (const name of seen) {
    if (!lifecycleSet.has(name) && !candidateSet.has(name) && !failedFetches.has(name)) seenOnlyNames.push(name)
  }

  // Packages with explicit state: candidates, failed, and lifecycle/ready (full manifest).
  const packages = []
  for (const name of candidates) packages.push({ name, state: 'candidate' })
  for (const name of failedFetches) packages.push({ name, state: 'failed' })
  for (const m of manifests) {
    packages.push({
      name: m.name,
      state: m.state || (m.weeklyDownloads > 0 ? 'ready' : 'lifecycle'),
      version: m.version,
      scripts: m.scripts,
      dependencies: m.dependencies,
      devDependencies: m.devDependencies,
      optionalDependencies: m.optionalDependencies,
      peerDependencies: m.peerDependencies,
      weeklyDownloads: m.weeklyDownloads || 0,
    })
  }

  // Snapshot is fully built — now safe to yield for the file write.
  const data = {
    generatedAt: new Date().toISOString(),
    count: manifests.length,
    discoveryState,
    seenOnlyNames,
    packages,
  }
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

// ---------------------------------------------------------------------------
// Process lock — prevents concurrent runs against the same output path
// ---------------------------------------------------------------------------

// Lock file uses a heartbeat timestamp rather than a PID check.
// PIDs are recycled by the OS, so `kill(pid, 0)` can return "alive" for an
// unrelated process.  Instead, the lock owner refreshes `ts` every 30 seconds;
// a checker that sees `ts` older than LOCK_STALE_MS considers the lock stale.
const LOCK_HEARTBEAT_MS = 30_000
const LOCK_STALE_MS     = 90_000  // 3 missed heartbeats → stale

function makeLockHelpers (lockPath) {
  let heartbeatTimer = null

  function writeHeartbeat () {
    try {
      require('fs').writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }), 'utf8')
    } catch {}
  }

  function acquire () {
    const raw = (() => { try { return require('fs').readFileSync(lockPath, 'utf8') } catch { return null } })()
    if (raw) {
      let lock = {}
      try { lock = JSON.parse(raw) } catch {}
      const age = Date.now() - (lock.ts || 0)
      if (age < LOCK_STALE_MS) {
        process.stderr.write(`\n⛔  Already running (PID ${lock.pid}) with the same output path.\n`)
        process.stderr.write(`   Lock file: ${lockPath}\n`)
        process.stderr.write(`   Heartbeat is ${Math.round(age / 1000)}s old (stale after ${LOCK_STALE_MS / 1000}s).\n`)
        process.stderr.write(`   If that process is gone, delete the lock file and retry.\n\n`)
        process.exit(1)
      }
      process.stderr.write(`⚠️  Stale lock (PID ${lock.pid}, heartbeat ${Math.round(age / 1000)}s ago) — removing and continuing\n`)
    }
    writeHeartbeat()
    heartbeatTimer = setInterval(writeHeartbeat, LOCK_HEARTBEAT_MS)
    heartbeatTimer.unref()  // don't prevent the process from exiting when work is done
  }

  function release () {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
    try { unlinkSync(lockPath) } catch {}
  }

  return { acquire, release }
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

After each collection run a scoped peer expansion step (Step 3.5) probes the
unscoped counterpart of every scoped package in the store. This catches pairs
like @fortawesome/react-native-fontawesome → react-native-fontawesome where
only the scoped version appears in npm search results.

Options:
  --top <n>          Number of new packages to collect per run  (default: 1000)
  --delay <ms>       Delay between npm registry requests in ms  (default: 60)
  --out <file>       Output JSON path                           (default: indicator-suggestions.json)
  --packages <file>  Seed package-name list instead of permanent store
  --keywords <csv>   Comma-separated keyword list (case-insensitive, "keywords:" prefix optional)
                     Resume: appends to existing list.  Fresh run: replaces defaults entirely.
                     Example: --keywords "ruby,python,go"
  --reset            Delete both cache files and the deep cache dir; start fresh
  --deep             Fetch indicator files from unpkg and run the production scanner
                     (cached by name@version in *.deep/ next to --out)
  --page-size <n>    Results per search page, 1–250 (default: 250 = npm registry max)
  --search-ttl <h>   Hours before the per-keyword result cursor resets to offset 0 (default: 168 = 7 days)
                     Within the TTL window each keyword continues from the last result offset reached.
                     Set to 0 to force page-0 restart for all keywords without wiping the store.
  --add <pkg,...>    Inject one or more package names as candidates (comma-separated).
                     Skips names already in the store or seen set. Forces collection
                     of specific packages without a full search run.
                     Example: --add "9router,some-other-pkg"
  -h, --help         Show this help message

Cache files (written next to --out, gitignored):
  *.packages.json    Permanent manifest store — survives successful runs
  *.tmp.json         Resume cache — deleted on successful completion
  *.deep/            Deep-scan file cache (name@version-keyed; only with --deep)

Typical workflow:
  1. Collect packages:    node scripts/build-indicator-suggestions.js --top 2000
  2. Deep-scan them:      node scripts/build-indicator-suggestions.js --deep
  3. Re-analyze anytime:  node scripts/build-indicator-suggestions.js
     (no network needed; re-runs analysis against the existing store)

When to use --reset:
  The permanent store pins each package at the version seen when it was first
  collected. Over time packages release new versions that may change their build
  approach (e.g. switching from node-gyp to a prebuilt binary). Use --reset
  occasionally (e.g. every few months) to discard stale manifests and re-collect
  current versions, so the analysis reflects what users are actually installing.

  --reset clears the manifest store AND the deep-scan cache, so follow it with
  --top <n> --deep to re-collect and re-scan from scratch.

`)

    process.exit(0)
  }

  // topN defaults to 0 when not explicit — means "finish any in-progress run,
  // then re-analyze; don't collect new packages". A mid-step resume (tmp.json)
  // is still processed through steps 3.5, 4/5 using whatever was collected.
  const topN = args.includes('--top') ? +flag('--top', 0) : 0
  const topExplicit = args.includes('--top')
  const delayMs = +flag('--delay', 60)
  const outFile = flag('--out', 'indicator-suggestions.json')
  const outPath = path.isAbsolute(outFile) ? outFile : path.join(ROOT, outFile)
  // --keywords csv: normalize to "keywords:X" form; used to extend or replace the built-in list
  const userKeywordsStr = flag('--keywords', null)
  const userKeywords = userKeywordsStr
    ? (() => {
        const deduped = new Set()
        return userKeywordsStr.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
          .map(k => k.startsWith('keywords:') ? k : `keywords:${k}`)
          .filter(k => deduped.has(k) ? false : deduped.add(k))
      })()
    : []

  // Acquire process lock — prevents a second run from corrupting shared cache files.
  // Lock is released automatically on any exit (normal, error, or signal).
  const lockPath = outPath.replace(/\.json$/, '.lock')
  const lock = makeLockHelpers(lockPath)
  lock.acquire()
  process.on('exit', lock.release)
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { process.exit(sig === 'SIGINT' ? 130 : 143) })
  }

  const doReset = args.includes('--reset')
  const deepMode = args.includes('--deep')
  const pageSize = Math.min(250, Math.max(1, +flag('--page-size', 250)))  // results per npm search request (max 250)
  const searchTtlHours = args.includes('--search-ttl') ? parseFloat(flag('--search-ttl', DEFAULT_CURSOR_TTL_HOURS)) : DEFAULT_CURSOR_TTL_HOURS
  const searchTtlMs = searchTtlHours * 60 * 60 * 1000

  // Two cache files serve different purposes:
  //   .packages.json  — permanent manifest store; saved on every successful run;
  //                     never auto-deleted; loaded first on startup so re-analysis
  //                     with updated definitions is instant (no network needed).
  //   .tmp.json       — resume cache for interrupted runs; checkpointed every 100
  //                     packages; deleted on successful completion.
  // --packages <file> overrides the permanent store path (e.g. to seed with a
  //                     hand-crafted name list).
  // --reset           — delete both cache files and start from scratch.
  // --deep            — fetch indicator files from unpkg and run the production
  //                     scanner; results cached in .deep/ next to --out.
  const pkgFile          = flag('--packages', null)
  const manifestStorePath = outPath.replace(/\.json$/, '.packages.json')
  const resumeCachePath   = outPath.replace(/\.json$/, '.tmp.json')
  const deepDir           = outPath.replace(/\.json$/, '.deep')
  const pkgPath = pkgFile
    ? (path.isAbsolute(pkgFile) ? pkgFile : path.join(ROOT, pkgFile))
    : manifestStorePath

  if (userKeywords.length > 0 && !topExplicit) {
    process.stderr.write(`\n⛔  --keywords requires --top <n> (keywords only affect the collection phase).\n\n`)
    process.exit(1)
  }

  if (doReset) {
    await fs.unlink(manifestStorePath).catch(() => {})
    await fs.unlink(resumeCachePath).catch(() => {})
    await rmReadOnly(deepDir)
    process.stderr.write(`  ⚠️  --reset: deleted ${manifestStorePath}, ${resumeCachePath}, and ${deepDir}\n\n`)
    if (!topExplicit) process.exit(0)
  }

  process.stderr.write(`\n📦 npm indicator-suggestions builder\n`)
  process.stderr.write(`   out:      ${outPath}\n`)
  process.stderr.write(`   packages: ${pkgPath}${pkgFile ? ' (user-provided)' : ' (permanent store)'}\n`)
  process.stderr.write(`   resume:   ${resumeCachePath}  (deleted on success)\n`)
  if (deepMode) {
    const scannerPath = path.join(ROOT, 'lib', 'utils', 'indicator-scanner.js')
    process.stderr.write(`   deep:     ${deepDir}  (indicator files cached by name@version)\n`)
    process.stderr.write(`             with: ${scannerPath}\n`)
  }
  process.stderr.write('\n')

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
  let isPostCollectionResume = false  // true when tmp.json was written post-collection (collection already done)

  // If permanent store empty or missing, try the resume cache
  if (!loaded.manifests && !loaded.names) {
    loaded = await loadPackageCache(resumeCachePath)
    if (loaded.manifests || loaded.names) {
      process.stderr.write(`  (permanent store empty, loaded from resume cache)\n`)
      // discoveryState: null in tmp.json means collection was already complete
      if (loaded.manifests && loaded.discoveryState === null) isPostCollectionResume = true
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
        pendingCandidates: resume.pendingCandidates || [],
      }
      // discoveryState: null means collection was complete when tmp.json was written
      if (resume.discoveryState === null) isPostCollectionResume = true
    } else if (resume.manifests && resume.discoveryState === null) {
      // tmp.json exists with same package count but null discoveryState — step-4 resume
      isPostCollectionResume = true
    }
  }

  const { names, manifests: cached, seen: cachedSeen, discoveryState, pendingCandidates: loadedCandidates = [] } = loaded

  // Per-keyword rolling result cursor — persisted in discoveryState so subsequent
  // runs continue FROM the last result offset rather than re-walking results 0–N.
  // Each entry: { from: number, scannedAt: isoString }
  const keywordCursors = discoveryState?.keywordCursors || {}

  if (cached) {
    for (const m of cached) manifests.push(m)
    for (const n of (cachedSeen || [])) seen.add(n)
    if (discoveryState) {
      resumeQueryIndex = discoveryState.queryIndex || 0
      resumeQueryFrom  = discoveryState.queryFrom  || 0
    }
    const withDl = manifests.filter(m => m.weeklyDownloads > 0)
    const sorted = [...withDl].sort((a, b) => b.weeklyDownloads - a.weeklyDownloads)
    const dlMax  = sorted[0]?.weeklyDownloads ?? 0
    const dlMin  = sorted[sorted.length - 1]?.weeklyDownloads ?? 0

    process.stderr.write(`  ✓ loaded ${manifests.length} packages with lifecycle scripts (${seen.size.toLocaleString()} names examined, no lifecycle scripts in the rest)\n`)
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
    const remaining = isPostCollectionResume ? 0 : topN - resumeMergeCount
    let resumeHint = ''
    if (!isPostCollectionResume && discoveryState) {
      const qOrder = discoveryState.queryOrder || []
      const qName = (qOrder[resumeQueryIndex] || '').replace('keywords:', '')
      const pos = resumeQueryFrom > 0 ? `, position ${resumeQueryFrom}` : ''
      resumeHint = resumeMergeCount > 0 ? ` (resuming at "${qName}"${pos})` : ''
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
  let DISCOVERY_QUERIES_BASE = [
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

  // Resolve saved keyword order first — needed to decide resume vs fresh for --keywords.
  const savedOrder = discoveryState?.queryOrder || null

  // Apply --keywords override before shuffle/reconciliation:
  //   resume (savedOrder exists) → append user keywords not already in the base list
  //   fresh (no savedOrder)      → replace the built-in list entirely
  if (userKeywords.length > 0) {
    if (savedOrder) {
      const baseSet = new Set(DISCOVERY_QUERIES_BASE.map(k => k.toLowerCase()))
      const toAdd = userKeywords.filter(k => !baseSet.has(k.toLowerCase()))
      if (toAdd.length > 0) {
        DISCOVERY_QUERIES_BASE = [...DISCOVERY_QUERIES_BASE, ...toAdd]
        process.stderr.write(`  --keywords (resume): appending ${toAdd.map(k => k.replace('keywords:', '')).join(', ')}\n`)
      } else {
        process.stderr.write(`  --keywords (resume): all specified keywords already in list — no change\n`)
      }
    } else {
      // dedupe the user list itself in case they passed dupes
      const seen = new Set()
      DISCOVERY_QUERIES_BASE = userKeywords.filter(k => { const lk = k.toLowerCase(); return seen.has(lk) ? false : seen.add(lk) })
      process.stderr.write(`  --keywords (fresh): replacing defaults → ${DISCOVERY_QUERIES_BASE.map(k => k.replace('keywords:', '')).join(', ')}\n`)
    }
  }

  // Shuffle on a fresh run so different executions surface different packages.
  // The order is saved in the cache and restored on resume so qi indices stay stable.
  // If the keyword list has changed since the interrupted run, reconcile:
  //   - append new keywords (not in saved order) so they run after the current position
  //   - drop removed keywords (not in base list) so stale entries don't linger
  let DISCOVERY_QUERIES
  if (savedOrder) {
    const baseSet = new Set(DISCOVERY_QUERIES_BASE)
    const savedSet = new Set(savedOrder)
    // Keep only keywords still in the base list (drop removed ones)
    const reconciled = savedOrder.filter(q => baseSet.has(q))
    // Append any new keywords from the base list not in the saved order
    const added = DISCOVERY_QUERIES_BASE.filter(q => !savedSet.has(q))
    DISCOVERY_QUERIES = [...reconciled, ...added]
    if (reconciled.length !== savedOrder.length || added.length > 0) {
      const dropped = savedOrder.filter(q => !baseSet.has(q))
      process.stderr.write(`  ⚠️  keyword list changed since last run\n`)
      if (dropped.length > 0) process.stderr.write(`     dropped: ${dropped.map(q => q.replace('keywords:', '')).join(', ')}\n`)
      if (added.length > 0) process.stderr.write(`     added:   ${added.map(q => q.replace('keywords:', '')).join(', ')}\n`)
    }
  } else {
    DISCOVERY_QUERIES = [...DISCOVERY_QUERIES_BASE].sort(() => Math.random() - 0.5)
    process.stderr.write(`  query order: ${DISCOVERY_QUERIES.map(q => q.replace('keywords:', '')).join(', ')}\n`)
  }

  process.stderr.write(`Steps 1–3/${deepMode ? 5 : 4}: Scanning popular packages for lifecycle scripts...\n`)
  const needToCollect = isPostCollectionResume ? 0 : topN - resumeMergeCount
  process.stderr.write(`  (target: ${needToCollect} more packages with lifecycle scripts)\n`)
  process.stderr.write(`  (skipping ${seen.size} already-scanned names)\n\n`)

  let scanned = 0
  let alreadySeenSkips = 0  // names already in `seen` across all pages this run — measures search redundancy
  let newThisRun = resumeMergeCount  // count packages merged from interrupted run toward the --top target
  // Skip collection if resuming post-collection, or if no --top was given (topN === 0).
  let done = isPostCollectionResume || topN === 0
  let finalDiscoveryState = { queryOrder: DISCOVERY_QUERIES, queryIndex: resumeQueryIndex, queryFrom: resumeQueryFrom, keywordCursors }
  let passStartIndex = resumeQueryIndex  // where to start the next pass (0 after first wrap)
  let pagesFetchedTotal = 0  // global across all keywords
  let pagesSinceLastDrain = 0
  // Restore any candidates pending manifest fetch from a previous interrupted run.
  const candidates = [...loadedCandidates]

  // --add <pkg1,pkg2,...>: inject package names as candidates regardless of seen/store.
  // Useful for one-off additions or testing specific packages.
  const addFlag = flag('--add', null)
  if (addFlag) {
    const addNames = addFlag.split(',').map(s => s.trim()).filter(Boolean)
    const inStore = new Set(manifests.map(m => m.name))
    let addedCount = 0
    for (const name of addNames) {
      if (!inStore.has(name) && !seen.has(name) && !candidates.includes(name)) {
        candidates.push(name)
        seen.add(name)
        addedCount++
        process.stderr.write(`  + injected candidate: ${name}\n`)
      } else {
        process.stderr.write(`  ~ skipped (already known): ${name}\n`)
      }
    }
    if (addedCount > 0) {
      process.stderr.write(`\n`)
    }
  }
  // Track HTTP 4xx/5xx failures across all drains this run.
  // Persisted as state:'failed' so the next run retries them as candidates.
  // (Network errors / circuit-open keep the name in candidates for retry instead.)
  const failedFetches = new Set()

  // Weekly download counts captured from search results — avoids a separate
  // api.npmjs.org call for every package that appeared in a search page.
  const searchDownloads = new Map()  // name → weeklyDownloads

  // Deep-scan state (used by drain(DrainMode.DeepScan) and the output step).
  const deepResults = new Map()      // name → IndicatorResult[]
  const deepRefFiles = new Map()     // name → referencedFiles[]
  const deepFetchedFiles = new Map() // name → fetchedFiles[]
  let deepNewPkgs = 0

  // Worker-pool drain — mode selects what to fetch:
  //   drain(DrainMode.Candidates) — fetch manifests for candidate names, populate manifests[]
  //   drain(DrainMode.DeepFetch)  — download files via unpkg for all manifests; collect discovered pkg names
  //   drain(DrainMode.DeepScan)   — run indicator scan on already-fetched manifests (reads from cache)
  // All modes use MANIFEST_CONCURRENCY workers staggered by MANIFEST_DELAY_MS.
  const drain = async (mode) => {
    // ── Candidates mode ────────────────────────────────────────────────────
    if (mode === DrainMode.Candidates) {
      if (candidates.length === 0) return
      const startCount = candidates.length
      await savePackageCache(resumeCachePath, manifests, seen, finalDiscoveryState, candidates, failedFetches)
      process.stderr.write(`\n  Candidates: fetching ${startCount}...\n`)
      let mFetched = 0
      let mFound = 0
      let circuitTripped = false
      const networkRetry = []

      const worker = async (workerIndex) => {
        await sleep(workerIndex * MANIFEST_DELAY_MS)
        while (!circuitTripped) {
          const name = candidates.shift()
          if (name === undefined) break
          await sleep(MANIFEST_DELAY_MS)

          let manifest = null
          let fetchErr = null
          try {
            manifest = await getPackageManifest(name)
          } catch (err) {
            if (err.isCircuitOpen) { circuitTripped = true; candidates.unshift(name); break }
            fetchErr = err
          }

          if (fetchErr) {
            if (fetchErr.statusCode) {
              failedFetches.add(name)
              process.stderr.write(`  ✗ HTTP ${fetchErr.statusCode} ${name} — marked failed\n`)
            } else {
              networkRetry.push(name)
            }
          } else if (manifest) {
            const lc = extractLifecycleScripts(manifest.scripts)
            if (Object.keys(lc).length > 0) {
              const weekly = searchDownloads.get(manifest.name)
              const state = weekly != null ? 'ready' : 'lifecycle'
              manifests.push({ ...manifest, state, weeklyDownloads: weekly ?? 0 })
              mFound++
              newThisRun++
              if (topN > 0 && newThisRun >= topN) done = true  // stop search pages, not drain
            }
          }

          mFetched++
          if (mFetched % DRAIN_CHECKPOINT_EVERY === 0) {
            process.stderr.write(`    [${mFetched}/${startCount}] checked, ${mFound} with lifecycle scripts\n`)
            await Promise.all([
              savePackageCache(resumeCachePath, manifests, seen, finalDiscoveryState, candidates, failedFetches),
              savePackageCache(pkgPath, manifests, seen, finalDiscoveryState, [], failedFetches),
            ])
          }
        }
      }

      await Promise.all(Array.from({ length: MANIFEST_CONCURRENCY }, (_, i) => worker(i)))
      for (const name of networkRetry) candidates.push(name)
      process.stderr.write(`    [${mFetched}/${startCount}] checked, ${mFound} with lifecycle scripts\n`)

      const hitRate = mFetched > 0 ? (mFound / mFetched * 100).toFixed(1) : '0.0'
      const failLine = failedFetches.size > 0 ? `, ${failedFetches.size} failed — retry next run` : ''
      const retryLine = networkRetry.length > 0 ? `, ${networkRetry.length} network errors — kept for retry` : ''

      if (circuitTripped) {
        process.stderr.write(
          `  ⚡ circuit breaker tripped during Candidates drain — checkpointing\n` +
          `     ${candidates.length} candidates remain for next run\n`
        )
        await Promise.all([
          savePackageCache(resumeCachePath, manifests, seen, finalDiscoveryState, candidates, failedFetches),
          savePackageCache(pkgPath, manifests, seen, finalDiscoveryState, [], failedFetches),
        ])
        process.stderr.write(`  checkpoint saved — re-run to continue\n`)
        process.exit(0)
      }

      process.stderr.write(`    ✓ +${mFound} of ${mFetched} candidates (${manifests.length} in store, ${hitRate}% hit rate${failLine}${retryLine})\n`)
      await Promise.all([
        savePackageCache(resumeCachePath, manifests, seen, finalDiscoveryState, candidates, failedFetches),
        savePackageCache(pkgPath, manifests, seen, finalDiscoveryState, [], failedFetches),
      ])
      process.stderr.write(`    checkpoint saved — ready to refill\n`)
      pagesSinceLastDrain = 0

    // ── DeepFetch mode ────────────────────────────────────────────────────
    // Download files for all manifests via unpkg (Steps 1-2 of deep scan).
    // Collects ALL discovered package names from require() BFS — no filtering.
    // Caller dedupes and adds new names to candidates after the drain.
    } else if (mode === DrainMode.DeepFetch) {
      // Sort: packages without a cache dir (need network fetch) come first so
      // workers spend time on real work while cached packages fill the tail.
      const safeDirs = manifests.map(m => path.join(deepDir, m.name.replace(/\//g, '__')))
      const cached = await Promise.all(safeDirs.map(d => fs.access(d).then(() => true, () => false)))
      const fetchQueue = [
        ...manifests.filter((_, i) => !cached[i]),
        ...manifests.filter((_, i) =>  cached[i]),
      ]
      const startCount = fetchQueue.length
      if (startCount === 0) return
      await savePackageCache(resumeCachePath, manifests, seen, finalDiscoveryState, candidates, failedFetches)
      process.stderr.write(`\n  DeepFetch: fetching files for ${startCount} packages...\n`)
      let dfFetched = 0
      const allDiscovered = []  // accumulate across all workers (names only, unfiltered)
      const fileLimit = makeLimiter(5)

      const worker = async (workerIndex) => {
        await sleep(workerIndex * MANIFEST_DELAY_MS)
        while (true) {
          const manifest = fetchQueue.shift()
          if (!manifest) break
          await sleep(MANIFEST_DELAY_MS)
          const { fetchedFiles, discoveredManifests, fromCache } =
            await deepFetchPackage(manifest, deepDir, fileLimit)
          deepFetchedFiles.set(manifest.name, fetchedFiles || [])
          for (const m of (discoveredManifests || [])) allDiscovered.push(m.name)
          dfFetched++
          if (dfFetched % DRAIN_CHECKPOINT_EVERY === 0 || dfFetched === startCount) {
            process.stderr.write(`    [${dfFetched}/${startCount}] processed${fromCache ? ' [cached]' : ''}\n`)
            await Promise.all([
              savePackageCache(resumeCachePath, manifests, seen, finalDiscoveryState, candidates, failedFetches),
              savePackageCache(pkgPath, manifests, seen, finalDiscoveryState, [], failedFetches),
            ])
          }
        }
      }

      await Promise.all(Array.from({ length: MANIFEST_CONCURRENCY }, (_, i) => worker(i)))

      // Dedupe discovered names against seen + current store, add new ones to candidates
      const inStore = new Set(manifests.map(m => m.name))
      const newNames = []
      for (const name of new Set(allDiscovered)) {
        if (!seen.has(name) && !inStore.has(name)) {
          seen.add(name)
          candidates.push(name)
          deepNewPkgs++
          newNames.push(name)
        }
      }
      process.stderr.write(`    ✓ ${dfFetched} packages processed` +
        (newNames.length > 0 ? `, +${newNames.length} discovered:` : ', no new packages') + '\n')
      for (const name of newNames) process.stderr.write(`      + ${name}\n`)
      await Promise.all([
        savePackageCache(resumeCachePath, manifests, seen, finalDiscoveryState, candidates, failedFetches),
        savePackageCache(pkgPath, manifests, seen, finalDiscoveryState, [], failedFetches),
      ])
      process.stderr.write(`    checkpoint saved\n\n`)

    // ── DeepScan mode ─────────────────────────────────────────────────────
    // Run indicator scan on already-fetched packages (reads from cache).
    // Must be called after drain(DeepFetch) so files are on disk.
    } else if (mode === DrainMode.DeepScan) {
      const dsQueue = [...manifests]
      const startCount = dsQueue.length
      if (startCount === 0) return
      await savePackageCache(resumeCachePath, manifests, seen, finalDiscoveryState, candidates, failedFetches)
      process.stderr.write(`\n  DeepScan: analyzing ${startCount} packages...\n`)
      let dsFetched = 0

      const worker = async (workerIndex) => {
        await sleep(workerIndex * MANIFEST_DELAY_MS)
        while (true) {
          const manifest = dsQueue.shift()
          if (!manifest) break
          await sleep(MANIFEST_DELAY_MS)
          const { results, referencedFiles, fromCache } =
            await deepAnalyzePackage(manifest, deepDir)
          deepResults.set(manifest.name, results)
          deepRefFiles.set(manifest.name, referencedFiles || [])
          const hitCount = results?.length ?? 0
          const tag = fromCache ? ' [cached]' : hitCount > 0 ? ` — ${hitCount} indicator(s)` : ''
          process.stderr.write(`    ${manifest.name}@${manifest.version}${tag}\n`)
          dsFetched++
          if (dsFetched % DRAIN_CHECKPOINT_EVERY === 0 || dsFetched === startCount) {
            process.stderr.write(`    [${dsFetched}/${startCount}] analyzed\n`)
          }
        }
      }

      await Promise.all(Array.from({ length: MANIFEST_CONCURRENCY }, (_, i) => worker(i)))
      process.stderr.write(`    ✓ ${dsFetched} packages analyzed\n\n`)
    }
  }

  // Drain any candidates left pending from a previous interrupted run before searching more.
  if (candidates.length > 0 && !done) {
    process.stderr.write(`Step 3.25/4: Resuming ${candidates.length} pending candidates from previous run...\n`)
    await drain(DrainMode.Candidates)
    process.stderr.write('\n')
  }

  while (!done) {
    const newAtPassStart = manifests.length  // detect a pass with no new lifecycle packages

    for (let qi = passStartIndex; qi < DISCOVERY_QUERIES.length && !done; qi++) {
      const query = DISCOVERY_QUERIES[qi]

      // Determine starting offset for this keyword:
      //  1. Interrupted-run resume (tmp cursor): exact result offset from last fetch
      //  2. Rolling cursor within TTL: continue from last result offset — sweep start
      //     age (cursor.startedAt) determines TTL, not the last scan time.
      //  3. Expired/missing cursor: start at offset 0 and begin a new sweep.
      let from
      let fromLabel = ''
      let sweepStartedAt  // preserved across runs so TTL is measured from sweep origin
      if (qi === resumeQueryIndex && resumeQueryFrom > 0) {
        from = resumeQueryFrom  // mid-run interrupt — exact resume position
        fromLabel = ` (resuming from offset ${from})`
        sweepStartedAt = keywordCursors[query]?.startedAt || new Date().toISOString()
      } else {
        const cursor = keywordCursors[query]
        if (cursor?.startedAt && searchTtlMs > 0) {
          const sweepAgeMs = Date.now() - new Date(cursor.startedAt).getTime()
          if (sweepAgeMs < searchTtlMs) {
            from = cursor.from  // continue forward within this sweep
            sweepStartedAt = cursor.startedAt  // keep the original sweep origin
            const ageH = (sweepAgeMs / 3_600_000).toFixed(1)
            const approxPage = Math.floor(from / pageSize) + 1
            fromLabel = ` (cursor: offset ${from} ~page ${approxPage}, sweep age ${ageH}h/${searchTtlHours}h)`
          } else {
            from = 0  // sweep expired: restart from top to catch newly-popular packages
              sweepStartedAt = new Date().toISOString()
          }
        } else {
          from = 0  // no cursor or TTL disabled (searchTtlMs === 0 forces restart)
          sweepStartedAt = new Date().toISOString()
        }
      }

      process.stderr.write(`  query: ${query}${fromLabel}\n`)

      const sweepStartOffset = from  // capture where this keyword started this run
      let dryPageStreak = 0          // consecutive pages with zero new lifecycle-script packages
      while (!done) {
        const enc = encodeURIComponent(query)
        const url =
          `https://registry.npmjs.org/-/v1/search` +
          `?text=${enc}&popularity=1.0&quality=0.0&maintenance=0.0` +
          `&size=${pageSize}&from=${from}`

        let page
        const fetchStart = Date.now()
        process.stderr.write(`    fetching offset=${from}...\r`)
        try {
          page = await fetchJson(url)
        } catch (err) {
          if (err.isCircuitOpen) {
            process.stderr.write(`  ⚡ circuit open during search — checkpointing\n`)
            await Promise.all([
              savePackageCache(resumeCachePath, manifests, seen, { queryOrder: DISCOVERY_QUERIES, queryIndex: qi, queryFrom: from, keywordCursors }, candidates),
              savePackageCache(pkgPath, manifests, seen, { keywordCursors }),
            ])
            process.exit(0)
          }
          process.stderr.write(`  ⚠️  error fetching ${query}: ${err.message} — skipping to next keyword\n`)
          break
        }
        const fetchMs = Date.now() - fetchStart
        if (!page || !page.objects || page.objects.length === 0) break  // exhausted

        const allNames = page.objects.map(o => o.package.name)
        const newNames = allNames.filter(n => !seen.has(n))
        const skippedThisPage = allNames.length - newNames.length
        alreadySeenSkips += skippedThisPage
        for (const o of page.objects) {
          if (!seen.has(o.package.name) && o.downloads?.weekly) {
            searchDownloads.set(o.package.name, o.downloads.weekly)
          }
        }
        for (const n of newNames) seen.add(n)
        const pageFrom = from   // offset this page started at (for display)
        from += allNames.length
        pagesFetchedTotal++

        candidates.push(...newNames)
        scanned += allNames.length
        finalDiscoveryState = { queryOrder: DISCOVERY_QUERIES, queryIndex: qi, queryFrom: from, keywordCursors }
        process.stderr.write(
          `    p${pagesFetchedTotal} offset=${pageFrom} fetch=${fetchMs}ms` +
          ` | +${newNames.length} new names, ${skippedThisPage} seen-skips` +
          ` | ${candidates.length} candidates, ${manifests.length} in store\n`
        )
        process.stderr.write(`    saving checkpoint...\r`)
        await savePackageCache(resumeCachePath, manifests, seen, { queryOrder: DISCOVERY_QUERIES, queryIndex: qi, queryFrom: from, keywordCursors }, candidates)
        process.stderr.write(`                       \r`)  // clear the saving line

        // Dry page: all results were already in seen-set — no new names to fetch.
        // Three consecutive all-seen pages signals we're in an overlapping or spam zone.
        if (newNames.length > 0) {
          dryPageStreak = 0
        } else {
          dryPageStreak++
          if (dryPageStreak >= 3) {
            process.stderr.write(
              `  ⏭️  skipping ${query} after ${dryPageStreak} pages with all-seen results ` +
              `(offset=${from}, overlapping zone) — moving to next keyword\n`
            )
            break
          }
        }

        // Drain every 2 search pages so manifests are fetched incrementally.
        pagesSinceLastDrain++
        if (pagesSinceLastDrain >= 2 && candidates.length > 0 && !done) {
          // Pre-drain checkpoint is inside drain() — update finalDiscoveryState first.
          finalDiscoveryState = { queryOrder: DISCOVERY_QUERIES, queryIndex: qi, queryFrom: from, keywordCursors }
          await drain(DrainMode.Candidates)
        }

        if (from >= sweepStartOffset + 2000) break  // scanned 2000 results this run for this keyword
        // Note: the npm registry has no hard from-offset cap, but result quality degrades
        // significantly past offset ~2000 (spam/placeholder packages appear). The 2000-result
        // window keeps scans in the higher-quality range while still making progress.
      }
      // Save rolling cursor — covers exhaustion, 2000-cap, topN-reached, and error exits.
      // Preserve startedAt (sweep origin) so TTL is measured from the first page-0 scan,
      // not from the most-recent run.
      keywordCursors[query] = { from, startedAt: sweepStartedAt, scannedAt: new Date().toISOString() }

      // Advance to the next query: flush both caches so future merges start from a current base.
      const nextQi = qi + 1
      const nextFrom = 0
      const nextState = { queryOrder: DISCOVERY_QUERIES, queryIndex: nextQi, queryFrom: nextFrom, keywordCursors }
      process.stderr.write(`  checkpoint: ${manifests.length} packages, ${seen.size} seen — saved\n`)
      await Promise.all([
        savePackageCache(resumeCachePath, manifests, seen, nextState, candidates),
        savePackageCache(pkgPath, manifests, seen, nextState),
      ])
    }

    if (!done) {
      if (manifests.length === newAtPassStart && candidates.length === 0) {
        // Full pass with no new lifecycle packages and no pending candidates — exhausted
        process.stderr.write(`  all keywords exhausted with no new candidates — stopping\n`)
        break
      }
      // Found new packages; wrap around and try all keywords again
      process.stderr.write(`  wrapping around keyword list (${manifests.length} in store so far)...\n`)
      passStartIndex = 0
      resumeQueryFrom = 0  // reset so next pass starts each keyword from the top
    }
  }
  process.stderr.write(
    `\n  ✓ search complete: ${scanned.toLocaleString()} names examined this run` +
    ` (${seen.size.toLocaleString()} unique in seen-set)\n`
  )
  if (candidates.length > 0) {
    await drain(DrainMode.Candidates)
  } else process.stderr.write('\n')

  // ---------------------------------------------------------------------------
  // Step 3.5: Scoped → unscoped peer expansion.
  // Probe each bare name for existence, then push confirmed names into candidates
  // and let drain(DrainMode.Candidates) do the full manifest fetch + lifecycle classification.
  // ---------------------------------------------------------------------------
  {
    process.stderr.write('Step 3.5/4: Expanding scoped packages with unscoped peers...\n')
    const peerNames = []
    for (const m of manifests) {
      if (m.name.startsWith('@')) {
        const bare = m.name.replace(/^@[^/]+\//, '')
        if (!seen.has(bare)) peerNames.push(bare)
      }
    }

    if (peerNames.length === 0) {
      process.stderr.write('  (no new unscoped peers to check)\n\n')
    } else {
      process.stderr.write(`  checking ${peerNames.length} bare names...\n`)
      let checked = 0, found = 0
      const checkQueue = [...peerNames]

      const worker = async (workerIndex) => {
        await sleep(workerIndex * MANIFEST_DELAY_MS)
        while (true) {
          const name = checkQueue.shift()
          if (!name) break
          await sleep(MANIFEST_DELAY_MS)
          const exists = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`)
            .then(() => true, () => false)
          if (exists) { seen.add(name); candidates.push(name); found++ }
          checked++
        }
      }

      await Promise.all(Array.from({ length: MANIFEST_CONCURRENCY }, (_, i) => worker(i)))
      process.stderr.write(`  ${found} of ${checked} peers exist — added to candidates\n`)

      if (found > 0) {
        finalDiscoveryState = { queryOrder: DISCOVERY_QUERIES, queryIndex: -1, queryFrom: 0, keywordCursors }
        await drain(DrainMode.Candidates)
      } else {
        process.stderr.write('\n')
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 4/5 (--deep only): Fetch indicator files + lifecycle JS files via unpkg,
  // follow require() refs recursively, then run the full scanner stack.
  // Results are cached by name@version in deepDir so re-runs are instant.
  // ---------------------------------------------------------------------------
  if (deepMode) {
    process.stderr.write('Step 4/5: Deep scanning packages via unpkg...\n')
    await fs.mkdir(deepDir, { recursive: true })

    // Phase A: fetch files for all current manifests, collect cross-package discoveries
    process.stderr.write('  ├─ A: fetching files for all packages...\n')
    await drain(DrainMode.DeepFetch)

    // Phase B: drain any newly discovered packages into manifests[]
    if (candidates.length > 0) {
      process.stderr.write('  ├─ B: draining discovered packages...\n')
      await drain(DrainMode.Candidates)

      // Phase C: fetch files for the newly added packages
      process.stderr.write('  ├─ C: fetching files for newly discovered packages...\n')
      await drain(DrainMode.DeepFetch)
    }

    // Phase D: run indicator scan across all packages (files now cached)
    process.stderr.write('  └─ D: running indicator scan...\n')
    await drain(DrainMode.DeepScan)
  }

  // Save final manifests to permanent store.  discoveryState carries only
  // keywordCursors (no resume position) so the next run continues forward
  // from the last page reached for each keyword, skipping already-walked pages.
  await savePackageCache(pkgPath, manifests, seen, { keywordCursors })
  process.stderr.write(`  ✓ manifests saved to ${pkgPath}\n\n`)
  await fs.unlink(resumeCachePath).catch(() => {})

  const analyzeStep = deepMode ? '5/5' : '4/4'
  process.stderr.write(`Step ${analyzeStep}: Analyzing...\n`)

  const categorized = {} // indicatorFile → packageName[]
  const uncategorized = [] // packages with build signals but no definition match

  // token → { packages: string[], totalDownloads: number }
  const gapTokens = {}

  for (const manifest of manifests) {
    const lc = extractLifecycleScripts(manifest.scripts)

    // --deep: use production scanner results (keyed by name@version in cache)
    // Fall back to command-pattern matching when deep results aren't available.
    const deepScan = deepResults.get(manifest.name)
    const deepRefs = deepRefFiles.get(manifest.name) || []
    const deepFetched = deepFetchedFiles.get(manifest.name) || []
    const matches = deepScan
      ? deepScan.map(r => r.indicatorFile)
      : matchExistingDefinitions(lc, manifest)

    // Collect classified URLs from the deep scan (all files' url lists).
    // entry.urls is [{url, classification}]; older cached entries may be strings.
    const scannedUrls = deepRefs.flatMap(f => (f.urls || []).map(u =>
      typeof u === 'string' ? { url: u, classification: classifyUrl(u) } : u
    ))

    if (matches.length > 0) {
      for (const m of matches) {
        if (!categorized[m]) categorized[m] = []
        categorized[m].push(manifest.name)
      }
      continue // already handled by existing definitions
    }

    // Not matched — is it a build package at all?
    // Use the same hasBuildHint gate as the production approve-scripts scanner,
    // passing deep referencedFiles and deps so all hint sources are checked.
    const allDeps = [
      ...Object.keys(manifest.dependencies),
      ...Object.keys(manifest.devDependencies),
      ...Object.keys(manifest.optionalDependencies),
    ]
    if (!hasBuildHint(manifest.scripts || {}, deepRefs, undefined, allDeps)) continue

    const tokens = extractCommandTokens(lc)
    const inferred = inferIndicatorFiles(manifest)
    const signal = suggestSignal(tokens, inferred)

    const buildDeps = allDeps.filter(d => BUILD_DEP_PATTERNS.some(p => p.test(d)))

    // Collect unique signals detected across all scanned files (including cross-package refs)
    const detectedSignals = [...new Set(deepRefs.flatMap(f => f.signals || []))]

    uncategorized.push({
      name: manifest.name,
      version: manifest.version,
      weeklyDownloads: manifest.weeklyDownloads,
      lifecycleScripts: lc,
      buildDependencies: buildDeps,
      commandTokens: tokens,
      inferredIndicatorFiles: inferred,
      detectedSignals: detectedSignals.length > 0 ? detectedSignals : undefined,
      suggestedSignal: signal || detectedSignals[0] || null,
      scannedFiles: deepFetched.length > 0 ? deepFetched : undefined,
      // Classified URLs found in scanned lifecycle files — 'reference' URLs are
      // marked so the AI can distinguish "downloads a binary from registry.npmjs.org"
      // (download) from "links to a license page" (reference, likely ok).
      scannedUrls: scannedUrls.length > 0 ? scannedUrls : undefined,
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
      deepScan: deepMode,
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
      lifecycleOnlyNoBuildHint: manifests.length - Object.values(categorized).flat().length - uncategorized.length,
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

  const noBuildHint = manifests.length - Object.values(categorized).flat().length - uncategorized.length
  process.stderr.write(`\n✅ Done!\n`)
  process.stderr.write(`   New this run:         ${newThisRun}\n`)
  if (alreadySeenSkips > 0) {
    const skipPct = scanned > 0 ? Math.round((alreadySeenSkips / (scanned + alreadySeenSkips)) * 100) : 0
    process.stderr.write(`   Already-seen skips:   ${alreadySeenSkips.toLocaleString()} (${skipPct}% of results were repeats)\n`)
  }
  if (deepNewPkgs > 0) {
    process.stderr.write(`   Found via deep scan:  ${deepNewPkgs} new packages added — discovered by following require() imports across package boundaries during file fetch\n`)
  }
  process.stderr.write(`   With lifecycle scripts: ${manifests.length} (of ${seen.size.toLocaleString()} total examined)\n`)
  process.stderr.write(`   Covered by existing indicator defs: ${output.coverage.matchedByExistingDefinitions} (of ${manifests.length} with lifecycle scripts)\n`)
  process.stderr.write(`   Uncategorized builds: ${output.coverage.uncategorizedBuildPackages} (have build hint, no matching indicator)\n`)
  process.stderr.write(`   Lifecycle-only (no build hint): ${noBuildHint} (postinstall/setup scripts, not native builders)\n`)
  process.stderr.write(`   Pattern gaps found:   ${commandPatternGaps.length}\n`)

  // Warn when indicator coverage of lifecycle-script packages is low.
  // Threshold: fewer than 30% of lifecycle-script packages matched an indicator.
  const coveragePct = manifests.length > 0
    ? Math.round((output.coverage.matchedByExistingDefinitions / manifests.length) * 100)
    : 100
  if (coveragePct < 30) {
    process.stderr.write(
      `\n   ⚠️  Only ${coveragePct}% of lifecycle-script packages are covered by existing indicators.\n` +
      `   Consider reviewing ${outPath} and indicator-definitions.js with an AI assistant:\n` +
      `   ask it to compare the uncategorizedPackages entries against the existing indicator\n` +
      `   registry and suggest new commandPatterns, signals, or indicator entries. Improvements\n` +
      `   affect both approve-scripts (production scanning) and this suggestion tool.\n`
    )
  }

  process.stderr.write(`\n   Written to: ${outPath}\n\n`)
}

main().catch(err => {
  process.stderr.write(`\nFatal: ${err.message}\n${err.stack}\n`)
  process.exit(1)
})
