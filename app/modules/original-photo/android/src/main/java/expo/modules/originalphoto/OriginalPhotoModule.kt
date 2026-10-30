package expo.modules.originalphoto

import android.net.Uri
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

class OriginalPhotoModule : Module() {
  private val context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private fun fileOf(uri: String): File = File(Uri.parse(uri).path ?: uri)

  private fun result(file: File, original: Boolean): Map<String, Any?> = mapOf(
    "uri" to Uri.fromFile(file).toString(),
    "original" to original,
    "latLong" to Originals.latLong(file)?.let { mapOf("lat" to it.first, "lon" to it.second) },
  )

  override fun definition() = ModuleDefinition {
    Name("OriginalPhoto")

    /** Copies a MediaStore image (by its _ID, as expo-media-library lists it) to `dir/name.<ext>`. */
    AsyncFunction("copyAsset") { id: String, dir: String, name: String ->
      val copied = Originals.copy(context, Originals.assetUri(id), fileOf(dir), name)
      result(copied.file, copied.original)
    }

    /** The GPS fix in a file the app already holds, for camera shots and shared photos. */
    AsyncFunction("latLong") { uri: String ->
      Originals.latLong(fileOf(uri))?.let { mapOf("lat" to it.first, "lon" to it.second) }
    }
  }
}
