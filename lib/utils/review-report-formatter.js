const { output } = require('proc-log')
const formatBytes = require('./format-bytes')
const { classifyUrl } = require('./url-classifier')

// Defang a URL so it cannot be clicked accidentally in a markdown renderer.
// hxxps://example[.]com/path  — standard CTI/SOC defang convention.
const defang = (url) => url
  .replace(/^https?/, (s) => s.replace('tt', 'xx'))
  .replace(/\./g, '[.]')

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
//     referencedFiles: Array<{ path, reason, sha256, sizeBytes, signals, references, urls }>,
//     buildInfo: null | Array<{
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
// Two categories:
//   Risk/behavioural  -  "this does something dangerous": BE AWARE.
//   Classifier        -  "this is what kind of build it is": TELLS YOU WHAT TO REVIEW.
const SIGNAL_LABELS = {
  // --- Risk / behavioural signals ---
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
  'makes-executable': 'marks a file executable (chmod +x  -  indicates a bundled or downloaded binary is activated; see bundled-binary-installer / binary-downloader indicators for classification)',
  'modifies-shell-config': 'references shell/git/npm config files',
  'base64-decode-exec': 'decodes base64 data (possible obfuscation)',
  'obfuscation-pattern': 'contains dense hex-escape sequences (obfuscation indicator)',
  'jsfuck-obfuscation': 'contains JSFuck-style encoding ([]()!+ only  -  behaviour is hidden)',
  'external-url': 'references external URLs',
  'shell-network-fetch': 'invokes curl, wget, or netcat (fetches remote data)',
  'process-binding': 'calls process.binding() or process.dlopen() (bypasses module system)',
  'runtime-installer': 'runs npm/yarn/pnpm install as a child process at install time (second-stage install — may pull arbitrary packages with scripts enabled)',
  'requires-local-file': 'imports local files',
  'file-unreadable': 'file could not be read',
  'file-too-large': 'file exceeded scan limit (partially scanned  -  treat with extra suspicion)',
  'depth-limit-reached': 'import chain exceeds scan depth limit (20 levels)  -  further local imports were not scanned',
  // --- Classifier signals  -  identify what kind of build the lifecycle script performs ---
  'native-build': 'lifecycle script compiles a native binary (.node addon)',
  'rust-native': 'Rust build  -  compiles a native addon via napi-rs or neon',
  'wasm-build': 'Rust/WebAssembly build  -  compiles a .wasm module via wasm-bindgen',
  'android-native': 'Android native module  -  includes JNI/NDK C/C++ code',
  'make-build': 'Makefile-driven build  -  may compile code or run arbitrary commands',
  'gyp-conditions': 'GYP build has platform-specific conditions  -  review each branch',
  'binary-download': 'downloads a prebuilt binary at install time (supply-chain risk  -  verify source and integrity)',
  'activates-bundled-binary': 'activates a binary bundled inside the npm tarball (makes it executable  -  verify the binary origin and integrity)',
}

// Signals that are most relevant to security review – shown in risk summary and suggested focus.
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
  'makes-executable',
  'modifies-shell-config',
  'base64-decode-exec',
  'obfuscation-pattern',
  'jsfuck-obfuscation',
  'shell-network-fetch',
  'process-binding',
  'runtime-installer',
  'depth-limit-reached',
  'native-build',
  'rust-native',
  'wasm-build',
  'android-native',
  'make-build',
  'gyp-conditions',
  'binary-download',
  'activates-bundled-binary',
])

