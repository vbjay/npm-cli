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

# --json is equivalent shorthand for the above
npm approve-scripts --allow-scripts-pending --json > review.json

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
- **CI policy enforcement** — check top-level `status` to gate a deployment
  pipeline.
- **Custom tooling** — build your own renderer, dashboard, or audit trail.

> **Note:** The exact JSON structure may evolve between npm versions. The
> example below shows the current shape and the kinds of information available,
> but treat field names and nesting as illustrative rather than a stable API
> contract.

#### Example

Here is a real output entry for `esbuild`, a package that downloads a
platform-specific binary at install time and then installs additional packages
via `npm install` at runtime:

```json
{
  "packages": [
    {
      "name": "esbuild",
      "version": "0.28.1",
      "location": "node_modules/esbuild",
      "approvalStatus": "pending",
      "dependencyType": "transitive",
      "introducedBy": [
        ["my-app", "tsx@4.22.4", "esbuild@0.28.1"]
      ],
      "lifecycleScripts": {
        "postinstall": "node install.js"
      },
      "referencedFiles": [
        {
          "path": "install.js",
          "reason": "referenced by lifecycle script: `postinstall`",
          "sha256": "612294e278914443bdcf81cb17f54afec34dbdd2ebd999a6ee187912320cc315",
          "sizeBytes": 11773,
          "signals": [
            "uses-child-process",
            "reads-process-env",
            "network-access",
            "obfuscation-pattern",
            "binary-download",
            "runtime-installer",
            "external-url"
          ],
          "references": [],
          "urls": [
            { "url": "https://registry.npmjs.org/", "classification": "download" }
          ]
        }
      ],
      "buildInfo": [
        {
          "indicatorFile": "binary-downloader",
          "label": "Prebuilt binary downloader",
          "signals": ["binary-download"],
          "downloadUrls": ["https://registry.npmjs.org/"]
        },
        {
          "indicatorFile": "runtime-installer",
          "label": "Runtime package installer",
          "signals": ["runtime-installer"]
        }
      ],
      "changeClassification": {
        "status": "new",
        "previousApprovedVersion": null
      },
      "riskSummary": [
        "downloads a prebuilt platform binary at install time",
        "installs additional npm packages at runtime"
      ],
      "suggestedReviewFocus": [
        "inspect `install.js` — binary download and child npm install detected"
      ],
      "approveCommand": "npm approve-scripts esbuild",
      "denyCommand": "npm deny-scripts esbuild"
    }
  ]
}
```

The key things to look for in the JSON:

- **`signals`** on each `referencedFiles` entry — what behaviours were detected
  in that file
- **`riskSummary`** — human-readable summary across all files for the package
- **`buildInfo`** — indicator-specific detail (native build targets, download
  URLs, etc.)
- **`changeClassification.status`** — `"new"` (never approved before) vs
  `"version-change"` (previously approved at a different version)
- **`approveCommand`** / **`denyCommand`** — copy-pasteable commands for acting
  on the review

#### Analyzing with GitHub Copilot

> **Tip:** You can attach `review.json` directly to a GitHub Copilot Chat
> conversation and ask it to help evaluate the findings. Try a prompt like:
>
> *"I've attached a JSON report from `npm approve-scripts`. Each entry lists
> the lifecycle scripts a package will run at install time and the risk signals
> detected in those scripts. Please summarise the risk for each package and
> flag anything that looks especially suspicious. Don't approve or deny
> anything — I'll make that call after reading your analysis."*
>
> Copilot can explain what signals like `runtime-installer` or
> `obfuscation-pattern` mean in context, compare the `introducedBy` chains to
> understand blast radius, and highlight packages that warrant a closer manual
> read. The final approval decision always stays with you.

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
# 1. Generate the JSON report (--json is shorthand for --allow-scripts-report-format=json)
npm approve-scripts --allow-scripts-pending --json > review.json

# 2. Pass review.json to your AI tool of choice with a prompt like:
#    "Review these npm lifecycle scripts for security concerns.
#     Identify any high-risk signals and explain why they are concerning.
#     Do not approve or deny anything — produce a findings report only."

# 3. A human reads the AI findings and decides
# 4. A human runs approve-scripts / deny-scripts
```

#### CI gate (block merge if unapproved scripts exist)

```bash
npm approve-scripts --allow-scripts-pending --json > review.json

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
* [approve-scripts indicator suggestions](/using-npm/approve-scripts-indicator-suggestions)
* [using-npm scripts](/using-npm/scripts)
* [package.json](/configuring-npm/package-json)
