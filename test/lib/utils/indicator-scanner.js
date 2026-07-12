'use strict'
const t = require('tap')
const { mkdtemp, writeFile, mkdir, rm } = require('node:fs/promises')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const {
  hasBuildHint,
  scanBuildIndicators,
  scanBuildIndicatorsForPackage,
} = require('../../../lib/utils/indicator-scanner.js')

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const withPackage = async (t, files, fn) => {
  const dir = await mkdtemp(join(tmpdir(), 'npm-test-indicator-'))
  t.teardown(() => rm(dir, { recursive: true, force: true }))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel)
    await mkdir(join(abs, '..'), { recursive: true }).catch(() => {})
    await writeFile(abs, typeof content === 'string' ? content : JSON.stringify(content), 'utf8')
  }
  return fn(dir)
}

// Minimal registry entries for unit testing (isolated from live definitions)
const GYP = {
  'binding.gyp': {
    label: 'GYP build descriptor',
    detect: {
      commandPatterns: [/\bnode-gyp\b/],
      triggeredByNativeBuildSignal: true,
    },
    signals: { onFound: ['native-build'], onWarning: ['gyp-conditions'] },
    scanner: 'gyp',
  },
}

const CARGO = {
  'Cargo.toml': {
    label: 'Rust native addon',
    detect: {
      commandPatterns: [/\bnapi\s+build\b/],
      triggeredByNativeBuildSignal: false,
    },
    signals: { onFound: ['native-build', 'rust-native'], onWarning: [] },
    scanner: {
      type: 'generic',
      steps: [
        { type: 'regex', pattern: /^name\s*=\s*"([^"]+)"/m, group: 1, label: 'Crate name' },
        { type: 'glob',  pattern: 'src/**/*.rs', label: 'Rust source files' },
      ],
    },
  },
}

