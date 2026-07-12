const t = require('tap')
const { classifyUrl } = require('../../../lib/utils/url-classifier.js')

t.test('classifyUrl: download (file extension or release path wins)', (t) => {
  t.equal(classifyUrl('https://example.com/path/file.tgz'), 'download', 'archive extension')
  t.equal(classifyUrl('https://example.com/bin/tool.exe'), 'download', 'exe extension')
  t.equal(classifyUrl('https://github.com/o/r/releases/download/v1/file'), 'download', 'release download path')
  // Strong download signals win even when a download-y prefix host is present.
  t.equal(classifyUrl('https://downloads.sentry-cdn.com/sentry-cli/1.77.3/sentry-cli-Linux-x86_64'), 'download', 'download domain prefix')
  t.end()
})

t.test('classifyUrl: telemetry (analytics/ingest/API are not downloads)', (t) => {
  // The key "URL ≠ binary" case: ingest/analytics/API endpoints must not be
  // classified as 'download' just because the host has a download-y prefix.
  t.equal(classifyUrl('https://o123.ingest.sentry.io/api/123/store/'), 'telemetry', 'sentry ingest host')
  t.equal(classifyUrl('https://www.google-analytics.com/collect'), 'telemetry', 'analytics host')
  t.equal(classifyUrl('https://api.example.com/v1/track'), 'telemetry', 'api path')
  t.equal(classifyUrl('https://cdn.segment.com/analytics.js/v1/x.min.js'), 'telemetry', 'analytics vendor over cdn prefix')
  t.equal(classifyUrl('https://example.com/v2/collect'), 'telemetry', 'versioned collect path')
  t.end()
})

t.test('classifyUrl: reference (homepage/docs/funding)', (t) => {
  t.equal(classifyUrl('https://github.com/o/r'), 'reference', 'github repo')
  t.equal(classifyUrl('https://example.com/docs/readme'), 'reference', 'docs path')
  t.equal(classifyUrl('https://opencollective.com/project'), 'reference', 'funding host')
  t.end()
})

t.test('classifyUrl: unknown when no signal matches', (t) => {
  t.equal(classifyUrl('https://example.com/something'), 'unknown', 'no recognizable signal')
  t.end()
})
