'use strict'
const t = require('tap')
const { mkdtemp, writeFile, mkdir, rm } = require('node:fs/promises')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const {
  hasNativeBuildHint,
  scanNativeBuildIndicators,
  scanNativeBuildIndicatorsForPackage,
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
// hasNativeBuildHint
// ---------------------------------------------------------------------------

t.test('hasNativeBuildHint: matches native-build command patterns', (t) => {
  t.ok(hasNativeBuildHint({ install: 'node-gyp rebuild' }, []))
  t.ok(hasNativeBuildHint({ install: 'prebuild-install' }, []))
  t.ok(hasNativeBuildHint({ install: 'napi build' }, []))
  t.ok(hasNativeBuildHint({ install: 'cmake-js rebuild' }, []))
  t.end()
})

t.test('hasNativeBuildHint: fires on native-build signal in already-scanned file', (t) => {
  t.ok(hasNativeBuildHint({ install: 'node install.js' }, [{ signals: ['native-build'] }]))
  t.end()
})

t.test('hasNativeBuildHint: false when no command match and no signal', (t) => {
  t.notOk(hasNativeBuildHint({ install: 'node install.js' }, []))
  t.notOk(hasNativeBuildHint({}, [{ signals: ['reads-process-env'] }]))
  t.end()
})

// ---------------------------------------------------------------------------
// Detect phase: disk-presence-only (no command hint)
// ---------------------------------------------------------------------------

t.test('scanNativeBuildIndicators: finds indicator present on disk even with no command hint', async (t) => {
  await withPackage(t, { 'binding.gyp': JSON.stringify({ targets: [] }) }, async (dir) => {
    const results = await scanNativeBuildIndicators(dir, GYP)
    t.equal(results.length, 1, 'binding.gyp found via disk check')
  })
})

t.test('scanNativeBuildIndicators: returns empty when no indicator file on disk', async (t) => {
  await withPackage(t, {}, async (dir) => {
    const results = await scanNativeBuildIndicators(dir, GYP)
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
    const results = await scanNativeBuildIndicators(dir, GYP)
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
    const results = await scanNativeBuildIndicators(dir, GYP)
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
    const results = await scanNativeBuildIndicators(dir, GYP)
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
    const results = await scanNativeBuildIndicators(dir, GYP)
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
    const results = await scanNativeBuildIndicators(dir, GYP)
    t.ok(results[0].signals.includes('gyp-conditions'), 'gyp-conditions emitted')
    const condGroup = results[0].groups.find(g => g.label.includes('conditions'))
    t.ok(condGroup, 'conditions group present')
  })
})

t.test('GYP scanner: sets parseError for invalid GYP file', async (t) => {
  await withPackage(t, { 'binding.gyp': 'not valid json or gyp {{ ' }, async (dir) => {
    const results = await scanNativeBuildIndicators(dir, GYP)
    t.ok(results[0].parseError, 'parseError set for invalid GYP')
    t.ok(results[0].sha256, 'sha256 computed even for unparseable file')
  })
})

t.test('GYP scanner: returns no-targets group for empty targets array', async (t) => {
  await withPackage(t, { 'binding.gyp': JSON.stringify({ targets: [] }) }, async (dir) => {
    const results = await scanNativeBuildIndicators(dir, GYP)
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
    const results = await scanNativeBuildIndicators(dir, CARGO)
    t.ok(results[0].signals.includes('rust-native'))
    const nameGroup = results[0].groups.find(g => g.label === 'Crate name')
    t.equal(nameGroup?.items[0], 'my-crate')
  })
})

t.test('Generic scanner: regex step omits group when no match', async (t) => {
  await withPackage(t, { 'Cargo.toml': '# no name here\n' }, async (dir) => {
    const results = await scanNativeBuildIndicators(dir, CARGO)
    t.notOk(results[0].groups.find(g => g.label === 'Crate name'), 'group absent when no match')
  })
})

t.test('Generic scanner: regex-all step extracts all unique captures', async (t) => {
  const cmake = 'add_library(mylib SHARED)\nadd_library(otherlib STATIC)\nadd_library(mylib SHARED)\n'
  await withPackage(t, { 'CMakeLists.txt': cmake }, async (dir) => {
    const results = await scanNativeBuildIndicators(dir, CMAKE)
    const libGroup = results[0].groups.find(g => g.label === 'Native libraries')
    t.ok(libGroup?.items.includes('mylib'))
    t.ok(libGroup?.items.includes('otherlib'))
    t.equal(libGroup.items.filter(i => i === 'mylib').length, 1, 'duplicates deduplicated')
  })
})

t.test('Generic scanner: presence step emits yes when section found', async (t) => {
  await withPackage(t, { 'presence.txt': '[dependencies]\nsomething = "1.0"\n' }, async (dir) => {
    const results = await scanNativeBuildIndicators(dir, PRESENCE)
    const g = results[0].groups.find(g => g.label === 'Has dependencies section')
    t.equal(g?.items[0], 'yes')
  })
})

t.test('Generic scanner: presence step omits group when section absent', async (t) => {
  await withPackage(t, { 'presence.txt': '[package]\nname = "x"\n' }, async (dir) => {
    const results = await scanNativeBuildIndicators(dir, PRESENCE)
    t.notOk(results[0].groups.find(g => g.label === 'Has dependencies section'))
  })
})

t.test('Generic scanner: glob step lists matching files', async (t) => {
  await withPackage(t, {
    'Cargo.toml': '[package]\nname = "x"\n',
    'src/lib.rs': '// lib',
    'src/utils.rs': '// utils',
  }, async (dir) => {
    const results = await scanNativeBuildIndicators(dir, CARGO)
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
    const results = await scanNativeBuildIndicators(dir, CMAKE)
    const globGroup = results[0].groups.find(g => g.label === 'C/C++ source files')
    t.ok(globGroup?.items.includes('src/native.c'))
    t.ok(globGroup?.items.includes('src/binding.cc'))
  })
})

// ---------------------------------------------------------------------------
// Multiple indicators in parallel
// ---------------------------------------------------------------------------

t.test('scanNativeBuildIndicators: returns one result per found indicator file', async (t) => {
  await withPackage(t, {
    'binding.gyp': JSON.stringify({ targets: [] }),
    'Cargo.toml': '[package]\nname = "x"\n',
  }, async (dir) => {
    const results = await scanNativeBuildIndicators(dir, { ...GYP, ...CARGO })
    t.equal(results.length, 2)
    t.ok(results.find(r => r.indicatorFile === 'binding.gyp'))
    t.ok(results.find(r => r.indicatorFile === 'Cargo.toml'))
  })
})

t.test('scanNativeBuildIndicators: skips definition when file is absent', async (t) => {
  await withPackage(t, { 'binding.gyp': JSON.stringify({ targets: [] }) }, async (dir) => {
    const results = await scanNativeBuildIndicators(dir, { ...GYP, ...CARGO })
    t.equal(results.length, 1)
    t.equal(results[0].indicatorFile, 'binding.gyp')
  })
})

// ---------------------------------------------------------------------------
// scanNativeBuildIndicatorsForPackage — command + signal hints pre-populate clue set
// ---------------------------------------------------------------------------

t.test('scanNativeBuildIndicatorsForPackage: command hint + disk file → scan runs', async (t) => {
  await withPackage(t, {
    'binding.gyp': JSON.stringify({ targets: [{ target_name: 'mod', sources: ['x.cc'] }] }),
  }, async (dir) => {
    const results = await scanNativeBuildIndicatorsForPackage(
      dir, { install: 'node-gyp rebuild' }, [], GYP
    )
    t.equal(results.length, 1)
    t.equal(results[0].indicatorFile, 'binding.gyp')
  })
})

t.test('scanNativeBuildIndicatorsForPackage: native-build signal + triggeredByNativeBuildSignal + disk file → scan runs', async (t) => {
  await withPackage(t, {
    'binding.gyp': JSON.stringify({ targets: [] }),
  }, async (dir) => {
    const results = await scanNativeBuildIndicatorsForPackage(
      dir,
      { install: 'node install.js' },   // no command-pattern match
      [{ signals: ['native-build'] }],   // signal in scanned file
      GYP
    )
    t.equal(results.length, 1, 'scan runs because triggeredByNativeBuildSignal + file on disk')
  })
})

t.test('scanNativeBuildIndicatorsForPackage: native-build signal without triggeredByNativeBuildSignal flag does NOT hint Cargo.toml', async (t) => {
  await withPackage(t, {
    'Cargo.toml': '[package]\nname = "x"\n',
  }, async (dir) => {
    // Cargo.toml entry has triggeredByNativeBuildSignal: false
    // But the file IS on disk, so disk check still finds it
    const results = await scanNativeBuildIndicatorsForPackage(
      dir,
      { install: 'node install.js' },
      [{ signals: ['native-build'] }],
      CARGO
    )
    // Disk check finds the file regardless of the signal flag
    t.equal(results.length, 1, 'disk check finds Cargo.toml independently')
  })
})
