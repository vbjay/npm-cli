const { output } = require('proc-log')
const formatBytes = require('./format-bytes')

// Format a review report for pending lifecycle script approvals.
//
// Input `packages` shape:
//   Array<{
//     name: string,
//     version: string,
//     location: string,
//     approvalStatus: 'pending',
//     dependencyType: 'direct' | 'transitive',
//     introducedBy: string[][],
//     lifecycleScripts: Object,
//     referencedFiles: Array<{ path, reason, sha256, sizeBytes, signals, references }>,
//     nativeBuildInfo: null | Array<{
//       indicatorFile: string,
//       label: string,
//       sha256: string,
//       parseError: string | null,
//       signals: string[],
//       groups: Array<{ label: string, items: string[] }>,
//     }>,
//     changeClassification: { status, previousApprovedVersion },
//   }>
//
// `format` is either `'markdown'` or `'json'`.

// Human-readable descriptions for signal keys.
const SIGNAL_LABELS = {
  'uses-child-process': 'uses child_process (can spawn external commands)',
  'uses-eval': 'uses eval or dynamic Function constructor',
  'uses-vm': 'uses the vm module (can execute arbitrary code in a new context)',
  'uses-worker-threads': 'uses worker_threads (can run arbitrary code in parallel workers)',
  'reads-process-env': 'reads process.env',
  'references-credential-env-var': 'references credential-like environment variable',
  'network-access': 'makes network requests',
  'uses-net-socket': 'uses raw TCP/TLS socket (net or tls module)',
  'uses-dns': 'performs DNS lookups (potential data-exfiltration channel)',
  'writes-file': 'writes files to disk',
  'writes-outside-package': 'may write outside the package directory',
  'modifies-shell-config': 'references shell/git/npm config files',
  'base64-decode-exec': 'decodes base64 data (possible obfuscation)',
  'obfuscation-pattern': 'contains dense hex-escape sequences (obfuscation indicator)',
  'jsfuck-obfuscation': 'contains JSFuck-style encoding ([]()!+ only — behaviour is hidden)',
  'external-url': 'references external URLs',
  'native-build': 'builds native code (compiles C/C++ or Rust addon)',
  'rust-native': 'compiles a Rust native addon (Cargo.toml / napi-rs / neon)',
  'shell-network-fetch': 'invokes curl, wget, or netcat (fetches remote data)',
  'process-binding': 'calls process.binding() or process.dlopen() (bypasses module system)',
  'requires-local-file': 'imports local files',
  'file-unreadable': 'file could not be read',
  'file-too-large': 'file exceeded scan limit (partially scanned — treat with extra suspicion)',
}

// Signals that are most relevant to security review – shown in suggested focus.
const HIGH_RISK_SIGNALS = new Set([
  'uses-child-process',
  'uses-eval',
  'uses-vm',
  'uses-worker-threads',
  'references-credential-env-var',
  'network-access',
  'uses-net-socket',
  'uses-dns',
  'writes-outside-package',
  'modifies-shell-config',
  'base64-decode-exec',
  'obfuscation-pattern',
  'jsfuck-obfuscation',
  'shell-network-fetch',
  'process-binding',
  'native-build',
  'rust-native',
  'gyp-conditions',
])

