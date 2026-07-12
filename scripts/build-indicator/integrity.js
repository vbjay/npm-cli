'use strict'

const crypto = require('crypto')
const path = require('path')

// Seed strings distinguish each file type — a hash from one cannot validate another.
const CACHE_HASH_SEED  = 'npm-build-pkg-cache-v1'
const OUTPUT_HASH_SEED = 'npm-build-output-v1'
const META_HASH_SEED   = 'npm-build-deep-meta-v1'

function hashPayload (seed, dataObj) {
  const content = seed + '\x00' + JSON.stringify(dataObj)
  return 'sha256:' + crypto.createHash('sha256').update(content, 'utf8').digest('hex')
}

function wrapWithHash (seed, dataObj) {
  return { data: dataObj, hash: hashPayload(seed, dataObj) }
}

/** Returns the verified inner data object, or null if verification fails. */
function unwrapVerified (seed, envelope, filePath) {
  if (!envelope || typeof envelope !== 'object' || !envelope.hash || !envelope.data) return null
  const expected = hashPayload(seed, envelope.data)
  if (envelope.hash !== expected) {
    process.stderr.write(`  ⚠️  integrity check failed for ${path.basename(filePath)} — file may be corrupt or tampered\n`)
    return null
  }
  return envelope.data
}

module.exports = {
  CACHE_HASH_SEED,
  OUTPUT_HASH_SEED,
  META_HASH_SEED,
  hashPayload,
  wrapWithHash,
  unwrapVerified,
}
