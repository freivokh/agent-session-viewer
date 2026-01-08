#!/usr/bin/env bash
set -euo pipefail

APP_NAME="Agent Session Viewer"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:-0.1.0}"

echo "Building $APP_NAME v$VERSION..."

cd "$ROOT_DIR"

# Build release with Tauri (app bundle only)
npx @tauri-apps/cli build

# Paths
BUNDLE_DIR="$ROOT_DIR/src-tauri/target/release/bundle/macos"
APP_PATH="$BUNDLE_DIR/${APP_NAME}.app"
DIST_DIR="$ROOT_DIR/dist"
DMG_NAME="${APP_NAME}-${VERSION}.dmg"

if [ ! -d "$APP_PATH" ]; then
  echo "Error: App bundle not found at $APP_PATH"
  exit 1
fi

# Verify signature
echo "Verifying code signature..."
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

# Create DMG manually
echo "Creating DMG..."
mkdir -p "$DIST_DIR"
rm -rf "$DIST_DIR/staging"
mkdir -p "$DIST_DIR/staging"
cp -R "$APP_PATH" "$DIST_DIR/staging/"
ln -s /Applications "$DIST_DIR/staging/Applications"

rm -f "$DIST_DIR/$DMG_NAME"
hdiutil create -volname "$APP_NAME" -srcfolder "$DIST_DIR/staging" -ov -format UDZO "$DIST_DIR/$DMG_NAME"
rm -rf "$DIST_DIR/staging"

echo ""
echo "Build complete!"
echo "  App: $APP_PATH"
echo "  DMG: $DIST_DIR/$DMG_NAME"
