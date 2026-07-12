// Compute all dependency paths from the project root to a given arborist node.
//
// Returns:
//   {
//     dependencyType: 'direct' | 'transitive',
//     introducedBy: string[][]
//   }
//
// Each `introducedBy` entry is an ordered path array like:
//   ['my-app', 'direct-dep@4.5.6', 'target@1.3.4']
//
// `dependencyType` is `'direct'` when at least one edge into the node comes
// directly from the project root; `'transitive'` otherwise.
//
// At most `MAX_PATHS` paths are returned to avoid excessive output for
// packages that are heavily shared across the dependency graph.
const MAX_PATHS = 8

// Build a human-readable "name@version" label for a node.  This is for
// display only — not for policy matching — so we use the node's own
// packageName/name and version rather than the trusted registry identity
// (which would require pulling in @npmcli/arborist at load time and would
// create a hard workspace-level import cycle for a utility module).
const nodeDisplay = (node) => {
  /* istanbul ignore next: defensive fallback */
  const n = node.packageName || node.name || '<unknown>'
  const v = node.version || null
  return v ? `${n}@${v}` : n
}

// Recursive helper: returns all paths from the project root to `node`.
// `visited` prevents re-entering the same node in a single path (cycle guard).
//
// NOTE: This function accesses `node.edgesIn`, `edge.from`, and
// `node.isProjectRoot` directly.  These are instance-level properties of
// arborist's Node / Edge classes — not part of a formally versioned public API,
// but structurally stable because arborist is a workspace-internal package
// within this monorepo and no higher-level public API exists that provides
// equivalent path-traversal information.
const collectPaths = (node, visited) => {
  /* istanbul ignore next: defensive guard — collectPaths is only called with
     a truthy node (from getDepPaths or after the !from continue guard) */
  if (!node) {
    return []
  }

  // edgesIn may be absent on minimal mock nodes used in some tests.
  const edges = node.edgesIn instanceof Set ? [...node.edgesIn] : []

  if (edges.length === 0) {
    // No incoming edges – treat as if directly attached to root.
    return [[nodeDisplay(node)]]
  }

  const paths = []
  for (const edge of edges) {
    const from = edge.from
    if (!from) {
      continue
    }
    if (from.isProjectRoot) {
      const rootName = (from.packageName || from.name || 'root')
      paths.push([rootName, nodeDisplay(node)])
    } else {
      if (visited.has(from)) {
        // Cycle guard: skip this edge.
        continue
      }
      const newVisited = new Set(visited).add(from)
      const parentPaths = collectPaths(from, newVisited)
      for (const pp of parentPaths) {
        paths.push([...pp, nodeDisplay(node)])
        if (paths.length >= MAX_PATHS) {
          return paths
        }
      }
    }
    if (paths.length >= MAX_PATHS) {
      break
    }
  }

  return paths
}

// Determine whether a node is a direct or transitive dependency.
const classifyDepType = (node) => {
  const edges = node.edgesIn instanceof Set ? [...node.edgesIn] : []
  for (const edge of edges) {
    if (edge.from && edge.from.isProjectRoot) {
      return 'direct'
    }
  }
  return 'transitive'
}

const getDepPaths = (node) => {
  const dependencyType = classifyDepType(node)
  const introducedBy = collectPaths(node, new Set([node]))
  return { dependencyType, introducedBy }
}

module.exports = getDepPaths