const REVIEW_FOCUS = {
  // --- Risk / behavioural ---
  'uses-child-process': 'confirm what external commands are executed and whether they are constrained',
  'uses-eval': 'review eval/Function arguments for dynamic code execution',
  'uses-vm': 'review what code is executed inside the VM context and whether the sandbox is adequately isolated',
  'uses-worker-threads': 'confirm what code runs in worker threads and whether they access sensitive data or make network requests',
  'references-credential-env-var': 'confirm whether environment variable access could expose credentials',
  'network-access': 'confirm what remote endpoints are contacted and whether responses are verified',
  'uses-net-socket': 'confirm what remote hosts are contacted over raw TCP/TLS sockets and whether the data is sensitive',
  'uses-dns': 'confirm whether DNS lookups serve a legitimate purpose or could be used to exfiltrate data via encoded subdomain queries',
  'writes-outside-package': 'confirm whether file writes are scoped to the package directory',
  'makes-executable': 'confirm what file is marked executable  -  cross-reference with bundled-binary-installer (binary bundled in the tarball) or binary-downloader (network fetch) to understand whether the activated file is from a trusted source',
  'modifies-shell-config': 'confirm whether shell or config files are modified unexpectedly',
  'base64-decode-exec': 'review base64-decoded content for hidden payloads',
  'obfuscation-pattern': 'investigate obfuscated code sections',
  'jsfuck-obfuscation': 'decode and audit the JSFuck expression  -  it may execute arbitrary JavaScript',
  'shell-network-fetch': 'confirm what remote URLs are fetched and whether the response is executed or stored',
  'process-binding': 'investigate use of process.binding() or dlopen() to access internal Node.js bindings or native libraries',
  'runtime-installer': 'inspect what package is installed, what version/registry is used, and whether --ignore-scripts=false is passed (enabling the secondary package\'s lifecycle scripts to run)',
  'depth-limit-reached': 'manually follow remaining local imports  -  the scan stopped at depth 20',
  // --- Classifier signals  -  handled per-indicator by buildIndicatorFocusItem ---
  // native-build:             replaced by buildIndicatorReviewFocus (per-file, per-target details)
  // gyp-conditions:           folded into buildIndicatorReviewFocus (conditions detected per-target)
  // wasm-build:               replaced by buildIndicatorReviewFocus (per-module, per-API details)
  // android-native:           replaced by buildIndicatorReviewFocus (per-file details)
  // make-build:               replaced by buildIndicatorReviewFocus (per-file details)
  // binary-download:          replaced by buildIndicatorReviewFocus
  // activates-bundled-binary: replaced by buildIndicatorReviewFocus
  'rust-native': 'review Rust source files for unsafe blocks, network access, and unexpected system calls',
}

// Returns info about where runtime-installer signal was found:
// { found: bool, direct: bool, transitiveFiles: string[] }
// direct = true if the signal appears in the first referenced file (the lifecycle entry point itself)
// transitiveFiles = files beyond the entry point that carry the signal
const findRuntimeInstaller = (pkg) => {
  const files = pkg.referencedFiles || []
  const hits = files.filter(f => (f.signals || []).includes('runtime-installer'))
  if (hits.length === 0) return { found: false }
  const entryFile = files[0]
  const directHit = entryFile && (entryFile.signals || []).includes('runtime-installer')
  const transitiveFiles = hits
    .filter(f => f !== entryFile)
    .map(f => f.path || f.reason || '(unknown)')
  return { found: true, direct: directHit, transitiveFiles }
}

