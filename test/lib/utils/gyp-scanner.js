'use strict'
const t = require('tap')
const { mkdtemp, writeFile, mkdir, rm } = require('node:fs/promises')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const withPackage = async (t, files, fn) => {
  const dir = await mkdtemp(join(tmpdir(), 'npm-test-gyp-scanner-'))
  t.teardown(() => rm(dir, { recursive: true, force: true }))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel)
    await mkdir(join(abs, '..'), { recursive: true }).catch(() => {})
    await writeFile(abs, content, 'utf8')
  }
  return fn(dir)
}

const scanGypFile = (t, mocks = {}) =>
  t.mock('../../../lib/utils/gyp-scanner.js', mocks)

// --- flattenConditions unit tests -------------------------------------------

t.test('flattenConditions: returns empty merged object for non-array input', (t) => {
  const { flattenConditions } = scanGypFile(t)
  const result = flattenConditions(null)
  t.strictSame(result, { sources: [], libraries: [], includeDirs: [] })
  t.end()
})

t.test('flattenConditions: extracts sources and libraries from condition branches', (t) => {
  const { flattenConditions } = scanGypFile(t)
  const conditions = [
    ['OS == "linux"', { sources: ['src/linux.cc'], libraries: ['-ldl'] }],
  ]
  const result = flattenConditions(conditions)
  t.ok(result.sources.includes('src/linux.cc'))
  t.ok(result.libraries.includes('-ldl'))
  t.end()
})

t.test('flattenConditions: extracts include_dirs from condition branches', (t) => {
  const { flattenConditions } = scanGypFile(t)
  const conditions = [
    ['OS == "win"', { include_dirs: ['include/win'] }],
  ]
  const result = flattenConditions(conditions)
  t.ok(result.includeDirs.includes('include/win'))
  t.end()
})

t.test('flattenConditions: handles false branch (third element)', (t) => {
  const { flattenConditions } = scanGypFile(t)
  const conditions = [
    ['OS == "linux"',
      { sources: ['src/linux.cc'] },
      { sources: ['src/other.cc'] },
    ],
  ]
  const result = flattenConditions(conditions)
  t.ok(result.sources.includes('src/linux.cc'))
  t.ok(result.sources.includes('src/other.cc'))
  t.end()
})

t.test('flattenConditions: recurses into nested conditions', (t) => {
  const { flattenConditions } = scanGypFile(t)
  const conditions = [
    ['OS == "linux"', {
      sources: ['src/linux.cc'],
      conditions: [
        ['target_arch == "x64"', { libraries: ['-lm'] }],
      ],
    }],
  ]
  const result = flattenConditions(conditions)
  t.ok(result.sources.includes('src/linux.cc'))
  t.ok(result.libraries.includes('-lm'))
  t.end()
})

t.test('flattenConditions: skips non-object condition branches', (t) => {
  const { flattenConditions } = scanGypFile(t)
  // malformed — second element is a string instead of object
  const conditions = [['OS == "linux"', 'not-an-object']]
  const result = flattenConditions(conditions)
  t.strictSame(result, { sources: [], libraries: [], includeDirs: [] })
  t.end()
})

// --- scanGypFile integration tests ------------------------------------------

t.test('returns null when no binding.gyp exists', async (t) => {
  await withPackage(t, {}, async (dir) => {
    const scan = scanGypFile(t)
    const result = await scan(dir)
    t.equal(result, null)
  })
})

t.test('parses a simple binding.gyp with one target', async (t) => {
  const gyp = JSON.stringify({
    targets: [{
      target_name: 'mymodule',
      sources: ['src/binding.cc'],
      libraries: ['-lpng'],
      include_dirs: ['include'],
    }],
  })
  await withPackage(t, { 'binding.gyp': gyp }, async (dir) => {
    const scan = scanGypFile(t)
    const result = await scan(dir)
    t.ok(result)
    t.equal(result.parseError, null)
    t.equal(result.targets.length, 1)
    const target = result.targets[0]
    t.equal(target.name, 'mymodule')
    t.ok(target.sources.includes('src/binding.cc'))
    t.ok(target.libraries.includes('-lpng'))
    t.ok(target.includeDirs.includes('include'))
    t.equal(target.hasConditions, false)
  })
})

t.test('parses a binding.gyp with # comments (GYP format)', async (t) => {
  const gyp = `
# This is a GYP comment
{
  "targets": [{
    "target_name": "canvas",
    "sources": ["src/canvas.cc"] # inline comment
  }]
}
`
  await withPackage(t, { 'binding.gyp': gyp }, async (dir) => {
    const scan = scanGypFile(t)
    const result = await scan(dir)
    t.ok(result)
    t.equal(result.parseError, null)
    t.equal(result.targets[0].name, 'canvas')
  })
})

