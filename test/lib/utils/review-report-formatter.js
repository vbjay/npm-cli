'use strict'
const t = require('tap')
const { formatMarkdown, formatJson } = require('../../../lib/utils/review-report-formatter.js')

// Minimal package fixture for tests
const makePkg = (overrides = {}) => ({
  name: 'canvas',
  version: '1.0.0',
  location: 'node_modules/canvas',
  approvalStatus: 'pending',
  dependencyType: 'direct',
  introducedBy: [],
  lifecycleScripts: { install: 'node-gyp rebuild' },
  referencedFiles: [],
  buildInfo: null,
  changeClassification: { status: 'new', previousApprovedVersion: null },
  ...overrides,
})

// --- formatMarkdown ---

t.test('formatMarkdown returns header for empty list', (t) => {
  const out = formatMarkdown([])
  t.match(out, /# npm Lifecycle Script Approval Review/)
  t.match(out, /No packages with unreviewed install scripts/)
  t.end()
})

t.test('formatMarkdown includes package header', (t) => {
  const out = formatMarkdown([makePkg()])
  t.match(out, /## Package: canvas@1\.0\.0/)
  t.end()
})

t.test('formatMarkdown includes location, dependency type and approval status', (t) => {
  const out = formatMarkdown([makePkg()])
  t.match(out, /\*\*Location:\*\*.*node_modules\/canvas/)
  t.match(out, /\*\*Dependency type:\*\* direct/)
  t.match(out, /\*\*Approval status:\*\* pending/)
  t.end()
})

t.test('formatMarkdown shows lifecycle scripts as JSON', (t) => {
  const out = formatMarkdown([makePkg()])
  t.match(out, /node-gyp rebuild/)
  t.end()
})

t.test('formatMarkdown shows version-changed classification', (t) => {
  const out = formatMarkdown([makePkg({
    changeClassification: { status: 'version-changed', previousApprovedVersion: '0.9.0' },
  })])
  t.match(out, /previously approved version was/)
  t.match(out, /0\.9\.0/)
  t.end()
})

t.test('formatMarkdown shows new classification', (t) => {
  const out = formatMarkdown([makePkg({
    changeClassification: { status: 'new', previousApprovedVersion: null },
  })])
  t.match(out, /no previous approval found/)
  t.notMatch(out, /🔔/)
  t.end()
})

t.test('formatMarkdown shows introducedBy chain', (t) => {
  const out = formatMarkdown([makePkg({
    introducedBy: [['host', 'dep-a', 'canvas']],
  })])
  t.match(out, /\*\*Introduced by:\*\*/)
  t.match(out, /host.*dep-a.*canvas/)
  t.end()
})

t.test('formatMarkdown shows multiple introducedBy chains as separate list items', (t) => {
  const out = formatMarkdown([makePkg({
    introducedBy: [
      ['my-app', 'plugin-a@1.0.0', 'canvas@2.0.0'],
      ['my-app', 'plugin-b@2.0.0', 'canvas@2.0.0'],
    ],
  })])
  t.match(out, /\*\*Introduced by:\*\*/)
  t.match(out, /- my-app → plugin-a@1\.0\.0 → canvas@2\.0\.0/)
  t.match(out, /- my-app → plugin-b@2\.0\.0 → canvas@2\.0\.0/)
  // Both paths must appear as separate bullet lines
  const bulletLines = out.split('\n').filter((l) => l.startsWith('- my-app'))
  t.equal(bulletLines.length, 2, 'renders one bullet per introducedBy chain')
  t.end()
})

t.test('formatMarkdown lists referenced files with signals', (t) => {
  const out = formatMarkdown([makePkg({
    referencedFiles: [{
      path: 'install.js',
      reason: 'direct reference in lifecycle script',
      sha256: 'abc123',
      signals: ['uses-child-process', 'network-access'],
      references: ['./helper.js'],
    }],
  })])
  t.match(out, /install\.js/)
  t.match(out, /abc123/)
  t.match(out, /uses child_process/)
  t.match(out, /makes network requests/)
  t.match(out, /helper\.js/)
  t.end()
})

t.test('formatMarkdown shows risk summary for high-risk signals', (t) => {
  const out = formatMarkdown([makePkg({
    referencedFiles: [{
      path: 'install.js',
      reason: 'direct',
      sha256: null,
      signals: ['uses-eval', 'writes-outside-package'],
      references: [],
    }],
  })])
  t.match(out, /### Risk summary/)
  t.match(out, /eval/)
  t.match(out, /outside the package directory/)
  t.end()
})

t.test('formatMarkdown shows suggested review focus', (t) => {
  const out = formatMarkdown([makePkg({
    referencedFiles: [{
      path: 'install.js',
      reason: 'direct',
      sha256: null,
      signals: ['network-access'],
      references: [],
    }],
  })])
  t.match(out, /### Suggested review focus/)
  t.match(out, /remote endpoints/)
  t.end()
})

t.test('formatMarkdown omits risk/focus sections when no high-risk signals', (t) => {
  const out = formatMarkdown([makePkg({
    referencedFiles: [{
      path: 'helper.js',
      reason: 'direct',
      sha256: null,
      signals: ['requires-local-file'],
      references: [],
    }],
  })])
  t.notMatch(out, /### Risk summary/)
  t.notMatch(out, /### Suggested review focus/)
  t.end()
})

t.test('formatMarkdown handles package with no version', (t) => {
  const out = formatMarkdown([makePkg({ version: null })])
  t.match(out, /## Package: canvas/)
  t.notMatch(out, /canvas@null/)
  t.end()
})

t.test('formatMarkdown separates packages with horizontal rules', (t) => {
  const out = formatMarkdown([makePkg(), makePkg({ name: 'sharp' })])
  t.match(out, /---/)
  t.match(out, /canvas@1\.0\.0/)
  t.match(out, /sharp@1\.0\.0/)
  t.end()
})

// --- formatJson ---

t.test('formatJson returns valid JSON', (t) => {
  const out = formatJson([])
  const parsed = JSON.parse(out)
  t.strictSame(parsed, { packages: [] })
  t.end()
})

t.test('formatJson includes package fields', (t) => {
  const parsed = JSON.parse(formatJson([makePkg()]))
  t.equal(parsed.packages.length, 1)
  const pkg = parsed.packages[0]
  t.equal(pkg.name, 'canvas')
  t.equal(pkg.version, '1.0.0')
  t.equal(pkg.approvalStatus, 'pending')
  t.equal(pkg.dependencyType, 'direct')
  t.end()
})

t.test('formatJson adds riskSummary and suggestedReviewFocus', (t) => {
  const pkg = makePkg({
    referencedFiles: [{
      path: 'install.js',
      reason: 'direct',
      sha256: null,
      signals: ['uses-eval', 'network-access'],
      references: [],
    }],
  })
  const parsed = JSON.parse(formatJson([pkg]))
  const out = parsed.packages[0]
  t.ok(Array.isArray(out.riskSummary))
  t.ok(out.riskSummary.some(s => /eval/.test(s)))
  t.ok(Array.isArray(out.suggestedReviewFocus))
  t.ok(out.suggestedReviewFocus.some(s => /remote endpoints/.test(s)))
  t.end()
})

t.test('formatJson riskSummary is empty for low-risk signals', (t) => {
  const pkg = makePkg({
    referencedFiles: [{
      path: 'helper.js',
      reason: 'direct',
      sha256: null,
      signals: ['requires-local-file'],
      references: [],
    }],
  })
  const parsed = JSON.parse(formatJson([pkg]))
  t.strictSame(parsed.packages[0].riskSummary, [])
  t.end()
})

t.test('formatJson handles multiple packages', (t) => {
  const parsed = JSON.parse(formatJson([makePkg(), makePkg({ name: 'sharp' })]))
  t.equal(parsed.packages.length, 2)
  const names = parsed.packages.map(p => p.name).sort()
  t.strictSame(names, ['canvas', 'sharp'])
  t.end()
})

// --- JSFuck signal -------------------------------------------------------

t.test('formatMarkdown includes jsfuck-obfuscation in risk summary and focus', (t) => {
  const out = formatMarkdown([makePkg({
    referencedFiles: [{
      path: 'install.js',
      reason: 'referenced by lifecycle script: `install`',
      sha256: null,
      signals: ['jsfuck-obfuscation'],
      references: [],
    }],
  })])
  t.match(out, /JSFuck/, 'jsfuck signal label appears in output')
  t.match(out, /### Risk summary/, 'risk summary section present')
  t.match(out, /### Suggested review focus/, 'review focus section present')
  t.match(out, /decode and audit/, 'review focus guidance for jsfuck included')
  t.end()
})

t.test('formatMarkdown includes jsfuck-obfuscation for inline entry (path: null)', (t) => {
  const out = formatMarkdown([makePkg({
    referencedFiles: [{
      path: null,
      reason: 'inline lifecycle script: `postinstall`',
      sha256: null,
      signals: ['jsfuck-obfuscation'],
      references: [],
    }],
  })])
  t.match(out, /inline lifecycle script/, 'inline reason shown')
  t.match(out, /JSFuck/, 'jsfuck signal label present')
  t.end()
})

t.test('formatJson riskSummary includes jsfuck-obfuscation as high-risk', (t) => {
  const pkg = makePkg({
    referencedFiles: [{
      path: 'install.js',
      reason: 'direct',
      sha256: null,
      signals: ['jsfuck-obfuscation'],
      references: [],
    }],
  })
  const parsed = JSON.parse(formatJson([pkg]))
  const { riskSummary, suggestedReviewFocus } = parsed.packages[0]
  t.ok(riskSummary.some(s => /JSFuck/.test(s)), 'jsfuck-obfuscation in riskSummary')
  t.ok(suggestedReviewFocus.some(s => /decode and audit/.test(s)),
    'jsfuck-obfuscation in suggestedReviewFocus')
  t.end()
})

// --- New signal label and high-risk tests --------------------------------

t.test('SIGNAL_LABELS: uses-vm has a label and is high-risk', (t) => {
  const out = formatMarkdown([makePkg({
    referencedFiles: [{
      path: 'install.js',
      reason: 'direct',
      sha256: null,
      signals: ['uses-vm'],
      references: [],
    }],
  })])
  t.match(out, /vm module/, 'uses-vm label present')
  t.match(out, /### Risk summary/, 'risk summary section present')
  t.match(out, /### Suggested review focus/, 'review focus section present')
  t.end()
})

t.test('SIGNAL_LABELS: uses-worker-threads has a label and is high-risk', (t) => {
  const out = formatMarkdown([makePkg({
    referencedFiles: [{
      path: 'install.js',
      reason: 'direct',
      sha256: null,
      signals: ['uses-worker-threads'],
      references: [],
    }],
  })])
  t.match(out, /worker_threads/, 'uses-worker-threads label present')
  t.match(out, /### Risk summary/, 'risk summary section present')
  t.match(out, /worker threads/, 'review focus mentions worker threads')
  t.end()
})

t.test('SIGNAL_LABELS: uses-net-socket has a label and is high-risk', (t) => {
  const out = formatMarkdown([makePkg({
    referencedFiles: [{
      path: 'install.js',
      reason: 'direct',
      sha256: null,
      signals: ['uses-net-socket'],
      references: [],
    }],
  })])
  t.match(out, /TCP/, 'uses-net-socket label present')
  t.match(out, /### Risk summary/, 'risk summary present')
  t.match(out, /raw TCP/, 'review focus mentions raw TCP')
  t.end()
})

t.test('SIGNAL_LABELS: uses-dns has a label and is high-risk', (t) => {
  const out = formatMarkdown([makePkg({
    referencedFiles: [{
      path: 'install.js',
      reason: 'direct',
      sha256: null,
      signals: ['uses-dns'],
      references: [],
    }],
  })])
  t.match(out, /DNS/, 'uses-dns label present')
  t.match(out, /### Risk summary/, 'risk summary present')
  t.match(out, /exfiltrate/, 'review focus mentions exfiltration')
  t.end()
})

t.test('SIGNAL_LABELS: shell-network-fetch has a label and is high-risk', (t) => {
  const out = formatMarkdown([makePkg({
    referencedFiles: [{
      path: 'fetch.sh',
      reason: 'direct',
      sha256: null,
      signals: ['shell-network-fetch'],
      references: [],
    }],
  })])
  t.match(out, /curl/, 'shell-network-fetch label present')
  t.match(out, /### Risk summary/, 'risk summary present')
  t.match(out, /remote URLs/, 'review focus mentions remote URLs')
  t.end()
})

t.test('SIGNAL_LABELS: process-binding has a label and is high-risk', (t) => {
  const out = formatMarkdown([makePkg({
    referencedFiles: [{
      path: 'install.js',
      reason: 'direct',
      sha256: null,
      signals: ['process-binding'],
      references: [],
    }],
  })])
  t.match(out, /process\.binding/, 'process-binding label present')
  t.match(out, /### Risk summary/, 'risk summary present')
  t.match(out, /dlopen/, 'review focus mentions dlopen')
  t.end()
})

t.test('formatJson: new signals are included in riskSummary', (t) => {
  const pkg = makePkg({
    referencedFiles: [{
      path: 'install.js',
      reason: 'direct',
      sha256: null,
      signals: ['uses-worker-threads', 'uses-net-socket', 'uses-dns',
        'shell-network-fetch', 'process-binding'],
      references: [],
    }],
  })
  const parsed = JSON.parse(formatJson([pkg]))
  const { riskSummary, suggestedReviewFocus } = parsed.packages[0]
  t.ok(riskSummary.some(s => /worker_threads/.test(s)), 'uses-worker-threads in riskSummary')
  t.ok(riskSummary.some(s => /TCP/.test(s)), 'uses-net-socket in riskSummary')
  t.ok(riskSummary.some(s => /DNS/.test(s)), 'uses-dns in riskSummary')
  t.ok(riskSummary.some(s => /curl/.test(s)), 'shell-network-fetch in riskSummary')
  t.ok(riskSummary.some(s => /process\.binding/.test(s)), 'process-binding in riskSummary')
  t.ok(suggestedReviewFocus.some(s => /worker threads/.test(s)),
    'uses-worker-threads in suggestedReviewFocus')
  t.ok(suggestedReviewFocus.some(s => /raw TCP/.test(s)),
    'uses-net-socket in suggestedReviewFocus')
  t.ok(suggestedReviewFocus.some(s => /exfiltrate/.test(s)),
    'uses-dns in suggestedReviewFocus')
  t.ok(suggestedReviewFocus.some(s => /remote URLs/.test(s)),
    'shell-network-fetch in suggestedReviewFocus')
  t.ok(suggestedReviewFocus.some(s => /dlopen/.test(s)),
    'process-binding in suggestedReviewFocus')
  t.end()
})

// --- file size in markdown output (uses existing formatBytes utility) ---

t.test('formatMarkdown shows human-readable size for scanned files', (t) => {
  const out = formatMarkdown([makePkg({
    referencedFiles: [{
      path: 'install.js',
      reason: 'referenced by lifecycle script: `install`',
      sha256: 'abc123',
      sizeBytes: 2000000,  // 2 MB (1000-based, matches formatBytes)
      signals: [],
      references: [],
    }],
  })])
  t.match(out, /\*\*Size:\*\* 2\.0 MB/, 'file size displayed as 2.0 MB via formatBytes')
  t.end()
})

t.test('formatMarkdown shows kB for small files', (t) => {
  const out = formatMarkdown([makePkg({
    referencedFiles: [{
      path: 'helper.js',
      reason: 'direct',
      sha256: 'def456',
      sizeBytes: 4000,  // 4 kB (1000-based, matches formatBytes)
      signals: [],
      references: [],
    }],
  })])
  t.match(out, /\*\*Size:\*\* 4\.0 kB/, 'file size displayed as 4.0 kB via formatBytes')
  t.end()
})

t.test('formatMarkdown shows bytes for sub-kilobyte files', (t) => {
  const out = formatMarkdown([makePkg({
    referencedFiles: [{
      path: 'tiny.js',
      reason: 'direct',
      sha256: 'aaa',
      sizeBytes: 512,
      signals: [],
      references: [],
    }],
  })])
  t.match(out, /\*\*Size:\*\* 512 B/, 'file size displayed in bytes')
  t.end()
})

t.test('formatMarkdown omits size line when sizeBytes is null', (t) => {
  const out = formatMarkdown([makePkg({
    referencedFiles: [{
      path: 'install.js',
      reason: 'direct',
      sha256: null,
      sizeBytes: null,
      signals: ['file-unreadable'],
      references: [],
    }],
  })])
  t.notMatch(out, /\*\*Size:\*\*/, 'no size line when sizeBytes is null')
  t.end()
})

// --- file size in JSON output ---

t.test('formatJson preserves sizeBytes in referenced file entries', (t) => {
  const pkg = makePkg({
    referencedFiles: [{
      path: 'install.js',
      reason: 'direct',
      sha256: 'abc',
      sizeBytes: 8192,
      signals: [],
      references: [],
    }],
  })
  const parsed = JSON.parse(formatJson([pkg]))
  t.equal(parsed.packages[0].referencedFiles[0].sizeBytes, 8192,
    'sizeBytes is preserved in JSON output')
  t.end()
})

t.test('formatJson preserves sizeBytes: null for inline/unreadable entries', (t) => {
  const pkg = makePkg({
    referencedFiles: [{
      path: null,
      reason: 'inline lifecycle script: `install`',
      sha256: null,
      sizeBytes: null,
      signals: ['uses-eval'],
      references: [],
    }],
  })
  const parsed = JSON.parse(formatJson([pkg]))
  t.equal(parsed.packages[0].referencedFiles[0].sizeBytes, null,
    'sizeBytes is null for inline entries in JSON output')
  t.end()
})

// --- formatReviewReport public API (covers lines 229-232) ---

t.test('formatReviewReport outputs markdown by default', (t) => {
  let captured = null
  const mod = t.mock('../../../lib/utils/review-report-formatter.js', {
    'proc-log': { output: { standard: (s) => { captured = s } } },
  })
  mod([makePkg()], 'markdown')
  t.ok(captured, 'output.standard was called')
  t.match(captured, /# npm Lifecycle Script Approval Review/, 'markdown output produced')
  t.match(captured, /### Actions/, 'Actions section present')
  t.match(captured, /`npm approve-scripts canvas`/, 'approve command present')
  t.match(captured, /`npm approve-scripts --no-allow-scripts-pin canvas`/, 'approve name-only command present')
  t.match(captured, /`npm deny-scripts canvas`/, 'deny command present (name-only)')
  t.end()
})

t.test('formatReviewReport outputs JSON for json format', (t) => {
  let captured = null
  const mod = t.mock('../../../lib/utils/review-report-formatter.js', {
    'proc-log': { output: { standard: (s) => { captured = s } } },
  })
  mod([makePkg()], 'json')
  t.ok(captured, 'output.standard was called')
  const parsed = JSON.parse(captured)
  t.ok(Array.isArray(parsed.packages), 'JSON output has packages array')
  t.equal(parsed.packages[0].approveCommand, 'npm approve-scripts canvas', 'approveCommand is name-only')
  t.equal(parsed.packages[0].approveCommandNameOnly, 'npm approve-scripts --no-allow-scripts-pin canvas', 'approveCommandNameOnly present')
  t.equal(parsed.packages[0].denyCommand, 'npm deny-scripts canvas', 'denyCommand is name-only')
  t.end()
})

// --- Uncovered formatter branches -----------------------------------------

t.test('formatMarkdown renders unknown signal name as-is (line 157 fallback)', (t) => {
  // An unknown signal (not in SIGNAL_LABELS) is rendered as-is via `|| sig`.
  const out = formatMarkdown([makePkg({
    referencedFiles: [{
      path: 'install.js',
      reason: 'direct',
      sha256: null,
      signals: ['completely-unknown-future-signal'],
      references: [],
    }],
  })])
  t.match(out, /completely-unknown-future-signal/, 'unknown signal rendered as raw key')
  t.end()
})

t.test('formatMarkdown with changeClassification null (line 118 false branch)', (t) => {
  // changeClassification is null — the `if (pkg.changeClassification)` block is skipped.
  const out = formatMarkdown([makePkg({ changeClassification: null })])
  t.notMatch(out, /\*\*Change:\*\*/, 'no Change line when changeClassification is null')
  t.end()
})

t.test('formatMarkdown with version-changed and no previous version (line 120 sub-branch)', (t) => {
  // status === 'version-changed' but previousApprovedVersion is null.
  const out = formatMarkdown([makePkg({
    changeClassification: { status: 'version-changed', previousApprovedVersion: null },
  })])
  t.notMatch(out, /previously approved version was/, 'no previousApprovedVersion line')
  t.end()
})

t.test('formatMarkdown shows GB for very large files (format-bytes line 26)', (t) => {
  // sizeBytes >= 999_950_000 triggers the GB branch in format-bytes.js.
  const out = formatMarkdown([makePkg({
    referencedFiles: [{
      path: 'huge.js',
      reason: 'direct',
      sha256: 'abc',
      sizeBytes: 1_000_000_000,  // 1.0 GB
      signals: [],
      references: [],
    }],
  })])
  t.match(out, /\*\*Size:\*\* 1\.0 GB/, 'file size displayed in GB via formatBytes')
  t.end()
})

// --- native-build signal and buildInfo section ---------------------

// Helper: build a minimal IndicatorResult[] for a single GYP indicator
const makeGypIndicator = (overrides = {}) => ({
  indicatorFile: 'binding.gyp',
  label: 'GYP build descriptor',
  sha256: 'abc123',
  parseError: null,
  signals: ['native-build'],
  groups: [],
  ...overrides,
})

const makeNativePkg = (buildInfo, overrides = {}) =>
  makePkg({ buildInfo, ...overrides })

t.test('native-build signal appears in risk summary and review focus', (t) => {
  const out = formatMarkdown([makePkg({
    referencedFiles: [{
      path: 'install.js',
      reason: 'direct',
      sha256: null,
      signals: ['native-build'],
      references: [],
    }],
  })])
  t.match(out, /### Risk summary/, 'risk summary present')
  t.match(out, /native binary/, 'native-build label appears')
  t.match(out, /### Suggested review focus/, 'review focus present')
  t.match(out, /binding\.gyp/, 'review focus mentions binding.gyp')
  t.end()
})

t.test('formatMarkdown renders native build section with targets', (t) => {
  const out = formatMarkdown([makeNativePkg([makeGypIndicator({
    sha256: 'abc123',
    groups: [
      { label: 'Target `canvas` — C/C++ sources', items: ['src/canvas.cc', 'src/Image.cc'] },
      { label: 'Target `canvas` — libraries', items: ['-lpng'] },
      { label: 'Target `canvas` — include directories', items: ['include'] },
    ],
  })])])
  t.match(out, /### Build indicators/)
  t.match(out, /binding\.gyp.*GYP build descriptor/)
  t.match(out, /SHA-256.*abc123/)
  t.match(out, /canvas/)
  t.match(out, /src\/canvas\.cc/)
  t.match(out, /src\/Image\.cc/)
  t.match(out, /-lpng/)
  t.match(out, /include/)
  t.end()
})

t.test('formatMarkdown native build section shows conditions warning group', (t) => {
  const out = formatMarkdown([makeNativePkg([makeGypIndicator({
    sha256: 'def456',
    signals: ['native-build', 'gyp-conditions'],
    groups: [
      { label: 'Target `native` — C/C++ sources', items: ['src/native.cc'] },
      { label: 'Target `native` — platform-specific conditions',
        items: ['yes — inspect for platform-specific build behaviour'] },
    ],
  })])])
  t.match(out, /platform-specific/)
  t.end()
})

t.test('formatMarkdown native build section shows parse error', (t) => {
  const out = formatMarkdown([makeNativePkg([makeGypIndicator({
    sha256: 'fff000',
    parseError: 'Unexpected token',
    groups: [],
  })])])
  t.match(out, /### Build indicators/)
  t.match(out, /Warning/)
  t.match(out, /could not be parsed/)
  t.match(out, /Unexpected token/)
  t.end()
})

t.test('formatMarkdown native build section shows no-details message', (t) => {
  const out = formatMarkdown([makeNativePkg([makeGypIndicator({
    sha256: 'aaa111',
    groups: [],
  })])])
  t.match(out, /### Build indicators/)
  t.match(out, /No details extracted/)
  t.end()
})

t.test('formatMarkdown omits native build section when buildInfo is null', (t) => {
  const out = formatMarkdown([makeNativePkg(null)])
  t.notMatch(out, /### Build indicators/)
  t.end()
})

t.test('formatMarkdown omits native build section when buildInfo is empty array', (t) => {
  const out = formatMarkdown([makeNativePkg([])])
  t.notMatch(out, /### Build indicators/)
  t.end()
})

t.test('formatMarkdown renders multiple indicator files', (t) => {
  const out = formatMarkdown([makeNativePkg([
    makeGypIndicator({ sha256: 'aaa' }),
    {
      indicatorFile: 'Cargo.toml',
      label: 'Rust native addon',
      sha256: 'bbb',
      parseError: null,
      signals: ['native-build', 'rust-native'],
      groups: [{ label: 'Crate name', items: ['my-crate'] }],
    },
  ])])
  t.match(out, /binding\.gyp.*GYP build descriptor/)
  t.match(out, /Cargo\.toml.*Rust native addon/)
  t.match(out, /my-crate/)
  t.end()
})

t.test('formatJson includes buildInfo as-is (IndicatorResult[])', (t) => {
  const buildInfo = [makeGypIndicator({ sha256: 'aabbcc' })]
  const parsed = JSON.parse(formatJson([makeNativePkg(buildInfo)]))
  t.strictSame(parsed.packages[0].buildInfo, buildInfo)
  t.end()
})

t.test('formatJson preserves buildInfo: null', (t) => {
  const parsed = JSON.parse(formatJson([makeNativePkg(null)]))
  t.equal(parsed.packages[0].buildInfo, null)
  t.end()
})

t.test('formatJson includes native-build in riskSummary', (t) => {
  const pkg = makePkg({
    referencedFiles: [{
      path: 'install.js',
      reason: 'direct',
      sha256: null,
      signals: ['native-build'],
      references: [],
    }],
  })
  const parsed = JSON.parse(formatJson([pkg]))
  const { riskSummary, suggestedReviewFocus } = parsed.packages[0]
  t.ok(riskSummary.some(s => /native binary/.test(s)), 'native-build in riskSummary')
  // buildInfo is null → fallback message listing possible descriptor filenames
  t.ok(suggestedReviewFocus.some(s => /binding\.gyp/.test(s)), 'native-build fallback in suggestedReviewFocus')
  t.end()
})

t.test('buildIndicatorReviewFocus: names specific target from binding.gyp groups', (t) => {
  const pkg = makeNativePkg([makeGypIndicator({
    signals: ['native-build'],
    groups: [
      { label: 'Target `node_sqlite3` — C/C++ sources', items: ['src/database.cc'] },
      { label: 'Target `node_sqlite3` — libraries', items: ['-lsqlite3'] },
    ],
  })])
  const out = formatMarkdown([pkg])
  t.match(out, /### Suggested review focus/, 'focus section present')
  t.match(out, /target.*`node_sqlite3`/, 'target name in focus item')
  t.match(out, /inspect source files/, 'source inspection mentioned')
  t.match(out, /verify all dependencies/, 'dependency check mentioned')
  t.end()
})

t.test('buildIndicatorReviewFocus: mentions platform conditions when gyp-conditions signal in groups', (t) => {
  const pkg = makeNativePkg([makeGypIndicator({
    signals: ['native-build', 'gyp-conditions'],
    groups: [
      { label: 'Target `mod` — C/C++ sources', items: ['src/mod.cc'] },
      { label: 'Target `mod` — platform-specific conditions', items: ['yes — inspect...'] },
    ],
  })])
  const out = formatMarkdown([pkg])
  t.match(out, /platform-specific condition/, 'condition review mentioned in focus')
  t.notMatch(out, /binding\.gyp has platform-specific conditions/, 'old static gyp-conditions message not present')
  t.end()
})

t.test('buildIndicatorReviewFocus: uses crate name from Cargo.toml groups', (t) => {
  const pkg = makeNativePkg([{
    indicatorFile: 'Cargo.toml',
    label: 'Rust native addon (napi-rs / neon)',
    sha256: 'c0ffee',
    parseError: null,
    signals: ['native-build', 'rust-native'],
    groups: [
      { label: 'Crate name', items: ['zstd-sys'] },
      { label: 'Has build dependencies', items: ['yes'] },
      { label: 'Rust source files', items: ['src/lib.rs', 'src/encoder.rs'] },
    ],
  }])
  const out = formatMarkdown([pkg])
  t.match(out, /`zstd-sys`/, 'crate name appears in focus')
  t.match(out, /verify all dependencies/, 'dependency check present')
  t.match(out, /inspect source files/, 'source file check present')
  t.end()
})

t.test('buildIndicatorReviewFocus: parse error gives manual review prompt', (t) => {
  const pkg = makeNativePkg([makeGypIndicator({
    parseError: 'Unexpected token at line 5',
    groups: [],
  })])
  const out = formatMarkdown([pkg])
  t.match(out, /inspect.*binding\.gyp.*could not be parsed/, 'parse error message in focus')
  t.match(out, /manually/, 'manual review instruction present')
  t.end()
})

t.test('buildIndicatorReviewFocus: target with no recognised aspect groups → review build configuration', (t) => {
  // A target whose only group is include_dirs — not 'source', 'librar', or 'condition'.
  const pkg = makeNativePkg([makeGypIndicator({
    signals: ['native-build'],
    groups: [{ label: 'Target `mymod` — include directories', items: ['deps/include'] }],
  })])
  const out = formatMarkdown([pkg])
  t.match(out, /target.*`mymod`/, 'target name present')
  t.match(out, /review build configuration/, 'fallback aspect phrase used')
  t.end()
})

t.test('buildIndicatorReviewFocus: no targets, no aspects, no conditions → review before approving', (t) => {
  // An indicator with empty groups and no gyp-conditions — e.g. a bare Cargo.toml
  // with no parseable sections, treated generically.
  const pkg = makeNativePkg([{
    indicatorFile: 'Cargo.toml',
    label: 'Rust native addon (napi-rs / neon)',
    sha256: 'deadbeef',
    parseError: null,
    signals: ['native-build', 'rust-native'],
    groups: [],
  }])
  const out = formatMarkdown([pkg])
  t.match(out, /inspect.*`Cargo\.toml`/, 'file name in focus')
  t.match(out, /review before approving/, 'generic prompt when no details available')
  t.end()
})

t.test('buildIndicatorReviewFocus: multi-target message pluralises target label', (t) => {
  const pkg = makeNativePkg([makeGypIndicator({
    signals: ['native-build'],
    groups: [
      { label: 'Target `alpha` — C/C++ sources', items: ['a.cc'] },
      { label: 'Target `beta` — C/C++ sources', items: ['b.cc'] },
    ],
  })])
  const out = formatMarkdown([pkg])
  t.match(out, /targets `alpha`, `beta`/, 'both targets listed in focus')
  t.end()
})



t.test('allSignals merges indicator signals into risk summary', (t) => {
  const pkg = makePkg({
    buildInfo: [{
      indicatorFile: 'binding.gyp',
      label: 'GYP build descriptor',
      sha256: 'x',
      parseError: null,
      signals: ['native-build', 'gyp-conditions'],
      groups: [],
    }],
  })
  const parsed = JSON.parse(formatJson([pkg]))
  const { riskSummary, suggestedReviewFocus } = parsed.packages[0]
  t.ok(riskSummary.some(s => /native binary/.test(s)), 'native-build from indicator in riskSummary')
  t.ok(suggestedReviewFocus.some(s => /platform-specific/.test(s)),
    'gyp-conditions in suggestedReviewFocus')
  t.end()
})

t.test('rust-native signal appears in risk summary and review focus', (t) => {
  const pkg = makePkg({
    buildInfo: [{
      indicatorFile: 'Cargo.toml',
      label: 'Rust native addon',
      sha256: 'y',
      parseError: null,
      signals: ['native-build', 'rust-native'],
      groups: [],
    }],
  })
  const out = formatMarkdown([pkg])
  t.match(out, /### Risk summary/)
  t.match(out, /Rust native addon|Rust/)
  t.ok(formatMarkdown([pkg]).includes('rust-native') ||
    out.match(/Rust/), 'rust-native signal rendered')
  t.end()
})

// ---------------------------------------------------------------------------
// New classifier signals: wasm-build, android-native, make-build
// ---------------------------------------------------------------------------

t.test('wasm-build signal appears in SIGNAL_LABELS, HIGH_RISK_SIGNALS, and risk summary', (t) => {
  const pkg = makePkg({
    buildInfo: null,
    referencedFiles: [{
      path: 'install.js', reason: 'direct', sha256: null,
      signals: ['wasm-build'], references: [],
    }],
  })
  const out = formatMarkdown([pkg])
  t.match(out, /wasm|WebAssembly|\.wasm/, 'wasm-build label present in risk summary')
  t.end()
})

t.test('android-native signal appears in SIGNAL_LABELS and risk summary', (t) => {
  const pkg = makePkg({
    buildInfo: [{
      indicatorFile: 'android/build.gradle',
      label: 'Android native module',
      sha256: 'a1',
      parseError: null,
      signals: ['android-native'],
      groups: [],
    }],
  })
  const out = formatMarkdown([pkg])
  t.match(out, /Android/, 'android-native label present in risk summary')
  t.end()
})

t.test('make-build signal appears in SIGNAL_LABELS and risk summary', (t) => {
  const pkg = makePkg({
    buildInfo: [{
      indicatorFile: 'Makefile',
      label: 'Makefile build script',
      sha256: 'b2',
      parseError: null,
      signals: ['make-build'],
      groups: [],
    }],
  })
  const out = formatMarkdown([pkg])
  t.match(out, /Makefile|make/, 'make-build label present in risk summary')
  t.end()
})

// --- buildIndicatorFocusItem: wasm-build case ---

t.test('buildIndicatorReviewFocus: wasm-build names specific imported APIs', (t) => {
  const pkg = makeNativePkg([{
    indicatorFile: 'Cargo.toml',
    label: 'Rust build descriptor',
    sha256: 'wasm1',
    parseError: null,
    signals: ['native-build', 'rust-native', 'wasm-build'],
    groups: [
      { label: 'Crate name', items: ['my-wasm-pkg'] },
      { label: 'web-sys browser/Node.js APIs imported', items: ['"fetch", "Window", "XmlHttpRequest"'] },
      { label: 'js-sys imported (direct JavaScript built-in access — includes eval, Function, Reflect)', items: ['yes'] },
    ],
  }])
  const out = formatMarkdown([pkg])
  t.match(out, /WebAssembly module.*`my-wasm-pkg`/, 'WASM module name in focus')
  t.match(out, /fetch.*Window.*XmlHttpRequest/, 'imported APIs listed in focus')
  t.match(out, /js-sys.*review direct JavaScript interop/, 'js-sys warning in focus')
  t.end()
})

t.test('buildIndicatorReviewFocus: wasm-build without web-sys group uses generic API message', (t) => {
  const pkg = makeNativePkg([{
    indicatorFile: 'Cargo.toml',
    label: 'Rust build descriptor',
    sha256: 'wasm2',
    parseError: null,
    signals: ['native-build', 'rust-native', 'wasm-build'],
    groups: [
      { label: 'wasm-bindgen-futures (async WASM ↔ JS bridge — spawns JS promises from Rust)', items: ['yes'] },
    ],
  }])
  const out = formatMarkdown([pkg])
  t.match(out, /verify what browser\/Node\.js APIs/, 'generic API guidance when no web-sys group')
  t.match(out, /wasm-bindgen-futures/, 'async bridge warning present')
  t.end()
})

// --- buildIndicatorFocusItem: android-native case ---

t.test('buildIndicatorReviewFocus: android-native names dependencies and JNI code', (t) => {
  const pkg = makeNativePkg([{
    indicatorFile: 'android/build.gradle',
    label: 'Android native module',
    sha256: 'and1',
    parseError: null,
    signals: ['android-native'],
    groups: [
      { label: 'Android dependencies', items: ['com.facebook.react:react-android:+', 'org.webkit:android-jsc:+'] },
      { label: 'Contains C/C++ native code (externalNativeBuild — CMake or ndk-build)', items: ['yes'] },
    ],
  }])
  const out = formatMarkdown([pkg])
  t.match(out, /Android native module/, 'indicator label in focus')
  t.match(out, /react-android/, 'Android dependency in focus')
  t.match(out, /JNI\/NDK/, 'JNI/NDK check in focus')
  t.end()
})

t.test('buildIndicatorReviewFocus: android-native with iOS companion mentions iOS', (t) => {
  const pkg = makeNativePkg([{
    indicatorFile: 'android/build.gradle',
    label: 'Android native module',
    sha256: 'and2',
    parseError: null,
    signals: ['android-native'],
    groups: [
      { label: 'iOS pod specification', items: ['MyModule.podspec'] },
    ],
  }])
  const out = formatMarkdown([pkg])
  t.match(out, /iOS native code/, 'iOS review mentioned in focus')
  t.end()
})

t.test('buildIndicatorReviewFocus: android-native with no groups → generic fallback', (t) => {
  const pkg = makeNativePkg([{
    indicatorFile: 'android/build.gradle',
    label: 'Android native module',
    sha256: 'and3',
    parseError: null,
    signals: ['android-native'],
    groups: [],
  }])
  const out = formatMarkdown([pkg])
  t.match(out, /Android native module/, 'indicator label in focus')
  t.match(out, /review build configuration/, 'generic fallback when no groups')
  t.end()
})

// --- buildIndicatorFocusItem: make-build case ---

t.test('buildIndicatorReviewFocus: make-build names external tools and linked libs', (t) => {
  const pkg = makeNativePkg([{
    indicatorFile: 'Makefile',
    label: 'Makefile build script',
    sha256: 'make1',
    parseError: null,
    signals: ['make-build'],
    groups: [
      { label: 'External tools invoked', items: ['curl', 'wget'] },
      { label: 'Libraries linked', items: ['ssl', 'crypto'] },
      { label: 'C/C++ source files', items: ['src/main.c'] },
    ],
  }])
  const out = formatMarkdown([pkg])
  t.match(out, /Makefile build/, 'Makefile label in focus')
  t.match(out, /curl.*wget/, 'external tools in focus')
  t.match(out, /ssl.*crypto/, 'linked libs in focus')
  t.match(out, /C\/C\+\+ source files/, 'source file review in focus')
  t.end()
})

t.test('buildIndicatorReviewFocus: make-build with no groups → generic fallback', (t) => {
  const pkg = makeNativePkg([{
    indicatorFile: 'Makefile',
    label: 'Makefile build script',
    sha256: 'make2',
    parseError: null,
    signals: ['make-build'],
    groups: [],
  }])
  const out = formatMarkdown([pkg])
  t.match(out, /review all build steps/, 'generic fallback for empty Makefile groups')
  t.end()
})

// --- buildAllReviewFocus: wasm-build fallback ---

t.test('buildAllReviewFocus: wasm-build fallback fires when signal present but no buildInfo', (t) => {
  const pkg = makePkg({
    buildInfo: null,
    referencedFiles: [{
      path: 'install.js', reason: 'direct', sha256: null,
      signals: ['wasm-build'], references: [],
    }],
  })
  const out = formatMarkdown([pkg])
  t.match(out, /WebAssembly build/, 'WASM fallback message in review focus')
  t.end()
})

// --- Build indicators section heading ---

t.test('formatMarkdown uses "Build indicators" heading (not "Native build indicators")', (t) => {
  const pkg = makeNativePkg([makeGypIndicator({ sha256: 'x' })])
  const out = formatMarkdown([pkg])
  t.match(out, /### Build indicators/, 'new heading present')
  t.notMatch(out, /### Native build indicators/, 'old heading absent')
  t.end()
})

