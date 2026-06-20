---
title: approve-scripts report
section: 7
description: Understanding the npm approve-scripts Markdown and JSON review report
---

### Description

When you run `npm approve-scripts --allow-scripts-pending`, npm generates a
structured **review report** for every package whose lifecycle scripts have not
yet been approved. The report is meant to be read — by a human, a security
reviewer, or an AI assistant — before any approval decision is made.

Two output formats are available:

```bash
# Markdown (default) — human-readable, renders on GitHub and in editors
npm approve-scripts --allow-scripts-pending > review.md

# JSON — machine-readable, suitable for AI pipelines and CI tooling
npm approve-scripts --allow-scripts-pending \
  --allow-scripts-report-format=json > review.json

# Plain text listing — original behaviour, no report
npm approve-scripts --allow-scripts-pending \
  --allow-scripts-report-format=null
```

---

### Markdown report

The Markdown report is optimised for reading in a GitHub PR comment, a code
review tool, or a plain text editor. It renders GitHub Flavored Markdown
including task lists, fenced code blocks, and the GitHub alert callout syntax
(`> [!CAUTION]`, `> [!WARNING]`, `> [!NOTE]`).

#### Per-package sections

Each pending package gets its own section containing:

| Field | Description |
|-------|-------------|
| **Header** | `## package-name@version` with dependency type (direct / transitive) |
| **Introduced by** | Full dependency path(s) from your project root |
| **Lifecycle scripts** | Exact command strings that will run (`preinstall`, `install`, `postinstall`, `prepare`) |
| **Scanned files** | Every local file referenced by those commands, with SHA-256 hash and byte count |
| **Risk signals** | Signals detected in each file (see below) |
| **Risk summary** | Aggregated signal list across all scanned files |

#### Alarm callouts

Two high-priority alarm blocks appear above the risk summary when especially
concerning patterns are found:

> [!CAUTION]
> **SECOND-STAGE PACKAGE INSTALL DETECTED**
>
> This package's postinstall calls `npm install` (or `yarn`/`pnpm`) as a child
> process. This means additional packages are downloaded and installed — with
> their own lifecycle scripts — **outside the dependency tree you reviewed**.