t.test('parses a binding.gyp with trailing commas (real-world GYP files)', async (t) => {
  // GYP files commonly have trailing commas after array/object elements.
  // Standard JSON.parse rejects these; the parser must strip them first.
  const gyp = `
{
  'targets': [
    {
      'target_name': 'canvas',
      'sources': [
        'src/Canvas.cc',
        'src/util.cc',
      ],
      'libraries': ['-lpng',],
    },
  ],
}
`
  await withPackage(t, { 'binding.gyp': gyp }, async (dir) => {
    const scan = scanGypFile(t)
    const result = await scan(dir)
    t.ok(result)
    t.equal(result.parseError, null, 'trailing commas should not cause a parse error')
    t.equal(result.targets.length, 1)
    const target = result.targets[0]
    t.equal(target.name, 'canvas')
    t.ok(target.sources.includes('src/Canvas.cc'))
    t.ok(target.sources.includes('src/util.cc'))
    t.ok(target.libraries.includes('-lpng'))
  })
})

t.test('parses a binding.gyp with single-quoted strings and trailing commas', async (t) => {
  // Real-world packages (e.g. canvas) combine single-quoted strings and trailing
  // commas.  Both must be normalised before JSON.parse is called.
  const gyp = `
# canvas binding.gyp
{
  'targets': [{
    'target_name': 'canvas',
    'sources': ['src/binding.cc',],
    'libraries': ['-lX11',],
  },],
}
`
  await withPackage(t, { 'binding.gyp': gyp }, async (dir) => {
    const scan = scanGypFile(t)
    const result = await scan(dir)
    t.ok(result)
    t.equal(result.parseError, null, 'single-quoted strings + trailing commas should parse')
    const target = result.targets[0]
    t.equal(target.name, 'canvas')
    t.ok(target.sources.includes('src/binding.cc'))
    t.ok(target.libraries.includes('-lX11'))
  })
})

t.test('populates sha256 from raw file bytes', async (t) => {
  const gyp = JSON.stringify({ targets: [] })
  await withPackage(t, { 'binding.gyp': gyp }, async (dir) => {
    const scan = scanGypFile(t)
    const result = await scan(dir)
    t.ok(result.sha256)
    t.match(result.sha256, /^[0-9a-f]{64}$/)
  })
})

t.test('sets parseError when binding.gyp is malformed', async (t) => {
  await withPackage(t, { 'binding.gyp': '{ not valid json {{' }, async (dir) => {
    const scan = scanGypFile(t)
    const result = await scan(dir)
    t.ok(result)
    t.ok(result.parseError)
    t.strictSame(result.targets, [])
  })
})

t.test('returns empty targets array when targets key is missing', async (t) => {
  const gyp = JSON.stringify({ variables: { foo: 'bar' } })
  await withPackage(t, { 'binding.gyp': gyp }, async (dir) => {
    const scan = scanGypFile(t)
    const result = await scan(dir)
    t.ok(result)
    t.equal(result.parseError, null)
    t.strictSame(result.targets, [])
  })
})

t.test('sets hasConditions true when conditions array is present', async (t) => {
  const gyp = JSON.stringify({
    targets: [{
      target_name: 'native',
      sources: ['src/native.cc'],
      conditions: [['OS == "linux"', { libraries: ['-ldl'] }]],
    }],
  })
  await withPackage(t, { 'binding.gyp': gyp }, async (dir) => {
    const scan = scanGypFile(t)
    const result = await scan(dir)
    const target = result.targets[0]
    t.equal(target.hasConditions, true)
    t.ok(target.libraries.includes('-ldl'), 'conditional library is merged in')
  })
})

t.test('handles multiple targets', async (t) => {
  const gyp = JSON.stringify({
    targets: [
      { target_name: 'a', sources: ['a.cc'] },
      { target_name: 'b', sources: ['b.cc'] },
    ],
  })
  await withPackage(t, { 'binding.gyp': gyp }, async (dir) => {
    const scan = scanGypFile(t)
    const result = await scan(dir)
    t.equal(result.targets.length, 2)
    t.equal(result.targets[0].name, 'a')
    t.equal(result.targets[1].name, 'b')
  })
})

t.test('uses <unnamed> when target_name is missing', async (t) => {
  const gyp = JSON.stringify({ targets: [{ sources: ['x.cc'] }] })
  await withPackage(t, { 'binding.gyp': gyp }, async (dir) => {
    const scan = scanGypFile(t)
    const result = await scan(dir)
    t.equal(result.targets[0].name, '<unnamed>')
  })
})

t.test('handles target with no sources, libraries, or include_dirs', async (t) => {
  const gyp = JSON.stringify({ targets: [{ target_name: 'bare' }] })
  await withPackage(t, { 'binding.gyp': gyp }, async (dir) => {
    const scan = scanGypFile(t)
    const result = await scan(dir)
    const target = result.targets[0]
    t.equal(target.name, 'bare')
    t.strictSame(target.sources, [])
    t.strictSame(target.libraries, [])
    t.strictSame(target.includeDirs, [])
  })
})

