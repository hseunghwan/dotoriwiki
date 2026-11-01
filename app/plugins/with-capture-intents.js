const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');

// Shared text and photos (ACTION_SEND, ACTION_SEND_MULTIPLE) and the text-selection menu (PROCESS_TEXT)
// all land in one translucent activity that turns the intent into <scheme>://compose?... and hands it to
// MainActivity. The JS side then only ever sees a deep link, so expo-router opens the same compose sheet.
// Shared photos are copied into the app's files before that: the URI grant ends with this activity.
const kotlin = (pkg, scheme) => `package ${pkg}

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log
import expo.modules.originalphoto.Originals
import java.io.File
import java.util.UUID
import org.json.JSONArray

class CaptureActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val i = intent
    when (i?.action) {
      Intent.ACTION_PROCESS_TEXT -> open("selection", i.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString(), null, emptyList())
      Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE -> {
        val text = i.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
        val subject = i.getStringExtra(Intent.EXTRA_SUBJECT)
        val streams = imageStreams(i)
        if (streams.isEmpty()) open("share", text, subject, emptyList())
        else Thread {
          val photos = streams.mapNotNull(::copy)
          runOnUiThread { open("share", text, subject, photos) }
        }.start()
      }
      else -> finish()
    }
  }

  @Suppress("DEPRECATION")
  private fun imageStreams(i: Intent): List<Uri> {
    if (i.type?.startsWith("image/") != true) return emptyList()
    val uris = if (i.action == Intent.ACTION_SEND_MULTIPLE) i.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty()
      else listOfNotNull(i.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
    return uris.take(${MAX_PHOTOS})
  }

  private fun copy(uri: Uri): String? =
    try {
      val c = Originals.copy(this, uri, File(filesDir, "outbox/pending"), UUID.randomUUID().toString())
      Log.i("CaptureActivity", "copied \$uri original=\${c.original} gps=\${Originals.latLong(c.file) != null}")
      Uri.fromFile(c.file).toString()
    } catch (e: Exception) {
      Log.w("CaptureActivity", "could not copy \$uri", e)
      null
    }

  private fun open(source: String, text: String?, subject: String?, photos: List<String>) {
    if (!text.isNullOrBlank() || photos.isNotEmpty()) {
      val uri = Uri.Builder().scheme("${scheme}").authority("compose")
        .appendQueryParameter("source", source)
        .apply { if (!text.isNullOrBlank()) appendQueryParameter("text", text) }
        .apply { if (!subject.isNullOrBlank()) appendQueryParameter("subject", subject) }
        .apply { if (photos.isNotEmpty()) appendQueryParameter("photos", JSONArray(photos).toString()) }
        .build()
      startActivity(Intent(Intent.ACTION_VIEW, uri, this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
    finish()
  }
}
`;

/** The same cap as the app's photo strip (src/lib/photos.ts MAX_PHOTOS). */
const MAX_PHOTOS = 10;

const filter = (action, mimeType) => ({
  action: [{ $: { 'android:name': action } }],
  category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }],
  data: [{ $: { 'android:mimeType': mimeType } }],
});

module.exports = function withCaptureIntents(config) {
  const pkg = config.android?.package;
  if (!pkg) throw new Error('with-capture-intents: android.package is required');
  const scheme = config.scheme;
  if (typeof scheme !== 'string') throw new Error('with-capture-intents: one scheme is required');

  config = withDangerousMod(config, [
    'android',
    (cfg) => {
      const dir = path.join(cfg.modRequest.platformProjectRoot, 'app/src/main/java', ...pkg.split('.'));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'CaptureActivity.kt'), kotlin(pkg, scheme));
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
      'intent-filter': [
        filter('android.intent.action.SEND', 'text/plain'),
        filter('android.intent.action.SEND', 'image/*'),
        filter('android.intent.action.SEND_MULTIPLE', 'image/*'),
        filter('android.intent.action.PROCESS_TEXT', 'text/plain'),
      ],
    });
    return cfg;
  });
};