This alarm fires when the `runtime-installer` signal is detected: a lifecycle
script (directly or in a `require()`'d file) executes `npm install`,
`yarn add`, `pnpm install`, or equivalent via any exec-like API
(`execSync`, `spawnSync`, `execa`, `cross-spawn`, etc.).

> [!WARNING]
> **CHILD PROCESS WITH OBFUSCATED COMMAND**
>
> This package uses `child_process` and also contains patterns consistent with
> string obfuscation. Static analysis cannot determine what command will run.

This alarm fires when `uses-child-process` and any obfuscation signal
(`obfuscation-pattern`, `base64-decode-exec`, `jsfuck-obfuscation`) are
both detected. It acknowledges that static analysis has fundamental limits:
index lookups, bitwise operations, and runtime-fetched data can construct
arbitrary strings that no scanner can detect.

#### Risk signals reference

| Signal | Meaning |
|--------|---------|
| `uses-child-process` | Imports or uses `child_process` to spawn external commands |
| `uses-eval` | Uses `eval()` or `new Function()` — arbitrary code execution |
| `uses-vm` | Uses the `vm` module — sandbox escape vector |
| `uses-worker-threads` | Spins up a parallel Node.js worker |
| `reads-process-env` | Reads environment variables via `process.env` |
| `references-credential-env-var` | Reads a named secret-like env var (token, key, password…) |
| `network-access` | Makes HTTP(S) requests at install time |
| `uses-net-socket` | Opens raw TCP/TLS connections (invisible to HTTP detectors) |
| `uses-dns` | Performs DNS lookups (covert exfiltration channel) |
| `writes-file` | Writes files to disk |
| `writes-outside-package` | Uses `../` or `process.cwd()` — may write outside `node_modules` |
| `modifies-shell-config` | References `.bashrc`, `.npmrc`, `.ssh/authorized_keys`, etc. |
| `native-build` | Invokes `node-gyp`, `cargo build`, `cmake`, etc. |
| `binary-download` | Downloads a prebuilt binary at install time |
| `runtime-installer` | Calls `npm/yarn/pnpm install` as a child process — **high severity** |
| `external-url` | Contains non-reference external URLs (download links, CDN assets) |
| `shell-network-fetch` | Uses `curl` or `wget` to fetch remote content |
| `base64-decode-exec` | Decodes base64 at runtime (`Buffer.from(…,'base64')`, `atob()`) |
| `obfuscation-pattern` | Contains hex/unicode escapes, char-by-char string building, etc. |
| `jsfuck-obfuscation` | JSFuck-style encoding — all code expressed with `[]()!+` only |
| `process-binding` | Uses low-level `process.binding()` — bypasses normal module system |

Signals are evidence, not verdicts. A package that writes files may be
perfectly legitimate (e.g. a code generator). The report surfaces what it
finds; a human makes the approval decision.

---

### JSON report

The JSON report exposes the full structured data behind the Markdown view.
It is suitable for:

- **AI-assisted security review** — pass the JSON to a model with a prompt
  asking it to evaluate risk. The model must not modify `allowScripts`; it
  produces a report for a human to act on.
- **CI policy enforcement** — parse `status` and `packages[].approvalStatus`
  to gate a deployment pipeline.
- **Custom tooling** — build your own renderer, dashboard, or audit trail.

#### Top-level schema

```json
{
  "status": "pending | all-approved",
  "generatedAt": "<ISO-8601 timestamp>",
  "prefix": "/path/to/project",
  "packages": [ /* array of PackageEntry */ ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | `string` | `"all-approved"` when nothing is pending; `"pending"` otherwise |
| `generatedAt` | `string` | ISO-8601 timestamp of report generation |
| `prefix` | `string` | Absolute path of the project root |
| `packages` | `PackageEntry[]` | One entry per pending package |

#### PackageEntry schema

```json
{
  "name": "canvas",
  "version": "2.11.2",
  "location": "node_modules/canvas",
  "approvalStatus": "pending",
  "dependencyType": "direct | transitive",
  "introducedBy": [
    ["my-app", "canvas@2.11.2"]
  ],
  "lifecycleScripts": {
    "install": "node-pre-gyp install --fallback-to-build"
  },
  "referencedFiles": [
    {
      "path": "scripts/install.js",
      "reason": "referenced by lifecycle script: `install`",
      "sha256": "abc123…",
      "sizeBytes": 4096,
      "signals": ["uses-child-process", "native-build"],
      "references": ["scripts/utils.js"],
      "urls": [
        { "url": "https://github.com/…", "classification": "download" }
      ]
    }
  ],
  "riskSummary": ["uses-child-process", "native-build"],
  "indicatorScanResults": [ /* native-build indicator details */ ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Package name |
| `version` | `string` | Installed version |
| `location` | `string` | Path under `node_modules` |
| `approvalStatus` | `string` | Always `"pending"` in this report |
| `dependencyType` | `string` | `"direct"` or `"transitive"` |
| `introducedBy` | `string[][]` | Dependency path(s) from project root |
| `lifecycleScripts` | `object` | Hook name → command string |
| `referencedFiles` | `FileEntry[]` | Every file scanned (see below) |
| `riskSummary` | `string[]` | Unique signals across all scanned files |
| `indicatorScanResults` | `object[]` | Native-build / binary-downloader scanner output |

#### FileEntry schema

| Field | Type | Description |
|-------|------|-------------|
| `path` | `string` | POSIX-relative path within the package |
| `reason` | `string` | Why this file was scanned |
| `sha256` | `string` | SHA-256 of bytes scanned (partial if file > 50 MB) |
| `sizeBytes` | `number` | Bytes actually scanned |
| `signals` | `string[]` | Risk signals detected in this file |
| `references` | `string[]` | Local files this file `require()`s or `import`s |
| `urls` | `UrlEntry[]` | External URLs found in this file |

#### UrlEntry classification

| Classification | Meaning |
|----------------|---------|
| `download` | Points to a file download (release archive, binary, tarball) |
| `registry` | npm or other package registry endpoint |
| `cdn` | CDN-hosted asset |
| `reference` | Documentation, homepage, license page (low risk) |
| `unknown` | Could not be classified |

---

### Workflow examples

#### Human review in a pull request

```bash
# 1. Install without scripts (the point: review before running)
npm ci --ignore-scripts

# 2. Generate the review report
npm approve-scripts --allow-scripts-pending > npm-script-review.md

# 3. Open the report, read it, make a decision
# 4. Approve what you're comfortable with
npm approve-scripts canvas sharp esbuild
```

#### AI-assisted review

```bash
# 1. Generate the JSON report
npm approve-scripts --allow-scripts-pending \
  --allow-scripts-report-format=json > review.json

# 2. Pass review.json to your AI tool of choice with a prompt like:
#    "Review these npm lifecycle scripts for security concerns.
#     Identify any high-risk signals and explain why they are concerning.
#     Do not approve or deny anything — produce a findings report only."

# 3. A human reads the AI findings and decides
# 4. A human runs approve-scripts / deny-scripts
```

#### CI gate (block merge if unapproved scripts exist)

```bash
npm approve-scripts --allow-scripts-pending \
  --allow-scripts-report-format=json > review.json

STATUS=$(node -e "console.log(JSON.parse(require('fs').readFileSync('review.json','utf8')).status)")
if [ "$STATUS" != "all-approved" ]; then
  echo "Unapproved install scripts found. Review review.json before merging."
  exit 1
fi
```

---

### Limitations

The report is produced by **static analysis only**. npm never executes lifecycle
scripts to generate it. This means:

- Obfuscated commands assembled at runtime cannot be fully detected (the
  `obfuscation-pattern` signal flags many common techniques but not all)
- Signals are evidence, not verdicts — a package may trigger `uses-child-process`
  for completely benign reasons
- The scanner reads up to 50 MB per file; extremely large generated files may
  not be fully analysed (a `file-too-large` signal is emitted)
- Cross-package `require()` chains are followed up to 20 levels deep; deeper
  chains emit a `depth-limit-reached` signal

### See Also

* [npm approve-scripts](/commands/npm-approve-scripts)
* [npm deny-scripts](/commands/npm-deny-scripts)
* [using-npm scripts](/using-npm/scripts)
* [package.json](/configuring-npm/package-json)
