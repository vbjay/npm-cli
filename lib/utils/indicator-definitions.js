// Build indicator registry.
//
// Each entry describes ONE kind of build indicator — a file whose presence
// during `npm install` (or a related lifecycle hook) means a reviewer should
// go look at it.  The registry is intentionally broad: it covers native binary
// builds, WebAssembly compilation, Android/iOS native modules, Makefile-driven
// builds, and anything else that warrants human review before approving a
// lifecycle script.
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
//            — all unique captures; if presence:true, emits 'yes' instead.
//          { type: 'glob',      pattern, label, maxDisplay? }
//            — files in the package directory matching pattern (POSIX paths).
//          { type: 'signal',    pattern, signal }
//            — emits `signal` when pattern matches the file content.
//              Used for conditional classifier signals (e.g. 'wasm-build'
//              only when wasm-bindgen is present in Cargo.toml).
//
// Adding support for a new build tool:
//   1. Add one entry to INDICATOR_REGISTRY below.
//   2. If it warrants the 'native-build' signal, add its command patterns to
//      NATIVE_BUILD_COMMAND_PATTERN at the bottom too.
//   No scanner engine code changes needed unless the file format requires a
//   new built-in scanner type.
//
// Signal discipline:
//   Each indicator should emit the MOST SPECIFIC signal for its build type:
//     'native-build' — compiles a native binary (.node addon, .so, .dylib)
//     'wasm-build'   — compiles a WebAssembly (.wasm) module
//     'android-native' — Android JNI/NDK native module
//     'make-build'   — Makefile-driven build (arbitrary commands)
//   Companion files that add context to an already-detected build (build.rs,
//   CMakePresets.json) use onFound: [] — the signal is emitted exactly once.

