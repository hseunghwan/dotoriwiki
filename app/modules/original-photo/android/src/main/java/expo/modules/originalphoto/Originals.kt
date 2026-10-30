package expo.modules.originalphoto

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.MediaStore
import androidx.exifinterface.media.ExifInterface
import java.io.File

/**
 * Copies a photo's bytes into the app's own files, untouched. MediaStore hands out a copy with the
 * GPS tags blanked unless the reader holds ACCESS_MEDIA_LOCATION and asks with setRequireOriginal,
 * so that is tried first. Shared with CaptureActivity, which copies shared streams the same way.
 */
object Originals {
  data class Copied(val file: File, val original: Boolean)

  fun assetUri(id: String): Uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id.toLong())

  fun canReadLocation(context: Context): Boolean =
    context.checkSelfPermission(Manifest.permission.ACCESS_MEDIA_LOCATION) == PackageManager.PERMISSION_GRANTED

  /** `dir/name.<ext>`, the extension from the provider's MIME type. The gateway sniffs the bytes anyway. */
  fun copy(context: Context, uri: Uri, dir: File, name: String): Copied {
    val resolver = context.contentResolver
    dir.mkdirs()
    val dest = File(dir, "$name.${extensionOf(resolver.getType(uri))}")
    val fromMediaStore = uri.authority == MediaStore.AUTHORITY
    if (fromMediaStore && canReadLocation(context)) {
      try {
        write(context, MediaStore.setRequireOriginal(uri), dest)
        return Copied(dest, true)
      } catch (e: Exception) {
        // A picker URI or a revoked grant: fall back to the stream we were given.
        dest.delete()
      }
    }
    write(context, uri, dest)
    return Copied(dest, false)
  }

  /** The GPS fix from the file's EXIF, or null. */
  fun latLong(file: File): Pair<Double, Double>? =
    try {
      ExifInterface(file).latLong?.let { Pair(it[0], it[1]) }
    } catch (e: Exception) {
      null
    }

  private fun write(context: Context, uri: Uri, dest: File) {
    try {
      val input = context.contentResolver.openInputStream(uri) ?: throw IllegalStateException("no stream for $uri")
      input.use { i -> dest.outputStream().use { o -> i.copyTo(o) } }
    } catch (e: Exception) {
      dest.delete()
      throw e
    }
  }

  private fun extensionOf(mime: String?): String =
    when (mime?.lowercase()) {
      "image/heic", "image/heif" -> "heic"
      "image/png" -> "png"
      "image/webp" -> "webp"
      else -> "jpg"
    }
}
