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
        // Package-level rebuild invocations — yarn/pnpm/npm rebuild triggers
        // node-gyp on packages with native addons (e.g. eas-cli prepack).
        /\byarn\s+rebuild\b/,
        /\bnpm\s+rebuild\b/,
        /\bpnpm\s+rebuild\b/,
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
  //
  // Note: packages that bundle a binary inside the tarball and chmod+x it
  // (without a network fetch) are classified separately as 'bundled-binary-installer'
  // below.  Both indicators may fire together when a package both downloads
  // a binary AND makes it executable.
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
      triggeredByMakesExecutableSignal: false,
    },
    signals: {
      onFound: ['binary-download'],
      onWarning: [],
    },
    scanner: { type: 'none' },
  },

  // -------------------------------------------------------------------------
  // Bundled binary activator — packages that ship a pre-compiled binary inside
  // the npm tarball and make it executable at install time (chmod +x / fs.chmod
  // with an execute bit).  No network fetch occurs; the binary is already on
  // disk after `npm install`.
  //
  // This is distinct from 'binary-downloader' (which fetches the binary from a
  // remote URL) and from 'native-build' (which compiles from source).  Both
  // 'binary-downloader' and 'bundled-binary-installer' may fire together for
  // packages that download a binary AND then make it executable.
  //
  // Supply-chain risk: the bundled binary bypasses npm's integrity checks for
  // individual files within the tarball.  Reviewers should check the binary
  // origin, verify any provided checksum, and confirm the package is from a
  // trustworthy publisher.
  //
  // Why 'makes-executable' is the right trigger: a telemetry POST, a JSON config
  // download, or a docs URL reference never needs to flip the execute bit.  Its
  // presence is strong evidence that a file meant to be run is being activated.
  // -------------------------------------------------------------------------
  'bundled-binary-installer': {
    label: 'Bundled binary activator',
    detect: {
      commandPatterns: [],
      triggeredByNativeBuildSignal: false,
      triggeredByBinaryDownloadSignal: false,
      triggeredByRuntimeInstallerSignal: false,
      triggeredByExternalUrlSignal: false,
      triggeredByMakesExecutableSignal: true,
    },
    signals: {
      onFound: ['activates-bundled-binary'],
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
  //
  // Low-confidence: a URL in lifecycle code does NOT by itself confirm that a
  // binary or source archive is downloaded.  It may be a telemetry endpoint, a
  // CDN for JSON config, a release-notes link, or similar.  Reviewers should
  // examine the URLs and surrounding code before drawing conclusions.
  // For higher-confidence network-binary classification see 'binary-downloader'.
  // For bundled-binary activation (chmod+x without a network fetch) see
  // 'bundled-binary-installer'.
  'source-downloader': {
    label: 'Lifecycle script URL fetch',
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
  // Bower — a front-end package manager from the same Grunt/Gulp era.
  // Running `bower install` inside a postinstall script is a supply-chain
  // concern: it installs additional packages from the Bower registry at
  // install time, outside of npm's lockfile and integrity checks.
  // The indicator file is bower.json (the Bower manifest).
  // -------------------------------------------------------------------------
  'bower.json': {
    label: 'Bower front-end package manager',
    detect: {
      commandPatterns: [
        /\bbower\s+(?:install|update|prune|link)\b/,
        /\bbower-installer\b/,
      ],
      triggeredByNativeBuildSignal: false,
    },
    signals: {
      onFound: ['runtime-installer'],
      onWarning: [],
    },
    scanner: {
      type: 'generic',
      steps: [
        // bower.json "name" field — identifies the package being managed.
        { type: 'regex', pattern: /"name"\s*:\s*"([^"]+)"/, group: 1,
          label: 'Bower package name' },
        // bower.json "dependencies" keys — packages installed from Bower registry.
        { type: 'regex-all',
          pattern: /"dependencies"\s*:\s*\{([^}]+)\}/s, group: 1,
          label: 'Bower dependencies' },
        // Bower registry endpoint — if overridden it may point to a private/malicious source.
        { type: 'regex',
          pattern: /"registry"\s*:\s*"([^"]+)"/, group: 1,
          label: 'Bower registry endpoint (non-default = extra scrutiny)' },
      ],
    },
  },

  // -------------------------------------------------------------------------
  // Brunch — a JavaScript build tool / assembler from the Grunt/Gulp era.
  // Config file is brunch-config.js (or .coffee/.ts).  Less common today but
  // still appears in legacy packages.  Its `compile` and `build` commands run
  // arbitrary plugin chains that can execute native code.
  // -------------------------------------------------------------------------
  'brunch-config.js': {
    label: 'Brunch build tool config',
    detect: {
      commandPatterns: [
        /\bbrunch\s+(?:build|compile|watch|test)\b/,
        /\bbrunch-cli\b/,
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
        // Plugin declarations — brunch plugins can execute native compilation.
        { type: 'regex-all',
          pattern: /plugins\s*:\s*\{([^}]+)\}/s, group: 1,
          label: 'Brunch plugins configured' },
        // Native/download tool invocations if referenced in config.
        { type: 'regex-all',
          pattern: /\b(node-gyp|cmake|make|cargo|curl|wget|python[23]?)\b/g, group: 1,
          label: 'External tools referenced in brunch config' },
        { type: 'glob', pattern: 'brunch-config.{js,coffee,ts}', label: 'Brunch config variants', maxDisplay: 5 },
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

  // -------------------------------------------------------------------------
  // Gulp — a streaming JavaScript task runner widely used for native addon
  // compilation, asset processing, and build orchestration.  Gulp v3 registers
  // tasks with gulp.task(); Gulp v4 exports them as named functions.  Its
  // presence in a lifecycle script means the gulpfile defines tasks that
  // can compile, copy, or run arbitrary shell commands.
  // -------------------------------------------------------------------------
  'gulpfile.js': {
    label: 'Gulp task runner script',
    detect: {
      commandPatterns: [
        /\bgulp\b/,
        /\bgulp-cli\b/,
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
        // Gulp v3 task registrations.
        { type: 'regex-all',
          pattern: /gulp\.task\s*\(\s*['"]([^'"]+)['"]/g, group: 1,
          label: 'Registered Gulp tasks (v3 API)' },
        // Gulp v4 exports are regular JS exports — extract function/const names.
        { type: 'regex-all',
          pattern: /exports\.([A-Za-z_$][\w$]*)\s*=/g, group: 1,
          label: 'Exported Gulp tasks (v4 API)' },
        // External native/download tool calls inside the gulpfile.
        { type: 'regex-all',
          pattern: /\b(node-gyp|cmake|cmake-js|make|nmake|cargo|cc|curl|wget|python[23]?)\b/g, group: 1,
          label: 'External tools invoked in gulpfile' },
        // Child process spawns — exec/spawn calls reveal what the task actually runs.
        { type: 'regex-all',
          pattern: /(?:exec|spawn|execSync|spawnSync)\s*\(\s*['"]([^'"]+)['"]/g, group: 1,
          label: 'Child processes spawned' },
        { type: 'glob', pattern: 'gulpfile.{js,ts,mjs,cjs,coffee}', label: 'Gulpfile variants', maxDisplay: 5 },
      ],
    },
  },

  // -------------------------------------------------------------------------
  // Jake — a JavaScript Make-like task runner (similar to Rake for Ruby).
  // Less common than Grunt/Gulp but occasionally appears in older native addon
  // packages as the build orchestrator invoked from postinstall.
  // -------------------------------------------------------------------------
  'Jakefile': {
    label: 'Jake task runner script',
    detect: {
      commandPatterns: [
        /\bjake\b/,
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
        // Jake task/file/directory declarations.
        { type: 'regex-all',
          pattern: /(?:^|\s)(?:task|file|directory)\s*\(\s*['"]([^'"]+)['"]/gm, group: 1,
          label: 'Jake tasks' },
        // Native/download tool invocations inside the Jakefile.
        { type: 'regex-all',
          pattern: /\b(node-gyp|cmake|make|cargo|cc|curl|wget|python[23]?)\b/g, group: 1,
          label: 'External tools invoked in Jakefile' },
        { type: 'glob', pattern: 'Jakefile{,.js,.coffee}', label: 'Jakefile variants', maxDisplay: 5 },
      ],
    },
  },

  // -------------------------------------------------------------------------
  // Cakefile — CoffeeScript task runner (the CoffeeScript equivalent of Make/
  // Rake).  Task definitions are `task 'name', -> ...`.  Found in older npm
  // packages that were originally CoffeeScript projects.
  // Require a subcommand to avoid the common English word "cake".
  // -------------------------------------------------------------------------
  'Cakefile': {
    label: 'Cake (CoffeeScript) task runner script',
    detect: {
      commandPatterns: [
        /\bcake\s+(?:build|install|compile|all|native|setup|clean)\b/,
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
        // Cake task declarations.
        { type: 'regex-all',
          pattern: /^task\s+['"]([^'"]+)['"]/gm, group: 1,
          label: 'Cake tasks' },
        // Native/download tool invocations inside the Cakefile.
        { type: 'regex-all',
          pattern: /\b(node-gyp|cmake|make|cargo|curl|wget|python[23]?)\b/g, group: 1,
          label: 'External tools invoked in Cakefile' },
      ],
    },
  },

  // -------------------------------------------------------------------------
  // Rakefile — Ruby's Make equivalent.  Occasionally appears in npm packages
  // that wrap native C/C++/Ruby extensions, where the Rakefile drives the
  // native compilation step.
  // Require a subcommand to avoid false positives from 'rake' in prose.
  // -------------------------------------------------------------------------
  'Rakefile': {
    label: 'Rake (Ruby Make) build script',
    detect: {
      commandPatterns: [
        /\brake\s+(?:install|build|compile|all|native|setup|clean|default)\b/,
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
        // Rake task declarations — `task :name` or `task name: :dep`.
        { type: 'regex-all',
          pattern: /^task\s+:([A-Za-z_][\w]*)/gm, group: 1,
          label: 'Rake tasks' },
        // Native/download tool invocations inside the Rakefile.
        { type: 'regex-all',
          pattern: /\b(node-gyp|cmake|make|cc|gcc|g\+\+|curl|wget|python[23]?|gem|bundle)\b/g, group: 1,
          label: 'External tools invoked in Rakefile' },
        { type: 'glob', pattern: 'Rakefile{,.rb}', label: 'Rakefile variants', maxDisplay: 5 },
      ],
    },
  },

  // -------------------------------------------------------------------------
  // Taskfile.yml — the go-task task runner (https://taskfile.dev), a modern
  // YAML-based alternative to Make with cross-platform shell support.  Growing
  // usage in native addon packages as a readable alternative to Makefiles.
  // Require a specific subcommand to avoid false positives from the generic
  // word "task" used in prose or Windows CLI tools (tasklist, taskkill).
  // -------------------------------------------------------------------------
  'Taskfile.yml': {
    label: 'Taskfile (go-task) task runner',
    detect: {
      commandPatterns: [
        /\btask\s+(?:install|build|compile|all|native|setup|rebuild|clean|default)\b/,
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
        // YAML task names appear as top-level keys under `tasks:`.
        { type: 'regex-all',
          pattern: /^\s{2}([A-Za-z_-][\w-]*):/gm, group: 1,
          label: 'Taskfile tasks' },
        // Native/download tool invocations in task commands.
        { type: 'regex-all',
          pattern: /\b(node-gyp|cmake|make|cargo|cc|curl|wget|python[23]?)\b/g, group: 1,
          label: 'External tools invoked in Taskfile' },
        { type: 'glob', pattern: 'Taskfile.{yml,yaml}', label: 'Taskfile variants', maxDisplay: 5 },
      ],
    },
  },

  // -------------------------------------------------------------------------
  // Just — a command runner (like Make but simpler) used as a build
  // orchestration tool for native addons and other install-time tasks.
  // A Justfile in a package defines recipes that can compile C/C++/Rust,
  // download binaries, or run arbitrary shell commands.
  // -------------------------------------------------------------------------
  'Justfile': {
    label: 'Just task runner script',
    detect: {
      commandPatterns: [
        // Match 'just <subcommand>' — require a word after 'just' to avoid
        // false positives from the common English word "just".
        /\bjust\s+(?:install|build|compile|all|native|setup|run|rebuild)\b/,
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
        // Recipe declarations (just equivalent of Makefile targets).
        { type: 'regex-all',
          pattern: /^(@?[\w-]+)\s*:/gm, group: 1,
          label: 'Just recipes (tasks)' },
        // Native/download tool calls inside recipes.
        { type: 'regex-all',
          pattern: /\b(node-gyp|cmake|cmake-js|cargo|make|curl|wget|python[23]?)\b/g, group: 1,
          label: 'External tools invoked in Justfile' },
        { type: 'glob', pattern: 'Justfile', label: 'Justfile', maxDisplay: 2 },
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
// Task runners (grunt, gulp, brunch) are included because their presence in a
// lifecycle script is a strong signal that a build or native compilation step
// is being orchestrated, even if the runner itself is not a compiler.
//
// The negative lookbehind (?<!/) prevents false positives when node-gyp appears
// inside a regex pattern (/node-gyp|gyp ERR/.test(stderr)) or a path-like string
// (gcc/node-gyp) — both common in error-handling code.  Command positions
// ("node-gyp rebuild", '"install": "node-gyp rebuild"', "&& node-gyp build")
// are unaffected because they are not preceded by /.
const NATIVE_BUILD_COMMAND_PATTERN =
  /(?<!\/)\bnode-gyp\b(?!\s*\|)|\bnode-gyp-build\b|\bnode-gyp-build-optional-packages\b|binding\.gyp|\bnode-pre-gyp\b|\bprebuild-install\b|\bprebuildify\b|\bcmake-js\b|\bnapi\s+build\b|\bneon\s+build\b|\belectron-rebuild\b|\belectron-build-env\b|\bprebuild\b|\.\/configure\b|\bgrunt\b|\bgulp\b|\bbrunch\b/

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
  'make-build':        'Makefile or task-runner driven build (Grunt/Gulp/Jake/Cake/Rake/Brunch/Taskfile) that can execute arbitrary shell commands',
  'binary-download':   'Downloads a pre-built binary at install time (node-pre-gyp, prebuild-install, etc.)',
  'activates-bundled-binary': 'Makes a file bundled inside the npm tarball executable (chmod +x / fs.chmod with execute bit)',
  'runtime-installer': 'Installs additional packages at runtime via npm/pnpm/yarn/bower install as a child process',
  'external-url':      'Fetches a URL (curl/wget/node https) at install time',
  'source-downloader': 'Fetches source code (curl/wget/git clone) at install time',
  'obfuscation-pattern': 'Uses Base64/hex decoding or eval/Function() to hide executed code',
}

module.exports = { INDICATOR_REGISTRY, NATIVE_BUILD_COMMAND_PATTERN, SIGNAL_DESCRIPTIONS }
