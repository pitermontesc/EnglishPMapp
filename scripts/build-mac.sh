#!/bin/sh
# Builds the Mac app (the iPad build running on Apple Silicon) and installs it as
# /Applications/Daily English.app, using the wrapper layout macOS expects for iPad apps:
#   Daily English.app/Wrapper/App.app  +  Daily English.app/WrappedBundle -> Wrapper/App.app
# Needs Xcode and your team selected in Signing & Capabilities.
set -e
cd "$(dirname "$0")/.."
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
DERIVED=build/mac/DerivedData
DEST="/Applications/Daily English.app"

npm run build
npx cap sync ios

xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination 'platform=macOS,variant=Designed for iPad,arch=arm64' \
  -derivedDataPath "$DERIVED" -allowProvisioningUpdates -quiet build

pkill -f "Wrapper/App.app/App" 2>/dev/null || true
rm -rf "$DEST"
mkdir -p "$DEST/Wrapper"
ditto "$DERIVED/Build/Products/Release-iphoneos/App.app" "$DEST/Wrapper/App.app"
ln -s "Wrapper/App.app" "$DEST/WrappedBundle"
echo "Installed $DEST"
open "$DEST"
