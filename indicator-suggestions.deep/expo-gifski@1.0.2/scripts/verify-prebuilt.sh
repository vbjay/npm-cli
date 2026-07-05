#!/usr/bin/env false  # DEFANGED: static-analysis cache — do not execute
# DEFANGED: static-analysis cache — do not execute
exit 1
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$SCRIPT_DIR/.."

FILES=(
  ios/libs/libexpo_gifski.a
  ios/libs/libexpo_gifski_sim.a
  ios/generated/expo_gifski.swift
  ios/generated/expo_gifskiFFI.h
  ios/generated/expo_gifskiFFI.modulemap
  android/src/main/jniLibs/arm64-v8a/libexpo_gifski.so
  android/src/main/jniLibs/armeabi-v7a/libexpo_gifski.so
  android/src/main/jniLibs/x86/libexpo_gifski.so
  android/src/main/jniLibs/x86_64/libexpo_gifski.so
  android/src/main/java/uniffi/expo_gifski/expo_gifski.kt
)

MISSING=()
for f in "${FILES[@]}"; do
  [ -f "$ROOT/$f" ] || MISSING+=("$f")
done

if [ ${#MISSING[@]} -gt 0 ]; then
  echo ""
  echo "ERROR: Cannot pack expo-gifski — prebuilt Rust binaries are missing."
  echo "Run the build scripts first:"
  echo "  ./ios/build.sh"
  echo "  ./android/build.sh"
  echo ""
  echo "Missing files:"
  for f in "${MISSING[@]}"; do
    echo "  - $f"
  done
  echo ""
  exit 1
fi

echo "All prebuilt binaries present."

REPO_ROOT="$ROOT/../.."
cp "$REPO_ROOT/README.md" "$ROOT/README.md"
cp "$REPO_ROOT/LICENSE" "$ROOT/LICENSE"
cp "$REPO_ROOT/THIRD-PARTY-NOTICES" "$ROOT/THIRD-PARTY-NOTICES"
sed -i '' \
  -e 's|\.github/resources/|https://github.com/adam-sajko/expo-gifski/raw/main/.github/resources/|g' \
  -e 's|\[contributing guide\](CONTRIBUTING.md)|[contributing guide](https://github.com/adam-sajko/expo-gifski/blob/main/CONTRIBUTING.md)|g' \
  -e 's|\[MIT\](LICENSE)|[MIT](https://github.com/adam-sajko/expo-gifski/blob/main/LICENSE)|g' \
  -e 's|\[THIRD-PARTY-NOTICES\](THIRD-PARTY-NOTICES)|[THIRD-PARTY-NOTICES](https://github.com/adam-sajko/expo-gifski/blob/main/THIRD-PARTY-NOTICES)|g' \
  "$ROOT/README.md"
