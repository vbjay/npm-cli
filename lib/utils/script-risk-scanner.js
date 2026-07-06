const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const { NATIVE_BUILD_COMMAND_PATTERN } = require('./indicator-definitions')
const { classifyUrl } = require('./url-classifier')

// Normalise a file-system path to forward slashes so that result objects
// always use POSIX-style separators regardless of the host OS.
const toPosix = (p) => p.split(path.sep).join('/')

// Best-effort static risk scanner for npm lifecycle scripts.
//
// Given a package directory and its lifecycle `scripts` map, this module:
//   1. Parses each lifecycle command to find directly-referenced local files.
//   2. Recursively walks `require()`/`import` references up to MAX_DEPTH deep.
//   3. Reads each discovered file and applies regex-based signal detectors.
//
// Returns: Promise<Array<{ path, reason, sha256, signals, references }>>
//
// This is intentionally best-effort. It does NOT:
//   - Execute any code
//   - Claim to prove a package is safe
//   - Perform full AST analysis
//   - Make network requests

const CHUNK_SIZE = 64 * 1024      // 64 KB per read — keeps peak memory constant
// Bytes of the previous chunk prepended to each new chunk so that signal
// patterns straddling a chunk boundary are not missed.  All patterns fit
// comfortably within 512 bytes.
const CHUNK_OVERLAP = 512
// Hard scan cap: files exceeding this size are partially scanned.  The scan
// stops at this boundary, `sha256` reflects the hash of the bytes that were
// read (not the whole file), and the `file-too-large` signal is emitted so
// reviewers know the file was not fully analysed.
const MAX_SCAN_BYTES = 50 * 1024 * 1024  // 50 MB
const MAX_DEPTH = 20              // Maximum recursion depth for local requires

// --- Signal detection patterns ------------------------------------------

