'use strict'

const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')
const { INDICATOR_REGISTRY } = require(path.join(ROOT, 'lib', 'utils', 'indicator-definitions.js'))
const scanPackageScripts = require(path.join(ROOT, 'lib', 'utils', 'script-risk-scanner.js'))
const { parseCommandFile, SIGNAL_PATTERNS } = scanPackageScripts

// Lifecycle script names that run during `npm install`
const LIFECYCLE_HOOKS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepack']

// Words too common in shell to be informative build tool signals
const SHELL_NOISE = new Set([
  'node', 'nodejs', 'npm', 'npx', 'sh', 'bash', 'zsh', 'cmd', 'pwsh',
  'yarn', 'pnpm', 'bun', 'lerna', 'turbo', 'nx', 'rush',  // package managers / monorepo tools
  'husky',   // git hook installer — not a build tool
  'gitignore', 'eslintrc', 'prettierrc', 'editorconfig',  // dotfile names from rm/cleanup cmds
  'if', 'else', 'then', 'fi', 'do', 'done', 'for', 'while', 'in',
  'echo', 'exit', 'true', 'false', 'test', 'eval', 'export', 'set',
  'unset', 'cd', 'ls', 'cp', 'mv', 'rm', 'mkdir', 'chmod', 'chown',
  'cat', 'grep', 'awk', 'sed', 'sort', 'head', 'tail', 'tee', 'xargs',
  'env', 'which', 'find', 'touch', 'read', 'printf', 'source', 'exec',
  'run', 'build', 'install', 'start', 'test', 'check', 'clean', 'all',
  'scripts', 'prebuild', 'postbuild',
  // Common path-segment directory names that appear in script paths like
  // "node hooks/postinstall.js" or "node src/install/postinstall.mjs".
  // These are not meaningful command tokens — just directory components.
  'hooks', 'src', 'lib', 'dist', 'bin', 'cli', 'utils', 'core',
  'init', 'setup', 'tools', 'helpers', 'common', 'shared',
])

// Dependencies (by name) that are strong signals of non-JS compilation.
// Purposefully excludes pure-JS bundlers (webpack, rollup, vite, esbuild)
// and TypeScript (tsc) — those are not security-relevant lifecycle builds.
const BUILD_DEP_PATTERNS = [
  // GYP family
  /\bnode-gyp\b/,
  /\bnode-pre-gyp\b/,
  /@mapbox\/node-pre-gyp\b/,
  /@xprofiler\/node-pre-gyp\b/,
  /\bprebuild-install\b/,
  /\bprebuildify\b/,
  /\bpkg-prebuilds-verify\b/,
  /\btodesktop-node-gyp-build\b/,
  /\bnode-gyp-build\b/,
  // Rust / WASM
  /@napi-rs\/cli\b/,
  /\bneon-cli\b/,
  /\bwasm-pack\b/,
  /\bcargo\b/,
  // CMake / Autoconf
  /\bcmake-js\b/,
  // Android / React Native native modules
  /\bexpo-modules-core\b/,
  /\bexpo-module-scripts\b/,
  /\breact-native-gradle-plugin\b/,
  // Generic foreign compilation tools
  /\bzig\b/,
  /\bffi-napi\b/,
  /\bref-napi\b/,
  // Binary downloader helpers — packages that fetch prebuilt binaries at install time
  /\binstall-binary\b/,
  /\bdownload-binary\b/,
  /\bbin-wrapper\b/,
  /\bnode-bin-setup\b/,
]

// Maps dependency name patterns to the indicator-definition file they imply.
// Used by matchExistingDefinitions to classify packages whose lifecycle scripts
// don't mention a native build tool directly (e.g. install: "node ./install.js").
// Uses ecosystem-level framework deps, not specific package names.
const DEP_TO_DEFINITION = [
  {
    pattern: /\bnode-gyp\b|\bnode-pre-gyp\b|@mapbox\/node-pre-gyp\b|@xprofiler\/node-pre-gyp\b|\bprebuildify\b|\bprebuild-install\b|\bnode-gyp-build\b|\bpkg-prebuilds-verify\b|\btodesktop-node-gyp-build\b/,
    file: 'binding.gyp',
  },
  {
    pattern: /\bcmake-js\b/,
    file: 'CMakeLists.txt',
  },
  {
    pattern: /@napi-rs\/cli\b|\bneon-cli\b|\bwasm-pack\b/,
    file: 'Cargo.toml',
  },
  {
    // Capacitor native plugin — any plugin with @capacitor/core has platform-native code.
    // react-native-gradle-plugin is the RN Gradle plugin dep for React Native modules.
    // react-native (exact name, not react-native-*) means it's an RN native module.
    pattern: /@capacitor\/core\b|\bexpo-modules-core\b|\bexpo-module-scripts\b|\breact-native-gradle-plugin\b/,
    file: 'android/build.gradle',
  },
  {
    // Exact package name 'react-native' as a dependency means this is an RN native module.
    // Using multiline ^ $ so react-native-xxx doesn't match.
    pattern: /^react-native$/m,
    file: 'android/build.gradle',
  },
]

