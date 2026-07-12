const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')

// Parse a GYP-format file (a superset of JSON used by node-gyp).
// GYP files differ from strict JSON in four ways that are common in the wild:
//   1. `#` line comments (including mid-line)
//   2. Python-style multiline string continuations (`'\` at end of line)
//   3. Single-quoted strings (which may themselves contain double-quote chars,
//      e.g. the condition string `'OS=="win"'`)
//   4. Trailing commas inside arrays and objects
// node-gyp's own parseConfigGypi handles (1) and (2) but not (3) or (4).
// A naive global `'` → `"` substitution for (3) corrupts mixed-quote lines
// like `['OS=="win"', { … }]`, so we use a character-by-character tokenizer.
const parseGypContent = (raw) => {
  // Tokenise: walk the source character by character, converting
  // single-quoted strings to properly-escaped double-quoted JSON strings
  // while leaving already-valid double-quoted strings untouched.
  // Python-style multiline string continuations (`'\<newline>  '`) are handled
  // inline while scanning single-quoted strings so they cannot accidentally
  // match a `'` that appears inside a `#` line comment on the previous line.
  // `#` line comments (outside of strings) are stripped here too.
  let out = ''
  let i = 0
  while (i < raw.length) {
    const ch = raw[i]
    if (ch === "'") {
      // Consume a single-quoted string, escaping any embedded double quotes.
      let s = '"'
      i++
      while (i < raw.length && raw[i] !== "'") {
        if (raw[i] === '"') {
          s += '\\"'        // escape embedded double quote for JSON
        } else if (raw[i] === '\\' && raw[i + 1] === '\n') {
          // Python-style string continuation: `'\<newline>whitespace'`
          // Skip the backslash, newline, leading whitespace, and the opening
          // quote of the next segment so the two halves merge into one string.
          i += 2            // skip `\` and `\n`
          while (i < raw.length && (raw[i] === ' ' || raw[i] === '\t')) i++
          if (i < raw.length && raw[i] === "'") i++  // skip continuation `'`
          // `i` will be incremented at the bottom of the loop
        } else if (raw[i] === '\\') {
          // Copy the backslash and the next character as a unit.  The `|| ''`
          // branch is only taken when the backslash falls at the very end of
          // the source string (malformed/truncated GYP), so it is excluded
          // from coverage tracking.
          s += raw[i] + /* istanbul ignore next */ (raw[i + 1] || '')
          i++
        } else {
          s += raw[i]
        }
        i++
      }
      s += '"'
      out += s
      i++                   // skip closing `'`
    } else if (ch === '"') {
      // Copy a double-quoted string verbatim (it is already valid JSON).
      out += ch
      i++
      while (i < raw.length && raw[i] !== '"') {
        if (raw[i] === '\\') {
          // Copy the two-char escape sequence verbatim.  The `|| ''` branch is
          // only taken when the backslash falls at the very end of the source
          // string (malformed/truncated GYP), so it is excluded from coverage.
          out += raw[i] + /* istanbul ignore next */ (raw[i + 1] || '')
          i += 2
        } else {
          out += raw[i]
          i++
        }
      }
      /* istanbul ignore next: defensive guard for unterminated double-quoted string (malformed GYP) */
      out += raw[i] || ''   // closing `"`
      i++
    } else if (ch === '#') {
      // Skip a # comment to the end of the line (we are outside a quoted
      // string here, so this is a genuine GYP line comment, not a literal #).
      while (i < raw.length && raw[i] !== '\n') {
        i++
      }
      // The newline itself is not consumed; it will be copied on the next
      // iteration, preserving line structure for error messages.
    } else {
      out += ch
      i++
    }
  }

  // Strip trailing commas before a closing bracket or brace (invalid in
  // JSON but common in GYP files).
  out = out.replace(/,(\s*[}\]])/g, '$1')
  return JSON.parse(out)
}

// Recursively flatten condition branches so that sources/libraries/include_dirs
// nested inside a `"conditions"` block are still surfaced to the reviewer.
// GYP conditions have the shape: [ [condStr, trueObj, falseObj?], ... ]
const flattenConditions = (conditions) => {
  const merged = { sources: [], libraries: [], includeDirs: [] }
  if (!Array.isArray(conditions)) {
    return merged
  }
  for (const cond of conditions) {
    // Each entry: [conditionString, trueProps, optionalFalseProps]
    for (let i = 1; i < cond.length; i++) {
      const branch = cond[i]
      if (!branch || typeof branch !== 'object') {
        continue
      }
      if (Array.isArray(branch.sources)) {
        merged.sources.push(...branch.sources)
      }
      if (Array.isArray(branch.libraries)) {
        merged.libraries.push(...branch.libraries)
      }
      if (Array.isArray(branch.include_dirs)) {
        merged.includeDirs.push(...branch.include_dirs)
      }
      // Recurse into nested conditions within this branch.
      if (Array.isArray(branch.conditions)) {
        const nested = flattenConditions(branch.conditions)
        merged.sources.push(...nested.sources)
        merged.libraries.push(...nested.libraries)
        merged.includeDirs.push(...nested.includeDirs)
      }
    }
  }
  return merged
}

/**
 * Read and parse the `binding.gyp` file found in `packageDir`, using the
 * local `parseGypContent()` tokenizer/normaliser.  Note: this should
 * ideally delegate to node-gyp's own GYP-format parser so that comment
 * stripping and string-quoting normalisation match what node-gyp itself does.
 * However, there is a parsing gap found by this PR that must be resolved
 * first (see https://github.com/nodejs/node-gyp/issues/3333).  Once that issue is
 * fixed, the plan is to use gyp's tooling directly.
 *
 * Returns `null`  when there is no `binding.gyp` in `packageDir`.
 * Returns `{ sha256, targets, parseError }` otherwise:
 *   - sha256      {string}         hex SHA-256 of the raw file bytes
 *   - targets     {Array<Object>}  parsed target descriptors (may be empty)
 *   - parseError  {string|null}    set when the file could not be parsed
 *
 * Each target descriptor:
 *   { name, sources, libraries, includeDirs, hasConditions }
 */
const scanGypFile = async (packageDir) => {
  const gypPath = path.join(packageDir, 'binding.gyp')

  let rawBuf
  try {
    rawBuf = await fs.readFile(gypPath)
  } catch {
    return null
  }

  const sha256 = crypto.createHash('sha256').update(rawBuf).digest('hex')
  const raw = rawBuf.toString('utf8')

  let parsed
  try {
    parsed = parseGypContent(raw)
  } catch (err) {
    return { sha256, targets: [], parseError: err.message }
  }

  const targets = []
  for (const target of (Array.isArray(parsed.targets) ? parsed.targets : [])) {
    const condMerge = flattenConditions(target.conditions)
    targets.push({
      name: typeof target.target_name === 'string' ? target.target_name : '<unnamed>',
      sources: [
        ...(Array.isArray(target.sources) ? target.sources : []),
        ...condMerge.sources,
      ],
      libraries: [
        ...(Array.isArray(target.libraries) ? target.libraries : []),
        ...condMerge.libraries,
      ],
      includeDirs: [
        ...(Array.isArray(target.include_dirs) ? target.include_dirs : []),
        ...condMerge.includeDirs,
      ],
      hasConditions: Array.isArray(target.conditions) && target.conditions.length > 0,
    })
  }

  return { sha256, targets, parseError: null }
}

module.exports = scanGypFile
module.exports.flattenConditions = flattenConditions
module.exports.parseGypContent = parseGypContent
