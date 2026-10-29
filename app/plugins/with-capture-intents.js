const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');

// Shared text (ACTION_SEND) and the text-selection menu (PROCESS_TEXT) both land in one translucent
// activity that turns the intent into llmwiki://compose?... and hands it to MainActivity. The JS side
// then only ever sees a deep link, so expo-router opens the same compose sheet for both.
const kotlin = (pkg) => `package ${pkg}

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle

class CaptureActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val source: String?
    val text: String?
    val subject: String?
    when (intent?.action) {
      Intent.ACTION_PROCESS_TEXT -> {
        source = "selection"
        text = intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString()
        subject = null
      }
      Intent.ACTION_SEND -> {
        source = "share"
        text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
        subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)
      }
      else -> {
        source = null
        text = null
        subject = null
      }
    }
    if (source != null && !text.isNullOrBlank()) {
      val uri = Uri.Builder().scheme("llmwiki").authority("compose")
        .appendQueryParameter("source", source)
        .appendQueryParameter("text", text)
        .apply { if (!subject.isNullOrBlank()) appendQueryParameter("subject", subject) }
        .build()
      startActivity(Intent(Intent.ACTION_VIEW, uri, this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
    finish()
  }
}
`;

const textFilter = (action) => ({
  action: [{ $: { 'android:name': action } }],
  category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }],
  data: [{ $: { 'android:mimeType': 'text/plain' } }],
});

module.exports = function withCaptureIntents(config) {
  const pkg = config.android?.package;
  if (!pkg) throw new Error('with-capture-intents: android.package is required');

  config = withDangerousMod(config, [
    'android',
    (cfg) => {
      const dir = path.join(cfg.modRequest.platformProjectRoot, 'app/src/main/java', ...pkg.split('.'));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'CaptureActivity.kt'), kotlin(pkg));
      return cfg;
    },
  ]);

  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application[0];
    app.activity = (app.activity ?? []).filter((a) => a.$['android:name'] !== '.CaptureActivity');
    app.activity.push({
      $: {
        'android:name': '.CaptureActivity',
        'android:label': '@string/app_name',
        'android:exported': 'true',
        'android:excludeFromRecents': 'true',
        'android:noHistory': 'true',
        'android:theme': '@android:style/Theme.Translucent.NoTitleBar',
      },
      'intent-filter': [textFilter('android.intent.action.SEND'), textFilter('android.intent.action.PROCESS_TEXT')],
    });
    return cfg;
  });
};
