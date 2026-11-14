#!/usr/bin/env bash
set -euo pipefail

# Automatically compiles the production Hermes bytecode bundle (ota/index.android.bundle)
# and generates ota/manifest.json so connected Android devices can pull new updates
# directly from https://github.com/vesant/NativeCamera without USB debugging.

export PATH="/home/linuxbrew/.linuxbrew/opt/node@22/bin:/home/linuxbrew/.linuxbrew/bin:$PATH"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OTA_DIR="$ROOT_DIR/ota"
mkdir -p "$OTA_DIR"

echo "==> [Git OTA Publisher] Resolving Expo Android entry point..."
ENTRY_FILE="$(node -e "require('expo/scripts/resolveAppEntry')" "$ROOT_DIR" android absolute)"
HERMESC="$ROOT_DIR/node_modules/hermes-compiler/hermesc/linux64-bin/hermesc"

TEMP_JS_BUNDLE="$OTA_DIR/index.android.jsbundle"
FINAL_HBC_BUNDLE="$OTA_DIR/index.android.bundle"

echo "==> [Git OTA Publisher] Bundling TypeScript/React Native application..."
npx expo export:embed \
  --entry-file "$ENTRY_FILE" \
  --platform android \
  --dev false \
  --bundle-output "$TEMP_JS_BUNDLE"

echo "==> [Git OTA Publisher] Compiling Hermes bytecode v99 (ota/index.android.bundle)..."
"$HERMESC" -emit-binary -max-diagnostic-width=80 -O -out "$FINAL_HBC_BUNDLE" "$TEMP_JS_BUNDLE"
rm -f "$TEMP_JS_BUNDLE"

BUNDLE_SHA256="$(sha256sum "$FINAL_HBC_BUNDLE" | awk '{print $1}')"
BUNDLE_SIZE="$(stat -c%s "$FINAL_HBC_BUNDLE")"
COMMIT_SHA="${1:-$(git -C "$ROOT_DIR" rev-parse --short HEAD)}"
COMMIT_MSG="${2:-$(git -C "$ROOT_DIR" log -1 --pretty=%s)}"
AUTHOR="$(git -C "$ROOT_DIR" log -1 --pretty=%an)"
PUBLISHED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

cat > "$OTA_DIR/manifest.json" <<EOF
{
  "schemaVersion": 1,
  "repository": "https://github.com/vesant/NativeCamera",
  "branch": "main",
  "commitSha": "$COMMIT_SHA",
  "commitMessage": $(node -e "console.log(JSON.stringify(process.argv[1]))" "$COMMIT_MSG"),
  "author": $(node -e "console.log(JSON.stringify(process.argv[1]))" "$AUTHOR"),
  "publishedAt": "$PUBLISHED_AT",
  "bundleUrl": "https://raw.githubusercontent.com/vesant/NativeCamera/main/ota/index.android.bundle",
  "bundleSha256": "$BUNDLE_SHA256",
  "bundleSizeBytes": $BUNDLE_SIZE,
  "apkUrl": "https://github.com/vesant/NativeCamera/releases/latest/download/NativeCamera-arm64.apk"
}
EOF

echo "==> [Git OTA Publisher] Wrote ota/manifest.json:"
cat "$OTA_DIR/manifest.json"
