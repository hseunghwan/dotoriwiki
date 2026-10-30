import * as Crypto from 'expo-crypto';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library/legacy';
import { Linking } from 'react-native';
import OriginalPhoto, { type LatLong } from '../modules/original-photo';
import { keepCameraShot, pendingUri } from './lib/files';
import { geocode } from './lib/location';
import type { DraftPhoto, PhotoOrigin } from './lib/photos';

// Where photos come from. The system photo picker blanks GPS on the way out (issuetracker 243294058),
// so the gallery is our own grid over MediaStore, read with ACCESS_MEDIA_LOCATION and setRequireOriginal.

export type GalleryAccess = { kind: 'all' } | { kind: 'limited' } | { kind: 'denied'; canAskAgain: boolean };

function accessOf(p: MediaLibrary.PermissionResponse): GalleryAccess {
  if (!p.granted) return { kind: 'denied', canAskAgain: p.canAskAgain };
  return p.accessPrivileges === 'limited' ? { kind: 'limited' } : { kind: 'all' };
}

/** READ_MEDIA_IMAGES with ACCESS_MEDIA_LOCATION, which expo-media-library asks for alongside when the manifest has it. */
export async function galleryAccess(ask: boolean): Promise<GalleryAccess> {
  const p = ask ? await MediaLibrary.requestPermissionsAsync(false, ['photo']) : await MediaLibrary.getPermissionsAsync(false, ['photo']);
  return accessOf(p);
}

/** Android 14 partial access: let the user widen the selection, or send them to settings once they said no for good. */
export async function widenAccess(access: GalleryAccess): Promise<GalleryAccess> {
  if (access.kind === 'denied' && !access.canAskAgain) {
    await Linking.openSettings();
    return access;
  }
  if (access.kind === 'limited') await MediaLibrary.presentPermissionsPickerAsync(['photo']);
  return galleryAccess(true);
}

export type GalleryPage = { assets: MediaLibrary.Asset[]; after: string | null };

/** Photos only, newest first. */
export async function recentPhotos(after: string | null, first = 60): Promise<GalleryPage> {
  const page = await MediaLibrary.getAssetsAsync({
    first,
    after: after ?? undefined,
    mediaType: MediaLibrary.MediaType.photo,
    sortBy: [[MediaLibrary.SortBy.creationTime, false]],
  });
  return { assets: page.assets, after: page.hasNextPage ? page.endCursor : null };
}

async function draft(uri: string, origin: PhotoOrigin, latLong: LatLong | null): Promise<DraftPhoto> {
  const where = latLong ? await geocode(latLong.lat, latLong.lon) : null;
  return { uri, origin, place: where?.place ?? null, address: where?.address ?? null };
}

/** Copies each original into the app's files. One that fails to copy is skipped, not fatal. */
export async function fromGallery(assets: readonly MediaLibrary.Asset[]): Promise<DraftPhoto[]> {
  const dir = pendingUri();
  const copied = await Promise.all(
    assets.map((a) =>
      OriginalPhoto.copyAsset(a.id, dir, Crypto.randomUUID())
        .then((c) => draft(c.uri, 'gallery', c.latLong))
        .catch(() => null),
    ),
  );
  return copied.filter((p): p is DraftPhoto => p !== null);
}

/** quality 1 and no editing: expo-image-picker then copies the camera's file as-is instead of re-encoding it. */
export async function fromCamera(): Promise<DraftPhoto | 'denied' | null> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) return 'denied';
  const r = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1, allowsEditing: false, exif: false });
  const shot = r.canceled ? null : r.assets[0];
  if (!shot) return null;
  const uri = await keepCameraShot(shot.uri, Crypto.randomUUID());
  return draft(uri, 'camera', await OriginalPhoto.latLong(uri).catch(() => null));
}

/** CaptureActivity already copied these; only their GPS and place are left to read. */
export async function fromShare(uris: readonly string[]): Promise<DraftPhoto[]> {
  return Promise.all(uris.map(async (uri) => draft(uri, 'share', await OriginalPhoto.latLong(uri).catch(() => null))));
}
