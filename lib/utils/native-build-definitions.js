// Native-build indicator registry.
//
// Each entry describes ONE kind of native-build indicator:
//
//   Key: the indicator filename looked up in the package root.
//        The key is also the canonical "clue ID" — when the detector finds
//        this file on disk, it does a single registry lookup to know exactly
//        which scanner to instantiate.  No iteration required.
//
//   detect.commandPatterns
//        Cheap, zero-I/O pre-checks.  If ANY lifecycle script command matches,
//        the detector marks this indicator as "potentially present" and includes
//        it in the parallel disk-existence check.  A match here does NOT skip
//        the disk check — the indicator file still has to exist before its
//        scanner is created.
//
//   detect.triggeredByNativeBuildSignal
//        When true, the detector also marks this indicator as "check disk" when
//        a previously-scanned file carries the 'native-build' signal.  Used for
//        cases where a JS file loads node-gyp lazily rather than the command
//        string mentioning it directly.
//
//   signals.onFound   — emitted whenever the indicator file is found on disk.
//   signals.onWarning — emitted by the scanner when it finds something worth
//                       extra scrutiny (e.g. platform-specific GYP conditions).
//
//   scanner
//        Either the string 'gyp' (use the built-in GYP format parser) or a
//        generic descriptor:  { type: 'generic', steps: [...] }
//
//        Generic step types:
//          { type: 'regex',     pattern, group, label }
//            — first capture of pattern (single value).
//          { type: 'regex-all', pattern, group, label, presence? }
//            — all unique captures; if presence:true, emits 'yes'/'no' instead.
//          { type: 'glob',      pattern, label, maxDisplay? }
//            — files in the package directory matching pattern (POSIX paths).
//
// Adding support for a new native-build tool:
//   1. Add one entry to INDICATOR_REGISTRY below.
//   2. Add its command patterns to NATIVE_BUILD_COMMAND_PATTERN at the bottom.
//   That's it — no scanner engine code changes needed unless the file format
//   is too exotic for the generic step types.

const INDICATOR_REGISTRY = {
  'binding.gyp': {
    label: 'GYP build descriptor',
    detect: {
      commandPatterns: [
        /\bnode-gyp\b/,
        /binding\.gyp/,
        /\bprebuild-install\b/,
        /\bprebuildify\b/,
        /\bcmake-js\b/,
        /\bprebuild\b/,
      ],
      triggeredByNativeBuildSignal: true,
    },
    signals: {
      onFound: ['native-build'],
      onWarning: ['gyp-conditions'],  // emitted when targets have platform conditions
    },
    scanner: 'gyp',
  },

  'Cargo.toml': {
    label: 'Rust native addon (napi-rs / neon)',
    detect: {
      commandPatterns: [
        /\bnapi\s+build\b/,
        /\bneon\s+build\b/,
        /\bcargo\s+build\b/,
      ],
      triggeredByNativeBuildSignal: false,
    },
    signals: {
      onFound: ['native-build', 'rust-native'],
      onWarning: [],
    },
    scanner: {
      type: 'generic',
      steps: [
        { type: 'regex',     pattern: /^name\s*=\s*"([^"]+)"/m,    group: 1, label: 'Crate name' },
        { type: 'regex',     pattern: /^version\s*=\s*"([^"]+)"/m, group: 1, label: 'Crate version' },
        { type: 'regex-all',
          pattern: /^\[(?:build-)?dependencies\]/m,
          group: 0, label: 'Has build dependencies', presence: true },
        { type: 'glob', pattern: 'src/**/*.rs', label: 'Rust source files', maxDisplay: 20 },
      ],
    },
  },

  'CMakeLists.txt': {
    label: 'CMake build descriptor',
    detect: {
      commandPatterns: [
        /\bcmake-js\b/,
        /\bcmake\b/,
      ],
      triggeredByNativeBuildSignal: false,
    },
    signals: {
      onFound: ['native-build'],
      onWarning: [],
    },
    scanner: {
      type: 'generic',
      steps: [
        { type: 'regex-all', pattern: /\badd_library\s*\(\s*(\S+)/g,    group: 1, label: 'Native libraries' },
        { type: 'regex-all', pattern: /\badd_executable\s*\(\s*(\S+)/g, group: 1, label: 'Executables' },
        { type: 'glob', pattern: '**/*.{c,cc,cpp,cxx}', label: 'C/C++ source files', maxDisplay: 30 },
      ],
    },
  },
}

// Consolidated command-pattern regexp used by script-risk-scanner.js for the
// 'native-build' signal.  Must stay in sync with the commandPatterns in the
// INDICATOR_REGISTRY entries above, plus any patterns not backed by an
// indicator file (e.g. node-pre-gyp, node-gyp-build).
const NATIVE_BUILD_COMMAND_PATTERN =
  /\bnode-gyp\b|binding\.gyp|\bnode-pre-gyp\b|\bprebuild-install\b|\bprebuildify\b|\bcmake-js\b|\bnapi\s+build\b|\bneon\s+build\b|\bprebuild\b/

module.exports = { INDICATOR_REGISTRY, NATIVE_BUILD_COMMAND_PATTERN }