const REVIEW_FOCUS = {
  'uses-child-process': 'confirm what external commands are executed and whether they are constrained',
  'uses-eval': 'review eval/Function arguments for dynamic code execution',
  'uses-vm': 'review what code is executed inside the VM context and whether the sandbox is adequately isolated',
  'uses-worker-threads': 'confirm what code runs in worker threads and whether they access sensitive data or make network requests',
  'references-credential-env-var': 'confirm whether environment variable access could expose credentials',
  'network-access': 'confirm what remote endpoints are contacted and whether responses are verified',
  'uses-net-socket': 'confirm what remote hosts are contacted over raw TCP/TLS sockets and whether the data is sensitive',
  'uses-dns': 'confirm whether DNS lookups serve a legitimate purpose or could be used to exfiltrate data via encoded subdomain queries',
  'writes-outside-package': 'confirm whether file writes are scoped to the package directory',
  'modifies-shell-config': 'confirm whether shell or config files are modified unexpectedly',
  'base64-decode-exec': 'review base64-decoded content for hidden payloads',
  'obfuscation-pattern': 'investigate obfuscated code sections',
  'jsfuck-obfuscation': 'decode and audit the JSFuck expression — it may execute arbitrary JavaScript',
  'shell-network-fetch': 'confirm what remote URLs are fetched and whether the response is executed or stored',
  'process-binding': 'investigate use of process.binding() or dlopen() to access internal Node.js bindings or native libraries',
  // native-build: replaced by buildIndicatorReviewFocus (per-file, per-target details)
  // gyp-conditions: folded into buildIndicatorReviewFocus (conditions detected per-target)
  'rust-native': 'review Rust source files for unsafe blocks, network access, and unexpected system calls',
}

const allSignals = (pkg) => {
  const fromFiles = pkg.referencedFiles.flatMap((f) => f.signals)
  const fromIndicators = (pkg.nativeBuildInfo || []).flatMap((ind) => ind.signals)
  return [...new Set([...fromFiles, ...fromIndicators])]
}

// Pinned ref for approve (name@version). Deny always writes name-only.
const buildRiskSummary = (signals) =>
  signals
    .filter((s) => HIGH_RISK_SIGNALS.has(s))
    .map((s) => SIGNAL_LABELS[s] || /* istanbul ignore next */ s)

const buildReviewFocus = (signals) =>
  signals
    .filter((s) => REVIEW_FOCUS[s])
    .map((s) => REVIEW_FOCUS[s])

// Generates a single, specific review focus item for one IndicatorResult,
// using the extracted groups and signals to name the exact file, targets,
// and aspects that the reviewer should check.
const buildIndicatorFocusItem = (ind) => {
  const file = `\`${ind.indicatorFile}\``

  if (ind.parseError) {
    return `inspect ${file} — file could not be parsed; review the raw descriptor manually before approving`
  }

  // GYP-style results use group labels of the form "Target `X` — <aspect>".
  // Collect unique target names to use in the focus message.
  const targetNames = [...new Set(
    ind.groups
      .map(g => g.label.match(/^Target `([^`]+)`/)?.[1])
      .filter(Boolean),
  )]

  const hasConditions =
    ind.signals.includes('gyp-conditions') ||
    ind.groups.some(g => g.label.toLowerCase().includes('condition'))

  const aspects = []
  if (ind.groups.some(g => g.label.toLowerCase().includes('source'))) {
    aspects.push('inspect source files for unsafe operations')
  }
  if (ind.groups.some(g =>
    g.label.toLowerCase().includes('librar') ||
    g.label.toLowerCase().includes('dependenc'))) {
    aspects.push('verify all dependencies are expected')
  }
  if (hasConditions) {
    aspects.push('review each platform-specific condition branch')
  }

  if (targetNames.length > 0) {
    const targets = targetNames.map(n => `\`${n}\``).join(', ')
    const prefix = `inspect ${file} — target${targetNames.length > 1 ? 's' : ''} ${targets}`
    return aspects.length
      ? `${prefix}: ${aspects.join(', ')}`
      : `${prefix}: review build configuration`
  }

  // No targets: look for a named primary item (e.g. crate name from Cargo.toml).
  const primaryGroup = ind.groups.find(g =>
    g.label.toLowerCase().includes('name') && g.items.length > 0)
  const primaryName = primaryGroup?.items[0]

  const subject = primaryName
    ? `inspect ${file} — ${ind.label} \`${primaryName}\``
    : `inspect ${file} — ${ind.label}`

  return aspects.length
    ? `${subject}: ${aspects.join(', ')}`
    : `${subject}: review before approving`
}

