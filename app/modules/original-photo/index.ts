import { requireNativeModule } from 'expo';

export type LatLong = { lat: number; lon: number };

/** `uri` is a file:// URI under the app's files dir. `original` is false when MediaStore may have blanked the GPS tags. */
export type CopiedPhoto = { uri: string; original: boolean; latLong: LatLong | null };

type OriginalPhotoModule = {
  /** Copies a MediaStore image's original bytes (by expo-media-library asset id) to `dir/name.<ext>`, never re-encoded. */
  copyAsset(id: string, dir: string, name: string): Promise<CopiedPhoto>;
  /** The EXIF GPS fix of a file the app holds, or null. */
  latLong(uri: string): Promise<LatLong | null>;
};

export default requireNativeModule<OriginalPhotoModule>('OriginalPhoto');
