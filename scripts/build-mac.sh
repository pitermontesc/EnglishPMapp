#!/bin/sh
# Builds the Mac app (the iPad build running on Apple Silicon), exports a signed
# .ipa to build/ and opens it, so macOS installs it into /Applications.
# Needs Xcode and your team selected in Signing & Capabilities.
set -e
cd "$(dirname "$0")/.."
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
TEAM="$(grep -m1 'DEVELOPMENT_TEAM = ' ios/App/App.xcodeproj/project.pbxproj | sed 's/.*= \(.*\);/\1/')"
OUT=build/mac
rm -rf "$OUT" && mkdir -p "$OUT"

npm run build
npx cap sync ios

cat > "$OUT/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>debugging</string>
  <key>teamID</key><string>$TEAM</string>
  <key>signingStyle</key><string>automatic</string>
</dict></plist>
PLIST

xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$OUT/DailyEnglish.xcarchive" \
  -allowProvisioningUpdates -quiet archive
xcodebuild -exportArchive -archivePath "$OUT/DailyEnglish.xcarchive" -exportPath "$OUT" \
  -exportOptionsPlist "$OUT/ExportOptions.plist" -allowProvisioningUpdates -quiet
mv "$OUT/App.ipa" "build/Daily English.ipa"
echo "Built build/Daily English.ipa — opening the installer"
open "build/Daily English.ipa"
