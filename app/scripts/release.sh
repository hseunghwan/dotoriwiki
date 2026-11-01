#!/bin/sh
# Builds the signed release APK locally (no EAS) and prints its path and sha256.
#   scripts/release.sh            prebuild --clean, then assembleRelease
#   scripts/release.sh --install  also install on the running emulator or phone and launch it
#   scripts/release.sh --js --install  skip prebuild when only JS changed (native config untouched)
set -eu
cd "$(dirname "$0")/.."

export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
[ -f keystore/keystore.properties ] || echo "warning: keystore/keystore.properties missing, the release APK will carry the debug key" >&2

if [ "${1:-}" = "--js" ] && [ -d android ]; then shift; else npx expo prebuild --platform android --clean --no-install >/dev/null; fi
(cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a --console=plain -q \
  "-Dorg.gradle.jvmargs=-Xmx4g -XX:MaxMetaspaceSize=1g")

apk="$PWD/android/app/build/outputs/apk/release/app-release.apk"
echo "$apk"
shasum -a 256 "$apk" | cut -d' ' -f1

if [ "${1:-}" = "--install" ]; then
  adb="$ANDROID_HOME/platform-tools/adb"
  pkg=$(npx expo config --type public --json | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).android.package)')
  "$adb" install -r "$apk" >/dev/null
  "$adb" shell am force-stop "$pkg"
  "$adb" shell am start -W -n "$pkg/.MainActivity" | grep -E 'Status|TotalTime'
fi