const CMAKE = {
  'CMakeLists.txt': {
    label: 'CMake build descriptor',
    detect: { commandPatterns: [/\bcmake-js\b/], triggeredByNativeBuildSignal: false },
    signals: { onFound: ['native-build'], onWarning: [] },
    scanner: {
      type: 'generic',
      steps: [
        { type: 'regex-all', pattern: /\badd_library\s*\(\s*(\S+)/g, group: 1, label: 'Native libraries' },
        { type: 'glob',      pattern: '**/*.{c,cc}', label: 'C/C++ source files' },
      ],
    },
  },
}

const PRESENCE = {
  'presence.txt': {
    label: 'Presence indicator',
    detect: { commandPatterns: [], triggeredByNativeBuildSignal: false },
    signals: { onFound: ['test-signal'], onWarning: [] },
    scanner: {
      type: 'generic',
      steps: [{
        type: 'regex-all', pattern: /\[dependencies\]/g,
        group: 0, label: 'Has dependencies section', presence: true,
      }],
    },
  },
}

// ---------------------------------------------------------------------------
// hasBuildHint
// ---------------------------------------------------------------------------

t.test('hasBuildHint: matches native-build command patterns', (t) => {
  t.ok(hasBuildHint({ install: 'node-gyp rebuild' }, []))
  t.ok(hasBuildHint({ install: 'prebuild-install' }, []))
  t.ok(hasBuildHint({ install: 'napi build' }, []))
  t.ok(hasBuildHint({ install: 'cmake-js rebuild' }, []))
  t.end()
})

t.test('hasBuildHint: fires on native-build signal in already-scanned file', (t) => {
  t.ok(hasBuildHint({ install: 'node install.js' }, [{ signals: ['native-build'] }]))
  t.end()
})

t.test('hasBuildHint: fires on makes-executable signal in already-scanned file', (t) => {
  t.ok(hasBuildHint({ install: 'node postinstall.js' }, [{ signals: ['makes-executable'] }]),
    'makes-executable signal triggers build hint (bundled-binary-installer pattern)')
  t.end()
})

t.test('hasBuildHint: false when no command match and no signal', (t) => {
  t.notOk(hasBuildHint({ install: 'node install.js' }, []))
  t.notOk(hasBuildHint({}, [{ signals: ['reads-process-env'] }]))
  t.end()
})

// ---------------------------------------------------------------------------
// Detect phase: disk-presence-only (no command hint)
// ---------------------------------------------------------------------------

t.test('scanBuildIndicators: finds indicator present on disk even with no command hint', async (t) => {
  await withPackage(t, { 'binding.gyp': JSON.stringify({ targets: [] }) }, async (dir) => {
    const results = await scanBuildIndicators(dir, GYP)
    t.equal(results.length, 1, 'binding.gyp found via disk check')
  })
})

t.test('scanBuildIndicators: returns empty when no indicator file on disk', async (t) => {
  await withPackage(t, {}, async (dir) => {
    const results = await scanBuildIndicators(dir, GYP)
    t.equal(results.length, 0, 'no results when indicator absent')
  })
})

// ---------------------------------------------------------------------------
// GYP scanner (instantiated only when binding.gyp detected)
// ---------------------------------------------------------------------------

t.test('GYP scanner: expands <(varname) reference in target_name from variables block', async (t) => {
  await withPackage(t, {
    'binding.gyp': JSON.stringify({
      variables: { module_name: 'node_sqlite3' },
      targets: [{
        target_name: '<(module_name)',
        sources: ['src/database.cc'],
      }],
    }),
  }, async (dir) => {
    const results = await scanBuildIndicators(dir, GYP)
    const sources = results[0].groups.find(g => g.label.includes('sources'))
    t.match(sources?.label, /node_sqlite3/, 'target name resolved from variables block')
    t.ok(sources?.items.includes('src/database.cc'))
  })
})

t.test('GYP scanner: leaves unresolvable <(varname) as literal when variable not in block', async (t) => {
  await withPackage(t, {
    'binding.gyp': JSON.stringify({
      targets: [{ target_name: '<(unknown_var)', sources: ['x.cc'] }],
    }),
  }, async (dir) => {
    const results = await scanBuildIndicators(dir, GYP)
    const sources = results[0].groups.find(g => g.label.includes('sources'))
    t.match(sources?.label, /<\(unknown_var\)/, 'unresolvable var kept as literal')
  })
})

t.test('GYP scanner: resolves variable declared with trailing % in variables block', async (t) => {
  await withPackage(t, {
    'binding.gyp': JSON.stringify({
      variables: { 'module_name%': 'my_module' },
      targets: [{ target_name: '<(module_name)', sources: ['src/x.cc'] }],
    }),
  }, async (dir) => {
    const results = await scanBuildIndicators(dir, GYP)
    const sources = results[0].groups.find(g => g.label.includes('sources'))
    t.match(sources?.label, /my_module/, 'variable with % suffix resolved correctly')
  })
})
t.test('GYP scanner: extracts sources, libraries, include dirs from binding.gyp', async (t) => {
  await withPackage(t, {
    'binding.gyp': JSON.stringify({
      targets: [{
        target_name: 'mymod',
        sources: ['src/mymod.cc', 'src/helper.cc'],
        libraries: ['-lpng'],
        include_dirs: ['include'],
      }],
    }),
  }, async (dir) => {
    const results = await scanBuildIndicators(dir, GYP)
    t.equal(results[0].indicatorFile, 'binding.gyp')
    t.ok(results[0].sha256?.length === 64, 'sha256 computed')
    t.equal(results[0].parseError, null)
    t.ok(results[0].signals.includes('native-build'))

    const sources = results[0].groups.find(g => g.label.includes('sources'))
    t.ok(sources?.items.includes('src/mymod.cc'))
    t.ok(sources?.items.includes('src/helper.cc'))

    const libs = results[0].groups.find(g => g.label.includes('libraries'))
    t.ok(libs?.items.includes('-lpng'))

    const incs = results[0].groups.find(g => g.label.includes('include'))
    t.ok(incs?.items.includes('include'))
  })
})

t.test('GYP scanner: emits gyp-conditions when target has platform conditions', async (t) => {
  await withPackage(t, {
    'binding.gyp': JSON.stringify({
      targets: [{
        target_name: 'mod',
        sources: ['src/mod.cc'],
        conditions: [['OS == "win"', { sources: ['src/win.cc'] }]],
      }],
    }),
  }, async (dir) => {
    const results = await scanBuildIndicators(dir, GYP)
    t.ok(results[0].signals.includes('gyp-conditions'), 'gyp-conditions emitted')
    const condGroup = results[0].groups.find(g => g.label.includes('conditions'))
    t.ok(condGroup, 'conditions group present')
  })
})

t.test('GYP scanner: sets parseError for invalid GYP file', async (t) => {
  await withPackage(t, { 'binding.gyp': 'not valid json or gyp {{ ' }, async (dir) => {
    const results = await scanBuildIndicators(dir, GYP)
    t.ok(results[0].parseError, 'parseError set for invalid GYP')
    t.ok(results[0].sha256, 'sha256 computed even for unparseable file')
  })
})

t.test('GYP scanner: returns no-targets group for empty targets array', async (t) => {
  await withPackage(t, { 'binding.gyp': JSON.stringify({ targets: [] }) }, async (dir) => {
    const results = await scanBuildIndicators(dir, GYP)
    t.equal(results[0].parseError, null)
    t.ok(results[0].groups.find(g => g.label === 'Targets'), 'fallback Targets group present')
  })
})

// ---------------------------------------------------------------------------
// Generic scanner (instantiated for Cargo.toml, CMakeLists.txt, etc.)
// ---------------------------------------------------------------------------

t.test('Generic scanner: regex step extracts single capture', async (t) => {
  await withPackage(t, {
    'Cargo.toml': '[package]\nname = "my-crate"\nversion = "0.1.0"\n',
  }, async (dir) => {
    const results = await scanBuildIndicators(dir, CARGO)
    t.ok(results[0].signals.includes('rust-native'))
    const nameGroup = results[0].groups.find(g => g.label === 'Crate name')
    t.equal(nameGroup?.items[0], 'my-crate')
  })
})

t.test('Generic scanner: regex step omits group when no match', async (t) => {
  await withPackage(t, { 'Cargo.toml': '# no name here\n' }, async (dir) => {
    const results = await scanBuildIndicators(dir, CARGO)
    t.notOk(results[0].groups.find(g => g.label === 'Crate name'), 'group absent when no match')
  })
})

t.test('Generic scanner: regex-all step extracts all unique captures', async (t) => {
  const cmake = 'add_library(mylib SHARED)\nadd_library(otherlib STATIC)\nadd_library(mylib SHARED)\n'
  await withPackage(t, { 'CMakeLists.txt': cmake }, async (dir) => {
    const results = await scanBuildIndicators(dir, CMAKE)
    const libGroup = results[0].groups.find(g => g.label === 'Native libraries')
    t.ok(libGroup?.items.includes('mylib'))
    t.ok(libGroup?.items.includes('otherlib'))
    t.equal(libGroup.items.filter(i => i === 'mylib').length, 1, 'duplicates deduplicated')
  })
})

t.test('Generic scanner: presence step emits yes when section found', async (t) => {
  await withPackage(t, { 'presence.txt': '[dependencies]\nsomething = "1.0"\n' }, async (dir) => {
    const results = await scanBuildIndicators(dir, PRESENCE)
    const g = results[0].groups.find(g => g.label === 'Has dependencies section')
    t.equal(g?.items[0], 'yes')
  })
})

t.test('Generic scanner: presence step omits group when section absent', async (t) => {
  await withPackage(t, { 'presence.txt': '[package]\nname = "x"\n' }, async (dir) => {
    const results = await scanBuildIndicators(dir, PRESENCE)
    t.notOk(results[0].groups.find(g => g.label === 'Has dependencies section'))
  })
})

t.test('Generic scanner: glob step lists matching files', async (t) => {
  await withPackage(t, {
    'Cargo.toml': '[package]\nname = "x"\n',
    'src/lib.rs': '// lib',
    'src/utils.rs': '// utils',
  }, async (dir) => {
    const results = await scanBuildIndicators(dir, CARGO)
    const globGroup = results[0].groups.find(g => g.label === 'Rust source files')
    t.ok(globGroup?.items.includes('src/lib.rs'))
    t.ok(globGroup?.items.includes('src/utils.rs'))
  })
})

t.test('Generic scanner: glob brace expansion finds multiple extensions', async (t) => {
  await withPackage(t, {
    'CMakeLists.txt': '',
    'src/native.c': '/* C */',
    'src/binding.cc': '/* C++ */',
  }, async (dir) => {
    const results = await scanBuildIndicators(dir, CMAKE)
    const globGroup = results[0].groups.find(g => g.label === 'C/C++ source files')
    t.ok(globGroup?.items.includes('src/native.c'))
    t.ok(globGroup?.items.includes('src/binding.cc'))
  })
})

// ---------------------------------------------------------------------------
// Multiple indicators in parallel
// ---------------------------------------------------------------------------

t.test('scanBuildIndicators: returns one result per found indicator file', async (t) => {
  await withPackage(t, {
    'binding.gyp': JSON.stringify({ targets: [] }),
    'Cargo.toml': '[package]\nname = "x"\n',
  }, async (dir) => {
    const results = await scanBuildIndicators(dir, { ...GYP, ...CARGO })
    t.equal(results.length, 2)
    t.ok(results.find(r => r.indicatorFile === 'binding.gyp'))
    t.ok(results.find(r => r.indicatorFile === 'Cargo.toml'))
  })
})

t.test('scanBuildIndicators: skips definition when file is absent', async (t) => {
  await withPackage(t, { 'binding.gyp': JSON.stringify({ targets: [] }) }, async (dir) => {
    const results = await scanBuildIndicators(dir, { ...GYP, ...CARGO })
    t.equal(results.length, 1)
    t.equal(results[0].indicatorFile, 'binding.gyp')
  })
})

// ---------------------------------------------------------------------------
// scanBuildIndicatorsForPackage — command + signal hints pre-populate clue set
// ---------------------------------------------------------------------------

t.test('scanBuildIndicatorsForPackage: command hint + disk file → scan runs', async (t) => {
  await withPackage(t, {
    'binding.gyp': JSON.stringify({ targets: [{ target_name: 'mod', sources: ['x.cc'] }] }),
  }, async (dir) => {
    const results = await scanBuildIndicatorsForPackage(
      dir, { install: 'node-gyp rebuild' }, [], GYP
    )
    t.equal(results.length, 1)
    t.equal(results[0].indicatorFile, 'binding.gyp')
  })
})

t.test('scanBuildIndicatorsForPackage: native-build signal + triggeredByNativeBuildSignal + disk file → scan runs', async (t) => {
  await withPackage(t, {
    'binding.gyp': JSON.stringify({ targets: [] }),
  }, async (dir) => {
    const results = await scanBuildIndicatorsForPackage(
      dir,
      { install: 'node install.js' },   // no command-pattern match
      [{ signals: ['native-build'] }],   // signal in scanned file
      GYP
    )
    t.equal(results.length, 1, 'scan runs because triggeredByNativeBuildSignal + file on disk')
  })
})

t.test('scanBuildIndicatorsForPackage: native-build signal without triggeredByNativeBuildSignal flag does NOT hint Cargo.toml', async (t) => {
  await withPackage(t, {
    'Cargo.toml': '[package]\nname = "x"\n',
  }, async (dir) => {
    // Cargo.toml entry has triggeredByNativeBuildSignal: false
    // But the file IS on disk, so disk check still finds it
    const results = await scanBuildIndicatorsForPackage(
      dir,
      { install: 'node install.js' },
      [{ signals: ['native-build'] }],
      CARGO
    )
    // Disk check finds the file regardless of the signal flag
    t.equal(results.length, 1, 'disk check finds Cargo.toml independently')
  })
})

t.test('scanBuildIndicatorsForPackage: makes-executable signal triggers bundled-binary-installer (none-scanner)', async (t) => {
  await withPackage(t, {}, async (dir) => {
    // Simulate @icp-sdk/ic-wasm pattern: postinstall.js that chmod+xs a bundled binary.
    // bundled-binary-installer has no indicator file on disk — it uses scanner type 'none'.
    const results = await scanBuildIndicatorsForPackage(
      dir,
      { postinstall: 'node postinstall.js' },
      [{ signals: ['makes-executable', 'writes-outside-package', 'reads-process-env'] }],
      INDICATOR_REGISTRY
    )
    const bundledResult = results.find(r => r.indicatorFile === 'bundled-binary-installer')
    t.ok(bundledResult, 'bundled-binary-installer triggered by makes-executable signal')
    t.ok(bundledResult.signals.includes('activates-bundled-binary'), 'activates-bundled-binary signal emitted')
    t.notOk(results.find(r => r.indicatorFile === 'binary-downloader'),
      'binary-downloader does NOT fire when only makes-executable is present (no download signal)')
  })
})

t.test('scanBuildIndicatorsForPackage: makes-executable alone triggers bundled-binary-installer (not binary-downloader)', async (t) => {
  await withPackage(t, {}, async (dir) => {
    const results = await scanBuildIndicatorsForPackage(
      dir,
      { postinstall: 'node setup.js' },
      [{ signals: ['makes-executable'] }],
      INDICATOR_REGISTRY
    )
    const bundledResult = results.find(r => r.indicatorFile === 'bundled-binary-installer')
    t.ok(bundledResult, 'bundled-binary-installer fires on makes-executable signal alone')
    t.notOk(results.find(r => r.indicatorFile === 'binary-downloader'),
      'binary-downloader does NOT fire without a binary-download signal')
  })
})

t.test('scanBuildIndicatorsForPackage: binary-download + makes-executable fires both indicators', async (t) => {
  await withPackage(t, {}, async (dir) => {
    const results = await scanBuildIndicatorsForPackage(
      dir,
      { postinstall: 'node install.js' },
      [{ signals: ['binary-download', 'makes-executable'] }],
      INDICATOR_REGISTRY
    )
    t.ok(results.find(r => r.indicatorFile === 'binary-downloader'),
      'binary-downloader fires when binary-download signal is present')
    t.ok(results.find(r => r.indicatorFile === 'bundled-binary-installer'),
      'bundled-binary-installer also fires when makes-executable is present')
  })
})

// ---------------------------------------------------------------------------
// Live definitions — new entries added to INDICATOR_REGISTRY
// ---------------------------------------------------------------------------

const { INDICATOR_REGISTRY, NATIVE_BUILD_COMMAND_PATTERN } =
  require('../../../lib/utils/indicator-definitions.js')

t.test('NATIVE_BUILD_COMMAND_PATTERN now matches node-gyp-build', (t) => {
  t.ok(NATIVE_BUILD_COMMAND_PATTERN.test('node-gyp-build'), 'node-gyp-build matched')
  t.ok(NATIVE_BUILD_COMMAND_PATTERN.test('cross-env ZERO_AR_DATE=1 node-gyp-build'), 'cross-env prefix ok')
  t.ok(NATIVE_BUILD_COMMAND_PATTERN.test('electron-rebuild'), 'electron-rebuild matched')
  t.ok(NATIVE_BUILD_COMMAND_PATTERN.test('electron-build-env npm run build'), 'electron-build-env matched')
  t.ok(NATIVE_BUILD_COMMAND_PATTERN.test('./configure --prefix=/usr'), './configure matched')
  t.end()
})

t.test('binding.gyp: node-gyp-build command pattern triggers detection', async (t) => {
  await withPackage(t, {
    'binding.gyp': JSON.stringify({ targets: [{ target_name: 'bcrypt_lib', sources: ['src/bcrypt.cc'] }] }),
  }, async (dir) => {
    const results = await scanBuildIndicatorsForPackage(
      dir, { install: 'node-gyp-build' }, [], INDICATOR_REGISTRY
    )
    t.equal(results.length, 1, 'binding.gyp scanned via node-gyp-build command')
    t.equal(results[0].indicatorFile, 'binding.gyp')
    const sources = results[0].groups.find(g => g.label.includes('sources'))
    t.ok(sources?.items.includes('src/bcrypt.cc'))
  })
})

t.test('binding.gyp: electron-rebuild command pattern triggers detection', async (t) => {
  await withPackage(t, {
    'binding.gyp': JSON.stringify({ targets: [{ target_name: 'robotjs', sources: ['src/robotjs.cc'] }] }),
  }, async (dir) => {
    const results = await scanBuildIndicatorsForPackage(
      dir, { install: 'electron-rebuild' }, [], INDICATOR_REGISTRY
    )
    t.equal(results.length, 1, 'binding.gyp scanned via electron-rebuild command')
  })
})

// --- build.rs scanner ---

const BUILD_RS = {
  'build.rs': {
    label: 'Rust build script',
    detect: { commandPatterns: [], triggeredByNativeBuildSignal: true },
    signals: { onFound: [], onWarning: [] },
    scanner: {
      type: 'generic',
      steps: [
        { type: 'regex-all', pattern: /\.file\s*\(\s*"([^"]+\.[cC][cCxXpP+]*)"/g, group: 1, label: 'C/C++ sources compiled via cc-rs' },
        { type: 'regex-all', pattern: /\.header\s*\(\s*"([^"]+\.h[a-z]*)"/g, group: 1, label: 'C headers wrapped by bindgen' },
        { type: 'regex-all', pattern: /probe_library\s*\(\s*"([^"]+)"/g, group: 1, label: 'System libraries via pkg-config' },
        { type: 'regex-all', pattern: /cargo:rustc-link-lib=(?:(?:static|dylib|framework)=)?([A-Za-z][\w-]*)/g, group: 1, label: 'Libraries linked' },
        { type: 'regex-all', pattern: /cmake::(?:build|Config::new)\s*\(\s*"([^"]+)"/g, group: 1, label: 'CMake packages invoked' },
      ],
    },
  },
}

t.test('build.rs: onFound emits no extra signals (Cargo.toml already signals native)', async (t) => {
  await withPackage(t, {
    'build.rs': 'fn main() { cc::Build::new().file("src/foo.c").compile("foo"); }',
  }, async (dir) => {
    const results = await scanBuildIndicators(dir, BUILD_RS)
    t.equal(results[0].signals.length, 0, 'no extra signals from build.rs alone')
  })
})

t.test('build.rs: scanner extracts cc-rs source files', async (t) => {
  const src = `
fn main() {
  cc::Build::new()
    .file("src/blake2b.c")
    .file("src/argon2.c")
    .compile("argon2");
}`
  await withPackage(t, { 'build.rs': src }, async (dir) => {
    const results = await scanBuildIndicators(dir, BUILD_RS)
    const g = results[0].groups.find(g => g.label.includes('C/C++ sources'))
    t.ok(g?.items.includes('src/blake2b.c'), 'blake2b.c extracted')
    t.ok(g?.items.includes('src/argon2.c'), 'argon2.c extracted')
  })
})

t.test('build.rs: scanner extracts bindgen header files', async (t) => {
  const src = `
fn main() {
  let _ = bindgen::Builder::default().header("wrapper.h").generate();
}`
  await withPackage(t, { 'build.rs': src }, async (dir) => {
    const results = await scanBuildIndicators(dir, BUILD_RS)
    const g = results[0].groups.find(g => g.label.includes('headers'))
    t.ok(g?.items.includes('wrapper.h'), 'header extracted')
  })
})

t.test('build.rs: scanner extracts pkg-config library probes', async (t) => {
  const src = `
fn main() {
  pkg_config::probe_library("libsodium").unwrap();
  pkg_config::probe_library("openssl").unwrap();
}`
  await withPackage(t, { 'build.rs': src }, async (dir) => {
    const results = await scanBuildIndicators(dir, BUILD_RS)
    const g = results[0].groups.find(g => g.label.includes('pkg-config'))
    t.ok(g?.items.includes('libsodium'), 'libsodium extracted')
    t.ok(g?.items.includes('openssl'), 'openssl extracted')
  })
})

t.test('build.rs: scanner extracts cargo:rustc-link-lib directives', async (t) => {
  const src = `
fn main() {
  println!("cargo:rustc-link-lib=ssl");
  println!("cargo:rustc-link-lib=static=crypto");
  println!("cargo:rustc-link-lib=framework=CoreFoundation");
}`
  await withPackage(t, { 'build.rs': src }, async (dir) => {
    const results = await scanBuildIndicators(dir, BUILD_RS)
    const g = results[0].groups.find(g => g.label.includes('Libraries linked'))
    t.ok(g?.items.includes('ssl'), 'ssl extracted')
    t.ok(g?.items.includes('crypto'), 'crypto extracted (static= stripped)')
    t.ok(g?.items.includes('CoreFoundation'), 'CoreFoundation extracted (framework= stripped)')
  })
})

t.test('build.rs: triggered by native-build signal from Cargo.toml detection', async (t) => {
  const registry = {
    ...CARGO,
    ...BUILD_RS,
  }
  await withPackage(t, {
    'Cargo.toml': '[package]\nname = "my-crate"\n\n[build-dependencies]\ncc = "1"',
    'build.rs': 'fn main() { cc::Build::new().file("src/foo.c").compile("foo"); }',
  }, async (dir) => {
    const results = await scanBuildIndicatorsForPackage(
      dir, { install: 'napi build --platform' }, [], registry
    )
    t.equal(results.length, 2, 'both Cargo.toml and build.rs scanned')
    const buildRs = results.find(r => r.indicatorFile === 'build.rs')
    t.ok(buildRs, 'build.rs result present')
    t.equal(buildRs.signals.length, 0, 'no double-counted signals from build.rs')
  })
})

// --- configure.ac scanner ---

const CONFIGURE_AC = {
  'configure.ac': {
    label: 'Autoconf build configuration',
    detect: { commandPatterns: [/\.\/configure\b/], triggeredByNativeBuildSignal: false },
    signals: { onFound: ['native-build'], onWarning: [] },
    scanner: {
      type: 'generic',
      steps: [
        { type: 'regex-all', pattern: /AC_CHECK_LIB\s*\(\s*\[?([^\],\s)]+)/g, group: 1, label: 'System libraries probed (AC_CHECK_LIB)' },
        { type: 'regex-all', pattern: /PKG_CHECK_MODULES\s*\(\s*\[?\w+\]?\s*,\s*([^)]+)/g, group: 1, label: 'pkg-config modules required' },
        { type: 'regex-all', pattern: /AC_CHECK_PROG\s*\(\s*\w+\s*,\s*([^\s,)]+)/g, group: 1, label: 'External programs required' },
      ],
    },
  },
}

t.test('configure.ac: ./configure command pattern fires native-build signal', async (t) => {
  const src = `AC_INIT([mylib],[1.0])\nAC_CHECK_LIB([ssl],[SSL_new])\nAC_OUTPUT\n`
  await withPackage(t, { 'configure.ac': src }, async (dir) => {
    const results = await scanBuildIndicatorsForPackage(
      dir, { install: './configure && make && make install' }, [], CONFIGURE_AC
    )
    t.equal(results.length, 1)
    t.ok(results[0].signals.includes('native-build'), 'native-build emitted')
    const libs = results[0].groups.find(g => g.label.includes('AC_CHECK_LIB'))
    t.ok(libs?.items.includes('ssl'), 'ssl library extracted')
  })
})

t.test('configure.ac: scanner extracts PKG_CHECK_MODULES entries', async (t) => {
  const src = `PKG_CHECK_MODULES([OPENSSL], [openssl >= 1.1])\nPKG_CHECK_MODULES([ZLIB], [zlib])\n`
  await withPackage(t, { 'configure.ac': src }, async (dir) => {
    const results = await scanBuildIndicators(dir, CONFIGURE_AC)
    const mods = results[0].groups.find(g => g.label.includes('pkg-config'))
    t.ok(mods?.items.some(i => /openssl/.test(i)), 'openssl module extracted')
    t.ok(mods?.items.some(i => /zlib/.test(i)), 'zlib module extracted')
  })
})

// --- Cargo.toml new scanner steps ---

t.test('Cargo.toml: scanner detects build script reference', async (t) => {
  const toml = `[package]\nname = "my-crate"\nversion = "1.0.0"\nbuild = "build.rs"\n`
  await withPackage(t, { 'Cargo.toml': toml }, async (dir) => {
    const results = await scanBuildIndicators(dir, {
      'Cargo.toml': INDICATOR_REGISTRY['Cargo.toml'],
    })
    const g = results[0].groups.find(g => g.label.includes('Build script'))
    t.equal(g?.items[0], 'build.rs', 'build script name extracted')
  })
})

t.test('Cargo.toml: scanner detects crate-type (cdylib = native or WASM output)', async (t) => {
  const toml = `[package]\nname = "my-crate"\n[lib]\ncrate-type = ["cdylib"]\n`
  await withPackage(t, { 'Cargo.toml': toml }, async (dir) => {
    const results = await scanBuildIndicators(dir, {
      'Cargo.toml': INDICATOR_REGISTRY['Cargo.toml'],
    })
    const g = results[0].groups.find(g => g.label.includes('output type'))
    t.match(g?.items[0], /cdylib/, 'cdylib crate type extracted')
  })
})

t.test('Cargo.toml: scanner flags wasm-bindgen dependency as WebAssembly target', async (t) => {
  const toml = `[package]\nname = "my-wasm-crate"\n[dependencies]\nwasm-bindgen = "0.2"\n`
  await withPackage(t, { 'Cargo.toml': toml }, async (dir) => {
    const results = await scanBuildIndicators(dir, {
      'Cargo.toml': INDICATOR_REGISTRY['Cargo.toml'],
    })
    const g = results[0].groups.find(g => g.label.includes('wasm-bindgen dependency'))
    t.ok(g, 'wasm-bindgen presence detected')
    t.ok(g?.items.includes('yes'), 'presence step returned yes')
  })
})

t.test('Cargo.toml: scanner lists native build toolchain crates (cc, bindgen)', async (t) => {
  const toml = `[package]\nname = "my-crate"\n[build-dependencies]\ncc = "1.0"\nbindgen = "0.70"\n`
  await withPackage(t, { 'Cargo.toml': toml }, async (dir) => {
    const results = await scanBuildIndicators(dir, {
      'Cargo.toml': INDICATOR_REGISTRY['Cargo.toml'],
    })
    const g = results[0].groups.find(g => g.label.includes('toolchain crates'))
    t.ok(g?.items.includes('cc'), 'cc crate detected')
    t.ok(g?.items.includes('bindgen'), 'bindgen crate detected')
  })
})

// --- CMakeLists.txt new scanner steps ---

t.test('CMakeLists.txt: scanner extracts find_package and target_link_libraries', async (t) => {
  const cmake = `
cmake_minimum_required(VERSION 3.15)
find_package(OpenSSL REQUIRED)
find_package(ZLIB REQUIRED)
add_library(mymod SHARED src/mymod.cpp)
target_link_libraries(mymod OpenSSL::SSL ZLIB::ZLIB)
`
  await withPackage(t, { 'CMakeLists.txt': cmake }, async (dir) => {
    const results = await scanBuildIndicators(dir, {
      'CMakeLists.txt': INDICATOR_REGISTRY['CMakeLists.txt'],
    })
    const pkgs = results[0].groups.find(g => g.label.includes('packages required'))
    t.ok(pkgs?.items.includes('OpenSSL'), 'OpenSSL find_package extracted')
    t.ok(pkgs?.items.includes('ZLIB'), 'ZLIB find_package extracted')
  })
})

// ---------------------------------------------------------------------------
// Generic scanner: signal step type
// ---------------------------------------------------------------------------

const SIGNAL_STEP_DEF = {
  'trigger.txt': {
    label: 'Signal step test',
    detect: { commandPatterns: [], triggeredByNativeBuildSignal: false },
    signals: { onFound: [], onWarning: [] },
    scanner: {
      type: 'generic',
      steps: [{ type: 'signal', pattern: /MAGIC_WORD/, signal: 'test-magic' }],
    },
  },
}

t.test('signal step: emits signal when pattern matches file content', async (t) => {
  await withPackage(t, { 'trigger.txt': 'this file contains MAGIC_WORD inside' }, async (dir) => {
    const results = await scanBuildIndicators(dir, SIGNAL_STEP_DEF)
    t.ok(results[0].signals.includes('test-magic'), 'signal emitted when pattern matches')
    t.equal(results[0].groups.length, 0, 'signal step does not add to groups')
  })
})

t.test('signal step: does not emit signal when pattern absent', async (t) => {
  await withPackage(t, { 'trigger.txt': 'no match here' }, async (dir) => {
    const results = await scanBuildIndicators(dir, SIGNAL_STEP_DEF)
    t.notOk(results[0].signals.includes('test-magic'), 'no signal when pattern absent')
  })
})

// ---------------------------------------------------------------------------
// hasBuildHint: now also checks all registry commandPatterns
// ---------------------------------------------------------------------------

t.test('hasBuildHint: expo-module command triggers hint via android/build.gradle patterns', (t) => {
  t.ok(hasBuildHint({ prepare: 'expo-module prepare' }, [], INDICATOR_REGISTRY),
    'expo-module command fires hint (matches android/build.gradle commandPatterns)')
  t.end()
})

t.test('hasBuildHint: make all command triggers hint via Makefile patterns', (t) => {
  t.ok(hasBuildHint({ install: 'make all' }, [], INDICATOR_REGISTRY),
    'make all command fires hint (matches Makefile commandPatterns)')
  t.end()
})

t.test('hasBuildHint: returns false for command with no registry match', (t) => {
  t.notOk(hasBuildHint({ install: 'node scripts/postinstall.js' }, [], INDICATOR_REGISTRY),
    'generic node script does not fire hint')
  t.end()
})

// ---------------------------------------------------------------------------
// Cargo.toml: wasm-build conditional signal + new WASM scanner steps
// ---------------------------------------------------------------------------

t.test('Cargo.toml: emits wasm-build signal when wasm-bindgen present', async (t) => {
  const toml = '[package]\nname = "my-wasm"\n[dependencies]\nwasm-bindgen = "0.2"\n'
  await withPackage(t, { 'Cargo.toml': toml }, async (dir) => {
    const results = await scanBuildIndicators(dir, { 'Cargo.toml': INDICATOR_REGISTRY['Cargo.toml'] })
    t.ok(results[0].signals.includes('wasm-build'), 'wasm-build signal emitted')
    t.ok(results[0].signals.includes('native-build'), 'native-build still emitted from onFound')
  })
})

t.test('Cargo.toml: does not emit wasm-build signal when wasm-bindgen absent', async (t) => {
  const toml = '[package]\nname = "my-native"\n[dependencies]\nnapi = "2"\n'
  await withPackage(t, { 'Cargo.toml': toml }, async (dir) => {
    const results = await scanBuildIndicators(dir, { 'Cargo.toml': INDICATOR_REGISTRY['Cargo.toml'] })
    t.notOk(results[0].signals.includes('wasm-build'), 'no wasm-build for non-WASM crate')
  })
})

t.test('Cargo.toml: extracts web-sys imported browser APIs', async (t) => {
  const toml = '[package]\nname = "my-wasm"\n[dependencies]\nwasm-bindgen = "0.2"\n' +
    'web-sys = { version = "0.3", features = ["fetch", "Window", "Request"] }\n'
  await withPackage(t, { 'Cargo.toml': toml }, async (dir) => {
    const results = await scanBuildIndicators(dir, { 'Cargo.toml': INDICATOR_REGISTRY['Cargo.toml'] })
    const g = results[0].groups.find(g => g.label.includes('web-sys'))
    t.ok(g, 'web-sys group present')
    t.match(g?.items[0], /fetch/, 'fetch API extracted')
    t.match(g?.items[0], /Window/, 'Window API extracted')
  })
})

t.test('Cargo.toml: detects js-sys presence (direct JS interop)', async (t) => {
  const toml = '[package]\nname = "my-wasm"\n[dependencies]\nwasm-bindgen = "0.2"\njs-sys = "0.3"\n'
  await withPackage(t, { 'Cargo.toml': toml }, async (dir) => {
    const results = await scanBuildIndicators(dir, { 'Cargo.toml': INDICATOR_REGISTRY['Cargo.toml'] })
    const g = results[0].groups.find(g => g.label.includes('js-sys'))
    t.ok(g, 'js-sys group present')
    t.equal(g?.items[0], 'yes', 'presence step returned yes')
  })
})

t.test('Cargo.toml: detects wasm-bindgen-futures (async JS bridge)', async (t) => {
  const toml = '[package]\nname = "my-wasm"\n[dependencies]\n' +
    'wasm-bindgen = "0.2"\nwasm-bindgen-futures = "0.4"\n'
  await withPackage(t, { 'Cargo.toml': toml }, async (dir) => {
    const results = await scanBuildIndicators(dir, { 'Cargo.toml': INDICATOR_REGISTRY['Cargo.toml'] })
    const g = results[0].groups.find(g => g.label.includes('wasm-bindgen-futures'))
    t.ok(g, 'wasm-bindgen-futures group present')
    t.equal(g?.items[0], 'yes', 'presence step returned yes')
  })
})

// ---------------------------------------------------------------------------
// android/build.gradle — new indicator
// ---------------------------------------------------------------------------

const ANDROID_BUILD_GRADLE = { 'android/build.gradle': INDICATOR_REGISTRY['android/build.gradle'] }

t.test('android/build.gradle: expo-module command triggers detection', async (t) => {
  const gradle = 'apply plugin: "com.android.library"\n' +
    'android { compileSdkVersion 33\ndefaultConfig { minSdkVersion 21 } }\n' +
    'dependencies { implementation "com.facebook.react:react-android:+" }\n'
  await withPackage(t, { 'android/build.gradle': gradle }, async (dir) => {
    const results = await scanBuildIndicatorsForPackage(
      dir, { prepare: 'expo-module prepare' }, [], ANDROID_BUILD_GRADLE
    )
    t.equal(results.length, 1, 'android/build.gradle scanned')
    t.equal(results[0].indicatorFile, 'android/build.gradle')
    t.ok(results[0].signals.includes('android-native'), 'android-native signal emitted')
  })
})

t.test('android/build.gradle: scanner extracts SDK config and dependencies', async (t) => {
  const gradle = 'android { compileSdkVersion 33\ndefaultConfig { minSdkVersion 21 } }\n' +
    'dependencies { implementation "com.facebook.react:react-android:+" }\n'
  await withPackage(t, { 'android/build.gradle': gradle }, async (dir) => {
    const results = await scanBuildIndicators(dir, ANDROID_BUILD_GRADLE)
    const sdk = results[0].groups.find(g => g.label.includes('SDK'))
    t.ok(sdk?.items.some(i => /compileSdkVersion/.test(i)), 'compileSdkVersion extracted')
    const deps = results[0].groups.find(g => g.label.includes('dependencies'))
    t.ok(deps?.items.includes('com.facebook.react:react-android:+'), 'dependency extracted')
  })
})

t.test('android/build.gradle: scanner flags externalNativeBuild (C/C++ code)', async (t) => {
  const gradle = 'android { externalNativeBuild { cmake { path "CMakeLists.txt" } } }\n'
  await withPackage(t, { 'android/build.gradle': gradle }, async (dir) => {
    const results = await scanBuildIndicators(dir, ANDROID_BUILD_GRADLE)
    const g = results[0].groups.find(g => g.label.includes('C/C++ native code'))
    t.ok(g, 'externalNativeBuild group present')
    t.equal(g?.items[0], 'yes')
  })
})

t.test('android/build.gradle: scanner finds iOS podspec companion via glob', async (t) => {
  await withPackage(t, {
    'android/build.gradle': 'apply plugin: "com.android.library"\n',
    'MyModule.podspec': 'Pod::Spec.new do |s|\n  s.name = "MyModule"\nend\n',
  }, async (dir) => {
    const results = await scanBuildIndicators(dir, ANDROID_BUILD_GRADLE)
    const podGroup = results[0].groups.find(g => g.label.includes('pod'))
    t.ok(podGroup?.items.some(i => /podspec/.test(i)), 'podspec found via glob')
  })
})

// ---------------------------------------------------------------------------
// Makefile — new indicator
// ---------------------------------------------------------------------------

const MAKEFILE_DEF = { Makefile: INDICATOR_REGISTRY['Makefile'] }

t.test('Makefile: make all command triggers detection', async (t) => {
  const make = 'CC=gcc\nall:\n\t$(CC) -o output src/main.c -lssl\n'
  await withPackage(t, { Makefile: make }, async (dir) => {
    const results = await scanBuildIndicatorsForPackage(
      dir, { install: 'make all' }, [], MAKEFILE_DEF
    )
    t.equal(results.length, 1, 'Makefile scanned')
    t.ok(results[0].signals.includes('make-build'), 'make-build signal emitted')
  })
})

t.test('Makefile: scanner extracts compiler, linked libraries, external tools', async (t) => {
  const make = 'CC=gcc\nCXX=g++\nall:\n\t$(CC) src/main.c -lssl -lcrypto\n\tcurl -O https://example.com/dep.tar\n'
  await withPackage(t, { Makefile: make }, async (dir) => {
    const results = await scanBuildIndicators(dir, MAKEFILE_DEF)
    const compilers = results[0].groups.find(g => g.label.includes('Compiler'))
    t.ok(compilers?.items.includes('gcc'), 'CC=gcc extracted')
    t.ok(compilers?.items.includes('g++'), 'CXX=g++ extracted')
    const libs = results[0].groups.find(g => g.label.includes('Libraries'))
    t.ok(libs?.items.includes('ssl'), 'ssl library extracted')
    t.ok(libs?.items.includes('crypto'), 'crypto library extracted')
    const tools = results[0].groups.find(g => g.label.includes('External tools'))
    t.ok(tools?.items.includes('curl'), 'curl tool extracted')
  })
})

