#!/usr/bin/env bash
set -euo pipefail

APP_NAME="Agent Session Viewer"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NOTARY_PROFILE="${NOTARY_PROFILE:-}"

# Find the DMG
BUNDLE_DIR="$ROOT_DIR/src-tauri/target/release/bundle"
DMG_PATH=$(find "$BUNDLE_DIR" -name "*.dmg" -type f | head -1)

if [ -z "$DMG_PATH" ] || [ ! -f "$DMG_PATH" ]; then
  echo "DMG not found. Run build_release.sh first."
  exit 1
fi

echo "Found DMG: $DMG_PATH"

if [ -z "$NOTARY_PROFILE" ]; then
  echo ""
  echo "Set NOTARY_PROFILE to your keychain profile name."
  echo "If you haven't created one yet, run:"
  echo "  xcrun notarytool store-credentials"
  echo ""
  echo "Then run:"
  echo "  NOTARY_PROFILE=your-profile-name ./scripts/notarize.sh"
  exit 1
fi

echo "Submitting for notarization..."
xcrun notarytool submit "$DMG_PATH" --keychain-profile "$NOTARY_PROFILE" --wait

echo "Stapling notarization ticket..."
xcrun stapler staple "$DMG_PATH"
xcrun stapler validate "$DMG_PATH"

# Verify the app inside the DMG
MOUNT_PATH="$(hdiutil attach -nobrowse -readonly "$DMG_PATH" | awk '/\/Volumes\// {print $NF; exit}')"
if [ -n "$MOUNT_PATH" ]; then
  APP_PATH="$MOUNT_PATH/${APP_NAME}.app"
  if [ -d "$APP_PATH" ]; then
    echo "Verifying Gatekeeper acceptance..."
    spctl --assess --type execute --verbose "$APP_PATH"
  fi
  hdiutil detach "$MOUNT_PATH" >/dev/null 2>&1 || true
fi

echo ""
echo "Notarization complete: $DMG_PATH"
