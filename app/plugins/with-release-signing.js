const { withAppBuildGradle } = require('expo/config-plugins');

// Signs release builds with keystore/keystore.properties (gitignored). Without that file the
// release build falls back to the debug key, so a fresh clone still builds.
const LOAD = `
def releaseKeystore = new Properties()
def releaseKeystoreFile = rootProject.file('../keystore/keystore.properties')
if (releaseKeystoreFile.exists()) { releaseKeystoreFile.withInputStream { releaseKeystore.load(it) } }
`;

const RELEASE_CONFIG = `signingConfigs {
        release {
            if (releaseKeystoreFile.exists()) {
                storeFile file(releaseKeystore['storeFile'])
                storePassword releaseKeystore['storePassword']
                keyAlias releaseKeystore['keyAlias']
                keyPassword releaseKeystore['keyPassword']
            }
        }`;

function replaceOnce(text, pattern, replacement) {
  const next = text.replace(pattern, replacement);
  if (next === text) throw new Error(`with-release-signing: ${pattern} not found in app/build.gradle`);
  return next;
}

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    let gradle = cfg.modResults.contents;
    if (gradle.includes('releaseKeystore')) return cfg;
    gradle = replaceOnce(gradle, /^android \{/m, `${LOAD}\nandroid {`);
    gradle = replaceOnce(gradle, /signingConfigs \{/, RELEASE_CONFIG);
    gradle = replaceOnce(
      gradle,
      /(buildTypes \{[\s\S]*?release \{[\s\S]*?)signingConfig signingConfigs\.debug/,
      '$1signingConfig releaseKeystoreFile.exists() ? signingConfigs.release : signingConfigs.debug',
    );
    cfg.modResults.contents = gradle;
    return cfg;
  });
};
