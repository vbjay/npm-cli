'use strict'

const { unlinkSync } = require('fs')

const LOCK_HEARTBEAT_MS = 30_000
const LOCK_STALE_MS     = 90_000  // 3 missed heartbeats → stale

// Returns true when the OS reports the pid is alive (process exists).
function isPidAlive (pid) {
  if (!pid || typeof pid !== 'number') return false
  try { process.kill(pid, 0); return true } catch { return false }
}

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
      const isAlive = isPidAlive(lock.pid)
      if (age < LOCK_STALE_MS && isAlive) {
        process.stderr.write(`\n⛔  Already running (PID ${lock.pid}) with the same output path.\n`)
        process.stderr.write(`   Lock file: ${lockPath}\n`)
        process.stderr.write(`   Heartbeat is ${Math.round(age / 1000)}s old (stale after ${LOCK_STALE_MS / 1000}s).\n`)
        process.stderr.write(`   If that process is gone, delete the lock file and retry.\n\n`)
        process.exit(1)
      }
      if (isAlive) {
        // Stale heartbeat but process still alive — it hung. Kill it so we can take over.
        process.stderr.write(`⚠️  Stale lock (PID ${lock.pid}, heartbeat ${Math.round(age / 1000)}s ago) — killing hung process\n`)
        try { process.kill(lock.pid, 'SIGTERM') } catch {}
        // Give it 2s to exit gracefully, then SIGKILL
        const deadline = Date.now() + 2000
        while (isPidAlive(lock.pid) && Date.now() < deadline) { /* spin wait */ }
        if (isPidAlive(lock.pid)) {
          try { process.kill(lock.pid, 'SIGKILL') } catch {}
        }
      } else {
        process.stderr.write(`⚠️  Stale lock (PID ${lock.pid}, heartbeat ${Math.round(age / 1000)}s ago) — removing and continuing\n`)
      }
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

module.exports = { makeLockHelpers, isPidAlive }