// Returns a specific review focus item for each IndicatorResult in nativeBuildInfo.
// Returns [] when nativeBuildInfo is absent or empty.
const buildIndicatorReviewFocus = (nativeBuildInfo) => {
  if (!nativeBuildInfo || nativeBuildInfo.length === 0) return []
  return nativeBuildInfo.map(buildIndicatorFocusItem)
}

// Returns all review focus items for a package: indicator-specific items first
// (derived from nativeBuildInfo), then static signal-based items.
// Falls back to a brief generic message when native-build fired but no indicator
// files were found on disk (should be rare in practice).
const buildAllReviewFocus = (signals, nativeBuildInfo) => {
  const indicatorFocus = buildIndicatorReviewFocus(nativeBuildInfo)
  if (signals.includes('native-build') && indicatorFocus.length === 0) {
    indicatorFocus.push(
      'inspect any native build descriptor present in the package — ' +
      'look for `binding.gyp`, `Cargo.toml`, or `CMakeLists.txt` and ' +
      'review source files for unsafe operations',
    )
  }
  return [...indicatorFocus, ...buildReviewFocus(signals)]
}

// --- Markdown formatter -------------------------------------------------

const escapeCode = (s) => String(s).replace(/\\/g, '\\\\').replace(/`/g, '\\`')

// Render the native build section for a package that has one or more
// indicator files (binding.gyp, Cargo.toml, CMakeLists.txt, …).
// The input is an IndicatorResult[] produced by indicator-scanner.js.
const formatNativeBuildSection = (indicators, lines) => {
  /* istanbul ignore next: call site already checks Array.isArray && length > 0 */
  if (!Array.isArray(indicators) || indicators.length === 0) return

  lines.push('### Native build indicators', '')

  for (const ind of indicators) {
    lines.push(`#### \`${escapeCode(ind.indicatorFile)}\` — ${ind.label}`, '')
    lines.push(`**SHA-256:** \`${ind.sha256}\`  `)

    if (ind.parseError) {
      lines.push('')
      lines.push(`> **Warning:** \`${escapeCode(ind.indicatorFile)}\` could not be parsed: ${ind.parseError}`)
      lines.push('> Inspect the file manually before approving.')
      lines.push('')
      continue
    }

    if (ind.groups.length === 0) {
      lines.push('')
      lines.push(`*No details extracted from \`${escapeCode(ind.indicatorFile)}\`.*`)
      lines.push('')
      continue
    }

    for (const group of ind.groups) {
      lines.push('')
      lines.push(`**${group.label}:**`)
      for (const item of group.items) {
        lines.push(`- \`${escapeCode(item)}\``)
      }
    }
    lines.push('')
  }
}

const formatMarkdown = (packages) => {
  if (packages.length === 0) {
    return '# npm Lifecycle Script Approval Review\n\nNo packages with unreviewed install scripts.\n'
  }

  const lines = ['# npm Lifecycle Script Approval Review', '']
  lines.push('> **Note:** This report is best-effort and does not claim to prove a package is safe.')
  lines.push('> A human must review this evidence before approving or denying any package.')
  lines.push('')

  for (const pkg of packages) {
    const header = pkg.version ? `${pkg.name}@${pkg.version}` : pkg.name
    lines.push(`## Package: ${header}`, '')
    lines.push(`**Location:** \`${pkg.location}\`  `)
    lines.push(`**Dependency type:** ${pkg.dependencyType}  `)
    lines.push(`**Approval status:** ${pkg.approvalStatus}  `)

    if (pkg.changeClassification) {
      const cc = pkg.changeClassification
      if (cc.status === 'version-changed' && cc.previousApprovedVersion) {
        lines.push(`**Change:** previously approved version was \`${cc.previousApprovedVersion}\`  `)
      } else if (cc.status === 'new') {
        lines.push('**Change:** no previous approval found (new)  ')
      }
    }
    lines.push('')

    if (pkg.introducedBy && pkg.introducedBy.length > 0) {
      lines.push('**Introduced by:**')
      for (const chain of pkg.introducedBy) {
        lines.push(`- ${chain.join(' → ')}`)
      }
      lines.push('')
    }

    lines.push('**Lifecycle scripts:**')
    lines.push('```json')
    lines.push(JSON.stringify(pkg.lifecycleScripts, null, 2))
    lines.push('```')
    lines.push('')

    if (pkg.referencedFiles.length > 0) {
      lines.push('### Referenced files', '')
      for (const file of pkg.referencedFiles) {
        const fileLabel = file.path === null ? '<inline>' : escapeCode(file.path)
        lines.push(`#### \`${fileLabel}\``, '')
        lines.push(`**Reason:** ${file.reason}  `)
        if (file.sha256 != null) {
          lines.push(`**SHA-256:** \`${file.sha256}\`  `)
        }
        if (file.sizeBytes != null) {
          lines.push(`**Size:** ${formatBytes(file.sizeBytes)}  `)
        }
        if (file.signals.length > 0) {
          lines.push('')
          lines.push('**Detected signals:**')
          for (const sig of file.signals) {
            lines.push(`- ${SIGNAL_LABELS[sig] || sig}`)
          }
        }
        if (file.references && file.references.length > 0) {
          lines.push('')
          lines.push('**Local imports:**')
          for (const ref of file.references) {
            lines.push(`- \`${escapeCode(ref)}\``)
          }
        }
        lines.push('')
      }
    } else {
      lines.push('*No local files directly referenced by lifecycle scripts.*', '')
    }

    if (pkg.nativeBuildInfo && pkg.nativeBuildInfo.length > 0) {
      formatNativeBuildSection(pkg.nativeBuildInfo, lines)
    }

    const signals = allSignals(pkg)
    const riskSummary = buildRiskSummary(signals)
    if (riskSummary.length > 0) {
      lines.push('### Risk summary', '')
      for (const s of riskSummary) {
        lines.push(`- ${s}`)
      }
      lines.push('')
    }

    const focus = buildAllReviewFocus(signals, pkg.nativeBuildInfo)
    if (focus.length > 0) {
      lines.push('### Suggested review focus', '')
      for (const f of focus) {
        lines.push(`- ${f}`)
      }
      lines.push('')
    }

    const ref = pkg.name
    lines.push('### Actions', '')
    lines.push(`- **Approve (pinned):** \`npm approve-scripts ${ref}\``)
    lines.push(`- **Approve (any version):** \`npm approve-scripts --no-allow-scripts-pin ${ref}\``)
    lines.push(`- **Deny:** \`npm deny-scripts ${ref}\``)
    lines.push('')

    lines.push('---', '')
  }

  return lines.join('\n')
}

// --- JSON formatter -----------------------------------------------------

const formatJson = (packages) => {
  const enriched = packages.map((pkg) => {
    const signals = allSignals(pkg)
    return {
      ...pkg,
      riskSummary: buildRiskSummary(signals),
      suggestedReviewFocus: buildAllReviewFocus(signals, pkg.nativeBuildInfo),
      approveCommand: `npm approve-scripts ${pkg.name}`,
      approveCommandNameOnly: `npm approve-scripts --no-allow-scripts-pin ${pkg.name}`,
      denyCommand: `npm deny-scripts ${pkg.name}`,
    }
  })
  return JSON.stringify({ packages: enriched }, null, 2)
}

// --- Public API ---------------------------------------------------------

const formatReviewReport = (packages, format) => {
  if (format === 'json') {
    output.standard(formatJson(packages))
  } else {
    output.standard(formatMarkdown(packages))
  }
}

module.exports = formatReviewReport
module.exports.formatMarkdown = formatMarkdown
module.exports.formatJson = formatJson
