'use strict'

const fs   = require('fs/promises')
const path = require('path')
const { wrapWithHash, unwrapVerified, CACHE_HASH_SEED } = require('./integrity')

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
    const envelope = JSON.parse(await fs.readFile(filePath, 'utf-8'))

    // Detect wrapped format (new): { hash, data }
    // Fall back to unwrapped (legacy) if hash field absent.
    let raw = envelope
    if (envelope && typeof envelope === 'object' && envelope.hash !== undefined) {
      const verified = unwrapVerified(CACHE_HASH_SEED, envelope, filePath)
      if (!verified) {
        return { names: null, manifests: null, seen: null, discoveryState: null, pendingCandidates: [], lastChangesSeq: null }
      }
      raw = verified
    }

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
        lastChangesSeq: raw.lastChangesSeq || null,
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      process.stderr.write(`  Warning: could not read cache ${filePath}: ${err.message}\n`)
    }
  }
  return { names: null, manifests: null, seen: null, discoveryState: null, pendingCandidates: [], lastChangesSeq: null }
}

// Build snapshot synchronously before any await so concurrent Promise.all closures
// cannot produce a torn checkpoint.  State for each package is derived from which
// array it lives in (manifests = lifecycle|ready, candidates = candidate, rest = seen).
async function savePackageCache (filePath, manifests, seen, discoveryState, candidates = [], failedFetches = new Set(), lastChangesSeq = null) {
  const candidateSet = new Set(candidates)
  const lifecycleSet = new Set(manifests.map(m => m.name))

  // Non-lifecycle, non-candidate, non-failed names are "seen" — store compactly as strings.
  const seenOnlyNames = []
  for (const name of seen) {
    if (!lifecycleSet.has(name) && !candidateSet.has(name) && !failedFetches.has(name)) seenOnlyNames.push(name)
  }
  seenOnlyNames.sort()

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
      downloadsFetchedAt: m.downloadsFetchedAt || null,
    })
  }

  // Sort packages deterministically: by name then version so diffs are stable.
  packages.sort((a, b) => {
    const n = a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    if (n !== 0) return n
    const av = a.version || ''
    const bv = b.version || ''
    return av < bv ? -1 : av > bv ? 1 : 0
  })

  // Snapshot is fully built — now safe to yield for the file write.
  // Sanitize keywordCursors: strip any non-string key (e.g. the "undefined" string
  // that accumulates when a query was JavaScript undefined in a corrupted run).
  const cleanCursors = Object.fromEntries(
    Object.entries(discoveryState?.keywordCursors ?? {})
      .filter(([k]) => typeof k === 'string' && k !== 'undefined')
  )
  const data = {
    generatedAt: new Date().toISOString(),
    count: manifests.length,
    discoveryState: discoveryState ? { ...discoveryState, keywordCursors: cleanCursors } : discoveryState,
    lastChangesSeq: lastChangesSeq ?? null,
    seenOnlyNames,
    packages,
  }
  await fs.writeFile(filePath, JSON.stringify(wrapWithHash(CACHE_HASH_SEED, data), null, 2) + '\n', 'utf-8')
}

module.exports = { loadPackageCache, savePackageCache }