t.test('parses single-quoted strings with embedded double quotes (e.g. condition strings)', async (t) => {
  // Covers the `s += '\\\"'` branch (line 35) in parseGypContent.
  // Real-world GYP condition strings like `'OS=="win"'` contain literal
  // double-quote characters inside single-quoted strings; the tokenizer must
  // escape them so the output is valid JSON.
  const gyp = `
{
  'targets': [{
    'target_name': 'native',
    'conditions': [
      ['OS=="win"', {
        'sources': ['src/win.cc'],
      }],
    ],
  }],
}
`
  await withPackage(t, { 'binding.gyp': gyp }, async (dir) => {
    const scan = scanGypFile(t)
    const result = await scan(dir)
    t.ok(result, 'parsed successfully')
    t.equal(result.parseError, null, 'no parse error with embedded double quotes in condition')
    const target = result.targets[0]
    t.ok(target.sources.includes('src/win.cc'), 'conditional source extracted correctly')
  })
})

t.test('parses single-quoted strings containing backslash sequences', async (t) => {
  // Covers lines 37-38 in parseGypContent: the `else if (src[i] === '\\\\')` branch
  // copies the backslash and the following character as a unit, then advances
  // the index an extra step so the next character is not re-processed.
  // This handles Windows-style paths like 'src\\\\file.cc' in GYP files.
  const gyp = "{ 'targets': [{ 'target_name': 'win', 'sources': ['src\\\\\\\\file.cc'] }] }"
  await withPackage(t, { 'binding.gyp': gyp }, async (dir) => {
    const scan = scanGypFile(t)
    const result = await scan(dir)
    t.ok(result, 'parsed successfully')
    t.equal(result.parseError, null, 'no parse error with backslash in single-quoted string')
    t.equal(result.targets[0].name, 'win')
  })
})

t.test('preserves # characters inside quoted strings (not treated as comments)', async (t) => {
  // A URL or fragment identifier inside a string value must not be stripped.
  const gyp = `
# top-level GYP comment — should be stripped
{
  'targets': [{
    'target_name': 'native',
    'sources': ['src/binding.cc'],
    'include_dirs': ['https://example.com/include#fragment'],
  }],
}
`
  await withPackage(t, { 'binding.gyp': gyp }, async (dir) => {
    const scan = scanGypFile(t)
    const result = await scan(dir)
    t.ok(result, 'parsed successfully')
    t.equal(result.parseError, null, 'no parse error')
    t.ok(
      result.targets[0].includeDirs.includes('https://example.com/include#fragment'),
      '# inside a quoted string is preserved verbatim'
    )
  })
})


t.test('parses double-quoted strings with backslash escapes', async (t) => {
  // Covers lines 53-58 in parseGypContent: the `if (src[i] === '\\\\')` branch
  // inside the double-quoted string handler — copies the two-char escape sequence
  // verbatim so that `JSON.parse` sees valid JSON (e.g. Windows paths like
  // "src\\\\file.cc" which represent a single backslash in the value).
  const gyp = '{"targets": [{"target_name": "native", "sources": ["src\\\\file.cc"]}]}'
  await withPackage(t, { 'binding.gyp': gyp }, async (dir) => {
    const scan = scanGypFile(t)
    const result = await scan(dir)
    t.ok(result, 'parsed successfully')
    t.equal(result.parseError, null, 'no parse error with backslash escape in double-quoted string')
    t.equal(result.targets[0].name, 'native')
    t.ok(result.targets[0].sources.some((s) => s.includes('src')),
      'source with backslash escape is present')
  })
})

t.test('does not mis-join a quoted comment string with the next line (regression)', async (t) => {
  // Regression test for the bug introduced by commit 82ea90444:
  // When a `#` comment contains a single-quoted string (e.g. `# 'OS!="win"'`),
  // the closing `'` of the comment must NOT be treated as the start of a
  // multiline string continuation joining it to the opening `'` of the next
  // content line.  Before the fix, the two quotes were merged by the pre-pass
  // regex `/'\\?\n\s*'/`, which ran before `#` comments were stripped, causing
  // canvas@2.11.2's `binding.gyp` to produce a JSON parse error.
  const gyp = `
{
  'conditions': [
    ['OS=="win"', {
      'variables': { 'x%': 'true' }
    }, {  # 'OS!="win"'
      'variables': { 'x%': 'false' }
    }]
  ],
  'targets': [{
    'target_name': 'native',
    'sources': ['src/native.cc'],
  }],
}
`
  await withPackage(t, { 'binding.gyp': gyp }, async (dir) => {
    const scan = scanGypFile(t)
    const result = await scan(dir)
    t.ok(result, 'parsed successfully')
    t.equal(result.parseError, null,
      'comment with single-quoted text must not corrupt the following line')
    t.equal(result.targets.length, 1, 'target is present')
    t.equal(result.targets[0].name, 'native')
  })
})

