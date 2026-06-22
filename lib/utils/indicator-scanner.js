// Build indicator scanner.
//
// Architecture: detect → investigate (scanner factory)
//
//  1. DETECT (fast, parallel)
//     Scans all available evidence in one pass:
//       (a) Lifecycle script command strings vs each entry's detect.commandPatterns
//       (b) 'native-build' signal on already-scanned files (for entries with
//           detect.triggeredByNativeBuildSignal: true)
//       (c) Parallel fs.access check for every registry key
//     Produces a Set of indicator filenames that have evidence ("clue set").
//
//  2. INVESTIGATE (scanner factory)
//     For each filename in the clue set, does one O(1) registry lookup and
//     instantiates the matching scanner  -  GYP parser or generic step-runner.
//     Scanners run concurrently (Promise.all).
//
// Adding a new build tool requires only a new entry in
// indicator-definitions.js.  No changes here unless the file format needs
// a new built-in scanner type.
//
// Public API
//   hasBuildHint(scripts, referencedFiles, registry?, deps?)  → boolean   (zero I/O pre-check)
//   scanBuildIndicators(packageDir)                           → Promise<IndicatorResult[]>
//   scanBuildIndicatorsForPackage(packageDir, scripts,
//                                 referencedFiles)            → Promise<IndicatorResult[]>
//
// IndicatorResult
//   { indicatorFile, label, sha256, parseError, signals: string[], groups: Group[] }
//
// Group
//   { label: string, items: string[] }

const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')

const { INDICATOR_REGISTRY, NATIVE_BUILD_COMMAND_PATTERN } = require('./indicator-definitions')
const { parseGypContent, flattenConditions } = require('./gyp-scanner')

// ---------------------------------------------------------------------------
// Public: zero-I/O hint check (gates the full scan in allow-scripts-cmd.js)
// ---------------------------------------------------------------------------

// Deps that strongly suggest a binary download-and-extract workflow when
// combined with a lifecycle script.  Zip/tar extractors are rare outside
// packages that ship prebuilt binaries.
const ARCHIVE_EXTRACTION_DEPS = new Set([
  'tar', 'yauzl', 'unzipper', 'extract-zip', 'adm-zip', 'decompress',
  'fflate', 'jszip', 'node-7z', 'archiver',
])

// Deps whose name ends with a platform/arch suffix — the "binary-as-npm-package"
// distribution pattern (e.g. @scope/pkg-linux-x64, esbuild-linux-64, etc.)
const PLATFORM_BINARY_PKG_RE = /[_-](?:linux|darwin|win32|windows|android|freebsd)[_-](?:x64|x86|arm64|ia32|arm|x86_64|aarch64)\b/i

