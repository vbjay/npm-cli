'use strict'

const http  = require('http')
const https = require('https')
const path  = require('path')

const ROOT = path.resolve(__dirname, '..', '..')
const { version: PKG_VERSION } = require(path.join(ROOT, 'package.json'))
const USER_AGENT = `npm/${PKG_VERSION} npm-indicator-suggestions (https://github.com/npm/cli)`

// ---------------------------------------------------------------------------
// Misc utilities used throughout
// ---------------------------------------------------------------------------

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Lightweight semver comparator: returns true if versionB > versionA.
// Handles the common `major.minor.patch[-prerelease]` form used in npm.
// Pre-release suffixes (e.g. '-beta.1') sort lower than the bare release.
function semverGt (versionA, versionB) {
  const parse = v => {
    const [main, pre] = String(v || '0').split('-')
    const parts = main.split('.').map(n => parseInt(n, 10) || 0)
    while (parts.length < 3) parts.push(0)
    return { parts, pre: pre ?? null }
  }
  const a = parse(versionA)
  const b = parse(versionB)
  for (let i = 0; i < 3; i++) {
    if (b.parts[i] !== a.parts[i]) return b.parts[i] > a.parts[i]
  }
  // Equal numeric parts: release (no pre) > pre-release
  if (a.pre === null && b.pre !== null) return false
  if (a.pre !== null && b.pre === null) return true
  return false
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
//
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

// Fetch all package names that changed in the CouchDB _changes feed since
// a given sequence number.  Returns { names: Set<string>, lastSeq: number }.
// When sinceSeq is null (first run) returns { names: null, lastSeq } — null
// signals "no filtering; re-check everything".
//
// replicate.npmjs.com notes:
//   - Does NOT support include_docs=false or filter=_doc_ids — omit them
//   - The seq space matches update_seq from the root (~116M range)
//   - HTTP 400 for a stored seq means the feed tip was behind it at the time
//     of the request (replication lag); fall back to full re-check and re-seed
//     from update_seq so the next run starts from a fresh valid point
const CHANGES_BATCH = 2500
async function fetchChangedNames (sinceSeq) {
  if (sinceSeq === null) {
    // No stored seq — read the current update_seq from the root so the next
    // run can diff from here.  Return null names → full re-check this run.
    try {
      const info = await fetchJson('https://replicate.npmjs.com/')
      const lastSeq = info?.update_seq ?? null
      process.stderr.write(`  (first run — recorded changes seq ${lastSeq?.toLocaleString?.() ?? lastSeq}; next run will filter)\n`)
      return { names: null, lastSeq }
    } catch {
      return { names: null, lastSeq: null }
    }
  }

  const names = new Set()
  let seq = sinceSeq
  let pages = 0
  const seqStr = s => (typeof s === 'number' ? s.toLocaleString() : s)
  process.stderr.write(`  fetching registry changes since seq ${seqStr(sinceSeq)}...\n`)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let data
    try {
      data = await fetchJson(
        `https://replicate.npmjs.com/_changes?since=${seq}&limit=${CHANGES_BATCH}`
      )
    } catch (err) {
      if (err.statusCode === 400) {
        // 400 = stored seq is ahead of the replication tip (transient lag).
        // Re-seed from the current update_seq so next run starts fresh.
        process.stderr.write(`  ⚠️  _changes: seq ${seqStr(seq)} ahead of replication tip — re-seeding from current update_seq\n`)
        try {
          const info = await fetchJson('https://replicate.npmjs.com/')
          return { names: null, lastSeq: info?.update_seq ?? null }
        } catch {
          return { names: null, lastSeq: null }
        }
      }
      process.stderr.write(`  ⚠️  _changes fetch error: ${err.message} — falling back to full re-check\n`)
      return { names: null, lastSeq: sinceSeq }
    }
    if (!data || !Array.isArray(data.results)) break
    for (const r of data.results) {
      if (typeof r.id === 'string' && !r.id.startsWith('_design/')) names.add(r.id)
    }
    seq = data.last_seq ?? seq
    pages++
    if (data.results.length < CHANGES_BATCH) break  // last page
    if (pages % 10 === 0) {
      process.stderr.write(`    ${names.size.toLocaleString()} changed names so far (seq ${seqStr(seq)})...\n`)
    }
  }
  return { names, lastSeq: seq }
}

async function getPackageManifest (nameAtVersion) {
  // Support 'name@version' input (e.g. from --add react@17 or discovered manifests).
  // A leading '@' on scoped packages is not a version — only split on a '@' that comes
  // after at least one character following the last '/'.
  let name = nameAtVersion
  let versionTag = 'latest'
  const lastAt = nameAtVersion.lastIndexOf('@')
  if (lastAt > 0) {
    name = nameAtVersion.slice(0, lastAt)
    versionTag = nameAtVersion.slice(lastAt + 1) || 'latest'
  }
  const encoded = name.replace(/\//g, '%2F')
  const data = await fetchJson(`https://registry.npmjs.org/${encoded}/${versionTag}`)
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

module.exports = {
  USER_AGENT,
  sleep,
  semverGt,
  makeLimiter,
  CircuitOpenError,
  humanDuration,
  fetchRaw,
  fetchJson,
  fetchChangedNames,
  getPackageManifest,
}