const allSignals = (pkg) => {
  const fromFiles = pkg.referencedFiles.flatMap((f) => f.signals)
  const fromIndicators = (pkg.buildInfo || []).flatMap((ind) => ind.signals)
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

// Generates a single, specific review focus item for one IndicatorResult.
// Uses the actual extracted groups and signals so the message names the exact
// file, targets/modules, APIs, and aspects the reviewer should check  - 
// not a generic "go look at this thing."
const buildIndicatorFocusItem = (ind) => {
  const file = `\`${ind.indicatorFile}\``

  if (ind.parseError) {
    return `inspect ${file}  -  file could not be parsed; review the raw descriptor manually before approving`
  }

  // --- Prebuilt binary downloader ---
  // No indicator file to scan; detection is from the install script command pattern alone.
  // The key reviewer question is: where does the binary come from and is it verified?
  if (ind.signals.includes('binary-download')) {
    if (ind.napiPackageName) {
      return `inspect the install script  -  this package installs a prebuilt binary via ` +
        `\`${ind.napiPackageName}-{platform}\`: verify the scoped npm packages come from ` +
        `the expected registry and publisher, and confirm no unexpected platform targets are included`
    }
    if (ind.downloadUrls && ind.downloadUrls.length > 0) {
      const urlList = ind.downloadUrls.map((u) => `\`${defang(u)}\``).join(', ')
      return `inspect the install script  -  this package fetches a prebuilt binary from ${urlList}: ` +
        `verify this is a trusted source, check for checksum or signature verification, ` +
        `and confirm the binary is scoped to this package's install directory`
    }
    return 'inspect the install script  -  this package fetches a prebuilt binary at install time: ' +
      'verify the download URL is a trusted source (official GitHub release, package author CDN), ' +
      'check for checksum or signature verification, and confirm the binary is scoped to this package\'s install directory'
  }

  // --- Bundled binary activator ---
  // The binary ships inside the npm tarball (no network fetch); a lifecycle script
  // uses chmod+x / fs.chmod to make it executable at install time.
  // Key reviewer question: is the bundled binary safe to run on this machine?
  if (ind.signals.includes('activates-bundled-binary')) {
    return 'inspect the install script  -  this package activates a binary bundled inside the npm tarball: ' +
      'verify the binary was published by a trusted author, confirm it is scoped to the expected platform/arch, ' +
      'and check that no download-from-network step was added alongside the chmod call'
  }

  // --- WebAssembly build (Rust + wasm-bindgen) ---
  // Produce a specific message naming the imported browser/Node.js APIs,
  // js-sys interop, and async bridge, so the reviewer knows exactly what
  // JavaScript capabilities this WASM module has access to.
  if (ind.signals.includes('wasm-build')) {
    const aspects = []
    const webSysGroup = ind.groups.find(g => g.label.includes('web-sys'))
    const hasJsSys = ind.groups.some(g => g.label.includes('js-sys'))
    const hasAsyncBridge = ind.groups.some(g => g.label.includes('wasm-bindgen-futures'))

    if (webSysGroup?.items[0]) {
      // The raw capture is the TOML array body: `"fetch", "Window", "Request"`.
      // Clean it up so the reviewer sees: fetch, Window, Request
      const apis = webSysGroup.items[0]
        .split(',').map(s => s.replace(/["'\s]/g, '')).filter(Boolean).join(', ')
      aspects.push(`imported browser APIs: ${apis}  -  confirm each is needed`)
    } else {
      aspects.push('verify what browser/Node.js APIs are imported via web-sys')
    }
    if (hasJsSys) {
      aspects.push('js-sys used  -  review direct JavaScript interop (includes eval, Function, Reflect)')
    }
    if (hasAsyncBridge) {
      aspects.push('wasm-bindgen-futures  -  review async JS promises spawned from Rust')
    }

    const crateNameGroup = ind.groups.find(g => g.label === 'Crate name' && g.items.length > 0)
    const subject = crateNameGroup?.items[0]
      ? `inspect ${file}  -  WebAssembly module \`${crateNameGroup.items[0]}\``
      : `inspect ${file}  -  WebAssembly module`
    return `${subject}: ${aspects.join('; ')}`
  }

  // --- Android native module ---
  // Name the actual dependencies and note JNI/NDK and iOS companion code.
  if (ind.signals.includes('android-native')) {
    const aspects = []
    const depsGroup = ind.groups.find(g => g.label.includes('dependencies'))
    const hasJni = ind.groups.some(g => g.label.includes('JNI') || g.label.includes('native code'))
    const hasiOS = ind.groups.some(g => g.label.includes('iOS') || g.label.includes('pod'))

    if (depsGroup?.items.length > 0) {
      aspects.push(`verify Android dependencies: ${depsGroup.items.slice(0, 3).join(', ')}`)
    }
    if (hasJni) {
      aspects.push('inspect JNI/NDK C/C++ code for memory safety and unexpected system calls')
    }
    if (hasiOS) {
      aspects.push('review iOS native code and pod specification')
    }

    const subject = `inspect ${file}  -  Android native module`
    return aspects.length
      ? `${subject}: ${aspects.join('; ')}`
      : `${subject}: review build configuration and all native code`
  }

  // --- Makefile build ---
  // Name the external tools invoked (curl/wget warrant close scrutiny),
  // the libraries linked, and any C/C++ sources.
  if (ind.signals.includes('make-build')) {
    const aspects = []
    const toolsGroup = ind.groups.find(g => g.label.includes('External tools'))
    const libsGroup  = ind.groups.find(g => g.label.includes('Libraries linked'))
    const srcGroup   = ind.groups.find(g => g.label.includes('source files'))

    if (toolsGroup?.items.length > 0) {
      aspects.push(`external tools invoked: ${toolsGroup.items.join(', ')}  -  confirm no unexpected remote downloads`)
    }
    if (libsGroup?.items.length > 0) {
      aspects.push(`libraries linked: ${libsGroup.items.join(', ')}  -  verify each is expected`)
    }
    if (srcGroup?.items.length > 0) {
      aspects.push('review C/C++ source files for unsafe operations')
    }

    const subject = `inspect ${file}  -  Makefile build`
    return aspects.length
      ? `${subject}: ${aspects.join('; ')}`
      : `${subject}: review all build steps and external commands`
  }

  // --- GYP-style results  -  group labels are "Target `X`  -  <aspect>" ---
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
    const prefix = `inspect ${file}  -  target${targetNames.length > 1 ? 's' : ''} ${targets}`
    return aspects.length
      ? `${prefix}: ${aspects.join(', ')}`
      : `${prefix}: review build configuration`
  }

  // Generic fallback  -  use the label and any primary named item (e.g. crate name).
  const primaryGroup = ind.groups.find(g =>
    g.label.toLowerCase().includes('name') && g.items.length > 0)
  const primaryName = primaryGroup?.items[0]

  const subject = primaryName
    ? `inspect ${file}  -  ${ind.label} \`${primaryName}\``
    : `inspect ${file}  -  ${ind.label}`

  return aspects.length
    ? `${subject}: ${aspects.join(', ')}`
    : `${subject}: review before approving`
}

// Returns a specific review focus item for each IndicatorResult in buildInfo.
// Returns [] when buildInfo is absent or empty.
const buildIndicatorReviewFocus = (buildInfo) => {
  if (!buildInfo || buildInfo.length === 0) return []
  return buildInfo.map(buildIndicatorFocusItem)
}

// Enrich buildInfo entries with napiPackageName and downloadUrls from
// referencedFiles so that the binary-download indicator can declare what
// it installs and where it fetches from.
// entry.urls is now [{url, classification}] — only 'download'/'unknown'
// classifications are surfaced; 'reference' (homepage) and 'telemetry'
// (analytics/API) URLs are excluded to avoid misleading the reviewer into
// thinking a homepage link or a telemetry endpoint is a download target.
const enrichBuildInfo = (buildInfo, referencedFiles) => {
  if (!buildInfo || buildInfo.length === 0) return buildInfo
  const files = referencedFiles || []
  const napiPackageName = files.map((f) => f.napiPackageName).find(Boolean)
  const downloadUrls = [...new Set(
    files
      .filter((f) => f.signals && f.signals.includes('binary-download') && f.urls && f.urls.length > 0)
      .flatMap((f) => f.urls)
      // Exclude 'reference' (homepage/docs) and 'telemetry' (analytics/API
      // endpoints) URLs: neither is a binary-download target, and surfacing
      // them would mislead the reviewer about where the binary comes from.
      .filter((u) => {
        const cls = u.classification || classifyUrl(u.url ?? u)
        return cls !== 'reference' && cls !== 'telemetry'
      })
      .map((u) => u.url ?? u)
  )]
  return buildInfo.map((ind) => {
    if (!ind.signals.includes('binary-download')) return ind
    const extra = {}
    if (napiPackageName) extra.napiPackageName = napiPackageName
    if (downloadUrls.length > 0) extra.downloadUrls = downloadUrls
    return { ...ind, ...extra }
  })
}

// Returns all review focus items for a package: indicator-specific items first
// (derived from buildInfo groups/signals), then static signal-based items.
// Fallbacks fire when a signal is set but no indicator file was found on disk.
const buildAllReviewFocus = (signals, buildInfo) => {
  const indicatorFocus = buildIndicatorReviewFocus(buildInfo)
  if (signals.includes('native-build') && indicatorFocus.length === 0) {
    indicatorFocus.push(
      'inspect any build descriptor present in the package  -  ' +
      'look for `binding.gyp`, `Cargo.toml`, or `CMakeLists.txt` and ' +
      'review source files for unsafe operations',
    )
  }
  if (signals.includes('wasm-build') && !indicatorFocus.some(s => /WebAssembly/.test(s))) {
    indicatorFocus.push(
      'inspect the WebAssembly build  -  review imported browser/Node.js APIs (web-sys), ' +
      'JavaScript interop (js-sys), and wasm-bindgen output target',
    )
  }
  return [...indicatorFocus, ...buildReviewFocus(signals)]
}

// --- Markdown formatter -------------------------------------------------

const escapeCode = (s) => String(s).replace(/\\/g, '\\\\').replace(/`/g, '\\`')

// Render the build indicator section for a package that has one or more
// indicator files (binding.gyp, Cargo.toml, CMakeLists.txt, android/build.gradle, …).
// The input is an IndicatorResult[] produced by indicator-scanner.js.
const formatBuildIndicatorSection = (indicators, lines, referencedFiles = []) => {
  /* istanbul ignore next: call site already checks Array.isArray && length > 0 */
  if (!Array.isArray(indicators) || indicators.length === 0) return

  lines.push('### Build indicators', '')

  for (const ind of indicators) {
    // 'none'-scanner indicators have no indicator file on disk (sha256 === null, no parseError).
    // Render them with a description-only layout  -  no SHA-256, no "no details" placeholder.
    if (ind.sha256 === null && !ind.parseError) {
      lines.push(`#### ${ind.label}`, '')
      // Emit the signal labels as a brief description so the reviewer knows what was detected.
      if (ind.signals.length > 0) {
        lines.push('> [!CAUTION]')
        for (const sig of ind.signals) {
          const label = SIGNAL_LABELS[sig]
          if (label) lines.push(`> ${label.charAt(0).toUpperCase() + label.slice(1)}.`)
        }
        // If binary-download was detected, show the napi binding package name
        // and/or URLs extracted from the scanned files (already filtered by
        // enrichBuildInfo to exclude reference/homepage URLs).
        if (ind.signals.includes('binary-download')) {
          const napiPackageName = ind.napiPackageName
          const downloadUrls = ind.downloadUrls || []
          if (napiPackageName || downloadUrls.length > 0) {
            lines.push('>')
            if (napiPackageName) {
              lines.push(`> **Installs npm package:** \`${napiPackageName}-{platform}\``)
            }
            if (downloadUrls.length > 0) {
              lines.push('> **Download URLs:**')
              for (const url of downloadUrls) {
                lines.push(`> - \`${defang(url)}\``)
              }
            }
          }
        }
        lines.push('')
      }
      continue
    }

    lines.push(`#### \`${escapeCode(ind.indicatorFile)}\`  -  ${ind.label}`, '')
    lines.push(`**SHA-256:** \`${ind.sha256}\`  `)

    if (ind.parseError) {
      lines.push('')
      lines.push('> [!WARNING]')
      lines.push(`> \`${escapeCode(ind.indicatorFile)}\` could not be parsed: ${ind.parseError}`)
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
      lines.push(`**${group.label}:**`, '')
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
  lines.push('> [!NOTE]')
  lines.push('> This report is best-effort and does not claim to prove a package is safe.')
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
      lines.push('**Introduced by:**', '')
      for (const chain of pkg.introducedBy) {
        lines.push(`- ${chain.join(' -> ')}`)
      }
      lines.push('')
    }

    lines.push('**Lifecycle scripts:**', '')
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
          lines.push('**Detected signals:**', '')
          for (const sig of file.signals) {
            lines.push(`- ${SIGNAL_LABELS[sig] || sig}`)
            if ((sig === 'external-url' || sig === 'binary-download') && file.urls && file.urls.length > 0) {
              for (const u of file.urls) {
                // entry.urls is [{url, classification}]; old fixtures may have plain strings.
                const urlStr = u.url ?? u
                const cls = u.classification ?? classifyUrl(urlStr)
                // 'reference' URLs are never download targets.  For the
                // binary-download bullet, also drop 'telemetry' URLs: an
                // analytics/API endpoint is not where a binary comes from.
                if (cls === 'reference') {
                  continue
                }
                if (sig === 'binary-download' && cls === 'telemetry') {
                  continue
                }
                lines.push(`  - \`${defang(urlStr)}\``)
              }
            }
          }
        }
        // Show reference-classified URLs separately so the reviewer can see
        // them without mistaking them for download targets.
        const otherUrls = (file.urls || []).filter((u) => {
          const cls = u.classification ?? classifyUrl(u.url ?? u)
          return cls === 'reference'
        })
        if (otherUrls.length > 0) {
          lines.push('')
          lines.push('**Other URLs:**', '')
          for (const u of otherUrls) {
            lines.push(`- \`${defang(u.url ?? u)}\``)
          }
        }
        if (file.references && file.references.length > 0) {
          lines.push('')
          lines.push('**Local imports:**', '')
          for (const ref of file.references) {
            lines.push(`- \`${escapeCode(ref)}\``)
          }
        }
        lines.push('')
      }
    } else {
      lines.push('*No local files directly referenced by lifecycle scripts.*', '')
    }

    if (pkg.buildInfo && pkg.buildInfo.length > 0) {
      const enrichedBuildInfo = enrichBuildInfo(pkg.buildInfo, pkg.referencedFiles)
      formatBuildIndicatorSection(enrichedBuildInfo, lines, pkg.referencedFiles)
    }

    const signals = allSignals(pkg)

    // 🚨 RUNTIME-INSTALLER ALARM — must appear before the general risk summary
    const ri = findRuntimeInstaller(pkg)
    if (ri.found) {
      lines.push('> [!CAUTION]')
      lines.push('> ## 🚨 SECOND-STAGE INSTALL DETECTED')
      lines.push('>')
      if (ri.direct) {
        lines.push('> This package\'s lifecycle script calls `npm install` (or `yarn`/`pnpm` equivalent)')
        lines.push('> **directly inside its own postinstall/install script.**')
      } else {
        lines.push('> A file called by this package\'s lifecycle script calls `npm install`')
        lines.push('> (or `yarn`/`pnpm` equivalent) — **hidden one level deep:**')
        for (const f of ri.transitiveFiles) {
          lines.push(`> - \`${f}\``)
        }
      }
      lines.push('>')
      lines.push('> **This means:**')
      lines.push('> - Additional packages are installed that do **not** appear in `package-lock.json`')
      lines.push('> - Those packages are **not** subject to `npm audit` or your lockfile')
      lines.push('> - If `--ignore-scripts=false` is passed, the secondary package\'s own lifecycle')
      lines.push('>   scripts will run — bypassing any `--ignore-scripts` flag you set')
      lines.push('>')
      lines.push('> **Before approving:** inspect the lifecycle script to identify exactly which')
      lines.push('> package is installed, which version/registry is used, and whether')
      lines.push('> `--ignore-scripts=false` is present.')
      lines.push('')
    }

    // 🚨 OBFUSCATED CHILD PROCESS ALARM
    // Fires when child_process is used but the command string is hidden via
    // obfuscation — static analysis cannot determine what is being executed.
    const OBFUSCATION_SIGNALS = new Set([
      'obfuscation-pattern', 'base64-decode-exec', 'jsfuck-obfuscation',
    ])
    const hasChildProcess = signals.includes('uses-child-process')
    const obfuscationHits = signals.filter(s => OBFUSCATION_SIGNALS.has(s))
    if (hasChildProcess && obfuscationHits.length > 0 && !ri.found) {
      lines.push('> [!WARNING]')
      lines.push('> ## ⚠️ CHILD PROCESS WITH OBFUSCATED COMMAND')
      lines.push('>')
      lines.push('> This package uses `child_process` to spawn external commands, but')
      lines.push('> the command string appears to be **constructed or hidden at runtime** using:')
      for (const s of obfuscationHits) {
        lines.push(`> - ${SIGNAL_LABELS[s] || s}`)
      }
      lines.push('>')
      lines.push('> **Static analysis cannot determine what command is executed.**')
      lines.push('> Known hiding techniques include: hex/unicode escapes, `String.fromCharCode`,')
      lines.push('> base64/atob decoding, reversed strings, single-character array joins,')
      lines.push('> char-by-char `+=` building, and junk-character insertion + `.replace()` removal.')
      lines.push('> A sufficiently determined attacker can use index lookups, bitwise ops,')
      lines.push('> or external data to construct any string — **no static tool can catch all forms.**')
      lines.push('>')
      lines.push('> **Do not approve without running the script in a sandboxed environment**')
      lines.push('> to observe what it actually executes at runtime.')
      lines.push('')
    }

    const riskSummary = buildRiskSummary(signals)
    if (riskSummary.length > 0) {
      lines.push('### Risk summary', '')
      lines.push('> [!CAUTION]')
      lines.push('>')
      for (const s of riskSummary) {
        lines.push(`> - ${s}`)
      }
      lines.push('')
    }

    const enrichedBuildInfo = enrichBuildInfo(pkg.buildInfo, pkg.referencedFiles)
    const focus = buildAllReviewFocus(signals, enrichedBuildInfo)
    if (focus.length > 0) {
      lines.push('### Suggested review focus', '')
      lines.push('> [!IMPORTANT]')
      lines.push('>')
      for (const f of focus) {
        lines.push(`> - ${f}`)
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

  return lines.join('\n').trimEnd()
}

// --- JSON formatter -----------------------------------------------------

const formatJson = (packages) => {
  const enriched = packages.map((pkg) => {
    const buildInfo = enrichBuildInfo(pkg.buildInfo, pkg.referencedFiles)
    const signals = allSignals(pkg)
    return {
      ...pkg,
      buildInfo,
      riskSummary: buildRiskSummary(signals),
      suggestedReviewFocus: buildAllReviewFocus(signals, buildInfo),
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