// Checks NATIVE_BUILD_COMMAND_PATTERN first (fast path for the most common
// cases), then checks all registry commandPatterns so that non-native-build
// indicators (android-native, make-build, wasm-build, …) also trigger the
// scan when their commands appear in lifecycle scripts.
// Optional `deps` (array of dep names from package.json) enables dep-based
// heuristics: archive-extraction packages and platform-binary npm packages.
const hasBuildHint = (scripts, referencedFiles, registry = INDICATOR_REGISTRY, deps = []) => {
  for (const cmd of Object.values(scripts)) {
    if (NATIVE_BUILD_COMMAND_PATTERN.test(cmd)) return true
    for (const def of Object.values(registry)) {
      if (def.detect.commandPatterns.some((p) => p.test(cmd))) return true
    }
  }
  for (const { signals } of referencedFiles) {
    if (Array.isArray(signals) && signals.includes('native-build')) return true
    if (Array.isArray(signals) && signals.includes('binary-download')) return true
    if (Array.isArray(signals) && signals.includes('runtime-installer')) return true
    if (Array.isArray(signals) && signals.includes('external-url')) return true
    if (Array.isArray(signals) && signals.includes('makes-executable')) return true
  }
  // Dep-based heuristics — only meaningful when the package has lifecycle scripts.
  if (deps.length > 0 && Object.keys(scripts).length > 0) {
    for (const dep of deps) {
      // Archive extraction dep + lifecycle script → likely download-unpack binary
      if (ARCHIVE_EXTRACTION_DEPS.has(dep)) return true
      // Platform-binary npm package dep → binary selected/extracted at install time
      if (PLATFORM_BINARY_PKG_RE.test(dep)) return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Public: full scan  -  detect then investigate
// ---------------------------------------------------------------------------

const scanBuildIndicators = async (packageDir, registry = INDICATOR_REGISTRY) => {
  const clues = await detectClues(packageDir, {}, [], registry)
  if (clues.size === 0) return []
  return Promise.all([...clues].map(file => investigate(file, registry[file], packageDir)))
}

// Variant used by allow-scripts-cmd.js: passes scripts + scanned files so
// command-pattern and signal hints can pre-populate the clue set before the
// disk check.
const scanBuildIndicatorsForPackage = async (
  packageDir, scripts, referencedFiles, registry = INDICATOR_REGISTRY
) => {
  const clues = await detectClues(packageDir, scripts, referencedFiles, registry)
  if (clues.size === 0) return []
  return Promise.all([...clues].map(file => investigate(file, registry[file], packageDir)))
}

// ---------------------------------------------------------------------------
// Phase 1: Detect
// ---------------------------------------------------------------------------

// Collect evidence from command strings, scan signals, and parallel disk checks.
// Returns a Set<indicatorFile>  -  the clue set.
const detectClues = async (packageDir, scripts, referencedFiles, registry) => {
  // Separate hint sets so we can apply different inclusion rules:
  //   cmdHintedFiles  -  triggered by a commandPattern match in the lifecycle scripts.
  //     These are included in clues even if the disk check misses (edge-case race);
  //     the scanner handles a missing file gracefully.  Also used for 'none'-scanner
  //     entries (binary-downloader) that intentionally have no file on disk.
  //   sigHintedFiles  -  triggered only by a 'native-build' signal on a referenced file.
  //     These are NOT included unless the disk check confirms the file exists, because
  //     the signal is evidence of a related build tool, not of this specific file.
  //     (Prevents false-positive "build.rs  -  file not readable" warnings on C/C++ packages
  //     that happen to trigger native-build but have no Rust code at all.)
  const cmdHintedFiles = new Set()
  const sigHintedFiles = new Set()

  const hasNativeSig = referencedFiles.some(
    (f) => Array.isArray(f.signals) && f.signals.includes('native-build')
  )
  const hasBinaryDownloadSig = referencedFiles.some(
    (f) => Array.isArray(f.signals) && f.signals.includes('binary-download')
  )
  const hasRuntimeInstallerSig = referencedFiles.some(
    (f) => Array.isArray(f.signals) && f.signals.includes('runtime-installer')
  )
  const hasExternalUrlSig = referencedFiles.some(
    (f) => Array.isArray(f.signals) && f.signals.includes('external-url')
  )
  const hasMakesExecutableSig = referencedFiles.some(
    (f) => Array.isArray(f.signals) && f.signals.includes('makes-executable')
  )

  // Command pattern and signal checks  -  zero I/O, builds the hint sets
  for (const [indicatorFile, def] of Object.entries(registry)) {
    const cmdMatch = Object.values(scripts).some(
      (cmd) => def.detect.commandPatterns.some((p) => p.test(cmd))
    )
    if (cmdMatch) {
      cmdHintedFiles.add(indicatorFile)
    } else if (
      (hasNativeSig && def.detect.triggeredByNativeBuildSignal) ||
      (hasBinaryDownloadSig && def.detect.triggeredByBinaryDownloadSignal) ||
      (hasRuntimeInstallerSig && def.detect.triggeredByRuntimeInstallerSignal) ||
      (hasExternalUrlSig && def.detect.triggeredByExternalUrlSignal) ||
      (hasMakesExecutableSig && def.detect.triggeredByMakesExecutableSignal)
    ) {
      sigHintedFiles.add(indicatorFile)
    }
  }

  // Parallel disk existence check  -  only files that exist are added to the
  // clue set.  Entries without a command/signal hint are still checked because
  // file presence alone (e.g. a Cargo.toml) is sufficient evidence.
  const allFiles = Object.keys(registry)
  const found = await Promise.all(
    allFiles.map((f) =>
      fs.access(path.join(packageDir, f))
        .then(() => f)
        .catch(() => null)
    )
  )

  const foundSet = new Set(found.filter(Boolean))
  const clues = new Set(foundSet)
  // Include command-pattern-hinted (and 'none'-scanner) files regardless of disk result.
  for (const f of cmdHintedFiles) clues.add(f)
  // Include signal-triggered files only if they actually exist on disk,
  // EXCEPT for 'none'-scanner entries which intentionally have no indicator file.
  for (const f of sigHintedFiles) {
    if (foundSet.has(f) || registry[f]?.scanner?.type === 'none') clues.add(f)
  }

  return clues
}

// ---------------------------------------------------------------------------
// Phase 2: Investigate  -  scanner factory
// ---------------------------------------------------------------------------

// Single O(1) registry lookup → instantiate the right scanner → run it.
const investigate = async (indicatorFile, def, packageDir) => {
  // 'none' scanner: detected by command pattern alone  -  no indicator file on disk.
  if (def.scanner?.type === 'none') {
    return {
      indicatorFile,
      label: def.label,
      sha256: null,
      parseError: null,
      signals: [...(def.signals.onFound || [])],
      groups: [],
    }
  }

  let rawBuf
  try {
    rawBuf = await fs.readFile(path.join(packageDir, indicatorFile))
  } catch (err) {
    /* istanbul ignore next: defensive guard for detect→investigate race (file deleted between stat and read) */
    return {
      indicatorFile,
      label: def.label,
      sha256: null,
      parseError: `file not readable: ${err.message}`,
      signals: [...(def.signals.onFound || [])],
      groups: [],
    }
  }

  const sha256 = crypto.createHash('sha256').update(rawBuf).digest('hex')
  const rawStr = rawBuf.toString('utf8')

  let groups = []
  let extraSignals = []
  let parseError = null

  try {
    if (def.scanner === 'gyp') {
      const r = gypScanner(rawStr, def)
      groups = r.groups
      extraSignals = r.extraSignals
    } else if (def.scanner?.type === 'generic') {
      const r = await genericScanner(rawStr, packageDir, def.scanner.steps)
      groups = r.groups
      extraSignals = r.extraSignals
    }
  } catch (err) {
    parseError = err.message
  }

  return {
    indicatorFile,
    label: def.label,
    sha256,
    parseError,
    signals: [...(def.signals.onFound || []), ...extraSignals],
    groups,
  }
}

// ---------------------------------------------------------------------------
// Built-in scanner: GYP
// Instantiated when def.scanner === 'gyp'
// ---------------------------------------------------------------------------

// Expand GYP simple variable references of the form <(varname) using the
// top-level `variables` block in the parsed GYP file.  Variable names may
// carry a trailing `%` in the declaration (that's GYP syntax for "default,
// overridable by environment")  -  strip it when building the lookup map.
// Shell-command expansions like `<!@(node -p ...)` are left as-is since we
// cannot safely evaluate them statically.
const expandGypVars = (str, vars) => {
  if (!str || typeof str !== 'string' || !vars || typeof vars !== 'object') return str
  return str.replace(/<\(([^)]+)\)/g, (match, varName) => {
    // Look up exact name first, then name without trailing %
    const value = vars[varName] ?? vars[varName.replace(/%$/, '')]
    return typeof value === 'string' ? value : match
  })
}

const buildVarMap = (variables) => {
  if (!variables || typeof variables !== 'object') return {}
  const map = {}
  for (const [k, v] of Object.entries(variables)) {
    // Strip trailing % (GYP default-value marker) to get the canonical name
    map[k.replace(/%$/, '')] = v
    map[k] = v  // also keep the raw key so exact matches work
  }
  return map
}

const gypScanner = (rawStr, def) => {
  const parsed = parseGypContent(rawStr)
  const vars = buildVarMap(parsed.variables)
  const groups = []
  const extraSignals = []

  for (const target of (Array.isArray(parsed.targets) ? parsed.targets : [])) {
    const cond = flattenConditions(target.conditions)
    const rawName = typeof target.target_name === 'string' ? target.target_name : '<unnamed>'
    const name = expandGypVars(rawName, vars)

    const sources     = [...(target.sources      || []), ...cond.sources]
    const libraries   = [...(target.libraries    || []), ...cond.libraries]
    const includeDirs = [...(target.include_dirs || []), ...cond.includeDirs]
    const hasConds    = Array.isArray(target.conditions) && target.conditions.length > 0

    if (sources.length > 0)
      groups.push({ label: `Target \`${name}\`  -  C/C++ sources`, items: sources })
    if (libraries.length > 0)
      groups.push({ label: `Target \`${name}\`  -  libraries`, items: libraries })
    if (includeDirs.length > 0)
      groups.push({ label: `Target \`${name}\`  -  include directories`, items: includeDirs })
    if (hasConds) {
      groups.push({
        label: `Target \`${name}\`  -  platform-specific conditions`,
        items: ['yes  -  inspect for platform-specific build behaviour'],
      })
      for (const sig of (def.signals.onWarning || [])) {
        if (!extraSignals.includes(sig)) extraSignals.push(sig)
      }
    }
  }

  if (groups.length === 0) {
    groups.push({ label: 'Targets', items: ['(no targets declared)'] })
  }

  return { groups, extraSignals }
}

// ---------------------------------------------------------------------------
// Built-in scanner: Generic step-runner
// Instantiated when def.scanner.type === 'generic'
// ---------------------------------------------------------------------------

const genericScanner = async (rawStr, packageDir, steps) => {
  const groups = []
  const extraSignals = []

  for (const step of steps) {
    if (step.type === 'regex') {
      const m = rawStr.match(step.pattern)
      const value = m?.[step.group ?? 0]
      if (value) groups.push({ label: step.label, items: [value.trim()] })

    } else if (step.type === 'regex-all') {
      if (step.presence) {
        const re = new RegExp(step.pattern.source, step.pattern.flags)
        if (re.test(rawStr)) groups.push({ label: step.label, items: ['yes'] })
      } else {
        const re = new RegExp(step.pattern.source, step.pattern.flags)
        const seen = new Set()
        const items = []
        let m
        while ((m = re.exec(rawStr)) !== null) {
          const v = m[step.group ?? 0]?.trim()
          if (v && !seen.has(v)) { seen.add(v); items.push(v) }
        }
        if (items.length > 0) groups.push({ label: step.label, items })
      }

    } else if (step.type === 'glob') {
      const items = await globRelative(packageDir, step.pattern, step.maxDisplay ?? 30)
      if (items.length > 0) groups.push({ label: step.label, items })

    } else if (step.type === 'signal') {
      // Emit a classifier signal when the pattern matches  -  does not add to groups.
      const re = new RegExp(step.pattern.source, step.pattern.flags)
      if (re.test(rawStr) && !extraSignals.includes(step.signal)) {
        extraSignals.push(step.signal)
      }
    }
  }

  return { groups, extraSignals }
}

// ---------------------------------------------------------------------------
// Glob helper  -  expands {a,b} brace alternatives, walks the directory tree
// ---------------------------------------------------------------------------

const globRelative = async (baseDir, pattern, maxDisplay) => {
  const patterns = expandBraces(pattern)
  const results = new Set()
  for (const p of patterns) {
    await walkGlob(baseDir, p.split('/'), 0, baseDir, results, maxDisplay)
    if (results.size >= maxDisplay) break
  }
  return [...results].sort().slice(0, maxDisplay)
    .map((abs) => path.relative(baseDir, abs).split(path.sep).join('/'))
}

const expandBraces = (pattern) => {
  const m = pattern.match(/^(.*)\{([^}]+)\}(.*)$/)
  if (!m) return [pattern]
  return m[2].split(',').map((alt) => `${m[1]}${alt}${m[3]}`)
}

const walkGlob = async (baseDir, segments, idx, dir, results, maxDisplay) => {
  if (results.size >= maxDisplay) return
  const seg = segments[idx]
  const isLast = idx === segments.length - 1

  if (seg === '**') {
    if (idx + 1 < segments.length)
      await walkGlob(baseDir, segments, idx + 1, dir, results, maxDisplay)
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (results.size >= maxDisplay) return
      if (e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.')) {
        const sub = path.join(dir, e.name)
        await walkGlob(baseDir, segments, idx, sub, results, maxDisplay)
        if (idx + 1 < segments.length)
          await walkGlob(baseDir, segments, idx + 1, sub, results, maxDisplay)
      }
    }
  } else {
    const re = new RegExp('^' + seg.replace(/\./g, '\\.').replace(/\*/g, '[^/]*') + '$')
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (results.size >= maxDisplay) return
      if (!re.test(e.name)) continue
      const abs = path.join(dir, e.name)
      if (isLast && e.isFile()) results.add(abs)
      else if (!isLast && e.isDirectory() && e.name !== 'node_modules')
        await walkGlob(baseDir, segments, idx + 1, abs, results, maxDisplay)
    }
  }
}

module.exports = {
  hasBuildHint,
  scanBuildIndicators,
  scanBuildIndicatorsForPackage,
}
