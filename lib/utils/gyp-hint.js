// Regex that matches a direct node-gyp or binding.gyp reference — the same
// pattern used by the 'native-build' signal in script-risk-scanner.js.
const GYP_RE = /\bnode-gyp\b|binding\.gyp/

// Returns true when there is evidence this package uses node-gyp:
//   1. A lifecycle script command directly mentions node-gyp or binding.gyp, OR
//   2. A file reachable from those scripts carries the 'native-build' signal.
// Only packages that pass this check are sent through scanGypFile so that
// the (relatively expensive) binding.gyp parse is not run for every package.
const hasGypHint = (scripts, referencedFiles) => {
  for (const cmd of Object.values(scripts)) {
    if (GYP_RE.test(cmd)) {
      return true
    }
  }
  for (const { signals } of referencedFiles) {
    if (Array.isArray(signals) && signals.includes('native-build')) {
      return true
    }
  }
  return false
}

module.exports = hasGypHint
