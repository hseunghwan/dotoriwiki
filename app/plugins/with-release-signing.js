const { withAppBuildGradle } = require('expo/config-plugins');

// Signs release builds with keystore/keystore.properties (gitignored). Without that file the
// release build falls back to the debug key, so a fresh clone still builds.
const LOAD = `
def llmwikiKeystore = new Properties()
def llmwikiKeystoreFile = rootProject.file('../keystore/keystore.properties')
if (llmwikiKeystoreFile.exists()) { llmwikiKeystoreFile.withInputStream { llmwikiKeystore.load(it) } }
`;

const RELEASE_CONFIG = `signingConfigs {
        release {
            if (llmwikiKeystoreFile.exists()) {
                storeFile file(llmwikiKeystore['storeFile'])
                storePassword llmwikiKeystore['storePassword']
                keyAlias llmwikiKeystore['keyAlias']
                keyPassword llmwikiKeystore['keyPassword']
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
    if (gradle.includes('llmwikiKeystore')) return cfg;
    gradle = replaceOnce(gradle, /^android \{/m, `${LOAD}\nandroid {`);
    gradle = replaceOnce(gradle, /signingConfigs \{/, RELEASE_CONFIG);
    gradle = replaceOnce(
      gradle,
      /(buildTypes \{[\s\S]*?release \{[\s\S]*?)signingConfig signingConfigs\.debug/,
      '$1signingConfig llmwikiKeystoreFile.exists() ? signingConfigs.release : signingConfigs.debug',
    );
    cfg.modResults.contents = gradle;
    return cfg;
  });
};