const INDICATOR_REGISTRY = {
  // -------------------------------------------------------------------------
  // GYP — the most common native-addon build system in the npm ecosystem.
  //
  // Covers the standard node-gyp toolchain plus all wrapper tools that
  // ultimately invoke gyp under the hood:
  //   node-gyp          — direct gyp invocation
  //   node-gyp-build    — loads a prebuilt or falls back to gyp rebuild
  //                       (bcrypt, leveldown, ffi-napi, ref-napi, argon2, …)
  //   node-pre-gyp /
  //   @mapbox/node-pre-gyp — fetches a prebuilt tarball or rebuilds
  //   prebuild-install  — prebuild download/fallback
  //   prebuildify       — creates prebuilt binaries for distribution
  //   electron-rebuild  — rebuilds .node addons for the Electron ABI
  //   electron-build-env — wraps npm commands to target Electron headers
  //   cmake-js          — CMake-based gyp alternative
  //   prebuild (legacy) — original prebuild CLI
  //   pkg-prebuilds-verify — checks prebuilts, falls back to gyp rebuild
  //   todesktop-node-gyp-build — ToDesktop variant of node-gyp-build
  // -------------------------------------------------------------------------
  'binding.gyp': {
    label: 'GYP build descriptor',
    detect: {
      commandPatterns: [
        /\bnode-gyp\b/,
        /binding\.gyp/,
        /\bnode-gyp-build\b/,
        /\bnode-gyp-build-optional-packages\b/,
        /\btodesktop-node-gyp-build\b/,
        /\bpkg-prebuilds-verify\b/,
        /\bnode-pre-gyp\b/,
        /\@mapbox\/node-pre-gyp\b/,
        /\@xprofiler\/node-pre-gyp\b/,
        /\bprebuild-install\b/,
        /\bprebuildify\b/,
        /\bcmake-js\b/,
        /\belectron-rebuild\b/,
        /\belectron-build-env\b/,
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

  // -------------------------------------------------------------------------
  // Rust — covers both native addons (napi-rs / neon → .node) and WASM
  // modules (wasm-pack → .wasm).  The 'wasm-build' signal is emitted
  // conditionally by the 'signal' scanner step when wasm-bindgen is present,
  // so the reviewer gets the right classifier for each case.
  // -------------------------------------------------------------------------
  'Cargo.toml': {
    label: 'Rust build descriptor',
    detect: {
      commandPatterns: [
        /\bnapi\s+build\b/,
        /\bneon\s+build\b/,
        /\bcargo\s+build\b/,
        /\bwasm-pack\b/,
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
        { type: 'regex', pattern: /^name\s*=\s*"([^"]+)"/m,    group: 1, label: 'Crate name' },
        { type: 'regex', pattern: /^version\s*=\s*"([^"]+)"/m, group: 1, label: 'Crate version' },
        // build = "build.rs" (or custom name) — a build script runs at compile time.
        { type: 'regex',
          pattern: /^build\s*=\s*"([^"]+)"/m, group: 1,
          label: 'Build script (runs at compile time)' },
        // crate-type tells the reviewer whether the output is a .node addon (cdylib)
        // or something else (rlib, staticlib, …).
        { type: 'regex',
          pattern: /^crate-type\s*=\s*\[([^\]]+)\]/m, group: 1,
          label: 'Crate output type' },
        // Well-known native-build toolchain crates — presence means C/C++ code is compiled.
        { type: 'regex-all',
          pattern: /\b(cc|bindgen|cmake|pkg-config|system-deps|vcpkg|cxx-build|autocxx|cbindgen)\s*=/gm,
          group: 1, label: 'Native build toolchain crates (C/C++ compilation)' },
        { type: 'regex-all',
          pattern: /^\[(?:build-)?dependencies\]/m,
          group: 0, label: 'Has build/runtime dependencies', presence: true },
        // wasm-bindgen presence — output is a .wasm module, not a native .node addon.
        // The 'signal' step below emits the 'wasm-build' classifier signal when this fires.
        { type: 'regex-all',
          pattern: /\bwasm-bindgen\b/, group: 0,
          label: 'wasm-bindgen dependency (output is a .wasm module, not a native addon)',
          presence: true },
        // web-sys imports — the specific browser/Node.js APIs this WASM module calls.
        // Reviewers should check for network (fetch/XHR/WebSocket), storage, and crypto APIs.
        { type: 'regex',
          pattern: /\bweb-sys\s*=\s*\{[^}]*features\s*=\s*\[([^\]]+)\]/s,
          group: 1, label: 'web-sys browser/Node.js APIs imported' },
        // js-sys — direct access to JS built-ins (eval, Function, Reflect, etc.).
        { type: 'regex-all',
          pattern: /\bjs-sys\b/, group: 0,
          label: 'js-sys imported (direct JavaScript built-in access — includes eval, Function, Reflect)',
          presence: true },
        // wasm-bindgen-futures — async WASM↔JS bridge, spawns JS promises from Rust.
        { type: 'regex-all',
          pattern: /\bwasm-bindgen-futures\b/, group: 0,
          label: 'wasm-bindgen-futures (async WASM ↔ JS bridge — spawns JS promises from Rust)',
          presence: true },
        // Conditional classifier signal: wasm-build fires only when wasm-bindgen is present.
        { type: 'signal', pattern: /\bwasm-bindgen\b/, signal: 'wasm-build' },
        { type: 'glob', pattern: 'src/**/*.rs', label: 'Rust source files', maxDisplay: 20 },
      ],
    },
  },

  // -------------------------------------------------------------------------
  // Rust build script — present when Cargo.toml declares `build = "build.rs"`.
  // This file runs at cargo-build time and often compiles C/C++ sources via
  // cc-rs, generates FFI bindings via bindgen, or links system libraries.
  //
  // onFound: [] — Cargo.toml already emits native-build + rust-native; this
  // entry adds scanner detail without double-counting the signal.
  // -------------------------------------------------------------------------
  'build.rs': {
    label: 'Rust build script',
    detect: {
      commandPatterns: [],  // discovered through Cargo.toml detection, not directly
      triggeredByNativeBuildSignal: true,
    },
    signals: {
      onFound: [],
      onWarning: [],
    },
    scanner: {
      type: 'generic',
      steps: [
        // .file("foo.c") calls in cc::Build — enumerate every C/C++ file compiled.
        { type: 'regex-all',
          pattern: /\.file\s*\(\s*"([^"]+\.[cC][cCxXpP+]*)"/g,
          group: 1, label: 'C/C++ sources compiled via cc-rs' },
        // .header("wrapper.h") calls in bindgen::Builder — what C API is being wrapped.
        { type: 'regex-all',
          pattern: /\.header\s*\(\s*"([^"]+\.h[a-z]*)"/g,
          group: 1, label: 'C headers wrapped by bindgen' },
        // pkg_config::probe_library("libname") — system library lookups.
        { type: 'regex-all',
          pattern: /probe_library\s*\(\s*"([^"]+)"/g,
          group: 1, label: 'System libraries via pkg-config' },
        // cargo:rustc-link-lib directives — explicit link instructions.
        { type: 'regex-all',
          pattern: /cargo:rustc-link-lib=(?:(?:static|dylib|framework)=)?([A-Za-z][\w-]*)/g,
          group: 1, label: 'Libraries linked' },
        // cmake::build / cmake::Config::new — CMake package compilation.
        { type: 'regex-all',
          pattern: /cmake::(?:build|Config::new)\s*\(\s*"([^"]+)"/g,
          group: 1, label: 'CMake packages invoked' },
      ],
    },
  },

  // -------------------------------------------------------------------------
  // CMake — used directly by cmake-js and some native addons without gyp.
  // -------------------------------------------------------------------------
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
        { type: 'regex-all',
          pattern: /\btarget_link_libraries\s*\(\s*\S+[^)]*\b([A-Za-z][\w:-]*)\s*\)/g,
          group: 1, label: 'Linked libraries' },
        { type: 'regex-all',
          pattern: /\bfind_package\s*\(\s*([A-Za-z]\w*)/g,
          group: 1, label: 'CMake packages required' },
        { type: 'glob', pattern: '**/*.{c,cc,cpp,cxx}', label: 'C/C++ source files', maxDisplay: 30 },
      ],
    },
  },

  // -------------------------------------------------------------------------
  // CMake build presets — companion to CMakeLists.txt.
  // Describes named build configurations (Debug/Release), generators, and
  // cache variables.  Only investigated when CMake activity is already detected.
  //
  // onFound: [] — CMakeLists.txt already emits native-build.
  // -------------------------------------------------------------------------
  'CMakePresets.json': {
    label: 'CMake build presets',
    detect: {
      commandPatterns: [
        /\bcmake-js\b/,
        /\bcmake\b/,
      ],
      triggeredByNativeBuildSignal: true,
    },
    signals: {
      onFound: [],
      onWarning: [],
    },
    scanner: {
      type: 'generic',
      steps: [
        { type: 'regex-all',
          pattern: /"name"\s*:\s*"([^"]+)"/g, group: 1,
          label: 'Preset names' },
        { type: 'regex-all',
          pattern: /"generator"\s*:\s*"([^"]+)"/g, group: 1,
          label: 'CMake generators' },
      ],
    },
  },

  // -------------------------------------------------------------------------
  // Autoconf — used by older C/C++ packages and some libraries that wrap
  // system code with ./configure + make.  Finding configure.ac is definitive
  // proof of a native build; no other file type is created by autoconf.
  // -------------------------------------------------------------------------
  'configure.ac': {
    label: 'Autoconf build configuration',
    detect: {
      commandPatterns: [
        /\.\/configure\b/,
        /\bautoconf\b/,
        /\bautomake\b/,
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
        // AC_CHECK_LIB(libname, ...) — system libraries the build probes for.
        { type: 'regex-all',
          pattern: /AC_CHECK_LIB\s*\(\s*\[?([^\],\s)]+)/g, group: 1,
          label: 'System libraries probed (AC_CHECK_LIB)' },
        // PKG_CHECK_MODULES(VAR, pkg-spec) — pkg-config module requirements.
        // The first arg may be bare (VAR) or bracket-quoted ([VAR]) per autoconf convention.
        { type: 'regex-all',
          pattern: /PKG_CHECK_MODULES\s*\(\s*\[?\w+\]?\s*,\s*([^)]+)/g, group: 1,
          label: 'pkg-config modules required' },
        // AC_CHECK_PROG(var, prog, ...) — external programs required to build.
        { type: 'regex-all',
          pattern: /AC_CHECK_PROG\s*\(\s*\w+\s*,\s*([^\s,)]+)/g, group: 1,
          label: 'External programs required' },
        { type: 'glob', pattern: '**/*.{c,cc,cpp,cxx,h}', label: 'C/C++ source files', maxDisplay: 20 },
      ],
    },
  },

  // -------------------------------------------------------------------------
  // Android native module — React Native and other cross-platform packages
  // that include JNI/NDK C/C++ code alongside a Gradle build descriptor.
  // The scanner also surfaces the iOS companion files (podspec, ObjC/Swift)
  // since most React Native native modules ship both platforms together.
  // -------------------------------------------------------------------------
  'android/build.gradle': {
    label: 'Android native module',
    detect: {
      commandPatterns: [
        /\bexpo-module\b/,              // Expo native module CLI (React Native libs)
        /\bgradlew?\b/,                 // direct Gradle invocation
        /\breact-native\s+build-android\b/,
        /\bbob\s+build\b/,              // react-native-builder-bob (compiles TS + bundles for RN)
        /\bcap\s+(?:build|sync|open|run)\b/, // Capacitor CLI (Ionic cross-platform native modules)
      ],
      triggeredByNativeBuildSignal: false,
    },
    signals: {
      onFound: ['android-native'],
      onWarning: [],
    },
    scanner: {
      type: 'generic',
      steps: [
        // Android SDK versions tell the reviewer what Android API levels are targeted.
        { type: 'regex-all',
          pattern: /(?:compileSdkVersion|minSdkVersion|targetSdkVersion)\s+(\d+)/g, group: 0,
          label: 'Android SDK configuration' },
        // externalNativeBuild block means C/C++ code is compiled via CMake or ndk-build.
        { type: 'regex-all',
          pattern: /externalNativeBuild\s*\{/, group: 0, presence: true,
          label: 'Contains C/C++ native code (externalNativeBuild — CMake or ndk-build)' },
        // abiFilters — which CPU architectures the native library targets.
        { type: 'regex-all',
          pattern: /abiFilters\s+([^\n]+)/g, group: 1,
          label: 'Target CPU architectures (abiFilters)' },
        // Android library dependencies — reviewer should verify each is expected.
        { type: 'regex-all',
          pattern: /(?:implementation|api|compileOnly)\s+['"]([^'"]+)['"]/g, group: 1,
          label: 'Android dependencies' },
        // CMake or ndk-build descriptor path — links to the C/C++ build file.
        { type: 'regex-all',
          pattern: /path\s+['"]([^'"]+(?:CMakeLists\.txt|Android\.mk))['"]/g, group: 1,
          label: 'Native build descriptor path' },
        // iOS companion: podspec at package root describes the CocoaPods pod.
        { type: 'glob', pattern: '*.podspec', label: 'iOS pod specification', maxDisplay: 3 },
        // iOS native source files (ObjC / Swift / headers).
        { type: 'glob', pattern: 'ios/**/*.{m,mm,swift,h}', label: 'iOS native sources', maxDisplay: 20 },
        // JNI C/C++ source files alongside the Gradle build.
        { type: 'glob', pattern: 'android/**/*.{c,cpp,cc,h}', label: 'JNI C/C++ sources', maxDisplay: 20 },
      ],
    },
  },

  // -------------------------------------------------------------------------
  // Makefile — generic build driver.  Only triggered when the lifecycle script
  // explicitly invokes make with a recognisable target or flag so that broad
  // TypeScript / docs Makefiles don't fire false positives.
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // Prebuilt binary downloader — packages that fetch a compiled binary from
  // a remote URL at install time instead of building from source.  There is
  // no indicator file to inspect; detection is purely command-pattern-based.
  // The scanner type 'none' tells investigate() to return immediately without
  // trying to read a file.
  //
  // Supply-chain risk: the binary is fetched from the internet and executed
  // without verification unless the install script checks a checksum or uses
  // a signed URL.  Reviewers should verify the download source and whether
  // integrity is validated.
  // -------------------------------------------------------------------------
  'binary-downloader': {
    label: 'Prebuilt binary downloader',
    detect: {
      commandPatterns: [
        /\binstall.?binary\b/i,    // install-binary.js / installBinary / install_binary
        /\bdownload.?binary\b/i,   // download-binary.js / downloadBinary
        /\bbin.?wrapper\b/i,       // bin-wrapper helper (wraps a downloaded binary)
        /\bffmpeg.install\b/i,     // @ffmpeg-installer and similar ffmpeg fetch scripts
        /\bbin\s+install\b/i,      // e.g. "node lib/tool.js bin install latest" (cloudflared pattern)
      ],
      triggeredByNativeBuildSignal: false,
      triggeredByBinaryDownloadSignal: true,
    },
    signals: {
      onFound: ['binary-download'],
      onWarning: [],
    },
    scanner: { type: 'none' },
  },

  // Virtual indicator: no file on disk — triggered purely by the runtime-installer
  // signal detected in lifecycle script files.  Matches any package whose postinstall
  // (or a file it requires) calls npm/yarn/pnpm install as a child process at install
  // time — a supply-chain concern regardless of whether the package is otherwise benign.
  'runtime-installer': {
    label: 'Runtime package installer',
    detect: {
      commandPatterns: [
        // Inline node -e that calls execSync/spawnSync to run npm/pnpm/yarn install or rebuild
        /node\s+-e\s+["'].*(?:execSync|spawnSync).*(?:install|rebuild)/,
        /node\s+-e\s+["'].*(?:install|rebuild).*(?:execSync|spawnSync)/,
      ],
      triggeredByNativeBuildSignal: false,
      triggeredByBinaryDownloadSignal: false,
      triggeredByRuntimeInstallerSignal: true,
    },
    signals: {
      onFound: ['runtime-installer'],
      onWarning: [],
    },
    scanner: { type: 'none' },
  },

  // Virtual indicator: no file on disk — triggered when at least one scanned
  // lifecycle file contains a non-reference external URL (download, CDN, registry,
  // release archive).  Covers packages like source-build wrappers (opencv-build)
  // that download tarballs from GitHub and binary shims (instar) that fetch
  // prebuilt releases — patterns not matched by binary-downloader's file heuristics.
  'source-downloader': {
    label: 'External source or binary downloader',
    detect: {
      commandPatterns: [
        /\bcurl\s+.*\bhttps?:\/\//,     // curl <url>
        /\bwget\s+.*\bhttps?:\/\//,     // wget <url>
      ],
      triggeredByNativeBuildSignal: false,
      triggeredByBinaryDownloadSignal: false,
      triggeredByRuntimeInstallerSignal: false,
      triggeredByExternalUrlSignal: true,
    },
    signals: {
      onFound: ['external-url'],
      onWarning: [],
    },
    scanner: { type: 'none' },
  },

  'Makefile': {
    label: 'Makefile build script',
    detect: {
      commandPatterns: [
        /\bmake\s+(?:all|install|build|release|native)\b/,
        /\b(?:nmake|gmake)\b/,
        /\bmake\s+-[BCfj]\b/,   // make -C <dir>, -B (force rebuild), -f <file>, -j (parallel)
      ],
      triggeredByNativeBuildSignal: false,
    },
    signals: {
      onFound: ['make-build'],
      onWarning: [],
    },
    scanner: {
      type: 'generic',
      steps: [
        // CC/CXX variable at top of file — tells the reviewer which compiler is used.
        { type: 'regex-all',
          pattern: /^(?:CC|CXX)\s*[:?]?=\s*(.+)$/gm, group: 1,
          label: 'Compiler definitions (CC/CXX)' },
        // -l flags — explicit library links.
        { type: 'regex-all',
          pattern: /-l([A-Za-z][\w-]*)/g, group: 1,
          label: 'Libraries linked' },
        // External tool calls — curl/wget are especially notable (remote downloads).
        { type: 'regex-all',
          pattern: /\b(curl|wget|python[23]?|node|npm|pip[23]?)\b/g, group: 1,
          label: 'External tools invoked' },
        { type: 'glob', pattern: '**/*.{c,cc,cpp,cxx}', label: 'C/C++ source files', maxDisplay: 20 },
      ],
    },
  },

  // -------------------------------------------------------------------------
  // Grunt — a JavaScript task runner widely used in older npm packages for
  // native compilation, asset processing, and build orchestration.  Its
  // presence in a lifecycle script usually means the Gruntfile.js defines
  // compile / build / native tasks that warrants review.
  // -------------------------------------------------------------------------
  'Gruntfile.js': {
    label: 'Grunt build script',
    detect: {
      commandPatterns: [
        /\bgrunt\b/,
        /\bgrunt-cli\b/,
      ],
      triggeredByNativeBuildSignal: false,
    },
    signals: {
      onFound: ['make-build'],
      onWarning: [],
    },
    scanner: {
      type: 'generic',
      steps: [
        // Grunt tasks that indicate native compilation.
        { type: 'regex-all',
          pattern: /grunt\.registerTask\s*\(\s*['"]([^'"]+)['"]/g, group: 1,
          label: 'Registered Grunt tasks' },
        // External tool calls — native compilers, curl/wget, cmake, etc.
        { type: 'regex-all',
          pattern: /\b(node-gyp|cmake|cmake-js|make|nmake|curl|wget|python[23]?)\b/g, group: 1,
          label: 'External tools invoked in Gruntfile' },
        // Shell commands via grunt-shell, grunt-exec, grunt-run — these can run anything.
        { type: 'regex-all',
          pattern: /(?:shell|exec|run)\s*:\s*\{[^}]*command\s*:\s*['"]([^'"]+)['"]/g, group: 1,
          label: 'Shell commands executed via grunt-shell/grunt-exec/grunt-run' },
        { type: 'glob', pattern: 'Gruntfile.{js,coffee}', label: 'Gruntfile variants', maxDisplay: 5 },
      ],
    },
  },
}

// Consolidated command-pattern regexp used by script-risk-scanner.js to emit
// the 'native-build' signal for GYP/CMake/Rust/Autoconf commands.
// Also used by hasBuildHint() as a fast-path check before the per-registry
// pattern scan.  Must stay in sync with binding.gyp/CMakeLists.txt/Cargo.toml/
// configure.ac commandPatterns plus any patterns not backed by an indicator
// file (e.g. @mapbox/node-pre-gyp).
//
// The negative lookbehind (?<!/) prevents false positives when node-gyp appears
// inside a regex pattern (/node-gyp|gyp ERR/.test(stderr)) or a path-like string
// (gcc/node-gyp) — both common in error-handling code.  Command positions
// ("node-gyp rebuild", '"install": "node-gyp rebuild"', "&& node-gyp build")
// are unaffected because they are not preceded by /.
const NATIVE_BUILD_COMMAND_PATTERN =
  /(?<!\/)\bnode-gyp\b(?!\s*\|)|\bnode-gyp-build\b|\bnode-gyp-build-optional-packages\b|binding\.gyp|\bnode-pre-gyp\b|\bprebuild-install\b|\bprebuildify\b|\bcmake-js\b|\bnapi\s+build\b|\bneon\s+build\b|\belectron-rebuild\b|\belectron-build-env\b|\bprebuild\b|\.\/configure\b|\bgrunt\b/

// Human-readable descriptions for every signal name that appears in
// INDICATOR_REGISTRY.  Used by build-indicator-suggestions.js to populate the
// $ai.availableSignals field in the generated JSON — single source of truth so
// the builder code never needs to be updated when signals change here.
const SIGNAL_DESCRIPTIONS = {
  'native-build':      'Compiles a native binary (.node addon, .so, .dylib) via node-gyp, CMake, Autoconf, or similar',
  'rust-native':       'Compiles a Rust-backed native addon (Cargo.toml / neon)',
  'wasm-build':        'Compiles a WebAssembly (.wasm) module',
  'android-native':    'Android JNI/NDK native module',
  'gyp-conditions':    'binding.gyp has platform/arch conditions (may behave differently per OS)',
  'make-build':        'Makefile or task-runner driven build that can execute arbitrary shell commands',
  'binary-download':   'Downloads a pre-built binary at install time (node-pre-gyp, prebuild-install, etc.)',
  'runtime-installer': 'Invokes npm/pnpm/yarn install as a child process during its own install',
  'external-url':      'Fetches a URL (curl/wget/node https) at install time',
  'source-downloader': 'Fetches source code (curl/wget/git clone) at install time',
  'obfuscation-pattern': 'Uses Base64/hex decoding or eval/Function() to hide executed code',
}

module.exports = { INDICATOR_REGISTRY, NATIVE_BUILD_COMMAND_PATTERN, SIGNAL_DESCRIPTIONS }
