# RFC #897 Implementation Plan: `npm approve-scripts` Review Report Mode

**RFC:** https://github.com/npm/rfcs/issues/897  
**Branch:** `copilot/implement-rfc-897-plan`

---

## Overview

Add a first-class review-report mode to `npm approve-scripts --allow-scripts-pending` that produces structured human-readable (Markdown) and machine-readable (JSON) output describing every pending lifecycle script, the files those scripts reference, and detected risk signals within those files. The tool never approves anything automatically, never executes lifecycle scripts, and does not claim to prove a package is safe.

---

## Motivation Summary

`npm approve-scripts --allow-scripts-pending` shows *which* packages need approval and *what* their lifecycle script commands are, but leaves developers to manually trace what each script actually does. This creates approval fatigue and reflexive approvals for transitive dependencies. A review-report mode turns approval from "do I trust this name?" into "do I trust this specific execution path?" — and generates auditable, AI-reviewable evidence.

---

## New Command Surface

### Option 1 (preferred): `--allow-scripts-report-format` flag

```bash
npm approve-scripts --allow-scripts-pending --allow-scripts-report-format=markdown
npm approve-scripts --allow-scripts-pending --allow-scripts-report-format=json
```

Dedicated scoped flag. The existing `--json` flag remains unchanged and maps to `format=json`. `markdown` and `json` are the two format values; only valid when `--allow-scripts-pending` is also set.

### Option 2: dedicated output flags

```bash
npm approve-scripts --allow-scripts-pending --review-report=npm-script-review.md
npm approve-scripts --allow-scripts-pending --review-report-json=npm-script-review.json
```

The exact option names are secondary; Option 1 is cleaner and avoids new top-level flags.

---

## Implementation Breakdown

### 1. New utility: `lib/utils/script-risk-scanner.js`

A best-effort static analysis module that walks a package's files referenced by lifecycle scripts and emits risk signals. It does **not** execute code.

**Inputs:**
- `packageDir` – absolute path to the package under `node_modules`
- `lifecycleScripts` – the `{ event: command }` map from the package's `scripts` field

**Algorithm:**
1. Parse each lifecycle command to identify directly-referenced local JS/shell/binary files (e.g. `node install.js`, `bash setup.sh`, `./scripts/postinstall.js`).
2. For each directly-referenced file, recursively walk `require()`/`import` statements to find local file dependencies (one or two levels deep; not a full bundler).
3. For each file in the walk, read its source and run a set of regex-based signal detectors.
4. Return a structured `referencedFiles` array with `{ path, reason, sha256, signals, references }` per file.

**Signal detectors** (regex/AST-pattern based, best-effort):

| Signal key | What to look for |
|---|---|
| `uses-child-process` | `require('child_process')`, `spawn`, `exec`, `execSync`, `spawnSync` |
| `uses-eval` | `eval(`, `new Function(`, `Function(` |
| `uses-dynamic-import` | `import(` expressions, `require(` with a variable/expression (non-literal) |
| `reads-process-env` | `process.env.`, `process.env[` |
| `references-credential-env-var` | `TOKEN`, `SECRET`, `KEY`, `PASSWORD`, `API_KEY`, `GITHUB_TOKEN`, `NPM_TOKEN`, etc. |
| `network-access` | `require('https')`, `require('http')`, `fetch(`, `axios`, `got`, `node-fetch`, `curl`, `wget` |
| `remote-code-download` | `download(`, `https.get(` followed by pipe/write patterns |
| `writes-outside-package` | `fs.write`/`fs.mkdir`/`fs.copy` with paths using `..`, absolute paths, or `process.cwd()` |
| `modifies-shell-config` | references to `.npmrc`, `.gitconfig`, `.ssh/`, `.bashrc`, `.zshrc`, `authorized_keys` |
| `base64-decode-exec` | `Buffer.from(…, 'base64')` combined with `eval` or `exec` |
| `native-build` | presence of `binding.gyp` in package dir; `node-gyp` in the command |
| `obfuscation-pattern` | very high ratio of hex escapes, `\x` sequences, very long single-line strings |
| `external-url` | any `https://` or `http://` literal in the file |
| `requires-local-file` | `require('./…')` or `import '…/…'` to a relative path |
| `writes-file` | `fs.writeFile`, `fs.writeFileSync`, `createWriteStream` |
| `shell-script` | lifecycle command invokes `.sh` file or `bash`/`sh`/`zsh` directly |
| `invokes-binary` | lifecycle command runs a package binary (not `node`) |

**Non-goals:** Not an AST parser, not a full static analysis tool, not a linter. Regex + simple heuristics only.

---

### 2. New utility: `lib/utils/review-report-formatter.js`

Formats the raw report data into either Markdown or JSON output.

**Markdown format:**
- One `## Package: name@version` section per pending package
- Subsections: location, dependency type, introduced-by chain, approval status, lifecycle scripts (fenced JSON), referenced files with signals per file, risk summary, suggested review focus
- Risk summary and suggested review focus are derived from the union of all signals across all files

**JSON format:**
- Matches the schema described in RFC #897:
  ```json
  {
    "packages": [
      {
        "name": "string",
        "version": "string",
        "location": "string",
        "approvalStatus": "pending",
        "dependencyType": "direct|transitive",
        "introducedBy": [["root", "direct@x.y.z", "pkg@a.b.c"]],
        "lifecycleScripts": {},
        "referencedFiles": [
          {
            "path": "string",
            "reason": "string",
            "sha256": "string",
            "signals": ["string"],
            "references": ["string"]
          }
        ],
        "changeClassification": {
          "status": "new|version-changed",
          "previousApprovedVersion": "string|null"
        },
        "riskSummary": ["string"],
        "suggestedReviewFocus": ["string"]
      }
    ]
  }
  ```