// Matches explicit `<pm> run <name>` and `node --run <name>` delegation forms.
// Captured group 1 is always the script name.
const PM_RUN_RE = /\b(?:npm|yarn|pnpm|bun)\s+run\s+([\w:-]+)|\bnode\s+--run\s+([\w:-]+)/g

// pm subcommands that are NOT script names — for bare-word matching below.
const PM_SUBCOMMANDS = new Set([
  'add', 'remove', 'install', 'uninstall', 'upgrade', 'update', 'ci',
  'list', 'ls', 'info', 'view', 'show', 'publish', 'pack', 'login', 'logout',
  'exec', 'dlx', 'create', 'init', 'link', 'unlink',
  'workspace', 'workspaces', 'config', 'set', 'get', 'delete',
  'cache', 'store', 'clean', 'audit', 'outdated', 'why',
  'dedupe', 'prune', 'rebuild', 'version', 'build',
])

// Pre-build a flat [{ pattern, file }] table from the registry so we can
// match any lifecycle script command against all known commandPatterns in
// a single O(n) pass.
const REGISTRY_PATTERNS = []
for (const [file, def] of Object.entries(INDICATOR_REGISTRY)) {
  for (const pat of (def.detect.commandPatterns || [])) {
    REGISTRY_PATTERNS.push({ pattern: pat, file })
  }
}

// Produce a unified-diff-style string comparing lifecycle scripts between two
// versions of the same package.  Returns null when nothing changed.
// Hooks are ordered by lifecycle execution order (LIFECYCLE_HOOKS), with any
// delegated extras appended alphabetically after — so preinstall always
// precedes install, etc.  Each hook is matched by name so a changed install
// script shows as a -/+ pair on the same hook, not a stray remove + add.
function lifecycleDiff (name, oldVer, oldLc, newVer, newLc) {
  const allKeys = new Set([...Object.keys(oldLc), ...Object.keys(newLc)])
  // Stable execution order: known lifecycle hooks first, then extras sorted
  const ordered = [
    ...LIFECYCLE_HOOKS.filter(h => allKeys.has(h)),
    ...[...allKeys].filter(h => !LIFECYCLE_HOOKS.includes(h)).sort(),
  ]
  const diffLines = []
  let hasChange = false
  for (const hook of ordered) {
    const inOld = hook in oldLc
    const inNew = hook in newLc
    if (inOld && inNew && oldLc[hook] === newLc[hook]) {
      diffLines.push(`      ${hook}: ${oldLc[hook]}`)
    } else {
      hasChange = true
      if (inOld) diffLines.push(`    - ${hook}: ${oldLc[hook]}`)
      if (inNew) diffLines.push(`    + ${hook}: ${newLc[hook]}`)
    }
  }
  if (!hasChange) return null
  const header = `    --- ${name}@${oldVer}\n    +++ ${name}@${newVer}`
  return header + '\n' + diffLines.join('\n')
}

// Extract lifecycle hooks and transitively follow any delegation to another
// named script.  Handles:
//   npm run <name>  |  yarn run <name>  |  pnpm run <name>  |  bun run <name>
//   node --run <name>
//   yarn <name>  |  pnpm <name>  |  bun <name>  (bare-word form, if <name>
//     is actually a key in scripts and not a PM subcommand)
// E.g. { install: "npm run build", build: "node-gyp rebuild" } → includes
// "build" in the result so pattern matching and deep scan see the real content.
function extractLifecycleScripts (scripts) {
  const result = {}
  const visited = new Set()
  const queue = [...LIFECYCLE_HOOKS]
  while (queue.length > 0) {
    const hook = queue.shift()
    if (visited.has(hook) || !scripts[hook]) continue
    visited.add(hook)
    result[hook] = scripts[hook]

    const src = scripts[hook]

    // Explicit `<pm> run <name>` and `node --run <name>`
    PM_RUN_RE.lastIndex = 0
    for (const m of src.matchAll(PM_RUN_RE)) {
      const delegated = m[1] || m[2]
      if (delegated && !visited.has(delegated) && scripts[delegated]) {
        queue.push(delegated)
      }
    }

    // Bare-word `yarn <name>` / `pnpm <name>` / `bun <name>` — only follow
    // when the name is a real key in scripts (not a PM subcommand or binary).
    for (const m of src.matchAll(/\b(?:yarn|pnpm|bun)\s+([\w:-]+)/g)) {
      const delegated = m[1]
      if (!PM_SUBCOMMANDS.has(delegated) && !visited.has(delegated) && scripts[delegated]) {
        queue.push(delegated)
      }
    }
  }
  return result
}

