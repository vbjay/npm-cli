#!/usr/bin/env false  # DEFANGED: static-analysis cache — do not execute
# DEFANGED: static-analysis cache — do not execute
exit 1
# Build the ai-notify menu bar agent into a self-contained .app bundle using the
# system Swift toolchain. No Xcode project, no dependencies.
#
#   menubar/build.sh                      -> menubar/dist/ai-notify.app  (unsigned)
#   CODESIGN_ID="Developer ID Application: ..." menubar/build.sh   -> signed
#
# Notarization (release only) is a separate step, see menubar/README.md.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/AiNotifyMenuBar.swift"
APP="$HERE/dist/ai-notify.app"
BIN_NAME="ai-notify-menubar"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# Universal binary when possible (arm64 + x86_64), so one bundle runs everywhere.
ARCH_FLAGS=(-target arm64-apple-macos11)
if swiftc -target x86_64-apple-macos11 -typecheck "$SRC" >/dev/null 2>&1; then
  ARCH_FLAGS=(-target arm64-apple-macos11)
fi

echo "compiling $BIN_NAME ..."
swiftc -O "${ARCH_FLAGS[@]}" -o "$APP/Contents/MacOS/$BIN_NAME" "$SRC"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>ai-notify</string>
  <key>CFBundleDisplayName</key><string>ai-notify</string>
  <key>CFBundleIdentifier</key><string>com.ai-notify.menubar</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>$BIN_NAME</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

if [ -n "${CODESIGN_ID:-}" ]; then
  echo "code signing with: $CODESIGN_ID"
  codesign --force --options runtime --timestamp \
    --sign "$CODESIGN_ID" "$APP"
else
  # Ad-hoc sign so locally-built bundles launch without a quarantine prompt loop.
  codesign --force --sign - "$APP" 2>/dev/null || true
fi

echo "built: $APP"
