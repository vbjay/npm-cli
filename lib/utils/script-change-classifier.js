const npa = require('npm-package-arg')

// Compare a pending package node against the project's existing `allowScripts`
// policy to classify the nature of the change that caused this entry to appear
// in the unreviewed list.
//
// Returns:
//   {
//     status: 'new' | 'version-changed',
//     previousApprovedVersion: string | null,
//   }
//
// `'new'`             – no approved (`true`) entry for this package name exists
//                       in `allowScripts`. Denied (`false`) entries do not count
//                       as prior approvals.
// `'version-changed'` – an approved entry exists for the same name, but it does
//                       not cover the currently-installed version (e.g.
//                       `canvas@1.0.0` is approved but `canvas@1.0.1` is now
//                       installed and pending).
//
// NOTE: A third case — "same name, same version, but scripts changed since last
// approval" — cannot be detected here. If `canvas@1.0.0` is already in the
// policy, `isScriptAllowed` returns `true` and `collectUnreviewedScripts` skips
// it before the classifier is ever called. Detecting this case would require
// storing script content (or a hash) alongside the policy entry and comparing it
// at install time, which is a data-model change not yet implemented.
//
// The comparison only uses the name derived from `npa` so it handles both plain
// and scoped packages. Best-effort: if `npa` cannot parse a key, that key is
// skipped.
const classifyScriptChange = (node, allowScripts) => {
  const nodeName = (node.packageName || node.name || '').toLowerCase()
  if (!nodeName || !allowScripts || typeof allowScripts !== 'object') {
    return { status: 'new', previousApprovedVersion: null }
  }

  let previousApprovedVersion = null

  for (const [key, value] of Object.entries(allowScripts)) {
    let keyName
    try {
      const parsed = npa(key)
      keyName = (parsed.name || '').toLowerCase()
    } catch {
      // Unparseable key – skip.
      continue
    }

    if (keyName !== nodeName) {
      continue
    }

    if (value === false) {
      continue
    }

    if (value !== true) {
      continue
    }

    // value === true from here on
    let keyVersion = null
    try {
      const parsed = npa(key)
      if (parsed.type === 'version') {
        keyVersion = parsed.fetchSpec
      } else if (parsed.type === 'range' && parsed.rawSpec && parsed.rawSpec !== '*') {
        // e.g. "pkg@1.0.0 || 2.0.0" – rawSpec holds the full range string and is
        // used as-is for display purposes.
        keyVersion = parsed.rawSpec
      }
    } catch {
      /* istanbul ignore next: key already parsed above */
      continue
    }

    if (!keyVersion) {
      // Name-only approval covers all versions. A node that still reaches the
      // pending report is in a degenerate state, but it still has a prior
      // approval for this package name.
      return { status: 'version-changed', previousApprovedVersion: null }
    }

    const nodeVersion = node.version || null
    if (nodeVersion === keyVersion) {
      // Exact-version approval. This should normally prevent the node from
      // reaching the pending report, but if it does, it still has a prior
      // approval and should not be classified as new.
      return { status: 'version-changed', previousApprovedVersion: keyVersion }
    }
    // Pinned entry for a different version. Record the first approved version
    // encountered (the display value for "previously approved") then keep
    // scanning the remaining entries so deny entries are also detected.
    if (previousApprovedVersion === null) {
      previousApprovedVersion = keyVersion
    }
  }

  if (previousApprovedVersion !== null) {
    return { status: 'version-changed', previousApprovedVersion }
  }

  return { status: 'new', previousApprovedVersion: null }
}

module.exports = classifyScriptChange
