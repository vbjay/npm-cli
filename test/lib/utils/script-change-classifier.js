const t = require('tap')

const mockClassifier = (t, mocks = {}) =>
  t.mock('../../../lib/utils/script-change-classifier.js', mocks)

t.test('returns "new" when allowScripts is null', (t) => {
  const classify = mockClassifier(t)
  const node = { name: 'canvas', packageName: 'canvas', version: '1.0.0' }
  const result = classify(node, null)
  t.equal(result.status, 'new')
  t.equal(result.previousApprovedVersion, null)
  t.end()
})

t.test('returns "new" when node has no name or packageName', (t) => {
  const classify = mockClassifier(t)
  const node = { version: '1.0.0' }
  const result = classify(node, { 'canvas@1.0.0': true })
  t.equal(result.status, 'new')
  t.equal(result.previousApprovedVersion, null)
  t.end()
})

t.test('returns "new" when allowScripts is empty', (t) => {
  const classify = mockClassifier(t)
  const node = { name: 'canvas', packageName: 'canvas', version: '1.0.0' }
  const result = classify(node, {})
  t.equal(result.status, 'new')
  t.equal(result.previousApprovedVersion, null)
  t.end()
})

t.test('returns "new" when package name is not in allowScripts', (t) => {
  const classify = mockClassifier(t)
  const node = { name: 'canvas', packageName: 'canvas', version: '1.0.0' }
  const result = classify(node, { 'sharp@2.0.0': true })
  t.equal(result.status, 'new')
  t.equal(result.previousApprovedVersion, null)
  t.end()
})

t.test('returns "version-changed" when a different pinned version was approved', (t) => {
  const classify = mockClassifier(t)
  const node = { name: 'canvas', packageName: 'canvas', version: '1.0.1' }
  const result = classify(node, { 'canvas@1.0.0': true })
  t.equal(result.status, 'version-changed')
  t.equal(result.previousApprovedVersion, '1.0.0')
  t.end()
})

t.test('returns "version-changed" for scoped package with previous pin', (t) => {
  const classify = mockClassifier(t)
  const node = { name: '@scope/pkg', packageName: '@scope/pkg', version: '2.0.0' }
  const result = classify(node, { '@scope/pkg@1.5.0': true })
  t.equal(result.status, 'version-changed')
  t.equal(result.previousApprovedVersion, '1.5.0')
  t.end()
})

t.test('exact approved version match still counts as prior approval in degenerate path', (t) => {
  const classify = mockClassifier(t)
  const node = { name: 'canvas', packageName: 'canvas', version: '1.0.0' }
  const result = classify(node, { 'canvas@1.0.0': true })
  t.equal(result.status, 'version-changed')
  t.equal(result.previousApprovedVersion, '1.0.0')
  t.end()
})

t.test('returns "version-changed" when name-only entry found', (t) => {
  const classify = mockClassifier(t)
  const node = { name: 'canvas', packageName: 'canvas', version: '1.0.0' }
  const result = classify(node, { canvas: true })
  t.equal(result.status, 'version-changed')
  t.equal(result.previousApprovedVersion, null)
  t.end()
})

t.test('ignores keys that cannot be parsed by npa', (t) => {
  const classify = mockClassifier(t)
  const node = { name: 'canvas', packageName: 'canvas', version: '1.0.0' }
  const result = classify(node, { '%%invalid': true })
  t.equal(result.status, 'new')
  t.end()
})

t.test('skips keys whose parsed name is empty (e.g. remote URL with no name)', (t) => {
  const classify = mockClassifier(t)
  const node = { name: 'canvas', packageName: 'canvas', version: '1.0.0' }
  const result = classify(node, { 'https://example.com/canvas-1.0.0.tgz': true })
  t.equal(result.status, 'new')
  t.end()
})

t.test('range key (e.g. "1.0.0 || 2.0.0") is treated as a versioned entry', (t) => {
  const classify = mockClassifier(t)
  const node = { name: 'canvas', packageName: 'canvas', version: '1.0.1' }
  const result = classify(node, { 'canvas@1.0.0 || 2.0.0': true })
  t.equal(result.status, 'version-changed')
  t.equal(result.previousApprovedVersion, '1.0.0 || 2.0.0')
  t.end()
})

t.test('is case-insensitive for package name matching', (t) => {
  const classify = mockClassifier(t)
  const node = { name: 'Canvas', packageName: 'Canvas', version: '1.0.1' }
  const result = classify(node, { 'canvas@1.0.0': true })
  t.equal(result.status, 'version-changed')
  t.equal(result.previousApprovedVersion, '1.0.0')
  t.end()
})

t.test('falls back to node.name when packageName is missing', (t) => {
  const classify = mockClassifier(t)
  const node = { name: 'pkg', version: '2.0.0' }
  const result = classify(node, { 'pkg@1.0.0': true })
  t.equal(result.status, 'version-changed')
  t.equal(result.previousApprovedVersion, '1.0.0')
  t.end()
})

t.test('node with no version treats version as null (mismatches any pinned key)', (t) => {
  const classify = mockClassifier(t)
  const node = { name: 'pkg', packageName: 'pkg' }
  const result = classify(node, { 'pkg@1.0.0': true })
  t.equal(result.status, 'version-changed')
  t.equal(result.previousApprovedVersion, '1.0.0')
  t.end()
})

t.test('denied entry (false) does not count as previous approval', (t) => {
  const classify = mockClassifier(t)
  const node = { name: 'evil', packageName: 'evil', version: '1.0.1' }
  const result = classify(node, { 'evil@1.0.0': false })
  t.equal(result.status, 'new')
  t.equal(result.previousApprovedVersion, null)
  t.end()
})

t.test('ignores denied entries and uses approved entry for same package', (t) => {
  const classify = mockClassifier(t)
  const node = { name: 'evil', packageName: 'evil', version: '1.0.1' }
  const result = classify(node, {
    'evil@1.0.0': false,
    'evil@0.9.0': true,
  })
  t.equal(result.status, 'version-changed')
  t.equal(result.previousApprovedVersion, '0.9.0')
  t.end()
})
