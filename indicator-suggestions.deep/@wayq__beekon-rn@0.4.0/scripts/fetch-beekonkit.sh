#!/usr/bin/env false  # DEFANGED: static-analysis cache — do not execute
# DEFANGED: static-analysis cache — do not execute
exit 1
# Fetches BeekonKit.xcframework from beekonlabs/beekon-ios-binary's GitHub
# Release at the pinned version, verifies SHA256, and extracts it into
# ios/Frameworks/. Idempotent: skips if the framework is already present.
#
# Run via `yarn prepare` (CI: pre-publish) and once locally before iOS dev
# (e.g. `bash scripts/fetch-beekonkit.sh` → `cd example/ios && pod install`).
#
# The SHA256 must match the value posted in the binary repo's release notes,
# and the URL must match the binary repo's `Package.swift` entry. Bumping the
# native version means updating BOTH constants below (and in the podspec
# comment), then re-running.

set -euo pipefail

VERSION="0.4.0"
URL="https://github.com/beekonlabs/beekon-ios-binary/releases/download/v${VERSION}/BeekonKit.xcframework.zip"
# SHA256 of the v0.3.0 BeekonKit.xcframework.zip. Matches the SwiftPM
# `binaryTarget` checksum in beekon-ios-binary's Package.swift at tag v0.3.0
# (SwiftPM's compute-checksum is the SHA256 of the zip).
EXPECTED_SHA="c5473e3a65449284aa2476cff14b82f7d8396fd1ecf2b04aa058d43a68295ec8"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST_DIR="${ROOT}/ios/Frameworks"
TARGET="${DEST_DIR}/BeekonKit.xcframework"

if [ -d "${TARGET}" ]; then
  echo "fetch-beekonkit: ${TARGET} already present, skipping"
  exit 0
fi

mkdir -p "${DEST_DIR}"
ZIP="${DEST_DIR}/BeekonKit.xcframework.zip"

echo "fetch-beekonkit: downloading ${URL}"
curl -fsSL "${URL}" -o "${ZIP}"

# `shasum` ships with macOS, `sha256sum` with most Linux distros. CI publish
# runs on Linux for cost reasons, so support both.
if command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "${ZIP}" | awk '{print $1}')
elif command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "${ZIP}" | awk '{print $1}')
else
  echo "fetch-beekonkit: neither shasum nor sha256sum found in PATH" >&2
  rm -f "${ZIP}"
  exit 1
fi

if [ "${actual}" != "${EXPECTED_SHA}" ]; then
  echo "fetch-beekonkit: SHA256 mismatch" >&2
  echo "  expected: ${EXPECTED_SHA}" >&2
  echo "  actual:   ${actual}" >&2
  rm -f "${ZIP}"
  exit 1
fi

echo "fetch-beekonkit: SHA256 verified, extracting"
unzip -q -o "${ZIP}" -d "${DEST_DIR}"
rm "${ZIP}"
echo "fetch-beekonkit: ${TARGET} ready"
