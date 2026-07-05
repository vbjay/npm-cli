'use strict'

const fs = require('fs/promises')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')

const { OUTPUT_HASH_SEED, META_HASH_SEED, wrapWithHash, unwrapVerified } = require('./integrity')
const {
  sleep, semverGt, makeLimiter, CircuitOpenError, humanDuration,
  fetchJson, fetchChangedNames, getPackageManifest,
} = require('./http')
const {
  LIFECYCLE_HOOKS, BUILD_DEP_PATTERNS, DEP_TO_DEFINITION,
  REGISTRY_PATTERNS, SHELL_NOISE,
  lifecycleDiff, extractLifecycleScripts, matchExistingDefinitions,
  extractCommandTokens, inferIndicatorFiles, suggestSignal,
  parseCommandFile, SIGNAL_PATTERNS,
} = require('./lifecycle')
const { loadPackageCache, savePackageCache } = require('./package-cache')
const { makeLockHelpers } = require('./process-lock')
const {
  DEEP_FETCH_VERSION, DEEP_SCAN_VERSION, MAX_FILES_DEEP_SCAN, INDICATOR_COUNT,
  NODE_BUILTIN_MODULES, isValidNpmPackageName,
  hashDirTree, deepSafeName, deepFetchPackage, deepAnalyzePackage,
  INDICATOR_REGISTRY, SIGNAL_DESCRIPTIONS, hasBuildHint,
} = require('./deep-cache')
const { rmReadOnly, writeDefanged } = require('./defang')
const { fetchRaw } = require('./http')

// ---------------------------------------------------------------------------
// Shared run-loop constants
// ---------------------------------------------------------------------------

const MANIFEST_CONCURRENCY = 5   // npm's own tooling (make-fetch-happen) uses 5 sockets
const MANIFEST_DELAY_MS = 150  // small inter-request stagger to avoid burst detection
const DRAIN_CHECKPOINT_EVERY = 50 // checkpoint to both stores every N manifest resolutions
const DEFAULT_CURSOR_TTL_HOURS = 168  // 7 days