const SIGNAL_PATTERNS = [
  ['uses-child-process',
    // CJS: require('child_process') or require('node:child_process')
    // ESM: any `import ... from 'child_process'` (the `from` keyword is common to all forms)
    /\brequire\s*\(\s*['"](?:node:)?child_process['"]\s*\)|\bfrom\s+['"](?:node:)?child_process['"]/],
  ['uses-eval',
    /\beval\s*\(|new\s+Function\s*\(/],
  ['uses-vm',
    // The `vm` module (and its node: prefixed form) allows arbitrary code execution
    // via vm.runInContext(), vm.runInNewContext(), vm.runInThisContext(), vm.Script,
    // vm.compileFunction(), etc.
    /\brequire\s*\(\s*['"](?:node:)?vm['"]\s*\)|\bfrom\s+['"](?:node:)?vm['"]/],
  ['uses-worker-threads',
    // worker_threads lets a package spin up Node.js workers that can make network
    // requests, read/write files, and run arbitrary code in parallel.
    /\brequire\s*\(\s*['"](?:node:)?worker_threads['"]\s*\)|\bfrom\s+['"](?:node:)?worker_threads['"]/],
  ['reads-process-env',
    /\bprocess\.env\b/],
  ['references-credential-env-var',
    // Dot notation:     process.env.TOKEN  (case-insensitive)
    // Bracket notation: process.env['TOKEN'] / process.env["TOKEN"]
    // Both forms are checked so that bracket-notation lookups (a trivial bypass
    // of dot-notation-only patterns) are also caught.
    /process\.env(?:\.(?:npm_token|github_token|node_auth_token|npm_config_token|actions_runtime_token|runner_token|token|secret|password|api_key|access_key|private_key|auth(?:orization)?|credential|aws_|ci_token|google_application_credentials|azure_client_secret)|\[['"](?:[^'"]*(?:token|secret|password|api_key|access_key|private_key|auth|credential|aws_|ci_|google_application|azure_client)[^'"]*)['"]\])/i],
  ['network-access',
    // Matches bare and node:-prefixed built-in HTTP(S) modules as well as common HTTP libraries.
    // Both CJS require() and ESM import-from forms are checked so that ESM-only packages
    // (e.g. undici, ky, got v12+, cross-fetch) are not missed.
    // Node 18+ exposes a global fetch() with no import required — caught by \bfetch\s*\(.
    /\brequire\s*\(\s*['"](?:node:)?(?:https?|node-fetch|axios|got|superagent|request|undici|ky|needle|phin|cross-fetch)['"]\s*\)|\bfrom\s+['"](?:node:)?(?:https?|undici|ky|node-fetch|cross-fetch|got|axios|needle|phin|superagent)['"]|\bfetch\s*\(|https?\.(?:get|request)\s*\(/i],
  ['uses-net-socket',
    // The `net` and `tls` modules enable raw TCP/TLS connections — a network path
    // that is invisible to HTTP-only detectors and can be used for data exfiltration.
    /\brequire\s*\(\s*['"](?:node:)?(?:net|tls)['"]\s*\)|\bfrom\s+['"](?:node:)?(?:net|tls)['"]/],
  ['uses-dns',
    // DNS lookups are a common covert channel: data encoded in subdomain queries
    // can exfiltrate secrets without opening a visible TCP connection.
    /\brequire\s*\(\s*['"](?:node:)?dns(?:\/promises)?['"]\s*\)|\bfrom\s+['"](?:node:)?dns(?:\/promises)?['"]/],
  ['writes-file',
    /\bfs(?:\.promises)?\.(writeFile|writeFileSync|createWriteStream|appendFile|appendFileSync)\s*\(/],
  ['writes-outside-package',
    // Heuristic: a string literal containing "../" indicates a path that traverses
    // outside the current directory — when combined with a file-write call this is
    // evidence that the script writes beyond the package boundary.
    // process.cwd() was previously included here but was removed: it fires on any
    // path construction including read-only ones, producing too many false positives.
    /(['"`])\.\.\/.*\1/],
  ['makes-executable',
    // Marking a file executable (chmod with an execute bit set, or `chmod +x`)
    // is a strong corroborating signal that a fetched file is meant to be RUN.
    // This is the discriminator that separates a genuine prebuilt-binary install
    // from an ordinary API call or data fetch — a telemetry POST or JSON download
    // never needs to flip the execute bit.  Best-effort only: a chmod whose mode
    // is passed via a variable, or an author who sets the bit through other means,
    // will not be caught here, so absence of this signal is not proof of safety.
    //   chmod(file, 0o755) / chmodSync(file, '755') / chmod 755 / chmod +x
    // An octal/string mode matches when any digit has the execute bit (1,3,5,7).
    /\bchmod(?:Sync)?\s*\([^)]*(?:0o[0-7]*[1357][0-7]*|['"`][0-7]*[1357][0-7]*['"`]|['"`]\+x['"`])|\bchmod\s+(?:\+x|[0-7]*[1357][0-7]*)\b/i],
  ['modifies-shell-config',
    /['"`](?:\.npmrc|\.gitconfig|\.ssh[/\\]|\.bashrc|\.zshrc|\.profile|authorized_keys)['"`]/],
  ['base64-decode-exec',
    // Buffer.from(..., 'base64') and atob() are both used to decode base64-encoded
    // payloads at runtime — a classic obfuscation technique to hide strings from
    // static analysis tools.
    /Buffer\.from\s*\([^)]+,\s*['"]base64['"]\)|atob\s*\(/],
  ['obfuscation-pattern',
    // Catch common techniques used to hide command strings from static analysis:
    //
    //   \\xNN sequences (10+ consecutive)  — hex-escaped string literals
    //     e.g.  '\x6e\x70\x6d\x20\x69\x6e\x73\x74\x61\x6c\x6c'  → 'npm install'
    //
    //   \\uNNNN sequences (3+ consecutive) — unicode-escaped string literals
    //     e.g.  '\u006e\u0070\u006d'  → 'npm'
    //
    //   String.fromCharCode(...)           — char-code array assembly
    //     e.g.  String.fromCharCode(110,112,109,32,105,110,115,116,97,108,108)
    //
    //   .split('').reverse().join('')      — reversed string reassembly
    //     e.g.  'llatsnI mpm'.split('').reverse().join('')
    //
    //   single-char array join             — character-by-character construction
    //     e.g.  ['n','p','m',' ','i'].join('')
    //     Heuristic: 4+ single-char string literals in sequence
    //
    //   repeated += with single chars      — char-by-char string building
    //     e.g.  cmd=''; cmd+='n'; cmd+='p'; cmd+='m'; cmd+=' '; cmd+='i'
    //     Heuristic: 4+ consecutive single-char string concatenation assignments
    //
    //   .replace() junk-character removal  — random chars stripped at runtime
    //     e.g.  'nXpXmX iXnXsXtXaXlXl'.replace(/X/g, '')  → 'npm install'
    //     e.g.  'n-p-m- -i-n-s'.split('-').join('')
    //
    // NOTE: These heuristics catch many known techniques but cannot detect all
    // possible obfuscation. A determined attacker can always construct strings
    // through arbitrary computation (index lookups, math, bitwise ops, external
    // data) that is impossible to detect statically. The cross-signal alarm in
    // the report formatter fires whenever uses-child-process + any obfuscation
    // signal are both present, regardless of whether the specific command is
    // readable — because the combination alone is grounds for manual review.
    /(?:\\x[0-9a-fA-F]{2}){10,}|(?:\\u[0-9a-fA-F]{4}){3,}|String\.fromCharCode\s*\(|\.split\s*\(\s*['"]{2}\s*\)\.reverse\s*\(\s*\)\.join\s*\(\s*['"]{2}\s*\)|(?:['"][^'"\\]{1}['"],?\s*){4,}|(?:\+=\s*['"][^'"\\]{1}['"]\s*;?\s*){4,}|\.replace\s*\(\s*\/[^/]{1,8}\/g?\s*,\s*['"]{2}\s*\)|\.split\s*\(\s*['"][^'"]{1,4}['"]\s*\)\s*\.join\s*\(\s*['"]{2}\s*\)/],
  // JSFuck encodes arbitrary JavaScript using only six characters: [ ] ( ) ! +
  // A run of 30+ consecutive chars drawn exclusively from this set is a reliable
  // indicator that the file (or an inline `-e` script) contains JSFuck-style
  // obfuscation intended to hide its behaviour from static reviewers.
  ['jsfuck-obfuscation',
    /[\][()!+]{30,}/],
  ['dynamic-require',
    // require() called with a non-literal argument — the loaded module cannot be
    // statically determined from the source text.  This is both a supply-chain risk
    // (the actual dependency is resolved at runtime, not auditable) and a common
    // loader-obfuscation technique where the module name is computed, env-driven,
    // or assembled from parts.
    // Matches: require(varName), require(process.env.X), require(getModule())
    // Excludes: require('string'), require(`template`), require(require.resolve(...))
    /\brequire\s*\(\s*(?!['"`])(?!require\s*\.)[A-Za-z_$]/],
  ['native-build',
    // Imported from native-build-definitions.js — the single source of truth for
    // all native-build command patterns.  Kept in sync with the trigger.commandPatterns
    // in INDICATOR_DEFINITIONS so that new tools only need one-line additions there.
    NATIVE_BUILD_COMMAND_PATTERN],
  ['binary-download',
    // Patterns found in install scripts that fetch prebuilt binaries rather than
    // compiling from source.  Detected from the script file content (not the
    // lifecycle command line), so packages like esbuild/puppeteer/playwright that
    // just say `node install.js` in their postinstall are still classified.
    //   napi-postinstall  — napi-rs official prebuilt-binary installer helper
    //   downloadBrowsers  — puppeteer / @puppeteer/browsers browser downloader
    //   installBrowsers   — playwright-core browser installer (installBrowsersForNpmInstall)
    //   XXXX_BINARY_PATH  — all-caps env var pattern used by esbuild, ffmpeg-installer,
    //                       canvas, sharp and similar packages to locate their binary
    //   XXXX_BINARY       — all-caps pattern for packages that set a binary name var
    //   binary-install    — npm helper that downloads prebuilt binaries; any package that
    //                       requires it in an install script is performing a binary download
    //   releases/download — GitHub Releases URL segment; appears in any script that
    //                       constructs a download URL for a platform-specific prebuilt asset
    /\bnapi-postinstall\b|\bdownloadBrowsers?\b|\binstallBrowsers|[A-Z][A-Z0-9_]{2,}BINARY_PATH\b|[A-Z][A-Z0-9_]{2,}_BINARY\b|\brequire\s*\(\s*['"]binary-install['"]\s*\)|\/releases\/download\//],
  ['wasm-load',
    // WebAssembly.instantiate / compile load a pre-compiled .wasm binary at runtime.
    // Unlike the 'wasm-build' indicator signal (which flags Cargo.toml + wasm-bindgen
    // meaning WASM is compiled from Rust source), this signal fires when an already-
    // compiled WASM payload is loaded.  Its machine code executes with the privileges
    // of the JS host process and cannot be inspected by regex-based static analysis.
    /\bWebAssembly\.(?:instantiate|compile|instantiateStreaming|compileStreaming)\s*\(/],
  ['runtime-installer',
    // Detects install scripts that run a secondary package manager install as a
    // child process at install time.  This is a supply-chain red flag:
    //   • The second install resolves its own dependency tree at install time
    //     (version pinning is bypassed — "latest" can change between installs)
    //   • If --ignore-scripts=false is passed the secondary packages run their
    //     own lifecycle scripts, creating an unaudited execution chain
    //   • Applies to ANY package — not just known clusters
    //
    // Package managers covered: npm, yarn, pnpm, bun, deno
    //
    // Three forms covered:
    //   1. String/template-literal argument to any exec-like function:
    //        execSync("npm install foo")        spawnSync(`pnpm add ${pkg}`)
    //        exec('yarn add foo', cb)           sh.exec('npm install ...')
    //        execa('npm install ...')           cross-spawn('yarn add ...')
    //      Matches whether the function is called bare or via property access
    //      (child_process.execSync, cp.exec, etc.) — the leading ident is optional.
    //   2. Array argument (exec-like with package manager as first arg):
    //        spawn('npm', ['install', ...])     execa('yarn', ['add', ...])
    //        spawnSync('pnpm', ['add', ...])
    //   3. Plain command string (shell runner, Makefile-style, build helpers):
    //        run('npm install foo')             shell('yarn add pkg')
    //
    // Note: the outer `(?:...)?` makes the function-call prefix optional so that
    // strings like  const cmd = 'npm install foo'  also fire — the string itself
    // is the evidence regardless of how it's eventually executed.
    /(?:(?:execSync|spawnSync|execa?|cross-?[Ss]pawn|crossSpawn|shelljs?\.exec|\.exec|\.execSync|\.spawnSync|run|shell)\s*\()?['"`][^'"`\n]*(?:npm|yarn|pnpm|bun|deno)\s+(?:install|add|i\b)|(?:execSync|spawnSync|spawn|execa?|cross-?[Ss]pawn|crossSpawn|\.exec|\.execSync|\.spawnSync)\s*\(\s*['"`](?:npm|yarn|pnpm|bun|deno)['"`]\s*,\s*\[/],
  ['shell-network-fetch',
    // curl / wget / nc / netcat / ncat are common tools used in shell scripts to
    // fetch remote content — sometimes piped directly into a shell interpreter.
    /\bcurl\s+|\bwget\s+|\bnc\s+-[^-]|\bnetcat\b|\bncat\b/],
  ['platform-specific-script',
    // Detects install scripts that branch on the host OS — a strong signal that
    // the package executes different (and potentially unreviewed) code paths
    // depending on where it is installed.  Common patterns:
    //
    //   process.platform checks:
    //     process.platform === 'win32' / 'linux' / 'darwin' / 'freebsd' / 'openbsd'
    //     process.platform.startsWith('win')
    //   os.platform() / os.type() calls (same information via the `os` module)
    //   Shell-side: `if [ "$(uname)" = "Darwin" ]`, `uname -s`, `%OS%` (Windows batch)
    //   Cross-env / platform-specific script-runner patterns:
    //     cross-env, if-env, per-env — packages that set env vars per platform
    /\bprocess\.platform\b|\bos\.platform\s*\(|\bos\.type\s*\(|\buname\b|\b%OS%\b|\bif-env\b|\bper-env\b|cross-env\b/],
  ['process-binding',
    // process.binding() and process.dlopen() bypass the Node.js module system to
    // load internal C++ bindings or native shared libraries directly.
    /\bprocess\.binding\s*\(|\bprocess\.dlopen\s*\(/],
  ['git-hook-setup',
    // Lifecycle scripts that install or configure git hooks using a hook manager.
    // husky, lefthook, and simple-git-hooks register shell scripts that run before
    // or after git operations — the hook scripts themselves are scanned separately
    // (see findGitHookScripts) and may contain build-relevant commands.
    /\bhusky\b|\blefthook\b|\bsimple-git-hooks\b|\bpinst\b/],
]

const detectSignals = (content) => {
  const signals = []
  for (const [name, pattern] of SIGNAL_PATTERNS) {
    if (pattern.test(content)) {
      signals.push(name)
    }
  }
  // external-url: any bare HTTP(S) URL in the content string.
  // The full classification (reference vs. non-reference) is handled in scanFile;
  // detectSignals fires for any URL so callers can gate on presence alone.
  if (/https?:\/\/[a-zA-Z0-9]/.test(content)) {
    signals.push('external-url')
  }
  return signals
}

// --- Local reference extraction -----------------------------------------

// Path character class uses (?:(?!\1)...)+ so that only the *matching* opening
// quote type terminates the path — other quote chars are allowed inside the string.
// Spaces are also permitted so that quoted paths with spaces are captured.
const LOCAL_REQUIRE_RE = /\brequire\s*\(\s*(['"`])(\.{1,2}\/(?:(?!\1)[^\n)])+)\1\s*\)/g
const LOCAL_IMPORT_FROM_RE = /\bfrom\s+(['"`])(\.{1,2}\/(?:(?!\1)[^\n])+)\1/g
const LOCAL_IMPORT_BARE_RE = /\bimport\s+(['"`])(\.{1,2}\/(?:(?!\1)[^\n])+)\1/g
// Dynamic import() calls with a literal local specifier: import('./helper.js')
const LOCAL_DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*(['"`])(\.{1,2}\/(?:(?!\1)[^\n)])+)\1\s*\)/g
// ESM import.meta.resolve() with a literal local specifier: import.meta.resolve('./helper.js')
const LOCAL_IMPORT_META_RESOLVE_RE = /\bimport\.meta\.resolve\s*\(\s*(['"`])(\.{1,2}\/(?:(?!\1)[^\n)])+)\1\s*\)/g
// Shell source directives: `source ./file.sh` or `. ./file.sh`
// Two alternatives: quoted (spaces allowed, only matching quote terminates path) and
// unquoted (spaces terminate the path, all quote chars are disallowed).
// Group 2 holds the quoted path; group 3 holds the unquoted path.
const SHELL_SOURCE_RE = /(?:^|[;\n&|])\s*(?:source|\.)\s+(?:(['"`])(\.{1,2}\/(?:(?!\1)[^\n;])+)(?:\1)|(\.{1,2}\/[^\s'"`\n;]+))/gm

// Bare (non-relative) require/import specifiers — package names, not local paths.
// Captures: require('pkg'), require('pkg/subpath'), require('@scope/pkg'), import('pkg').
// Excludes: node: builtins, relative paths (./  ../), dynamic expressions.
const BARE_REQUIRE_RE = /\brequire\s*\(\s*(['"`])((?!\.{1,2}\/)(?!node:)[a-zA-Z@][^'"`\n)]*)\1\s*\)/g
const BARE_IMPORT_FROM_RE = /\bfrom\s+(['"`])((?!\.{1,2}\/)(?!node:)[a-zA-Z@][^'"`\n]*)\1/g
const BARE_DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*(['"`])((?!\.{1,2}\/)(?!node:)[a-zA-Z@][^'"`\n)]*)\1\s*\)/g

// Extract the npm package name from a bare specifier.
// '@scope/pkg/subpath' → '@scope/pkg'
// 'pkg/subpath' → 'pkg'
const extractPackageName = (specifier) => {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/')
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier
  }
  return specifier.split('/')[0]
}

const findBareRefs = (content) => {
  const pkgs = new Set()
  for (const re of [BARE_REQUIRE_RE, BARE_IMPORT_FROM_RE, BARE_DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0
    let match
    while ((match = re.exec(content)) !== null) {
      pkgs.add(extractPackageName(match[2]))
    }
  }
  return [...pkgs]
}

// spawn(Sync)/execFile(Sync) calls that use process.execPath as the executable —
// equivalent to `node scriptPath` but not detected by findLocalRefs because
// process.execPath is a runtime expression, not a string literal.
// Example: spawnSync(process.execPath, ['scripts/fetch-prebuilt.cjs'], { cwd: root })
// The extracted paths are relative to the package root (the cwd the spawn uses),
// not relative to the calling file — callers must resolve from pkgCacheDir.
const SPAWN_EXEC_PATH_RE = /\b(?:spawn(?:Sync)?|execFile(?:Sync)?)\s*\(\s*process\.execPath\s*,\s*\[\s*(['`"])((?:(?!\1)[^\n])+)\1/g

const findExecPathRefs = (content) => {
  const refs = []
  SPAWN_EXEC_PATH_RE.lastIndex = 0
  let match
  while ((match = SPAWN_EXEC_PATH_RE.exec(content)) !== null) {
    refs.push(match[2])
  }
  return refs
}

const findLocalRefs = (content) => {
  const refs = new Set()
  for (const re of [LOCAL_REQUIRE_RE, LOCAL_IMPORT_FROM_RE, LOCAL_IMPORT_BARE_RE, LOCAL_DYNAMIC_IMPORT_RE, LOCAL_IMPORT_META_RESOLVE_RE]) {
    re.lastIndex = 0
    let match
    while ((match = re.exec(content)) !== null) {
      refs.add(match[2])
    }
  }
  // Shell source directives (also matched in JS files for best-effort coverage).
  SHELL_SOURCE_RE.lastIndex = 0
  let match
  while ((match = SHELL_SOURCE_RE.exec(content)) !== null) {
    // Quoted path is in group 2; unquoted path is in group 3.
    refs.add(match[2] ?? match[3])
  }
  return [...refs]
}

// --- External URL extraction --------------------------------------------

// Only match URLs that appear inside string literals — these are actively used
// by the code (as download targets, API endpoints, CDN base URLs, etc.) rather
// than merely mentioned in comments or documentation.
//
// QUOTED_URL_RE  — single/double-quoted strings; \1 backreference ensures the
//                  closing quote matches the opening quote.
// TEMPLATE_URL_RE — template literals; stops at `${` (start of an expression),
//                   a closing backtick, or end-of-line so that a URL prefix like
//                   `https://cdn.example.com/${version}/binary` is still captured.
// UNQUOTED_URL_RE — unquoted URLs appearing after `=` or at word boundaries,
//                   e.g. `--base-url=https://cdn.example.com/v1/` in a CLI arg.
//                   Stops at whitespace, quotes, or end-of-line.
const QUOTED_URL_RE = /(['"])(https?:\/\/[a-zA-Z0-9][^'"\n]*)\1/g
const TEMPLATE_URL_RE = /`(https?:\/\/[a-zA-Z0-9][^`\n$]*)/g
const UNQUOTED_URL_RE = /(?:^|[=\s])(https?:\/\/[a-zA-Z0-9][^\s'"`;,>\])\n]*)/g

const findExternalUrls = (content) => {
  const urls = new Set()
  let inBlockComment = false
  for (const line of content.split('\n')) {
    const trimmed = line.trimStart()

    // Track /* ... */ block comment state across lines.
    if (inBlockComment) {
      if (line.includes('*/')) {
        inBlockComment = false
      }
      continue
    }
    if (trimmed.startsWith('/*')) {
      // Single-line block comment /* ... */ — skip just this line.
      // Multi-line opener — skip and enter block-comment mode.
      if (!line.includes('*/')) {
        inBlockComment = true
      }
      continue
    }

    // Skip full-line comments.
    if (trimmed.startsWith('//') || trimmed.startsWith('#')) {
      continue
    }

    // Strip trailing inline `//` comment — but use a negative lookbehind so
    // that `://` inside a URL is not treated as a comment marker.
    const codePart = line.replace(/(?<!:)\/\/.*$/, '')
    QUOTED_URL_RE.lastIndex = 0
    TEMPLATE_URL_RE.lastIndex = 0
    UNQUOTED_URL_RE.lastIndex = 0
    let match
    while ((match = QUOTED_URL_RE.exec(codePart)) !== null) {
      urls.add(match[2].replace(/[.,;:]+$/, ''))
    }
    while ((match = TEMPLATE_URL_RE.exec(codePart)) !== null) {
      urls.add(match[1].replace(/[.,;:]+$/, ''))
    }
    while ((match = UNQUOTED_URL_RE.exec(codePart)) !== null) {
      urls.add(match[1].replace(/[.,;:]+$/, ''))
    }
  }
  return [...urls]
}

// Resolve a local reference to an absolute path, trying common extensions.
// Returns null if the resolved path escapes the package directory.
const resolveLocalRef = async (fromFile, ref, packageDir) => {
  const base = path.resolve(path.dirname(fromFile), ref)

  // Security: never follow a reference outside the package directory.
  const rel = path.relative(packageDir, base)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return null
  }

  // Use lstat (not stat) throughout so that symlinks are never followed.
  // A symlink inside the package could point outside the package directory;
  // treating it as a non-file is the safe default.

  // Stat base once — reused for both the direct-file and directory branches.
  let baseStat = null
  try {
    baseStat = await fs.lstat(base)
  } catch {
    // base doesn't exist yet; will still try with extensions below
  }

  // If base exists and is a plain file, return it immediately.
  if (baseStat && baseStat.isFile()) {
    return base
  }

  // Try with common JS extensions.
  for (const ext of ['.js', '.mjs', '.cjs']) {
    try {
      const st = await fs.lstat(base + ext)
      /* istanbul ignore next */
      if (st.isFile()) {
        return base + ext
      }
    } catch {
      // try next
    }
  }

  // If base is a directory, honour package.json#main then fall back to index.js.
  if (baseStat && baseStat.isDirectory()) {
    try {
      const pkgJson = JSON.parse(await fs.readFile(path.join(base, 'package.json'), 'utf8'))
      if (pkgJson.main) {
        const mainPath = path.resolve(base, pkgJson.main)
        const mainRel = path.relative(packageDir, mainPath)
        if (!mainRel.startsWith('..') && !path.isAbsolute(mainRel)) {
          try {
            const mainSt = await fs.lstat(mainPath)
            if (mainSt.isFile()) {
              return mainPath
            }
          } catch {
            // package.json#main points to a missing file; fall through to index.js
          }
        }
      }
    } catch {
      // no package.json or unparseable — fall through to index.js
    }
    try {
      const idxSt = await fs.lstat(path.join(base, 'index.js'))
      /* istanbul ignore next */
      if (idxSt.isFile()) {
        return path.join(base, 'index.js')
      }
    } catch {
      // no index.js either
    }
  }

  return null
}

// --- Lifecycle command parser -------------------------------------------

// Shell control operator regex — used for signal-pattern matching only.
// `&&` is listed before `&` so that the two-character sequence is matched as a
// unit before the single-character alternative can consume the first `&`.
const SHELL_OPS_RE = /&&|&|\|\||;|\|/

// Quote-aware shell operator splitter.  Unlike SHELL_OPS_RE.split(), this
// function skips over shell operators that appear inside single- or
// double-quoted strings so that `node -e "..."` patterns are not broken up.
// Double-quoted strings honour \" escapes; single-quoted strings are verbatim.
// Handles the common case of `node -e "code with || and ; inside"`.
const splitOnShellOps = (cmd) => {
  const parts = []
  let current = ''
  let i = 0
  while (i < cmd.length) {
    const ch = cmd[i]
    if (ch === '"' || ch === "'") {
      // Consume a quoted string without splitting on operators inside it.
      const quote = ch
      current += ch
      i++
      while (i < cmd.length && cmd[i] !== quote) {
        if (quote === '"' && cmd[i] === '\\' && i + 1 < cmd.length) {
          current += cmd[i] + cmd[i + 1]
          i += 2
        } else {
          current += cmd[i]
          i++
        }
      }
      if (i < cmd.length) {
        current += cmd[i]  // closing quote
        i++
      }
    } else if (cmd[i] === '&' && i + 1 < cmd.length && cmd[i + 1] === '&') {
      parts.push(current); current = ''; i += 2
    } else if (cmd[i] === '|' && i + 1 < cmd.length && cmd[i + 1] === '|') {
      parts.push(current); current = ''; i += 2
    } else if (cmd[i] === ';' || cmd[i] === '|' || cmd[i] === '&') {
      parts.push(current); current = ''; i++
    } else {
      current += cmd[i]
      i++
    }
  }
  if (current) parts.push(current)
  return parts
}

// Shell-aware tokenizer: splits a command string on unquoted whitespace while
// preserving spaces inside single- or double-quoted strings and stripping the
// outer quote characters from each token.  Handles \" escapes inside double
// quotes.  Single-quoted tokens are taken verbatim (no escape processing),
// matching POSIX sh behaviour.
const shellTokenize = (str) => {
  const tokens = []
  let token = ''
  let i = 0
  while (i < str.length) {
    const ch = str[i]
    if (ch === '"' || ch === "'") {
      const quote = ch
      i++
      while (i < str.length && str[i] !== quote) {
        /* istanbul ignore next -- backslash escapes in double-quoted args are rare in lifecycle scripts */
        if (quote === '"' && str[i] === '\\' && i + 1 < str.length) {
          i++ // consume backslash, keep the next character
          token += str[i]
        } else {
          token += str[i]
        }
        i++
      }
      i++ // consume closing quote
    } else if (/\s/.test(ch)) {
      /* istanbul ignore else -- consecutive spaces produce an empty token; skip silently */
      if (token.length > 0) {
        tokens.push(token)
        token = ''
      }
      i++
    } else {
      token += ch
      i++
    }
  }
  if (token.length > 0) {
    tokens.push(token)
  }
  return tokens
}

// Parse a single atomic sub-command (no shell operators) for local file references.
// Accepts either a raw command string (tokenized internally) or a pre-tokenized
// array of strings (used by the env/cross-env/bare-env and bash-c handlers when
// they have already split the command, so that filenames with spaces are not lost
// by a round-trip through join(' ') + shellTokenize).
// Returns Array<{ filePath: string, type: 'js'|'shell'|'other' }>
const parseSingleCommand = (cmdOrParts, packageDir) => {
  const parts = Array.isArray(cmdOrParts)
    ? cmdOrParts
    : shellTokenize(cmdOrParts.trim())
  if (!parts.length) {
    return []
  }
  const interpreter = parts[0]

  const makeEntry = (rel, type) => {
    const abs = path.resolve(packageDir, rel)
    const relCheck = path.relative(packageDir, abs)
    // Only include if the file is inside the package directory.
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
      return null
    }
    return { filePath: abs, type }
  }

  // Returns true when a module specifier looks like a local file path rather
  // than an npm package name (e.g. `./preload.js`, `../lib/helper`, `setup.mjs`).
  const isLocalSpecifier = (s) =>
    s.startsWith('./') || s.startsWith('../') || /\.(js|mjs|cjs|ts)$/.test(s)

  // bun run <file> / deno run <file> — `run` is a subcommand, not the script file.
  // Recurse after stripping the subcommand so the node-like handler below picks up the file.
  if ((interpreter === 'bun' || interpreter === 'deno') && parts[1] === 'run') {
    return parseSingleCommand([interpreter, ...parts.slice(2)], packageDir)
  }

  // node / nodejs / TypeScript runners: node install.js, node ./scripts/build.js,
  // ts-node install.ts, tsx ./scripts/build.ts
  // bun: bun install.js, bun ./scripts/build.ts
  // deno: deno ./scripts/build.ts (after `run` subcommand stripped above)
  if (interpreter === 'node' || interpreter === 'nodejs' ||
    interpreter === 'ts-node' || interpreter === 'ts-node-esm' ||
    interpreter === 'ts-node-cjs' || interpreter === 'tsx' ||
    interpreter === 'bun' || interpreter === 'deno') {
    const files = []
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i]
      // -e / --eval / -p / --print means inline code – there is no separate
      // script file, but the inline code may itself require/import local files.
      // shellTokenize() already stripped outer quotes, so parts[i+1] is the
      // raw code string ready to scan for local refs.
      if (part === '-e' || part === '--eval' || part === '-p' || part === '--print') {
        /* istanbul ignore else */
        if (i + 1 < parts.length) {
          const code = parts[i + 1]
          for (const ref of findLocalRefs(code)) {
            const entry = makeEntry(ref, 'js')
            /* istanbul ignore else */
            if (entry) {
              files.push(entry)
            }
          }
        }
        return files
      }
      // --require / -r (CJS), --import (ESM), and --loader / --experimental-loader
      // (custom module hooks) each take a module specifier as their next argument.
      // If that specifier is a local path, queue it for scanning.
      if (part === '-r' || part === '--require' || part === '--import' ||
        part === '--loader' || part === '--experimental-loader') {
        if (i + 1 < parts.length) {
          const specifier = parts[++i]
          if (isLocalSpecifier(specifier)) {
            const entry = makeEntry(specifier, 'js')
            if (entry) {
              files.push(entry)
            }
          }
        }
        continue
      }
      // Handle equals-form flags: --require=./preload.js, --import=./preload.mjs,
      // --loader=./loader.mjs, --experimental-loader=./loader.mjs
      const eqMatch = /^--(?:require|import|loader|experimental-loader)=(.+)$/.exec(part)
      if (eqMatch) {
        const specifier = eqMatch[1]
        if (isLocalSpecifier(specifier)) {
          const entry = makeEntry(specifier, 'js')
          if (entry) {
            files.push(entry)
          }
        }
        continue
      }
      if (part.startsWith('-')) {
        continue
      }
      // Accept .js/.mjs/.cjs/.ts or relative-looking paths as the main script.
      // Once the main script is found we stop — anything after it on the command
      // line is an argument to the script, not a Node.js option.
      if (isLocalSpecifier(part)) {
        const entry = makeEntry(part, 'js')
        if (entry) {
          files.push(entry)
        }
        return files
      }
      // Non-simple bare names (special chars, no '/') are unlikely to be local
      // scripts – skip them.  But if there IS a '/' we must not skip: it means
      // a subdirectory path (see below).
      if (!part.includes('/') && !/^[a-zA-Z0-9-]+$/.test(part)) {
        break
      }
      // Bare module name or subdirectory path that is a local script.
      // Examples: `node install`  (bare),  `node install/check`  (subdir).
      // Unscoped npm package names cannot legally contain '/', so any non-@
      // specifier with '/' is always a local path even without a './' prefix
      // (e.g. sharp's `node install/check`, mist's `script/install-ninja.js`).
      if (!part.startsWith('@')) {
        const entry = makeEntry(part, 'js')
        /* istanbul ignore next */
        if (entry) {
          files.push(entry)
        }
        return files
      }
      break
    }
    return files
  }

  // Shell invocations: bash setup.sh, sh ./scripts/build.sh
  // -c flag: the next argument is an inline shell command — re-parse it for local
  // file references instead of treating the command text as a script filename.
  // shellTokenize() already stripped the outer quotes from the -c argument, so
  // parts[i+1] is the raw inner command ready to parse.
  if (['bash', 'sh', 'zsh', 'dash'].includes(interpreter)) {
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i]
      if (p === '-c') {
        /* istanbul ignore else */
        if (i + 1 < parts.length) {
          return parseCommandFile(parts[i + 1], packageDir)
        }
        return []
      }
      if (!p.startsWith('-')) {
        const entry = makeEntry(p, 'shell')
        return entry ? [entry] : []
      }
    }
    return []
  }

  // Direct executable: ./scripts/build.sh, ./bin/postinstall.js
  if (interpreter.startsWith('./') || interpreter.startsWith('../')) {
    const type = /\.(sh|bash|zsh)$/.test(interpreter) ? 'shell' : 'other'
    const entry = makeEntry(interpreter, type)
    return entry ? [entry] : []
  }

  // Direct executable without './' prefix: script/install-ninja.js, install/check.sh
  // Unscoped npm package names cannot contain '/', so a non-@ path with '/'
  // that reaches this point is always a local file being run directly.
  if (!interpreter.startsWith('@') && interpreter.includes('/')) {
    const type = /\.(sh|bash|zsh)$/.test(interpreter) ? 'shell' : 'other'
    const entry = makeEntry(interpreter, type)
    return entry ? [entry] : []
  }

  // `env` wrapper: env [options] [KEY=VALUE ...] interpreter [args]
  // Skip past env's own flags and any KEY=VALUE environment assignments to find
  // the real interpreter and delegate back to parseSingleCommand.
  if (interpreter === 'env') {
    let start = 1
    while (start < parts.length) {
      const p = parts[start]
      // env flags (e.g. -i, -u, -S, --) or KEY=VALUE assignments.
      // Matches standard POSIX variable names ([A-Za-z_][A-Za-z0-9_]*).
      if (p.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(p)) {
        start++
      } else {
        break
      }
    }
    if (start < parts.length) {
      return parseSingleCommand(parts.slice(start), packageDir)
    }
    return []
  }

  // `cross-env` wrapper: cross-env [KEY=VALUE ...] interpreter [args]
  // cross-env only passes KEY=VALUE assignments — no flags of its own.
  if (interpreter === 'cross-env') {
    let start = 1
    while (start < parts.length) {
      const p = parts[start]
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(p)) {
        start++
      } else {
        break
      }
    }
    if (start < parts.length) {
      return parseSingleCommand(parts.slice(start), packageDir)
    }
    return []
  }

  // Bare inline env assignment(s) without an explicit wrapper:
  //   NODE_ENV=production node install.js
  //   DEBUG=1 NODE_OPTIONS=--inspect node ./build.js
  // The shell evaluates leading KEY=VALUE tokens as env assignments and then
  // runs the remainder as a command.  Skip them and delegate to parseSingleCommand.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(interpreter)) {
    let start = 0
    while (start < parts.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[start])) {
      start++
    }
    if (start < parts.length) {
      return parseSingleCommand(parts.slice(start), packageDir)
    }
    return []
  }

  return []
}

// Extracts local file references from a lifecycle command string, handling
// shell pipelines and control operators (&&, ||, ;, |).  Each sub-command is
// parsed independently using a quote-aware split (splitOnShellOps) so that
// operators inside quoted strings — e.g. `node -e "code with || and ;"` — are
// not mistakenly treated as command boundaries.
// Returns Array<{ filePath: string, type: 'js'|'shell'|'other' }>
const parseCommandFile = (cmd, packageDir) => {
  const trimmed = cmd.trim()
  if (!trimmed) {
    return []
  }

  const subCommands = splitOnShellOps(trimmed)
  const seen = new Set()
  const results = []

  for (const sub of subCommands) {
    for (const entry of parseSingleCommand(sub, packageDir)) {
      if (!seen.has(entry.filePath)) {
        seen.add(entry.filePath)
        results.push(entry)
      }
    }
  }

  return results
}

// --- File scanner -------------------------------------------------------

// Recursively scan a file and its local dependencies.
// `scanned` tracks already-visited absolute paths (cycle guard + dedup).
//
// Files are read in CHUNK_SIZE chunks so that peak memory stays constant
// regardless of file size.  If a file exceeds MAX_SCAN_BYTES the scan stops
// early: `sha256` reflects the hash of the bytes that were read (not the
// whole file), and the `file-too-large` signal is emitted to alert reviewers
// that the file was not fully analysed.
const scanFile = async (filePath, reason, packageDir, depth, scanned, results, maxDepth, maxFiles = Infinity) => {
  if (scanned.size >= maxFiles) return
  if (scanned.has(filePath)) {
    // File already scanned — reuse the cached result with the new reason so the
    // caller sees the relationship without re-reading the file.
    // The null guard handles the theoretical in-progress marker: all scans are
    // sequential awaits so this branch cannot be reached in practice.
    const cached = scanned.get(filePath)
    /* istanbul ignore else */
    if (cached) {
      results.push({ ...cached, reason })
    }
    return
  }
  // Mark as in-progress (null) before any async work so that circular local
  // references don't cause infinite recursion.
  scanned.set(filePath, null)

  // Guard: only open regular files.  Symlinks are rejected to prevent
  // following a link that escapes the package directory; special files
  // (named pipes, device nodes) are rejected to avoid blocking on a
  // read that never returns EOF.
  //
  // When the initial lstat misses (e.g. `node ./bin/post-install` where the
  // file on disk is `bin/post-install.js`), try common JS extensions before
  // giving up — matching the resolution logic in resolveLocalRef.
  let entryStat
  try {
    entryStat = await fs.lstat(filePath)
  } catch {
    // lstat failure — try with JS extensions below
  }

  if (!entryStat || !entryStat.isFile()) {
    // Only try extensions if there isn't already one (avoid double-extending).
    if (!path.extname(filePath)) {
      for (const ext of ['.js', '.mjs', '.cjs']) {
        const candidate = filePath + ext
        // Security: candidate must remain inside the package directory.
        const candidateRel = path.relative(packageDir, candidate)
        /* istanbul ignore next */
        if (candidateRel.startsWith('..') || path.isAbsolute(candidateRel)) {
          continue
        }
        try {
          const st = await fs.lstat(candidate)
          /* istanbul ignore else */
          if (st.isFile()) {
            // Re-enter scanFile with the resolved path so the full scan runs.
            // The original extensionless path gets an alias entry so callers
            // still see it under the name extracted from the lifecycle script.
            scanned.set(filePath, null) // keep the in-progress marker
            await scanFile(candidate, reason, packageDir, depth, scanned, results, maxDepth, maxFiles)
            // Mirror the result under the original path so the scanned map
            // doesn't leave a dangling null if someone looks it up later.
            scanned.set(filePath, scanned.get(candidate))
            return
          }
        } catch {
          // try next extension
        }
      }
    }
    const entry = {
      path: toPosix(path.relative(packageDir, filePath)),
      reason,
      sha256: null,
      sizeBytes: null,
      signals: ['file-unreadable'],
      references: [],
    }
    scanned.set(filePath, entry)
    results.push(entry)
    return
  }

  const hash = crypto.createHash('sha256')
  const foundSignals = new Set()
  const foundRefs = new Set()
  const foundExecPathRefs = new Set()
  const foundUrls = new Map()   // url string → { url, classification }
  let bytesScanned = 0
  let partial = false

  // JSON files (e.g. package.json required as data) are not executable code.
  // Running signal patterns on them produces false positives: dependency names
  // like "napi-postinstall" match binary-download, and metadata fields like
  // "homepage"/"funding" match external-url.  Hash them for integrity but skip
  // signal and URL extraction.
  const isJson = path.extname(filePath).toLowerCase() === '.json'

  // Open the file and stream it chunk by chunk.
  let fh
  try {
    fh = await fs.open(filePath, 'r')
    const buf = Buffer.alloc(CHUNK_SIZE)
    // `overlap` carries the tail of the previous chunk so that patterns
    // straddling a boundary between two reads are not missed.
    let overlap = ''
    while (true) {
      /* istanbul ignore next -- bottom-of-loop check fires first; top guard is defensive */
      if (bytesScanned >= MAX_SCAN_BYTES) {
        /* istanbul ignore next */
        partial = true
        /* istanbul ignore next */
        break
      }
      const toRead = Math.min(CHUNK_SIZE, MAX_SCAN_BYTES - bytesScanned)
      const { bytesRead } = await fh.read(buf, 0, toRead, bytesScanned)
      if (bytesRead === 0) {
        break
      }
      hash.update(buf.subarray(0, bytesRead))
      if (!isJson) {
        const chunk = buf.toString('utf8', 0, bytesRead)
        const window = overlap + chunk
        for (const sig of detectSignals(window)) {
          foundSignals.add(sig)
        }
        for (const ref of findLocalRefs(window)) {
          foundRefs.add(ref)
        }
        for (const ref of findExecPathRefs(window)) {
          foundExecPathRefs.add(ref)
        }
        for (const url of findExternalUrls(window)) {
          // Classify every URL and store the result alongside the URL string.
          // We keep ALL URLs (including 'reference' ones) so downstream consumers
          // (JSON formatter, suggestion script) can see the full picture and decide
          // what to show.  The 'external-url' signal is only emitted when at least
          // one URL is not a pure reference, so license/homepage URLs in code do
          // not inflate the signal count.
          if (!foundUrls.has(url)) {
            foundUrls.set(url, { url, classification: classifyUrl(url) })
          }
        }
        overlap = chunk.length > CHUNK_OVERLAP ? chunk.slice(-CHUNK_OVERLAP) : chunk
      }
      bytesScanned += bytesRead
      if (bytesScanned >= MAX_SCAN_BYTES) {
        partial = true
        break
      }
    }
  } catch {
    // File could not be opened or read — fh is closed by the finally block below.
    const entry = {
      path: toPosix(path.relative(packageDir, filePath)),
      reason,
      sha256: null,
      sizeBytes: null,
      signals: ['file-unreadable'],
      references: [],
    }
    scanned.set(filePath, entry)
    results.push(entry)
    return
  } finally {
    if (fh) {
      await fh.close().catch(/* istanbul ignore next */() => { })
    }
  }

  // When the scan cap was hit the hash covers only the scanned portion of the
  // file, but it is still useful for identifying the content that was read.
  // Flag the file prominently so the reviewer knows coverage is incomplete.
  if (partial) {
    foundSignals.add('file-too-large')
  }

  const signals = [...foundSignals]
  const localRefs = [...foundRefs]
  const urls = [...foundUrls.values()]   // [{ url, classification }, ...]
  const references = []

  if (localRefs.length > 0) {
    signals.push('requires-local-file')
  }

  // external-url fires only when at least one URL is not a pure reference
  // (homepage, license, funding page).  Reference URLs are preserved in
  // entry.urls for JSON consumers but are not security-relevant signals.
  if (urls.some((u) => u.classification !== 'reference')) {
    signals.push('external-url')
  }

  // Resolve and record local references.
  for (const ref of localRefs) {
    const resolved = await resolveLocalRef(filePath, ref, packageDir)
    if (resolved) {
      references.push(toPosix(path.relative(packageDir, resolved)))
    }
  }

  // When the depth cap prevents following local imports, emit a signal so
  // the reviewer knows coverage is incomplete for this file.
  if (depth >= maxDepth && localRefs.length > 0) {
    signals.push('depth-limit-reached')
  }

  const entry = {
    path: toPosix(path.relative(packageDir, filePath)),
    reason,
    sha256: hash.digest('hex'),
    sizeBytes: bytesScanned,
    signals,
    references,
    urls,
  }
  scanned.set(filePath, entry)
  results.push(entry)

  // Recurse into local references, if we haven't hit the depth limit.
  if (depth < maxDepth) {
    for (const ref of localRefs) {
      const resolved = await resolveLocalRef(filePath, ref, packageDir)
      if (resolved) {
        await scanFile(
          resolved,
          `required by ./${toPosix(path.relative(packageDir, filePath))}`,
          packageDir,
          depth + 1,
          scanned,
          results,
          maxDepth,
          maxFiles
        )
      }
    }
    // exec-path refs are package-root-relative (the cwd passed to spawn).
    // Resolve them from packageDir, not from the current file's directory.
    for (const ref of foundExecPathRefs) {
      // Simulate fromFile at the package root so resolveLocalRef resolves from there.
      const fakeFrom = path.join(packageDir, '_exec_path_ref_')
      const resolved = await resolveLocalRef(fakeFrom, ref, packageDir)
      if (resolved) {
        const refPosix = toPosix(path.relative(packageDir, resolved))
        if (!references.includes(refPosix)) {
          references.push(refPosix)
        }
        await scanFile(
          resolved,
          `spawned via process.execPath from ./${toPosix(path.relative(packageDir, filePath))}`,
          packageDir,
          depth + 1,
          scanned,
          results,
          maxDepth,
          maxFiles
        )
      }
    }
  }
}

// Add 'files-limit-reached' signal to the most-recently-added result when
// the scan was cut short by maxFiles; this mirrors the 'depth-limit-reached'
// signal so reviewers know coverage is incomplete.
// Called from scanPackageScripts after all scanFile calls complete.
const maybeSignalFilesLimitReached = (scanned, results, maxFiles) => {
  if (scanned.size >= maxFiles && results.length > 0) {
    const last = results[results.length - 1]
    if (last && !last.signals.includes('files-limit-reached')) {
      last.signals.push('files-limit-reached')
    }
  }
}

// --- Inline command scanner --------------------------------------------

// Scan the raw lifecycle command string for risk signals.
// This catches obfuscated payloads embedded directly in the command (e.g.
// `node -e '[][(![]+[])[+[]]+...]'`), which parseSingleCommand skips because
// there is no local file to walk.
const scanInlineCommand = (event, cmd, results) => {
  const signals = detectSignals(cmd)
  // Extract unquoted URLs from the command string (e.g. --base-url=https://...).
  // Classify each URL — keep all of them so JSON consumers see the full picture.
  // The external-url signal fires only for non-reference URLs.
  const urlMap = new Map()
  UNQUOTED_URL_RE.lastIndex = 0
  let m
  while ((m = UNQUOTED_URL_RE.exec(cmd)) !== null) {
    const url = m[1].replace(/[.,;:]+$/, '')
    if (!urlMap.has(url)) {
      urlMap.set(url, { url, classification: classifyUrl(url) })
    }
  }
  const urls = [...urlMap.values()]
  if (urls.some((u) => u.classification !== 'reference') && !signals.includes('external-url')) {
    signals.push('external-url')
  }
  if (signals.length === 0) {
    return
  }
  results.push({
    path: null,
    reason: `inline lifecycle script: \`${event}\``,
    sha256: null,
    sizeBytes: null,
    signals,
    references: [],
    urls,
  })
}

// --- Public API ---------------------------------------------------------

// When a lifecycle command invokes a git-hook manager (husky, lefthook), the
// hook scripts it registers may themselves contain build-relevant or risky
// commands.  This function enumerates the hook directories so those scripts
// are scanned recursively — just like any other explicitly referenced file.
//
// Directories checked per manager:
//   .husky/   — husky v4 + v8+ hook scripts (one shell file per git hook event)
//   .lefthook/ — lefthook local hook scripts
//
// The husky internal shim directory (.husky/_) is skipped because it only
// contains the husky.sh runtime helper, not user-defined hook logic.
const GIT_HOOK_MANAGER_RE = /\bhusky\b|\blefthook\b/

const findGitHookScripts = async (cmd, packageDir) => {
  if (!GIT_HOOK_MANAGER_RE.test(cmd)) return []

  const hookDirs = []
  if (/\bhusky\b/.test(cmd)) hookDirs.push({ dir: path.join(packageDir, '.husky'), skip: '_', recurse: false })
  if (/\blefthook\b/.test(cmd)) hookDirs.push({ dir: path.join(packageDir, '.lefthook'), skip: null, recurse: true })

  const files = []
  for (const { dir, skip, recurse } of hookDirs) {
    try {
      for (const name of await fs.readdir(dir)) {
        if (skip && name === skip) continue
        const abs = path.join(dir, name)
        try {
          const st = await fs.lstat(abs)
          if (st.isFile()) {
            files.push(abs)
          } else if (recurse && st.isDirectory()) {
            // lefthook local hooks nest scripts under .lefthook/<hook-name>/<script>
            try {
              for (const subname of await fs.readdir(abs)) {
                const subabs = path.join(abs, subname)
                try {
                  const subst = await fs.lstat(subabs)
                  if (subst.isFile()) files.push(subabs)
                } catch { /* ignore unreadable sub-entries */ }
              }
            } catch { /* subdirectory unreadable */ }
          }
        } catch { /* ignore unreadable entries */ }
      }
    } catch { /* hook dir does not exist in this package */ }
  }
  return files
}

// Read the package's own package.json and extract napi-rs binding metadata.
// Returns { napiPackageName } when present, or null.
const readNapiMeta = async (packageDir) => {
  try {
    const raw = await fs.readFile(path.join(packageDir, 'package.json'), 'utf8')
    const pkg = JSON.parse(raw)
    const napiPackageName = pkg?.napi?.packageName ?? null
    return napiPackageName ? { napiPackageName } : null
  } catch {
    return null
  }
}

// Scan a package directory for risk signals triggered by its lifecycle scripts.
//
// @param {string} packageDir   Absolute path to the package under node_modules.
// @param {Object} scripts      The package's lifecycle scripts object.
// @param {Object} [opts]       Optional options.
// @param {number} [opts.maxFiles=Infinity]  Stop BFS after this many unique files to
//                              prevent runaway scans on very large compiled bundles.
//                              When the cap is hit a 'files-limit-reached' signal is
//                              emitted on the last file so reviewers know coverage is
//                              incomplete.
// @param {number} [opts.maxDepth=MAX_DEPTH]  Override the recursion depth cap for
//                              following local require() chains.
// @returns {Promise<Array>}    Array of { path, reason, sha256, signals, references }.
const scanPackageScripts = async (packageDir, scripts, { maxFiles = Infinity, maxDepth = MAX_DEPTH } = {}) => {
  if (!packageDir || !scripts || typeof scripts !== 'object') {
    return []
  }

  const results = []
  const scanned = new Map()

  for (const [event, cmd] of Object.entries(scripts)) {
    // Always scan the raw command string itself — catches obfuscated payloads
    // (JSFuck, hex sequences, eval calls) embedded directly in the lifecycle
    // command without a separate file (e.g. `node -e '...'`).
    scanInlineCommand(event, cmd, results)

    const files = parseCommandFile(cmd, packageDir)
    for (const { filePath } of files) {
      const reason = `referenced by lifecycle script: \`${event}\``
      await scanFile(filePath, reason, packageDir, 0, scanned, results, maxDepth, maxFiles)
    }

    // Follow git-hook manager invocations into their hook script directories.
    // Hook scripts may contain build-relevant commands (native builds, network
    // fetches, etc.) that the scanner should surface, even when the lifecycle
    // command itself is just `husky` or `lefthook install`.
    const hookFiles = await findGitHookScripts(cmd, packageDir)
    for (const hookPath of hookFiles) {
      const reason = `git hook configured by lifecycle script: \`${event}\``
      await scanFile(hookPath, reason, packageDir, 0, scanned, results, maxDepth, maxFiles)
    }
    maybeSignalFilesLimitReached(scanned, results, maxFiles)
  }

  // If any file triggered binary-download, read napi metadata from the
  // package's own package.json so the report can declare which binding
  // package is being installed (e.g. @unrs/resolver-binding).
  if (results.some((r) => r.signals.includes('binary-download'))) {
    const napiMeta = await readNapiMeta(packageDir)
    if (napiMeta) {
      for (const entry of results) {
        if (entry.signals.includes('binary-download')) {
          entry.napiPackageName = napiMeta.napiPackageName
        }
      }
    }
  }

  return results
}

module.exports = scanPackageScripts
module.exports.detectSignals = detectSignals
module.exports.findLocalRefs = findLocalRefs
module.exports.findBareRefs = findBareRefs
module.exports.findExecPathRefs = findExecPathRefs
module.exports.parseCommandFile = parseCommandFile
module.exports.SIGNAL_PATTERNS = SIGNAL_PATTERNS
