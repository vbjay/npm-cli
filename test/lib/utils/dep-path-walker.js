const t = require('tap')

const mockWalker = (t, mocks = {}) =>
  t.mock('../../../lib/utils/dep-path-walker.js', {
    '@npmcli/arborist/lib/script-allowed.js': {
      trustedDisplay: (node) => ({ name: node.name, version: node.version }),
    },
    ...mocks,
  })

// Build a minimal arborist node with optional edgesIn.
const node = ({
  name = 'pkg',
  version = '1.0.0',
  edgesIn: edgeList = [],
  isProjectRoot = false,
  packageName,
} = {}) => ({
  name,
  packageName: packageName ?? name,
  version,
  location: `node_modules/${name}`,
  isProjectRoot,
  edgesIn: new Set(edgeList),
})

const root = ({ name = 'my-app', version = '1.0.0' } = {}) =>
  node({ name, version, isProjectRoot: true })

const edge = (from, to) => ({ from, to })

t.test('direct dependency – single parent is root', (t) => {
  const getDepPaths = mockWalker(t)
  const rootNode = root()
  const target = node({ name: 'canvas', version: '2.0.0', edgesIn: [edge(rootNode)] })

  const result = getDepPaths(target)

  t.equal(result.dependencyType, 'direct')
  t.equal(result.introducedBy.length, 1)
  t.strictSame(result.introducedBy[0], ['my-app', 'canvas@2.0.0'])
  t.end()
})

t.test('transitive dependency – one level deep', (t) => {
  const getDepPaths = mockWalker(t)
  const rootNode = root()
  const direct = node({ name: 'direct', version: '1.0.0', edgesIn: [edge(rootNode)] })
  const target = node({ name: 'transitive', version: '3.0.0', edgesIn: [edge(direct)] })

  const result = getDepPaths(target)

  t.equal(result.dependencyType, 'transitive')
  t.equal(result.introducedBy.length, 1)
  t.strictSame(result.introducedBy[0], ['my-app', 'direct@1.0.0', 'transitive@3.0.0'])
  t.end()
})

t.test('package introduced by multiple direct parents', (t) => {
  const getDepPaths = mockWalker(t)
  const rootNode = root()
  const depA = node({ name: 'dep-a', version: '1.0.0', edgesIn: [edge(rootNode)] })
  const depB = node({ name: 'dep-b', version: '2.0.0', edgesIn: [edge(rootNode)] })
  const target = node({ name: 'shared', version: '1.0.0', edgesIn: [edge(depA), edge(depB)] })

  const result = getDepPaths(target)

  t.equal(result.dependencyType, 'transitive')
  t.equal(result.introducedBy.length, 2)
  const pathStrings = result.introducedBy.map((p) => p.join(' → '))
  t.ok(pathStrings.some((p) => p.includes('dep-a')))
  t.ok(pathStrings.some((p) => p.includes('dep-b')))
  t.end()
})

t.test('node with no edgesIn (no incoming edges)', (t) => {
  const getDepPaths = mockWalker(t)
  const target = node({ name: 'orphan', version: '1.0.0', edgesIn: [] })

  const result = getDepPaths(target)

  t.equal(result.dependencyType, 'transitive', 'no root edge means transitive')
  t.equal(result.introducedBy.length, 1)
  t.equal(result.introducedBy[0][0], 'orphan@1.0.0')
  t.end()
})

t.test('node with undefined edgesIn (minimal mock node)', (t) => {
  const getDepPaths = mockWalker(t)
  // Nodes in some test fixtures don't have edgesIn at all.
  const target = { name: 'minimal', version: '1.0.0', location: 'node_modules/minimal' }

  const result = getDepPaths(target)

  t.equal(result.dependencyType, 'transitive')
  t.ok(Array.isArray(result.introducedBy))
  t.end()
})

t.test('deep transitive dependency – two levels', (t) => {
  const getDepPaths = mockWalker(t)
  const rootNode = root()
  const lvl1 = node({ name: 'lvl1', version: '1.0.0', edgesIn: [edge(rootNode)] })
  const lvl2 = node({ name: 'lvl2', version: '1.0.0', edgesIn: [edge(lvl1)] })
  const target = node({ name: 'target', version: '1.0.0', edgesIn: [edge(lvl2)] })

  const result = getDepPaths(target)

  t.equal(result.dependencyType, 'transitive')
  t.equal(result.introducedBy.length, 1)
  t.strictSame(result.introducedBy[0],
    ['my-app', 'lvl1@1.0.0', 'lvl2@1.0.0', 'target@1.0.0'])
  t.end()
})