const DrainMode = Object.freeze({
  Candidates: 'Candidates',
  Downloads: 'Downloads',
  DeepFetch: 'DeepFetch',
  DeepScan: 'DeepScan',
})
async function main() {
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
  --deep             For each package with lifecycle scripts, fetch only the
                     specific files needed for analysis — NOT the whole package:
                       • Known indicator files (binding.gyp, Cargo.toml, etc.)
                         fetched by name from the package root via unpkg.
                       • JS/MJS/CJS files explicitly named in lifecycle scripts
                         (e.g. "node scripts/install.js") plus their transitive
                         local require() dependencies, up to a depth limit.
                     Results are cached by name@version in *.deep/ so re-runs
                     are instant.  Cross-package require()/import refs discover new
                     candidate packages but only pull their entry file.
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
  // NOTE: this is a let so --add can bump it to 1 when needed (see below).
  let topN = args.includes('--top') ? +flag('--top', 0) : 0
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
  const pkgFile = flag('--packages', null)
  const manifestStorePath = outPath.replace(/\.json$/, '.packages.json')
  const resumeCachePath = outPath.replace(/\.json$/, '.tmp.json')
  const deepDir = outPath.replace(/\.json$/, '.deep')
  const pkgPath = pkgFile
    ? (path.isAbsolute(pkgFile) ? pkgFile : path.join(ROOT, pkgFile))
    : manifestStorePath

  if (userKeywords.length > 0 && !topExplicit) {
    process.stderr.write(`\n⛔  --keywords requires --top <n> (keywords only affect the collection phase).\n\n`)
    process.exit(1)
  }

  if (doReset) {
    await fs.unlink(manifestStorePath).catch(() => { })
    await fs.unlink(resumeCachePath).catch(() => { })
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
  const pkgLastChangesSeq = loaded.lastChangesSeq ?? null
  let resumeMergeCount = 0
  let isPostCollectionResume = false  // true when tmp.json was written post-collection (collection already done)
  // lastChangesSeq from the tmp cache, if any — used as the starting seq on a resume
  // so the changes-feed filter stays consistent across an interrupted run.
  let tmpLastChangesSeq = null

  // If permanent store empty or missing, try the resume cache
  if (!loaded.manifests && !loaded.names) {
    loaded = await loadPackageCache(resumeCachePath)
    if (loaded.manifests || loaded.names) {
      tmpLastChangesSeq = loaded.lastChangesSeq ?? null
      process.stderr.write(`  (permanent store empty, loaded from resume cache)\n`)
      // discoveryState: null in tmp.json means collection was already complete
      if (loaded.manifests && loaded.discoveryState === null) isPostCollectionResume = true
    }
  } else {
    // Permanent store has data — also check if there's a newer resume cache
    // (from an interrupted run) to merge its additional packages and discovery state.
    const resume = await loadPackageCache(resumeCachePath)
    tmpLastChangesSeq = resume.lastChangesSeq ?? null
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
      resumeQueryFrom = discoveryState.queryFrom || 0
    }
    const withDl = manifests.filter(m => m.weeklyDownloads > 0)
    const sorted = [...withDl].sort((a, b) => b.weeklyDownloads - a.weeklyDownloads)
    const dlMax = sorted[0]?.weeklyDownloads ?? 0
    const dlMin = sorted[sorted.length - 1]?.weeklyDownloads ?? 0

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
  // Filter out any null/undefined entries that may have crept in from a corrupted run.
  const savedOrder = (discoveryState?.queryOrder || null)?.filter(q => typeof q === 'string' && q) ?? null

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
    DISCOVERY_QUERIES = [...reconciled, ...added].filter(q => typeof q === 'string' && q)
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
  process.stderr.write(`  (skipping ${seen.size} already-scanned names)\n`)

  let scanned = 0
  let alreadySeenSkips = 0  // names already in `seen` across all pages this run — measures search redundancy
  let newThisRun = resumeMergeCount  // count packages merged from interrupted run toward the --top target
  // Skip collection if resuming post-collection, or if no --top was given (topN === 0).
  let done = isPostCollectionResume || topN === 0
  // Guarantee at least one search cycle even if version-upgrade candidates already
  // satisfied the --top quota.  Resets to true once the first search pass starts.
  let hasSearched = isPostCollectionResume || topN === 0
  let finalDiscoveryState = { queryOrder: DISCOVERY_QUERIES, queryIndex: resumeQueryIndex, queryFrom: resumeQueryFrom, keywordCursors }
  let passStartIndex = resumeQueryIndex  // where to start the next pass (0 after first wrap)
  let pagesFetchedTotal = 0  // global across all keywords
  let pagesSinceLastDrain = 0
  // Restore any candidates pending manifest fetch from a previous interrupted run.
  const candidates = [...loadedCandidates]

  // Use the CouchDB _changes feed to filter version re-checks to only packages
  // that actually changed since the last run.
  //
  // changesStartSeq: the seq we fetch changes FROM — stored in tmp so a resume
  //   uses the same starting point (and thus the same changedNames filter).
  //   If tmp already has a seq (resuming), use that; otherwise use pkgPath's seq.
  //   Only fetch from _changes when tmp is absent (fresh run start).
  //
  // lastChangesSeq: the new end seq returned by _changes — stored in pkgPath so
  //   the NEXT fresh run starts from here.
  let versionRecheckCount = 0
  // changesStartSeq is what we pass to _changes and persist in tmp.
  // If resuming (tmp had a seq), skip re-fetching — use same seq.
  let changesStartSeq = tmpLastChangesSeq ?? pkgLastChangesSeq
  // lastChangesSeq = the new end seq to save in pkgPath for the next run.
  // Keep as changesStartSeq until _changes returns a new value; if _changes
  // returns null (e.g. stale seq 400), reset to null so next run re-seeds.
  let lastChangesSeq = changesStartSeq

  // Always seed/fetch the changes seq when topN > 0, even if seen is empty —
  // so a completely fresh start (packages.json missing) still records update_seq.
  if (topN > 0) {
    const { names: changedNames, lastSeq } = await fetchChangedNames(changesStartSeq)
    lastChangesSeq = lastSeq
    if (lastSeq === null) changesStartSeq = null

    if (seen.size > 0) {
      const inCandidates = new Set(candidates)
      let skippedUnchanged = 0
      for (const name of seen) {
        if (inCandidates.has(name)) continue
        if (changedNames !== null && !changedNames.has(name)) {
          skippedUnchanged++
          continue
        }
        candidates.push(name)
        versionRecheckCount++
      }
      const filterNote = changedNames !== null
        ? ` (${skippedUnchanged.toLocaleString()} skipped — unchanged since last run)`
        : changesStartSeq === null
          ? ' (no seq — will seed on next run)'
          : ' (full re-check — seq seeded this run)'
      process.stderr.write(`  (re-queued ${versionRecheckCount.toLocaleString()} seen packages for version re-check${filterNote})\n`)
    }
  }
  process.stderr.write('\n')

  // Packages that are always injected as candidates on every run (unless already in store).
  // Covers well-known build tools, task runners, and security-relevant packages that
  // may not rank highly enough in keyword searches to be found organically.
  // Confirmed via live npm registry data (June 2026) — all have lifecycle scripts.
  // User --add names are merged on top of this list.
  const DEFAULT_ADD_PACKAGES = [
    // ── Security-research seeds ───────────────────────────────────────────
    '9router',

    // ── Binary downloaders (fetch prebuilt native binaries at install time) ─
    // Sorted by weekly downloads (descending, June 2026)
    '@swc/core',            // 36.8M/wk — postinstall: node postinstall.js  (NAPI binding selector)
    '@parcel/watcher',      // 28.8M/wk — install: node scripts/build-from-source.js
    '@sentry/cli',          // 19.4M/wk — postinstall: node ./scripts/install.js  (GitHub Releases binary)
    'prisma',               // 13.6M/wk — preinstall: node scripts/preinstall-entry.js
    'puppeteer',            // 11.0M/wk — postinstall: node install.mjs  (Chromium ~170MB)
    'better-sqlite3',       //  7.7M/wk — install: prebuild-install || node-gyp rebuild
    'canvas',               //  7.2M/wk — install: prebuild-install -r napi || node-gyp rebuild
    'cypress',              //  7.1M/wk — postinstall: node dist/index.js --exec install  (test runner binary)
    'bcrypt',               //  5.5M/wk — install: node-gyp-build
    'electron',             //  4.7M/wk — install: node install.js  (full Electron binary ~150MB)
    'lefthook',             //  2.6M/wk — postinstall: node postinstall.js  (GitHub Releases binary)
    'sqlite3',              //  2.4M/wk — install: prebuild-install || node-gyp rebuild
    'ffmpeg-static',        //  1.2M/wk — install: node install.js  (ffmpeg/ffprobe static binary)
    'node-sass',            //  934K/wk — install+postinstall: node scripts/install.js  (deprecated, still installed)
    '@tensorflow/tfjs-node', // 113K/wk — install: node scripts/install.js  (TF C binary via node-pre-gyp)

    // ── Cross-platform script helpers ─────────────────────────────────────
    'cross-env', 'cross-spawn', 'shelljs',

    // ── Task runners ──────────────────────────────────────────────────────
    'gulp', 'gulp-cli', 'grunt', 'grunt-cli', 'jake', 'just-task', 'nps', 'wireit', 'taskr', 'nake',

    // ── Bundlers / build tools ────────────────────────────────────────────
    'esbuild', 'rollup', 'vite', 'webpack', 'parcel', 'tsup', 'unbuild',

    // ── Older / niche bundlers ────────────────────────────────────────────
    'brunch', 'broccoli', 'fuse-box', 'snowpack',

    // ── Monorepo / task orchestration ─────────────────────────────────────
    'nx', 'turborepo', 'lerna',
  ]

  // --add <pkg1,pkg2,...>: inject package names as candidates regardless of seen/store.
  // Useful for one-off additions or testing specific packages.
  //
  // Scope-aware alternate probing: users often forget or misremember whether a
  // package is scoped.  For each name given, we also queue its alternate form:
  //   'angular/cli'   (has / but no @) → also try '@angular/cli'
  //   '@angular/cli'  (scoped)         → also try 'cli' (bare pkg name, no scope)
  // Alternates are probed against the registry; only confirmed packages are added.
  const addFlag = flag('--add', null)
  const userAddNames = addFlag ? addFlag.split(',').map(s => s.trim().replace(/\\/g, '/')).filter(Boolean) : []
  // Merge: defaults first, then any user-supplied names (deduped by position)
  const addNames = [...new Set([...DEFAULT_ADD_PACKAGES, ...userAddNames])]
  let addedCount = 0
  if (addNames.length > 0) {
    // For --add, check by name@version so the same name at a different version can be re-added.
    const inStore = new Set(manifests.map(m => `${m.name}@${m.version}`))
    const inStoreNames = new Set(manifests.map(m => m.name))

    const tryAdd = (name, label) => {
      // Allow re-adding if the version is explicitly specified and differs from stored.
      const hasVersion = name.lastIndexOf('@') > 0
      const alreadyStored = hasVersion ? inStore.has(name) : inStoreNames.has(name)
      if (!alreadyStored && !seen.has(name) && !candidates.includes(name)) {
        candidates.push(name)
        seen.add(name)
        addedCount++
        process.stderr.write(`  + injected candidate: ${name}${label ? `  (${label})` : ''}\n`)
        return true
      }
      return false
    }

    for (const name of addNames) {
      // Reject bare scope with no package name: '@angular' is not a valid npm package.
      // A scoped package must be '@scope/name'.
      if (name.startsWith('@') && !name.includes('/')) {
        process.stderr.write(
          `  ✗ '${name}' looks like a scope, not a package name.\n` +
          `    Did you mean '@${name.slice(1)}/<package>'?  e.g. '${name}/cli' or '${name}/core'\n`
        )
        continue
      }

      const added = tryAdd(name, '')

      // Determine and probe the alternate form.
      let alternate = null
      if (!name.startsWith('@') && name.includes('/')) {
        // e.g. 'angular/cli' → '@angular/cli'
        alternate = `@${name}`
      } else if (name.startsWith('@') && name.includes('/')) {
        // e.g. '@angular/cli' → 'cli' (bare package name without scope)
        alternate = name.replace(/^@[^/]+\//, '')
      }

      if (alternate && !inStoreNames.has(alternate) && !seen.has(alternate) && !candidates.includes(alternate)) {
        process.stderr.write(`  ? probing alternate form: ${alternate}\n`)
        const exists = await fetchJson(
          `https://registry.npmjs.org/${encodeURIComponent(alternate)}/latest`
        ).then(() => true, () => false)
        if (exists) {
          tryAdd(alternate, `alternate form of '${name}'`)
        } else {
          process.stderr.write(`  ✗ ${alternate} not found on registry — skipping\n`)
        }
      } else if (alternate) {
        process.stderr.write(`  ~ ${alternate} already known — skipping alternate\n`)
      }

      if (!added && !alternate) {
        process.stderr.write(`  ~ skipped (already known): ${name}\n`)
      }
    }
    if (addedCount > 0) {
      process.stderr.write(`\n`)
    }
  }
  // If --add injected new candidates but no --top was given, bump topN to 1 so
  // the candidates drain runs (done=true would otherwise skip it entirely).
  if (addedCount > 0 && topN === 0) {
    topN = 1
    done = false
    process.stderr.write(`  ↑ --add injected ${addedCount} candidate(s) with no --top; setting topN=1 to ensure they are fetched\n\n`)
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
  const deepFetchedFiles = new Map() // name@version → fetchedFiles[]
  let deepNewPkgs = 0

  // Worker-pool drain — mode selects what to fetch:
  //   drain(DrainMode.Candidates)                     — fetch manifests for candidate names, populate manifests[]
  //   drain(DrainMode.Downloads)                      — batch-fetch weekly download counts for 'lifecycle' manifests
  //   drain(DrainMode.DeepFetch)                      — download files via unpkg; collect discovered pkg names
  //   drain(DrainMode.DeepFetch, {onlyMissing:true})  — same but skip packages that already have a valid cache
  //   drain(DrainMode.DeepScan)                       — run indicator scan on already-fetched manifests (reads from cache)
  // All modes use MANIFEST_CONCURRENCY workers staggered by MANIFEST_DELAY_MS.
  const drain = async (mode, opts = {}) => {
    // ── Candidates mode ────────────────────────────────────────────────────
    if (mode === DrainMode.Candidates) {
      if (candidates.length === 0) return
      const startCount = candidates.length
      await savePackageCache(resumeCachePath, manifests, seen, finalDiscoveryState, candidates, failedFetches, changesStartSeq)
      process.stderr.write(`\n  Candidates: fetching ${startCount}...\n`)
      let mFetched = 0
      let mFound = 0
      let mUpdated = 0
      let circuitTripped = false
      const networkRetry = []

      // name@version set for O(1) exact-match dedup
      const manifestsByNameVer = new Set(manifests.map(m => `${m.name}@${m.version}`))
      // Track the highest stored version per name for O(1) "do we already have latest?" check
      const manifestMaxVerByName = new Map()
      for (const m of manifests) {
        const cur = manifestMaxVerByName.get(m.name)
        if (!cur || semverGt(cur, m.version)) manifestMaxVerByName.set(m.name, m.version)
      }

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
            const key = `${manifest.name}@${manifest.version}`
            if (manifestsByNameVer.has(key)) {
              // Exact name@version already in store — skip
            } else {
              const lc = extractLifecycleScripts(manifest.scripts)
              if (Object.keys(lc).length === 0) {
                // Latest version has no lifecycle scripts — skip
              } else {
                const storedMax = manifestMaxVerByName.get(manifest.name)
                if (storedMax && !semverGt(storedMax, manifest.version)) {
                  // We already have this version or newer stored — skip
                } else {
                  // New package, or genuine new latest version with lifecycle — add alongside
                  const weekly = searchDownloads.get(manifest.name) || 0
                  const state = weekly > 0 ? 'ready' : 'lifecycle'
                  // When weekly comes from search results it's fresh — stamp the timestamp so
                  // the Downloads drain doesn't immediately re-classify the entry as stale.
                  const downloadsFetchedAt = weekly > 0 ? new Date().toISOString() : null
                  manifests.push({ ...manifest, state, weeklyDownloads: weekly, downloadsFetchedAt })
                  manifestsByNameVer.add(key)
                  manifestMaxVerByName.set(manifest.name, manifest.version)
                  if (storedMax) {
                    process.stderr.write(`  ↑ ${manifest.name}: ${storedMax} → ${manifest.version}\n`)
                    const oldManifest = manifests.find(m => m.name === manifest.name && m.version === storedMax)
                    if (oldManifest) {
                      const oldLc = extractLifecycleScripts(oldManifest.scripts || {})
                      const diff = lifecycleDiff(manifest.name, storedMax, oldLc, manifest.version, lc)
                      if (diff) process.stderr.write(diff + '\n')
                    }
                    mUpdated++
                  } else {
                    mFound++
                    newThisRun++
                    if (topN > 0 && newThisRun >= topN) done = true
                  }
                }
              }
            }
          }

          mFetched++
          if (mFetched % DRAIN_CHECKPOINT_EVERY === 0) {
            process.stderr.write(`    [${mFetched}/${startCount}] checked, ${mFound} new, ${mUpdated} version updates\n`)
            await Promise.all([
              savePackageCache(resumeCachePath, manifests, seen, finalDiscoveryState, candidates, failedFetches, changesStartSeq),
              savePackageCache(pkgPath, manifests, seen, finalDiscoveryState, [], failedFetches, lastChangesSeq),
            ])
          }
        }
      }

      await Promise.all(Array.from({ length: MANIFEST_CONCURRENCY }, (_, i) => worker(i)))
      for (const name of networkRetry) candidates.push(name)
      process.stderr.write(`    [${mFetched}/${startCount}] checked, ${mFound} new, ${mUpdated} version updates\n`)

      const hitRate = mFetched > 0 ? (mFound / mFetched * 100).toFixed(1) : '0.0'
      const failLine = failedFetches.size > 0 ? `, ${failedFetches.size} failed — retry next run` : ''
      const retryLine = networkRetry.length > 0 ? `, ${networkRetry.length} network errors — kept for retry` : ''

      if (circuitTripped) {
        process.stderr.write(
          `  ⚡ circuit breaker tripped during Candidates drain — checkpointing\n` +
          `     ${candidates.length} candidates remain for next run\n`
        )
        await Promise.all([
          savePackageCache(resumeCachePath, manifests, seen, finalDiscoveryState, candidates, failedFetches, changesStartSeq),
          savePackageCache(pkgPath, manifests, seen, finalDiscoveryState, [], failedFetches, lastChangesSeq),
        ])
        process.stderr.write(`  checkpoint saved — re-run to continue\n`)
        process.exit(0)
      }

      process.stderr.write(`    ✓ +${mFound} of ${mFetched} candidates (${manifests.length} in store, ${hitRate}% hit rate${failLine}${retryLine})\n`)
      await Promise.all([
        savePackageCache(resumeCachePath, manifests, seen, finalDiscoveryState, candidates, failedFetches, changesStartSeq),
        savePackageCache(pkgPath, manifests, seen, finalDiscoveryState, [], failedFetches, lastChangesSeq),
      ])
      process.stderr.write(`    checkpoint saved — ready to refill\n`)
      pagesSinceLastDrain = 0

      // ── DeepFetch mode ─────────────────────────────────────────────────────
      // For each manifest: fetch indicator files + lifecycle JS (BFS within the
      // package only).  Bare require()/import refs (ESM import…from, import())
      // are collected as bareFollows.  Workers resolve each follow to name@version
      // via unpkg and push new ones to candidates so they go through the proper
      // Candidates drain pipeline (full manifest fetch + weekly-downloads → packages.json).
    } else if (mode === DrainMode.DeepFetch) {
      // opts.onlyMissing = true  → discovery pass: only fetch packages with no valid cache
      //                            (newly added packages whose deps haven't been found yet).
      // opts.onlyMissing = false → reverification pass: fetch all packages so stale caches
      //                            are caught even for packages that looked valid at scan start.
      const { onlyMissing = false } = opts

      // Sort: packages without a valid cache entry come first (real network work).
      // Cache status: 'valid' = fetchVersion matches, 'stale' = meta exists but version
      // changed (or file tree differs), 'missing' = no .meta.json yet.
      const cacheStatus = await Promise.all(manifests.map(async m => {
        const metaPath = path.join(deepDir, deepSafeName(m.name, m.version), '.meta.json')
        try {
          const envelope = JSON.parse(await fs.readFile(metaPath, 'utf-8'))
          // Unwrap hash envelope (new format) or use raw (legacy format).
          const meta = (envelope?.hash !== undefined)
            ? unwrapVerified(META_HASH_SEED, envelope, metaPath)
            : envelope
          if (!meta) return 'stale'
          const stateOk = meta.state === 'fetched' || meta.state === 'scanned'
          return (stateOk && meta.fetchVersion === DEEP_FETCH_VERSION) ? 'valid' : 'stale'
        } catch {
          return 'missing'
        }
      }))

      // Discovery pass: only non-valid packages (new deps that might add more candidates).
      // Reverification pass: all packages in execution order (non-valid first for fail-fast).
      const fetchQueue = onlyMissing
        ? manifests.filter((_, i) => cacheStatus[i] !== 'valid')
        : [
          ...manifests.filter((_, i) => cacheStatus[i] !== 'valid'),
          ...manifests.filter((_, i) => cacheStatus[i] === 'valid'),
        ]
      if (fetchQueue.length === 0) return

      const nValid = cacheStatus.filter(s => s === 'valid').length
      const nStale = cacheStatus.filter(s => s === 'stale').length
      const nMissing = cacheStatus.filter(s => s === 'missing').length
      const cacheParts = []
      if (nValid > 0) cacheParts.push(`${nValid} cached`)
      if (nStale > 0) {
        // When cache is invalidated, lump missing in — both will be re-fetched
        const nRefetch = nStale + nMissing
        cacheParts.push(`${nRefetch} cache invalidated — re-fetching`)
      } else if (nMissing > 0) {
        cacheParts.push(`${nMissing} new`)
      }
      const cacheNote = cacheParts.length > 0 ? cacheParts.join(', ') : (onlyMissing ? 'all cached — nothing to fetch' : 'all cached')
      const passLabel = onlyMissing ? 'DeepFetch (discovery)' : 'DeepFetch (reverify)'

      const inStore = new Set(manifests.map(m => `${m.name}@${m.version}`))
      await savePackageCache(resumeCachePath, manifests, seen, finalDiscoveryState, candidates, failedFetches, changesStartSeq)
      process.stderr.write(`\n  ${passLabel}: ${fetchQueue.length} packages (${cacheNote})...\n`)
      let dfFetched = 0
      let isCheckpointing = false  // guard against concurrent checkpoint writes
      const fileLimit = makeLimiter(5)

      const checkpoint = async () => {
        if (isCheckpointing) return  // a save is already in-flight — skip, state will be captured by the next one
        isCheckpointing = true
        try {
          await Promise.all([
            savePackageCache(resumeCachePath, manifests, seen, finalDiscoveryState, candidates, failedFetches, changesStartSeq),
            savePackageCache(pkgPath, manifests, seen, finalDiscoveryState, [], failedFetches, lastChangesSeq),
          ])
        } finally {
          isCheckpointing = false
        }
      }

      const deepFetchOpts = nStale > 0 ? { quietTreeWarning: true } : {}

      const worker = async (workerIndex) => {
        await sleep(workerIndex * MANIFEST_DELAY_MS)
        while (fetchQueue.length > 0) {
          const manifest = fetchQueue.shift()
          if (!manifest) break
          await sleep(MANIFEST_DELAY_MS)
          process.stderr.write(`    scanning ${manifest.name}@${manifest.version}...\n`)
          const { fetchedFiles, bareFollows, resolvedFollows, fromCache } =
            await deepFetchPackage(manifest, deepDir, fileLimit, deepFetchOpts)
          deepFetchedFiles.set(`${manifest.name}@${manifest.version}`, fetchedFiles || [])

          // Resolve bare follows → stage as versioned candidates.
          // Always run regardless of fromCache: if a previous run was interrupted
          // after file-fetch but before the checkpoint saved these candidates, a
          // cached package would otherwise permanently lose its discovered deps.
          // resolvedFollows (cached in meta) lets us skip the HTTP round-trips when
          // the resolution has already been done and stored.
          const followsToStage = resolvedFollows
            // Fast-path: meta already has resolved name@version list — no HTTP needed.
            // Still filter for validity: old meta may contain names that fail the
            // current isValidNpmPackageName check (e.g. hostname-like strings).
            ? resolvedFollows.filter(key => {
              const at = key.lastIndexOf('@')
              if (at <= 0) return false
              const name = key.slice(0, at)
              return isValidNpmPackageName(name) && !NODE_BUILTIN_MODULES.has(name) &&
                !inStore.has(key) && !seen.has(key)
            })
            // Slow-path: resolve each bare follow via unpkg to get the concrete version.
            : await (async () => {
              const resolved = []
              await Promise.all((bareFollows || []).map(async ({ name, versionSpec }) => {
                if (NODE_BUILTIN_MODULES.has(name) || !isValidNpmPackageName(name)) return
                const enc = name.replace(/\//g, '%2F')
                const suffix = versionSpec ? `@${encodeURIComponent(versionSpec)}` : ''
                const buf = await fileLimit(() => fetchRaw(`https://unpkg.com/${enc}${suffix}/package.json`))
                if (!buf) return
                let ver
                try { ver = JSON.parse(buf.toString('utf8')).version } catch { return }
                if (ver) resolved.push(`${name}@${ver}`)
              }))
              // Persist resolved list so future cache-hits skip the HTTP calls.
              if (resolved.length > 0) {
                const pkgCacheDir = path.join(deepDir, deepSafeName(manifest.name, manifest.version))
                const metaPath = path.join(pkgCacheDir, '.meta.json')
                try {
                  const envelope = JSON.parse(await fs.readFile(metaPath, 'utf-8'))
                  const meta = (envelope?.hash !== undefined)
                    ? unwrapVerified(META_HASH_SEED, envelope, metaPath)
                    : envelope
                  if (meta) {
                    meta.resolvedFollows = resolved
                    await fs.writeFile(metaPath, JSON.stringify(wrapWithHash(META_HASH_SEED, meta), null, 2) + '\n')
                  }
                } catch { /* non-critical — will re-resolve next run */ }
              }
              return resolved.filter(key => !inStore.has(key) && !seen.has(key))
            })()

          for (const key of followsToStage) {
            // .has() + .add() are synchronous — safe between awaits in single-threaded JS
            if (!inStore.has(key) && !seen.has(key)) {
              inStore.add(key)
              seen.add(key)
              candidates.push(key)
              deepNewPkgs++
              process.stderr.write(`      + discovered ${key}\n`)
            }
          }

          dfFetched++
          if (dfFetched % DRAIN_CHECKPOINT_EVERY === 0) {
            process.stderr.write(`    [${dfFetched}] processed\n`)
            await checkpoint()
          }
        }
      }

      await Promise.all(Array.from({ length: MANIFEST_CONCURRENCY }, (_, i) => worker(i)))

      process.stderr.write(`    ✓ ${dfFetched} packages processed` +
        (candidates.length > 0 ? `, ${candidates.length} new candidates queued` : ', no new candidates') + '\n')
      await checkpoint()  // final save — always runs (isCheckpointing=false at this point)
      process.stderr.write(`    checkpoint saved\n\n`)

      // ── DeepScan mode ─────────────────────────────────────────────────────
      // Run indicator scan on already-fetched packages (reads from cache).
      // Must be called after drain(DeepFetch) so files are on disk.
    } else if (mode === DrainMode.DeepScan) {
      const dsQueue = [...manifests]
      const startCount = dsQueue.length
      if (startCount === 0) return
      await savePackageCache(resumeCachePath, manifests, seen, finalDiscoveryState, candidates, failedFetches, changesStartSeq)
      process.stderr.write(`\n  DeepScan: checking ${startCount} packages against ${INDICATOR_COUNT} indicators...\n`)
      let dsFetched = 0

      const worker = async (workerIndex) => {
        await sleep(workerIndex * MANIFEST_DELAY_MS)
        while (true) {
          const manifest = dsQueue.shift()
          if (!manifest) break
          await sleep(MANIFEST_DELAY_MS)
          process.stderr.write(`    checking ${manifest.name}@${manifest.version}...\n`)
          const { results, referencedFiles, fromCache } =
            await deepAnalyzePackage(manifest, deepDir)
          deepResults.set(manifest.name, results)
          deepRefFiles.set(manifest.name, referencedFiles || [])
          const hitCount = results?.length ?? 0
          const cacheTag = fromCache ? ' [cached]' : ''
          const countTag = hitCount > 0 ? ` — ${hitCount} indicator(s)` : ' — 0 indicators'
          process.stderr.write(`    ${manifest.name}@${manifest.version}${countTag}${cacheTag}\n`)
          for (const r of (results || [])) {
            const signals = r.signals?.length ? ` [${r.signals.join(', ')}]` : ''
            process.stderr.write(`      ✓ ${r.indicatorFile} — ${r.label}${signals}\n`)
          }
          dsFetched++
          if (dsFetched % DRAIN_CHECKPOINT_EVERY === 0 || dsFetched === startCount) {
            process.stderr.write(`    [${dsFetched}/${startCount}] analyzed\n`)
          }
        }
      }

      await Promise.all(Array.from({ length: MANIFEST_CONCURRENCY }, (_, i) => worker(i)))
      process.stderr.write(`    ✓ ${dsFetched} packages analyzed\n\n`)

      // ── Downloads mode ─────────────────────────────────────────────────────
      // Resolve weekly download counts for manifests that weren't discovered via
      // search pages (state:'lifecycle' means searchDownloads had no entry).
      // Non-scoped packages are batched up to 128 per request; scoped packages
      // use individual requests (the bulk endpoint doesn't support @scope/name).
      // Both paths use fetchJson which handles redirects and 429 back-off.
    } else if (mode === DrainMode.Downloads) {
      const BATCH_SIZE = 128
      const DOWNLOADS_TTL_MS = 7 * 24 * 60 * 60 * 1000  // 7 days
      const now = Date.now()
      const pending = manifests
        .map((m, idx) => ({ m, idx }))
        .filter(({ m }) => {
          if (m.state === 'lifecycle') return true  // never fetched
          if (m.state === 'ready') {
            // Re-fetch if no timestamp or timestamp is older than 7 days
            const fetchedAt = m.downloadsFetchedAt ? new Date(m.downloadsFetchedAt).getTime() : 0
            return (now - fetchedAt) > DOWNLOADS_TTL_MS
          }
          return false
        })

      if (pending.length === 0) return

      const nNew = pending.filter(({ m }) => m.state === 'lifecycle').length
      const nStale = pending.length - nNew
      const dlNote = [
        nNew > 0 ? `${nNew} new` : '',
        nStale > 0 ? `${nStale} stale (>7d)` : '',
      ].filter(Boolean).join(', ')
      process.stderr.write(`\n  Downloads: resolving counts for ${pending.length} packages (${dlNote})...\n`)

      const nonScoped = pending.filter(({ m }) => !m.name.startsWith('@'))
      const scoped = pending.filter(({ m }) => m.name.startsWith('@'))
      let dlResolved = 0

      // Non-scoped: batch up to 128 per request, delay between batches
      const nonScopedBatches = Math.ceil(nonScoped.length / BATCH_SIZE)
      for (let bi = 0; bi < nonScopedBatches; bi++) {
        if (bi > 0) await sleep(MANIFEST_DELAY_MS)
        const batch = nonScoped.slice(bi * BATCH_SIZE, (bi + 1) * BATCH_SIZE)
        const names = batch.map(({ m }) => encodeURIComponent(m.name)).join(',')
        try {
          const dl = await fetchJson(`https://api.npmjs.org/downloads/point/last-week/${names}`)
          if (dl && typeof dl === 'object') {
            for (const { m, idx } of batch) {
              // Single-name response is flat ({downloads:N}); multi-name is nested ({name:{downloads:N}}).
              const entry = batch.length === 1 ? dl : dl[m.name]
              if (typeof entry?.downloads === 'number') {
                manifests[idx].weeklyDownloads = entry.downloads
                manifests[idx].state = 'ready'
                manifests[idx].downloadsFetchedAt = new Date().toISOString()
                dlResolved++
              }
            }
          }
        } catch { /* non-critical — leave as lifecycle/0 */ }
        if ((bi + 1) % 10 === 0 || bi + 1 === nonScopedBatches) {
          process.stderr.write(`    batch ${bi + 1}/${nonScopedBatches} (${dlResolved} resolved so far)\n`)
          await Promise.all([
            savePackageCache(resumeCachePath, manifests, seen, finalDiscoveryState, candidates, failedFetches, changesStartSeq),
            savePackageCache(pkgPath, manifests, seen, finalDiscoveryState, [], failedFetches, lastChangesSeq),
          ])
        }
      }

      // Scoped: one per request, serialized with a longer delay to avoid 429
      // (api.npmjs.org rate-limits individual scoped lookups more aggressively
      // than bulk non-scoped batches)
      let scopedCheckpointGuard = false
      let scopedSinceCheckpoint = 0
      const SCOPED_DELAY_MS = 500  // one scoped request every 500ms
      if (scoped.length > 0) {
        for (const item of scoped) {
          await sleep(SCOPED_DELAY_MS)
          try {
            const enc = encodeURIComponent(item.m.name)
            const dl = await fetchJson(`https://api.npmjs.org/downloads/point/last-week/${enc}`)
            if (typeof dl?.downloads === 'number') {
              manifests[item.idx].weeklyDownloads = dl.downloads
              manifests[item.idx].state = 'ready'
              manifests[item.idx].downloadsFetchedAt = new Date().toISOString()
              dlResolved++
              scopedSinceCheckpoint++
            }
          } catch { /* non-critical */ }
          if (scopedSinceCheckpoint >= DRAIN_CHECKPOINT_EVERY && !scopedCheckpointGuard) {
            scopedCheckpointGuard = true
            scopedSinceCheckpoint = 0
            process.stderr.write(`    scoped: ${dlResolved} resolved so far\n`)
            await Promise.all([
              savePackageCache(resumeCachePath, manifests, seen, finalDiscoveryState, candidates, failedFetches, changesStartSeq),
              savePackageCache(pkgPath, manifests, seen, finalDiscoveryState, [], failedFetches, lastChangesSeq),
            ])
            scopedCheckpointGuard = false
          }
        }
      }

      process.stderr.write(`    ✓ resolved ${dlResolved}/${pending.length} download counts\n`)
      await Promise.all([
        savePackageCache(resumeCachePath, manifests, seen, finalDiscoveryState, candidates, failedFetches, changesStartSeq),
        savePackageCache(pkgPath, manifests, seen, finalDiscoveryState, [], failedFetches, lastChangesSeq),
      ])
    }
  }

  // Drain any candidates left pending from a previous interrupted run before searching more.
  if (candidates.length > 0 && !done) {
    const pendingCount = loadedCandidates.length
    const parts = []
    if (pendingCount > 0) parts.push(`${pendingCount} pending from previous run`)
    if (versionRecheckCount > 0) parts.push(`${versionRecheckCount.toLocaleString()} version re-checks`)
    const note = parts.length > 0 ? ` (${parts.join(', ')})` : ''
    process.stderr.write(`Step 3.25/${deepMode ? 5 : 4}: Processing ${candidates.length.toLocaleString()} candidates${note}...\n`)
    await drain(DrainMode.Candidates)
    process.stderr.write('\n')
  }

  while (!done || !hasSearched) {
    hasSearched = true
    const newAtPassStart = manifests.length  // detect a pass with no new lifecycle packages

    // Track whether this pass has executed at least one query (for the one-search guarantee).
    let passQueried = false
    for (let qi = passStartIndex; qi < DISCOVERY_QUERIES.length && (!done || !passQueried); qi++) {
      passQueried = true
      const query = DISCOVERY_QUERIES[qi]
      if (!query) {
        process.stderr.write(`  ⚠️  skipping undefined/null query at index ${qi} — run --reset if this persists\n`)
        continue
      }

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
        const textParam = encodeURIComponent(query)
        const url =
          `https://registry.npmjs.org/-/v1/search` +
          `?text=${textParam}&popularity=1.0&quality=0.0&maintenance=0.0` +
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
              savePackageCache(resumeCachePath, manifests, seen, { queryOrder: DISCOVERY_QUERIES, queryIndex: qi, queryFrom: from, keywordCursors }, candidates, new Set(), changesStartSeq),
              savePackageCache(pkgPath, manifests, seen, { keywordCursors }, [], new Set(), lastChangesSeq),
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
        await savePackageCache(resumeCachePath, manifests, seen, { queryOrder: DISCOVERY_QUERIES, queryIndex: qi, queryFrom: from, keywordCursors }, candidates, new Set(), changesStartSeq)
        process.stderr.write(`                        \r`)  // 24 spaces — clears full "    saving checkpoint..."

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
        savePackageCache(resumeCachePath, manifests, seen, nextState, candidates, new Set(), changesStartSeq),
        savePackageCache(pkgPath, manifests, seen, nextState, [], new Set(), lastChangesSeq),
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
  // Step 4/5 (--deep only): Selective file fetch per package (NOT whole-package
  // download), then run the full production scanner stack.
  //
  // Fetched per package:
  //   • Indicator files (binding.gyp, Cargo.toml, …) by exact name.
  //   • JS files named in lifecycle scripts + their require() deps (BFS, depth-limited).
  // Results are cached by name@version in deepDir so re-runs are instant.
  // ---------------------------------------------------------------------------
  if (deepMode) {
    process.stderr.write('Step 4/5: Deep scanning packages via unpkg...\n')
    await fs.mkdir(deepDir, { recursive: true })

    // ── Deep-scan orchestration ────────────────────────────────────────────
    //
    // Phase 1 — Initial full fetch (all packages):
    //   Walk every manifest cache.  Fetch missing/stale files, collect
    //   cross-package require()/import deps as new candidates.
    //
    // Phase 2 — Targeted BFS (only newly discovered packages):
    //   Drain new candidates into manifests, then deep-fetch only those new
    //   arrivals (their caches are all missing).  Repeat until stable.
    //   We already verified the original 6000+ packages in phase 1 — no need
    //   to re-walk them every BFS round.
    //
    // Phase 3 — Final reverification (only when phase 2 added packages):
    //   If discovery added new packages, run one more full fetch to confirm
    //   every manifest (old + new) has a valid cache before the scan.
    //   Skipped when phase 1 discovered nothing — it already verified all.
    //
    // Phase 4 — DeepScan:
    //   Run indicator scan on cached files.
    // ──────────────────────────────────────────────────────────────────────

    // Phase 1: full fetch
    let deepPass = 1
    process.stderr.write(`  ├─ pass ${deepPass} (initial full fetch): all ${manifests.length} packages...\n`)
    await drain(DrainMode.DeepFetch)  // onlyMissing=false → all packages

    // Phase 2: BFS on only the newly discovered packages
    let discoveredAny = candidates.length > 0
    while (candidates.length > 0) {
      process.stderr.write(`  ├─ draining ${candidates.length} discovered packages...\n`)
      await drain(DrainMode.Candidates)
      deepPass++
      process.stderr.write(`  ├─ pass ${deepPass} (discovered only): ${candidates.length === 0 ? 'none queued yet' : `${manifests.length} total, fetching newly added`}...\n`)
      await drain(DrainMode.DeepFetch, { onlyMissing: true })
    }

    // Phase 3: final reverification (only if BFS added packages)
    if (discoveredAny) {
      process.stderr.write(`  ├─ reverify: full fetch (${manifests.length} packages — confirming all deps cached)...\n`)
      await drain(DrainMode.DeepFetch)
    }

    process.stderr.write('  └─ scanning indicators...\n')

    // Prune orphaned deep-cache dirs — packages no longer in the manifest list.
    // All current packages are fully fetched at this point, so it's safe to delete.
    const expectedDirs = new Set(manifests.map(m => deepSafeName(m.name, m.version)))
    try {
      const allDirs = await fs.readdir(deepDir, { withFileTypes: true })
      const orphans = allDirs.filter(e => e.isDirectory() && !expectedDirs.has(e.name))
      if (orphans.length > 0) {
        process.stderr.write(`  🧹 pruning ${orphans.length} orphaned deep-cache ${orphans.length === 1 ? 'entry' : 'entries'}...\n`)
        await Promise.all(orphans.map(e => rmReadOnly(path.join(deepDir, e.name))))
      }
    } catch (err) {
      process.stderr.write(`  Warning: prune step failed: ${err.message}\n`)
    }

    await drain(DrainMode.DeepScan)
  }

  // Resolve download counts for packages discovered outside of search pages
  // (deep-discovered deps, --add packages, scoped peer expansions).
  await drain(DrainMode.Downloads)

  // Save final manifests to permanent store.  discoveryState carries only
  // keywordCursors (no resume position) so the next run continues forward
  // from the last page reached for each keyword, skipping already-walked pages.
  await savePackageCache(pkgPath, manifests, seen, { keywordCursors }, [], new Set(), lastChangesSeq)
  process.stderr.write(`  ✓ manifests saved to ${pkgPath}\n\n`)
  await fs.unlink(resumeCachePath).catch(() => { })

  const analyzeStep = deepMode ? '5/5' : '4/4'
  process.stderr.write(`Step ${analyzeStep}: Analyzing...\n`)

  // indicatorFile → [{name, version, weeklyDownloads, signals, label?}]
  // Signals come from the actual scan results (deep mode) or registry defaults (non-deep).
  const categorized = {}
  const uncategorized = [] // packages with build signals but no definition match
  const lifecycleOnly = [] // packages with lifecycle scripts but no build hint detected

  // token → { packages: string[], totalDownloads: number }
  const gapTokens = {}

  for (const manifest of manifests) {
    const lc = extractLifecycleScripts(manifest.scripts)

    // --deep: use production scanner results (keyed by name@version in cache)
    // Fall back to command-pattern matching when deep results aren't available.
    const deepScan = deepResults.get(manifest.name)
    const deepRefs = deepRefFiles.get(manifest.name) || []
    const deepFetched = deepFetchedFiles.get(`${manifest.name}@${manifest.version}`) || []

    // Collect classified URLs from the deep scan (all files' url lists).
    // entry.urls is [{url, classification}]; older cached entries may be strings.
    const scannedUrls = deepRefs.flatMap(f => (f.urls || []).map(u =>
      typeof u === 'string' ? { url: u, classification: classifyUrl(u) } : u
    ))

    if (deepScan && deepScan.length > 0) {
      // Deep mode: use cached investigation results — signals/label reflect registry at scan time.
      for (const r of deepScan) {
        if (!categorized[r.indicatorFile]) categorized[r.indicatorFile] = []
        categorized[r.indicatorFile].push({
          name: manifest.name,
          version: manifest.version,
          weeklyDownloads: manifest.weeklyDownloads,
          label: r.label,
          signals: r.signals || [],
        })
      }
      continue
    }

    const matches = deepScan
      ? [] // deep scan ran but found nothing — fall through to uncategorized
      : matchExistingDefinitions(lc, manifest)

    if (matches.length > 0) {
      // Non-deep: command-pattern match — use current registry signals/label as best approximation.
      for (const m of matches) {
        if (!categorized[m]) categorized[m] = []
        const def = INDICATOR_REGISTRY[m]
        categorized[m].push({
          name: manifest.name,
          version: manifest.version,
          weeklyDownloads: manifest.weeklyDownloads,
          label: def?.label || m,
          signals: def?.signals?.onFound || [],
        })
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
    if (!hasBuildHint(manifest.scripts || {}, deepRefs, undefined, allDeps)) {
      lifecycleOnly.push({
        name: manifest.name,
        version: manifest.version,
        weeklyDownloads: manifest.weeklyDownloads,
        lifecycleScripts: lc,
        commandTokens: extractCommandTokens(lc),
      })
      continue
    }

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

  // Serialize a RegExp to a JSON-safe object so AI readers can see the exact
  // pattern that drives detection.
  function serializeRegex(re) {
    if (!(re instanceof RegExp)) return String(re)
    return { source: re.source, flags: re.flags }
  }

  // Serialize one indicator definition completely — all patterns, scanner steps,
  // and signal names — so the AI has the full picture from the JSON alone.
  function serializeIndicatorDef(def) {
    const out = {
      label: def.label,
      detect: {
        commandPatterns: (def.detect.commandPatterns || []).map(serializeRegex),
      },
      signals: {
        onFound: def.signals.onFound || [],
        onWarning: def.signals.onWarning || [],
      },
    }
    // Optional trigger flags
    for (const flag of [
      'triggeredByNativeBuildSignal',
      'triggeredByBinaryDownloadSignal',
      'triggeredByRuntimeInstallerSignal',
      'triggeredByExternalUrlSignal',
      'triggeredByMakesExecutableSignal',
      'triggeredByObfuscationPatternSignal',
      'triggeredByDynamicRequireSignal',
    ]) {
      if (def.detect[flag]) out.detect[flag] = true
    }
    // Scanner
    if (!def.scanner || def.scanner === 'none') {
      out.scanner = 'none'
    } else if (def.scanner === 'gyp') {
      out.scanner = 'gyp'
    } else if (def.scanner?.type === 'generic') {
      out.scanner = {
        type: 'generic',
        steps: (def.scanner.steps || []).map(step => {
          const s = { type: step.type }
          if (step.pattern) s.pattern = serializeRegex(step.pattern)
          if (step.group != null) s.group = step.group
          if (step.label) s.label = step.label
          if (step.presence) s.presence = step.presence
          if (step.signal) s.signal = step.signal
          if (step.globPattern != null) s.globPattern = step.globPattern
          if (step.maxDisplay != null) s.maxDisplay = step.maxDisplay
          return s
        }),
      }
    }
    return out
  }



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

  const matchedNames = new Set(Object.values(categorized).flatMap(pkgs => pkgs.map(p => p.name)))
  const matchedCount = matchedNames.size
  const noBuildHint = lifecycleOnly.length

  const output = {
    // ── AI INSTRUCTIONS ─────────────────────────────────────────────────────
    // This block is intentionally first so any AI that opens this file sees it
    // immediately.  Do not move it.
    $ai: {
      role: 'You are an expert in the npm ecosystem, native Node.js addon build tooling, supply-chain security, and the structure of indicator-definitions.js in the npm/cli repository.',
      thisFileIs: [
        'A dataset generated by scripts/build-indicator-suggestions.js.',
        'It scans popular npm packages for lifecycle scripts and compares them against',
        'the INDICATOR_REGISTRY in lib/utils/indicator-definitions.js.',
        'Your job is to review the data below and propose concrete improvements to that file.',
      ].join(' '),
      howToReadThisFile: 'The file is wrapped in an integrity envelope: { hash, data }. The actual content lives in the "data" field. Every section inside data (meta, coverage, existingDefinitionCoverage, uncategorizedPackages, lifecycleOnlyPackages, commandPatternGaps) has a "description" field that explains what the section contains and how to interpret it, and a "data" field with the actual content.  Read the description first, then inspect data.',
      sourceFile: 'lib/utils/indicator-definitions.js',
      tasks: [
        {
          priority: 1,
          task: 'Review commandPatternGaps.data where frequency >= 3 OR weeklyDownloadTotal >= 50000.',
          action: 'For each: decide whether the token warrants a NEW indicator entry (new build tool not yet covered) or just an additional commandPattern on an EXISTING entry.  Ignore tokens that are generic JS keywords (const, require, stdio, inherit) or non-build tools (tsc, oclif, lint, rimraf).',
        },
        {
          priority: 2,
          task: 'Review uncategorizedPackages.data sorted by weeklyDownloads descending.',
          action: 'For each: examine lifecycleScripts, commandTokens, detectedSignals, and inferredIndicatorFiles.  Propose a new INDICATOR_REGISTRY entry OR explain why it should not be added.  Focus on packages with weeklyDownloads > 10000.',
        },
        {
          priority: 3,
          task: 'Review existingDefinitionCoverage.data entries with low matchedCount.',
          action: 'Propose additional commandPatterns that would match real packages listed in the uncategorized or gap sections.',
        },
      ],
      outputFormat: {
        forNewIndicatorEntry: {
          file: '<the filename used as the registry key, e.g. "Gruntfile.js">',
          label: '<short human-readable label>',
          commandPatterns: ['<regex source strings — will be compiled with new RegExp(...)>'],
          signals: { onFound: ['<signal name>'], onWarning: [] },
          scannerSteps: [
            '{ type: "regex", pattern: "...", group: 1, label: "..." }',
            '{ type: "regex-all", pattern: "...", group: 1, label: "..." }',
            '{ type: "glob", pattern: "**/*.ext", label: "...", maxDisplay: 20 }',
            '{ type: "signal", pattern: "...", signal: "<signal-name>" }',
          ],
          addToNativeBuildCommandPattern: '<true if this tool compiles native code>',
          rationale: '<why this indicator is needed and what real packages triggered it>',
        },
        forExistingEntryUpdate: {
          existingKey: '<key in INDICATOR_REGISTRY to update>',
          addCommandPatterns: ['<new regex source strings>'],
          rationale: '<which packages would now be matched>',
        },
      },
      // Structured signal definitions: for each signal, its description and
      // which indicator files raise it. Gives the AI a complete bidirectional
      // picture: indicator→signals (via meta.registryDefinitions) and
      // signal→indicators (via raisedBy here).
      availableSignals: Object.fromEntries(
        Object.entries(SIGNAL_DESCRIPTIONS).map(([name, description]) => {
          const raisedBy = Object.entries(INDICATOR_REGISTRY)
            .filter(([, def]) => (def.signals.onFound || []).includes(name) ||
              (def.signals.onWarning || []).includes(name))
            .map(([file]) => file)
          return [name, { description, raisedBy }]
        })
      ),
    },

    meta: {
      description: 'Run metadata: when generated, registry size limit (topN), whether cross-package import following was enabled (deepScan), and the full indicator registry snapshot. registryDefinitions maps each indicator filename to its complete definition: label, detect (commandPatterns as {source,flags} objects, trigger flags), signals (onFound/onWarning), and scanner steps. See $ai.availableSignals for signal descriptions and the reverse mapping (signal → which indicators raise it).',
      data: {
        generatedAt: new Date().toISOString(),
        topN,
        deepScan: deepMode,
        // Full snapshot of the indicator registry at the time this file was written.
        // commandPatterns and scanner step patterns are serialized as {source, flags}
        // objects so AI can read and reproduce the exact detection logic.
        registryDefinitions: Object.fromEntries(
          Object.entries(INDICATOR_REGISTRY).map(([file, def]) => [file, serializeIndicatorDef(def)])
        ),
      },
    },

    coverage: {
      description: 'Aggregate counts for this run. totalScanned = registry pages fetched. uniqueNamesConsidered = distinct package names seen. withLifecycleScripts = had install/postinstall/etc. matchedByExistingDefinitions = covered by at least one indicator. uncategorizedBuildPackages = build signal present but no indicator matched. lifecycleOnlyNoBuildHint = lifecycle scripts with no build tool detected.',
      data: {
        totalScanned: scanned,
        uniqueNamesConsidered: seen.size,
        withLifecycleScripts: manifests.length,
        matchedByExistingDefinitions: matchedCount,
        uncategorizedBuildPackages: uncategorized.length,
        lifecycleOnlyNoBuildHint: noBuildHint,
      },
    },

    existingDefinitionCoverage: {
      description: 'Per-indicator match counts against real packages. Each entry is keyed by indicator filename with matchedCount and packages (sorted by weeklyDownloads desc). Each package entry includes name, version, weeklyDownloads, label, and signals. Deep mode: label+signals come from cached investigation results (scan-time registry). Non-deep mode: label+signals come from current registry definitions.',
      data: Object.fromEntries(
        Object.entries(categorized)
          .sort((a, b) => b[1].length - a[1].length)
          .map(([file, pkgs]) => [file, {
            matchedCount: pkgs.length,
            packages: pkgs
              .sort((a, b) => (b.weeklyDownloads || 0) - (a.weeklyDownloads || 0)),
          }])
      ),
    },

    uncategorizedPackages: {
      description: 'Packages that have a build signal (native compile, binary download, runtime-installer, etc.) but no existing indicator definition matched them. Each item has: name, version, weeklyDownloads, lifecycleScripts, buildDependencies, commandTokens, inferredIndicatorFiles, detectedSignals, suggestedSignal. Sorted by weeklyDownloads descending — highest-value gaps first.',
      data: uncategorized,
    },

    lifecycleOnlyPackages: {
      description: 'Packages with lifecycle scripts (install/postinstall/prepare/etc.) that did not trigger any build signal and were not matched by any indicator definition. Typically code-gen, patching, type stubs, or other non-native operations at install time. Each item has: name, version, weeklyDownloads, lifecycleScripts, commandTokens. Sorted by weeklyDownloads descending.',
      data: lifecycleOnly.sort((a, b) => (b.weeklyDownloads || 0) - (a.weeklyDownloads || 0)),
    },

    commandPatternGaps: {
      description: 'Command tokens that appear in multiple uncategorized build packages but are not covered by any existing commandPatterns entry. Each item has: token, frequency (package count), weeklyDownloadTotal, packages, suggestedCommandPattern. Sorted by frequency × downloads — entries with frequency >= 3 or weeklyDownloadTotal >= 50000 are highest priority.',
      data: commandPatternGaps,
    },
  }

  await fs.writeFile(outPath, JSON.stringify(wrapWithHash(OUTPUT_HASH_SEED, output), null, 2) + '\n', 'utf-8')

  process.stderr.write(`\n✅ Done!\n`)
  process.stderr.write(`   New this run:         ${newThisRun}\n`)
  if (alreadySeenSkips > 0) {
    const skipPct = scanned > 0 ? Math.round((alreadySeenSkips / (scanned + alreadySeenSkips)) * 100) : 0
    process.stderr.write(`   Already-seen skips:   ${alreadySeenSkips.toLocaleString()} (${skipPct}% of results were repeats)\n`)
  }
  if (deepNewPkgs > 0) {
    process.stderr.write(`   Found via deep scan:  ${deepNewPkgs} new packages added — discovered by following require()/import across package boundaries during file fetch\n`)
  }
  process.stderr.write(`   With lifecycle scripts: ${manifests.length} (of ${seen.size.toLocaleString()} total examined)\n`)
  process.stderr.write(`   Covered by existing indicator defs: ${matchedCount} (of ${manifests.length} with lifecycle scripts)\n`)
  process.stderr.write(`   Uncategorized builds: ${uncategorized.length} (have build hint, no matching indicator)\n`)
  process.stderr.write(`   Lifecycle-only (no build hint): ${noBuildHint} (postinstall/setup scripts, not native builders)\n`)
  process.stderr.write(`   Pattern gaps found:   ${commandPatternGaps.length}\n`)

  // Warn when indicator coverage of lifecycle-script packages is low.
  // Threshold: fewer than 30% of lifecycle-script packages matched an indicator.
  // Minimum sample: skip the warning for tiny runs (< 20 packages with lifecycle scripts)
  // because small samples produce noisy percentages that aren't actionable.
  const COVERAGE_MIN_SAMPLE = 20
  const coveragePct = manifests.length > 0
    ? Math.round((matchedCount / manifests.length) * 100)
    : 100
  if (coveragePct < 30 && manifests.length >= COVERAGE_MIN_SAMPLE) {
    process.stderr.write(
      `\n   ⚠️  Only ${coveragePct}% of lifecycle-script packages are covered by existing indicators` +
      ` (${matchedCount} of ${manifests.length}).\n` +
      `   Consider reviewing ${outPath} and indicator-definitions.js with an AI assistant:\n` +
      `   ask it to compare the uncategorizedPackages entries against the existing indicator\n` +
      `   registry and suggest new commandPatterns, signals, or indicator entries. Improvements\n` +
      `   affect both approve-scripts (production scanning) and this suggestion tool.\n`
    )
  } else if (coveragePct < 30) {
    process.stderr.write(
      `\n   ℹ️  Coverage appears low (${coveragePct}%) but sample is small (${manifests.length} packages` +
      ` with lifecycle scripts < ${COVERAGE_MIN_SAMPLE} minimum). Run with a larger --top value for a meaningful signal.\n`
    )
  }

  process.stderr.write(`\n   Written to: ${outPath}\n\n`)
}

main().catch(err => {
  process.stderr.write(`\nFatal: ${err.message}\n${err.stack}\n`)
  process.exit(1)
})
