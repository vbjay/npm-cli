// URL classification for npm lifecycle script risk scanning.
//
// Used by both the scanner (to filter extracted URLs before storing signals)
// and the formatter (to exclude reference/homepage URLs from binary-download
// indicator output).
//
// Three categories:
//   'download'  — high confidence: binary/archive extension, known download
//                 path pattern, or download-only domain.
//   'reference' — high confidence: homepage, funding page, docs, license, or
//                 social link.  Safe to drop from download-risk output.
//   'unknown'   — insufficient signal; treat as potentially meaningful.

const DOWNLOAD_EXT_RE = /\.(tgz|tar\.gz|tar\.bz2|tar\.xz|zip|gz|xz|bz2|node|wasm|exe|dmg|pkg|msi|deb|rpm|appimage|so|dll|dylib|nupkg)(\?[^#]*)?(#.*)?$/i
const DOWNLOAD_PATH_RE = /\/(releases\/download|archive\/refs\/|archive\/)\//i
const DOWNLOAD_DOMAIN_RE = /^https?:\/\/(registry\.npmjs\.org|dl\.google\.com|objects\.githubusercontent\.com|github-releases\.githubusercontent\.com|cdn\.|downloads?\.|releases?\.|artifacts?\.|binaries?\.)/i
const REFERENCE_DOMAIN_RE = /^https?:\/\/(?:www\.)?(github\.com(?!\/[^/]+\/[^/]+\/releases\/download)|gitlab\.com(?!\/[^/]+\/[^/]+\/-\/releases)|npmjs\.com|opencollective\.com|shields\.io|badgen\.net|badge\.fury\.io|buymeacoffee\.com|ko-fi\.com|patreon\.com|discord\.[a-z]+|twitter\.com|x\.com|linkedin\.com|slack\.com)/i
const REFERENCE_PATH_RE = /\/(licen[sc]es?|terms|privacy|docs?|documentation|about|changelog|contributing|security|coc|code.of.conduct)(\/|$|\?|#)/i

const classifyUrl = (url) => {
  if (DOWNLOAD_EXT_RE.test(url)) return 'download'
  if (DOWNLOAD_PATH_RE.test(url)) return 'download'
  if (DOWNLOAD_DOMAIN_RE.test(url)) return 'download'
  if (REFERENCE_DOMAIN_RE.test(url)) return 'reference'
  if (REFERENCE_PATH_RE.test(url)) return 'reference'
  return 'unknown'
}

module.exports = { classifyUrl }
