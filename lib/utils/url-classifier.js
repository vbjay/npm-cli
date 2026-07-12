// URL classification for npm lifecycle script risk scanning.
//
// Used by both the scanner (to filter extracted URLs before storing signals)
// and the formatter (to exclude reference/homepage URLs from binary-download
// indicator output).
//
// Four categories:
//   'download'  — high confidence: binary/archive extension, known download
//                 path pattern, or download-only domain.
//   'telemetry' — high confidence: analytics / metrics / ingest / generic API
//                 endpoint.  A URL alone is NOT evidence of a binary download;
//                 these hosts receive data, they do not serve binaries, so they
//                 are kept out of the 'download' bucket to avoid mislabelling a
//                 telemetry POST as a prebuilt-binary fetch.
//   'reference' — high confidence: homepage, funding page, docs, license, or
//                 social link.  Safe to drop from download-risk output.
//   'unknown'   — insufficient signal; treat as potentially meaningful.
//
// This is a best-effort heuristic: hosts and paths are matched by pattern, so
// it will neither catch every telemetry endpoint nor every download URL.  Use
// it to reduce obvious false positives, not as a definitive classifier.

const DOWNLOAD_EXT_RE = /\.(tgz|tar\.gz|tar\.bz2|tar\.xz|zip|gz|xz|bz2|node|wasm|exe|dmg|pkg|msi|deb|rpm|appimage|so|dll|dylib|nupkg)(\?[^#]*)?(#.*)?$/i
const DOWNLOAD_PATH_RE = /\/(releases\/download|archive\/refs\/|archive\/)\//i
const DOWNLOAD_DOMAIN_RE = /^https?:\/\/(registry\.npmjs\.org|dl\.google\.com|objects\.githubusercontent\.com|github-releases\.githubusercontent\.com|cdn\.|downloads?\.|releases?\.|artifacts?\.|binaries?\.)/i
// Telemetry / analytics / ingest / generic API hosts and paths.  These receive
// data rather than serve binaries, so they must be classified before the broad
// DOWNLOAD_DOMAIN_RE prefix heuristic (e.g. `cdn.<vendor>` ingest hosts).
const TELEMETRY_DOMAIN_RE = /^https?:\/\/(?:[^/]*\.)*(?:ingest\.[^/]+|telemetry\.|analytics\.|metrics\.|stats\.|google-analytics\.com|googletagmanager\.com|analytics\.google\.com|segment\.(?:io|com)|mixpanel\.com|amplitude\.com|datadoghq\.com|bugsnag\.com|sentry\.io|plausible\.io|posthog\.com|matomo\.|fullstory\.com|hotjar\.com|heap\.io)/i
const TELEMETRY_PATH_RE = /\/(?:api|v\d+|track|collect|ingest|telemetry|metrics|analytics|events?|beacon)(?:\/|$|\?|#)/i
const REFERENCE_DOMAIN_RE = /^https?:\/\/(?:www\.)?(github\.com(?!\/[^/]+\/[^/]+\/releases\/download)|gitlab\.com(?!\/[^/]+\/[^/]+\/-\/releases)|npmjs\.com|opencollective\.com|shields\.io|badgen\.net|badge\.fury\.io|buymeacoffee\.com|ko-fi\.com|patreon\.com|discord\.[a-z]+|twitter\.com|x\.com|linkedin\.com|slack\.com)/i
const REFERENCE_PATH_RE = /\/(licen[sc]es?|terms|privacy|docs?|documentation|about|changelog|contributing|security|coc|code.of.conduct)(\/|$|\?|#)/i

const classifyUrl = (url) => {
  // Strong download signals (an actual file extension or a release-download
  // path) win over everything: these point at a concrete artifact.
  if (DOWNLOAD_EXT_RE.test(url)) return 'download'
  if (DOWNLOAD_PATH_RE.test(url)) return 'download'
  // Telemetry/API endpoints are checked before the prefix-based download
  // heuristic so that ingest/analytics hosts are not mislabelled as downloads.
  if (TELEMETRY_DOMAIN_RE.test(url)) return 'telemetry'
  if (TELEMETRY_PATH_RE.test(url)) return 'telemetry'
  if (DOWNLOAD_DOMAIN_RE.test(url)) return 'download'
  if (REFERENCE_DOMAIN_RE.test(url)) return 'reference'
  if (REFERENCE_PATH_RE.test(url)) return 'reference'
  return 'unknown'
}

module.exports = { classifyUrl }
