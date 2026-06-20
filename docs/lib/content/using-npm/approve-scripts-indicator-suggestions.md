---
title: approve-scripts indicator suggestions
section: 7
description: Using the build-indicator-suggestions tool to improve signal coverage across popular packages
---

### Description

The risk signals that `npm approve-scripts` detects are defined in
`lib/utils/indicator-definitions.js` and `lib/utils/indicator-scanner.js`.
As the npm ecosystem evolves, new build tools, binary-download patterns, and
runtime-installer techniques appear. The **indicator suggestions tool** is the
mechanism for keeping those definitions current.

`scripts/build-indicator-suggestions.js` scans the most popular npm packages
(by download count) to find lifecycle scripts not yet covered by the existing
indicator registry, then produces a structured JSON file designed to be fed to
an AI — or a human contributor — that can propose new or improved registry
entries.

---

### Typical workflow

The tool has three logical phases that can be run separately or together:

#### Step 1 — Collect package manifests

```bash
# Fetch the top 2000 packages by popularity from the npm registry
node scripts/build-indicator-suggestions.js --top 2000
```

This queries the npm registry search API and saves each package's
`package.json` metadata (name, version, scripts, dependencies) to a local
`indicator-suggestions.packages.json` manifest store. Only packages with
lifecycle scripts (`preinstall`, `install`, `postinstall`, `prepare`) are
kept. The store persists across runs — re-running without `--top` skips the
collection phase entirely and re-analyzes the existing store.

Subsequent runs are resumable. If the process is interrupted, a
`indicator-suggestions.tmp.json` checkpoint is written every 100 packages
so you can pick up where you left off.

#### Step 2 — Deep-scan (optional but recommended)

```bash
node scripts/build-indicator-suggestions.js --deep
```

For each package in the manifest store the deep-scan:

1. Fetches known indicator files (`binding.gyp`, `Cargo.toml`, `CMakeLists.txt`,
   `android/build.gradle`, etc.) from `unpkg.com`
2. Parses the lifecycle script commands to find the entry-point JS file(s)
3. BFS-walks `require()`/`import` chains up to 10 levels deep, fetching each
   local file from unpkg and cross-package dependencies into sibling directories
4. Runs the full production scanner (`indicator-scanner.js` +
   `script-risk-scanner.js`) against the downloaded files
5. Caches results keyed by `name@version` in an `indicator-suggestions.deep/`
   directory — subsequent runs skip packages whose version and signal schema
   hash have not changed

The cache version is derived from the current signal regex patterns and
indicator registry command patterns. Any change to `indicator-definitions.js`
or the signal patterns automatically invalidates stale cache entries and
triggers a rescan on the next `--deep` run.

#### Step 3 — Re-analyze (no network)

```bash
# Re-run analysis against whatever is in the manifest store (no network calls)
node scripts/build-indicator-suggestions.js
```

This is the fast loop: after collecting packages and running a deep scan once,
you can tweak `indicator-definitions.js` and immediately see how the
categorization changes without fetching anything. The JSON output is
regenerated from the cached data.

---

### Output file

All three phases write (or update) `indicator-suggestions.json` in the repo
root. The file is structured to be fed to an AI for review:

```json
{
  "summary": {
    "totalScanned": 2000,
    "withLifecycleScripts": 312,
    "matched": 274,
    "unmatched": 23,
    "patternGaps": 15
  },
  "uncategorized": [
    {
      "name": "some-native-package",
      "version": "1.2.3",
      "weeklyDownloads": 840000,
      "lifecycleScripts": { "install": "node ./scripts/build.js" },
      "detectedSignals": ["uses-child-process", "native-build"],
      "scannedFiles": ["scripts/build.js"],
      "suggestedSignal": "native-build"
    }
  ],
  "patternGaps": [
    {
      "token": "zig",
      "count": 4,
      "packages": ["zig-native", "zig-wasm", "..."]
    }
  ]
}
```

- **`uncategorized`** — packages whose lifecycle scripts fired at least one
  risk signal but were not matched by any existing indicator definition.
  These are the highest-value targets for new definitions.
- **`patternGaps`** — command tokens that appear frequently in unmatched
  lifecycle scripts but aren't in the indicator registry. These often
  point to build tools worth adding.

---

### Analyzing with GitHub Copilot

The JSON output is designed to be submitted directly to an AI for analysis.
Attach `indicator-suggestions.json` to a GitHub Copilot Chat conversation
and use a prompt like:

> *"This JSON lists npm packages whose lifecycle scripts were not matched by our
> existing indicator registry. The `uncategorized` array shows each package's
> detected risk signals and lifecycle script commands. The `patternGaps` array
> shows command tokens that appear frequently in unmatched packages.*
>
> *Please suggest new entries for `INDICATOR_REGISTRY` in
> `lib/utils/indicator-definitions.js` — each entry needs an `indicatorFile`
> key (the canonical file that marks this indicator, e.g. `binding.gyp`), a
> human-readable `label`, and `commandPatterns` regexes that reliably match
> the lifecycle script commands shown in the data.*
>
> *Also flag any signals that look like obfuscation, runtime-installer, or
> binary-download patterns that should be handled as virtual indicators
> (no indicator file on disk) rather than file-based ones."*

Copilot can cross-reference the `detectedSignals`, `scannedFiles`, and
`suggestedSignal` fields to propose well-targeted registry entries. You
then review and land the suggestions as a pull request.

---

### Options reference

| Option | Default | Description |
|--------|---------|-------------|
| `--top N` | `0` (re-analyze only) | Fetch N new packages from the npm registry |
| `--delay ms` | `60` | Milliseconds between registry API requests |
| `--out path` | `indicator-suggestions.json` | Output JSON path |
| `--packages file` | _(manifest store)_ | Seed from a hand-crafted name list instead |
| `--deep` | off | Fetch files from unpkg and run the production scanner |
| `--reset` | off | Delete both cache files and deep-scan dir; start fresh |

#### When to use `--reset`

The manifest store pins each package at the version seen when it was first
collected. Over time packages release new versions that may change their build
approach (e.g. switching from `node-gyp` to a prebuilt binary downloader). Run
`--reset` occasionally — roughly every few months or before a major release —
to discard stale manifests and recollect current versions:

```bash
node scripts/build-indicator-suggestions.js --reset --top 2000 --deep
```

---

### Updating the definitions

After the AI (or a human) proposes new entries, the changes land in two files:

**`lib/utils/indicator-definitions.js`** — add to `INDICATOR_REGISTRY`:

```js
'Makefile': {
  label: 'Makefile',
  description: 'GNU Make build file',
  detect: {
    commandPatterns: [/\bmake\b/],
  },
  scanner: { type: 'makefile' },
},
```

**`lib/utils/indicator-scanner.js`** — add parsing logic if the indicator has
a custom scanner type (or use `type: 'none'` for signal-only virtual indicators
like `runtime-installer` and `source-downloader`).

After changing either file, run the suggestion tool without any flags to
immediately see how the new definitions reclassify the existing package store:

```bash
node scripts/build-indicator-suggestions.js
# No network calls — re-analyzes cached data with the updated definitions
```

The cache version is automatically recomputed from the new regex content, so
any package whose deep-scan results are now stale will be rescanned on the
next `--deep` run.

---

### See Also

* [npm approve-scripts](/commands/npm-approve-scripts)
* [approve-scripts report](/using-npm/approve-scripts-report)
* [using-npm scripts](/using-npm/scripts)