// Returns the list of indicator-definition files whose commandPatterns match
// anything in the package's scripts, or whose associated build deps appear in
// the manifest.  Scans ALL scripts (not just lifecycle hooks) so that packages
// like lru-native2 ("build":"node-gyp rebuild") or @azure/msal-node-extensions
// ("compile":"node-gyp rebuild") are classified correctly even though their
// lifecycle script is just "install":"npm run build".
function matchExistingDefinitions (lifecycleScripts, manifest) {
  // Union of lifecycle script values + all other script values from the manifest
  const allScriptValues = [
    ...Object.values(lifecycleScripts),
    ...Object.values((manifest && manifest.scripts) || {}),
  ]
  const combined = allScriptValues.join(' ')
  const matches = new Set()
  for (const { pattern, file } of REGISTRY_PATTERNS) {
    // Reset lastIndex to avoid stateful global-flag issues
    if (pattern.global) pattern.lastIndex = 0
    if (pattern.test(combined)) matches.add(file)
  }
  if (manifest) {
    const depStr = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.optionalDependencies,
    }).join('\n')
    for (const { pattern, file } of DEP_TO_DEFINITION) {
      if (pattern.test(depStr)) matches.add(file)
    }
  }
  return [...matches]
}

// Pull meaningful tool-like tokens out of lifecycle script text.
function extractCommandTokens (lifecycleScripts) {
  const tokens = new Set()
  for (const src of Object.values(lifecycleScripts)) {
    for (const m of src.matchAll(/\b([a-z][\w.-]{1,})\b/gi)) {
      const tok = m[1].toLowerCase()
      // Skip pure numbers, short words, shell noise, and dotfile names
      if (/^\d/.test(tok) || tok.length < 3 || SHELL_NOISE.has(tok)) continue
      // Skip path-like tokens (contain slashes or look like file extensions)
      if (tok.includes('/') || /\.\w{2,4}$/.test(tok)) continue
      // Skip tokens that are dotfile names (.gitignore, .eslintrc, etc.)
      if (tok.startsWith('.')) continue
      tokens.add(tok)
    }
  }
  return [...tokens]
}

// Infer which indicator files a package likely has, based on deps and scripts.
// These are heuristic — they help the AI propose a realistic indicatorFile key.
function inferIndicatorFiles (manifest) {
  const allDeps = Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
  }).join('\n')
  const scriptStr = Object.values(manifest.scripts).join(' ')
  const combined = `${allDeps}\n${scriptStr}`
  const inferred = []

  if (/\bnode-gyp\b|\bnode-pre-gyp\b|@mapbox\/node-pre-gyp\b|@xprofiler\/node-pre-gyp\b|\bnode-gyp-build\b|\bprebuild/.test(combined)) {
    inferred.push('binding.gyp')
  }
  if (/\bneon-cli\b|\bwasm-pack\b|\bcargo\s+(?:build|install|test|run)\b/.test(combined) ||
      /@napi-rs\/cli/.test(allDeps)) {
    inferred.push('Cargo.toml')
  }
  if (/\bcmake-js\b|\bcmake\b/.test(combined)) {
    inferred.push('CMakeLists.txt')
  }
  if (/\bexpo-module\b|\bgradlew\b|\breact-native\b|@capacitor\/core\b/.test(combined) ||
      /^react-native$/m.test(allDeps)) {
    inferred.push('android/build.gradle')
  }
  if (/\bmake\b/.test(scriptStr)) {
    inferred.push('Makefile')
  }
  if (/\.\/configure\b|\bautoconf\b|\bautomake\b/.test(scriptStr)) {
    inferred.push('configure.ac')
  }
  return inferred
}

// Suggest the most specific classifier signal for an uncategorized package.
function suggestSignal (tokens, inferredFiles) {
  if (inferredFiles.includes('android/build.gradle')) return 'android-native'
  if (tokens.includes('emcc') || tokens.includes('emcmake') || tokens.includes('emmake')) {
    return 'wasm-build'
  }
  if (inferredFiles.includes('Cargo.toml')) return 'rust-native'
  if (tokens.includes('wasm-pack')) return 'wasm-build'
  if (inferredFiles.includes('binding.gyp') || inferredFiles.includes('CMakeLists.txt')) {
    return 'native-build'
  }
  if (inferredFiles.includes('Makefile') || tokens.includes('make')) return 'make-build'
  return null
}

module.exports = {
  LIFECYCLE_HOOKS,
  SHELL_NOISE,
  BUILD_DEP_PATTERNS,
  DEP_TO_DEFINITION,
  PM_RUN_RE,
  PM_SUBCOMMANDS,
  REGISTRY_PATTERNS,
  lifecycleDiff,
  extractLifecycleScripts,
  matchExistingDefinitions,
  extractCommandTokens,
  inferIndicatorFiles,
  suggestSignal,
  parseCommandFile,
  SIGNAL_PATTERNS,
}