---

### 3. New utility: `lib/utils/dep-path-walker.js`

Traverses the arborist `actualTree` to compute dependency paths ("introduced by" chains) for a given node.

**Input:** An arborist `Node`  
**Output:** Array of path arrays, each representing one dependency path from project root to the node (e.g. `["myapp", "direct-dep@1.2.3", "transitive@4.5.6"]`)

Determines `dependencyType` as `direct` if the node's parent is the project root, otherwise `transitive`.

---

### 4. New utility: `lib/utils/script-change-classifier.js`

Compares a pending package node against the project's existing `allowScripts`
policy to classify whether the pending entry is entirely new or is a version
update of a previously-approved package.

**Classification statuses (current implementation):**
- `new` – package has no prior approved (`true`) entry in `allowScripts`; denied (`false`) entries do not count as prior approvals
- `version-changed` – an approved entry exists for the same name but the installed version differs

**Note:** Detecting a re-review of a version whose scripts changed since the last
approval (same name, same version, different script content) requires comparing
stored script hashes against the current scripts, which is not yet implemented.
If the previously-installed package is not available on disk or the required
hash information is absent, the classifier falls back to `new`.

---

### 5. Update `lib/utils/allow-scripts-cmd.js`

Add a `--allow-scripts-report-format` config parameter and wire up the new review-report path in `runPending()`:

```
if (format === 'markdown' || format === 'json') {
  return this.runReviewReport(unreviewed, format)
}
```

The new `runReviewReport()` method:
1. For each entry in `unreviewed`, calls `depPathWalker` to get introduced-by chains
2. Calls `scriptChangeClassifier` for change classification
3. Calls `scriptRiskScanner` for each package to get referenced files and signals
4. Passes the assembled data to `reviewReportFormatter` for final output
5. Writes to stdout (pipe-friendly) or optionally to a file if an output path flag is added

---

### 6. Update `lib/commands/approve-scripts.js`

Add `'allow-scripts-report-format'` to `static params`.

---

### 7. Update docs: `docs/lib/content/commands/npm-approve-scripts.md`

Add new `--allow-scripts-report-format` flag to Synopsis and Description. Document the two format values (`markdown`, `json`). Add examples showing piping to a file. Add a "Review Report" subsection explaining the output format, non-goals, and AI-assisted review workflow.

---

### 8. Tests

New test files under `test/lib/`:

- `test/lib/utils/script-risk-scanner.js` – unit tests per signal type, file-walk depth, graceful handling of missing/binary files, hash correctness
- `test/lib/utils/review-report-formatter.js` – unit tests for both Markdown and JSON output shape
- `test/lib/utils/dep-path-walker.js` – unit tests for direct vs. transitive, multi-path packages
- `test/lib/utils/script-change-classifier.js` – unit tests for all classification statuses
- `test/lib/commands/approve-scripts.js` – integration tests for `--allow-scripts-pending --allow-scripts-report-format=markdown` and `--allow-scripts-report-format=json`

Existing `approve-scripts.js` tests should continue to pass without modification.

---

## Config Changes

Add a new config definition for `allow-scripts-report-format` (values: `null`, `markdown`, `json`). `markdown` is the default; `json` maps to `--json`. Only meaningful when combined with `--allow-scripts-pending`; using it without that flag throws a usage error.

---

## Security and Non-Goals

- **Never execute lifecycle scripts** during scanning
- **Never auto-approve** anything
- **Never claim a package is safe** — all output is explicitly best-effort
- **Do not replace human review** — the report is evidence for a human decision
- **Graceful failure on unreadable files** — emit a `signal: file-unreadable` rather than crashing
- **Cap file traversal depth** at 3 levels to avoid very deep dependency trees
- **Cap file size** — skip files over a configurable threshold (default 500 KB) and emit a `signal: file-too-large`
- **No network calls** during scanning

---

## Rollout Considerations

- The feature is purely additive: no existing behavior changes
- The `--format` parameter is opt-in; existing `--json` and text output are unchanged
- The scanner is best-effort and clearly documented as non-exhaustive
- Output can be piped into CI artifacts or PR comments without any additional tooling

---

## File Change Summary

| File | Change |
|---|---|
| `lib/utils/script-risk-scanner.js` | **new** |
| `lib/utils/review-report-formatter.js` | **new** |
| `lib/utils/dep-path-walker.js` | **new** |
| `lib/utils/script-change-classifier.js` | **new** |
| `lib/utils/allow-scripts-cmd.js` | add `format` param, new `runReviewReport()` method |
| `lib/commands/approve-scripts.js` | add `'format'` to `static params` |
| `docs/lib/content/commands/npm-approve-scripts.md` | add `--format` docs, review-report section |
| `test/lib/utils/script-risk-scanner.js` | **new** |
| `test/lib/utils/review-report-formatter.js` | **new** |
| `test/lib/utils/dep-path-walker.js` | **new** |
| `test/lib/utils/script-change-classifier.js` | **new** |
| `test/lib/commands/approve-scripts.js` | extend with new format tests |