t.test('package with no version still works', (t) => {
  const getDepPaths = mockWalker(t)
  const rootNode = root()
  const target = node({ name: 'no-version', version: null, edgesIn: [edge(rootNode)] })

  const result = getDepPaths(target)

  t.equal(result.dependencyType, 'direct')
  // path entry should not include @null
  t.ok(result.introducedBy[0][1].startsWith('no-version'))
  t.end()
})

t.test('root node with no packageName or name falls back to "root" label', (t) => {
  // Covers the `|| 'root'` fallback branch in
  // `const rootName = (from.packageName || from.name || 'root')`.
  // A minimal root-like node that has neither a packageName nor a name field
  // should still produce a valid path, using the literal string 'root'.
  const getDepPaths = mockWalker(t)
  const namelessRoot = { isProjectRoot: true, edgesIn: new Set() }
  const target = node({ name: 'pkg', version: '1.0.0', edgesIn: [edge(namelessRoot)] })

  const result = getDepPaths(target)

  t.equal(result.dependencyType, 'direct')
  t.equal(result.introducedBy[0][0], 'root', 'falls back to literal "root" when name is absent')
  t.end()
})

t.test('edge with null from is skipped gracefully', (t) => {
  // Covers the `if (!from) { continue }` branch (line 54) in collectPaths.
  // An edge whose `from` property is null/undefined is silently skipped;
  // the remaining valid edge still produces a path.
  const getDepPaths = mockWalker(t)
  const rootNode = root()
  const target = node({
    name: 'pkg', version: '1.0.0',
    edgesIn: [
      { from: null },     // edge with no from — must be skipped
      edge(rootNode),     // valid direct edge — must still be processed
    ],
  })

  const result = getDepPaths(target)

  t.equal(result.dependencyType, 'direct', 'valid edge still makes it direct')
  t.equal(result.introducedBy.length, 1)
  t.end()
})

t.test('cycle in dependency graph is detected and skipped', (t) => {
  // Covers the `if (visited.has(from)) { continue }` branch (line 62).
  // parent.edgesIn → target creates a back-edge: when collectPaths recurses
  // into parent, target is already in `visited`, so the edge is skipped.
  const getDepPaths = mockWalker(t)
  const rootNode = root()

  // Build nodes manually to allow mutual edgesIn references.
  const parentNode = {
    name: 'parent', version: '1.0.0',
    packageName: 'parent',
    isProjectRoot: false,
    edgesIn: new Set(),  // filled in below
  }
  const target = node({
    name: 'cyclic-pkg', version: '1.0.0',
    edgesIn: [
      edge(rootNode),    // direct root edge (provides a valid path)
      edge(parentNode),  // transitive edge that will create a cycle
    ],
  })
  // Create the back-edge: parent → target (cycle)
  parentNode.edgesIn = new Set([edge(target)])

  const result = getDepPaths(target)

  t.ok(Array.isArray(result.introducedBy), 'returns without infinite recursion')
  t.ok(result.introducedBy.length >= 1, 'at least the direct root path is returned')
  t.end()
})

t.test('MAX_PATHS cap: break fires when direct-root edges exceed the limit', (t) => {
  // Covers the `break` on line 74 and the early `return` on line 69.
  // `mid` has MAX_PATHS (8) direct root-edges → its collectPaths hits the
  // line-74 break after the 8th push.
  // `target` has one edge from `mid` whose parentPaths returns 8 entries →
  // the inner loop accumulates 8 entries and line 69 fires.
  const getDepPaths = mockWalker(t)
  const rootNode = root()

  // 8 edges all coming directly from root — after the 8th push paths.length
  // equals MAX_PATHS (8), triggering the `break` on line 74.
  const MAX_PATHS = 8
  const manyEdges = Array.from({ length: MAX_PATHS }, () => edge(rootNode))
  const mid = node({ name: 'mid', version: '1.0.0', edgesIn: manyEdges })

  // target → mid: parentPaths for mid has MAX_PATHS entries, so the inner
  // for-loop hits the early `return` on line 69 after the 8th push.
  const target = node({ name: 'target', version: '1.0.0', edgesIn: [edge(mid)] })

  const result = getDepPaths(target)

  t.ok(result.introducedBy.length <= MAX_PATHS, 'introducedBy is capped at MAX_PATHS')
  t.end()
})
