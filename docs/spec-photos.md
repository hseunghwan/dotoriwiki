# Spec: photos on memos

A memo can carry up to 10 photos, the way an Obsidian note embeds images: the files sit in a vault-wide attachment folder and the note body has `![[file]]` lines. Each photo's metadata is pulled out on the gateway: when it was taken, where, and on what device. Decisions made with the user on 2026-10-30:

- Originals stay out of git. A downscaled JPEG is committed, and the metadata is committed in the memo frontmatter, so losing an original loses only resolution.
- The domain agent looks at the photos during ingest, not only at the metadata.
- Photos come in three ways: picked from the gallery, taken with the camera, or shared from a gallery app.

## Vault layout

| Path | What | In git |
| --- | --- | --- |
| `_originals/<id>-<n>.<ext>` | the bytes the phone sent, EXIF intact | no: the vault `.gitignore` lists `_originals/` |
| `_attachments/<id>-<n>.jpg` | long edge 2048 px, JPEG; the embed target | yes, committed with the ingest as a job input |

- `<id>` is the memo id and `<n>` is 1..10. `<ext>` comes from the sniffed bytes (`jpg`, `heic`, `png`, `webp`), never from a header.
- Both folders start with `_`, so they are not domains. Both are vault-wide, so a held or failed memo moves between domains without moving its photos, and any domain's page can embed any photo by bare name, which is how Obsidian resolves `![[...]]`.
- `openWiki` refuses to start unless `git check-ignore _originals/x` matches, so originals with GPS never reach GitHub by accident.
- The derivative is made with `sips -Z 2048 -s format jpeg` (the gateway runs on macOS), through the existing `Run` port so tests stay offline. HEIC becomes JPEG here, which both Obsidian and the model can read.

## Upload: `PUT /attachments/:id/:n`

- The body is raw image bytes. The limit is 40 MB, which answers 413 `too_large`. Auth is the same as every route.
- The gateway streams the body to a tmp file, sniffs the type from magic bytes (else 400), then links it in exclusively as `_originals/<id>-<n>.<ext>`.
- Same bytes already there: 200, so retries are free. Different bytes at the same `<id>-<n>`: 409 `conflict`.
- Reply: `{ name, sha256, bytes }`.
- Uploads come before the memo. An upload with no memo yet is an orphan; orphans older than 7 days are swept at startup.

## `MemoRequest.attachments`

```ts
attachments?: {
  n: number;                               // 1..10, unique, matches an uploaded original
  origin: 'gallery' | 'camera' | 'share';
  /** Geocoded on the phone from the photo's own GPS, same formats as location.place / address. */
  place?: string | null;
  address?: string | null;
}[] | null;
```

- `text` may be empty when at least one attachment is present.
- `accept` checks that every `n` has an original, else 422 `unprocessable` naming the missing `n`. The app always uploads first in the same flush pass, so this means a client bug, and the row goes `dead`.
- `accept` reads EXIF from each original (`exifr`), writes the derivative, then writes the inbox file. All three are deterministic from the original, so a retried accept rebuilds the same thing.

## Memo frontmatter

Added to 공통규칙 "원본 메모 frontmatter":

```yaml
attachments:
  - file: 01JB...-1.jpg          # _attachments/, embed with ![[...]]
    original: 01JB...-1.heic     # _originals/, not in git
    sha256: 9f2c...              # of the original
    bytes: 4183022
    width: 4000                  # original pixels, after EXIF orientation
    height: 3000
    origin: gallery              # gallery | camera | share
    taken_at: 2026-10-12T14:03:22+09:00   # DateTimeOriginal + OffsetTimeOriginal; null when absent
    location: { lat: 37.58, lon: 126.97, place: "종로구 사직동", address: "...", from: exif }   # null when unknown
    device: { make: samsung, model: SM-S928N, lens: "...", software: "..." }               # null when absent
    camera: { exposure: "1/120", f_number: 1.8, iso: 50, focal_35mm: 24, flash: false }      # null when absent
```

- `taken_at`: when the offset tag is missing, the memo's `tz` gives the offset. When `DateTimeOriginal` is missing, it is null, never the file time.
- `location.from` is `exif` when the photo had GPS. A `camera` photo without GPS was taken just now, so it gets the memo's own location with `from: device`. A gallery or share photo without GPS gets `null`, because the memo's location says nothing about where an old photo was taken.
- `place` and `address` come from the phone. The gateway has no geocoder.

The body is the memo text, then a blank line, then one `![[<file>]]` line per photo. `parseMemoFile` strips the trailing embed lines that match `attachments`, so `Memo.text` stays what the user typed.

## Routing and ingest

- `classifierText` gains one line per photo: `사진 1: 2026-10-12 14:03, 종로구 사직동, samsung SM-S928N`. The classifier does not see pixels.
- Each `_attachments/<file>` is a job input. It is checksummed in the inflight marker (rule `input-modified`) and committed with the ingest.
- The ingest prompt names each photo by its vault path and tells the agent to look at it with Read. The server rules gain:
  - 사진은 `![[파일명]]`으로만 넣는다. 붙은 사진이 아닌 파일은 넣지 않는다.
  - 사진에서 보이는 것은 사진에서 본 것이라고 적는다.
- Claude needs read access to `_attachments/`. Codex gets the photos with `-i`.
- `check`: a wikilink whose target ends in an image extension resolves only to a file that exists in `_attachments/`. Everything else is unchanged.

## Read side

- `MemoListItemWire.photos: number`.
- `MemoDetailWire.attachments: { file, taken_at, place, device }[]`, with `device` as `"make model"` or null.
- `GET /attachments/:file` serves the derivative (`image/jpeg`, cacheable, same auth). Originals are never served.

## App

- **Permissions.** expo-media-library with `isAccessMediaLocationEnabled: true`. The system photo picker strips GPS (issuetracker 243294058), so the gallery path does not use it.
- **Gallery.** An in-app grid of recent photos from `getAssetsAsync`, multi-select up to 10.
- **Original bytes.** A local Expo module (`app/modules/original-photo`, Kotlin) copies the photo's original bytes into the app's files dir via `MediaStore.setRequireOriginal`. It also returns `ExifInterface.latLong`, or null.
- **Camera.** expo-image-picker `launchCameraAsync`, `quality: 1`, no editing, so the bytes are not re-encoded.
- **Share.** `CaptureActivity` also takes `ACTION_SEND` and `ACTION_SEND_MULTIPLE` for `image/*`.
  - It copies each stream into the files dir right away, because the URI grant is temporary.
  - For a MediaStore URI with the permission granted, it tries `setRequireOriginal` first.
  - It opens the compose sheet with the copied paths. Gallery apps may strip GPS on share, and the gateway handles that as above.
- **Geocoding.** Photos with a GPS fix get `place` and `address` from `reverseGeocodeAsync` with the existing `placeOf` and `addressOf`.
- **Outbox.**
  - New table `outbox_files(memo_id, n, path, uploaded)`. The files live under the app files dir until the memo row is deleted.
  - A flush PUTs each file not yet uploaded, then POSTs the memo. Upload errors follow the same transition table: network, 5xx and 408/429 retry, 401 pauses, any other 4xx is dead.
  - Deleting a row deletes its files.
- **UI.**
  - The 메모 tab input and the compose sheet get a photo strip, with buttons for gallery and camera.
  - Memo list rows show a photo count.
  - Memo detail shows the photos, each captioned with taken-at, place and device.

## Verification

- **Gateway tests.**
  - EXIF extraction runs on fixture JPEGs: one with GPS, offset and make/model, and one with nothing.
  - PUT covers idempotency, the conflict, the sniffing, and 413.
  - `accept` covers a missing attachment and a photo-only memo.
  - The frontmatter round-trip strips the embeds.
  - The `location.from` rules hold for each origin.
  - The `check` embed rule passes an existing photo and fails a missing one.
  - The ingest inputs include the derivative.
  - The start-up check fails when `_originals/` is not ignored.
- **One real ingest on a test vault.** A photo memo through Claude with haiku shows the agent read the image (the page describes it) and embedded it.
- **App tests.** jest for the outbox upload-then-post order and the transition table with uploads.
- **Emulator against a test gateway.**
  - Push a JPEG with GPS EXIF to `/sdcard/DCIM` and media-scan it.
  - Pick it in the grid, and confirm the uploaded original still has GPS: `location.from: exif` with a place.
  - Share it from the emulator's gallery.
  - Take a camera photo.
  - Screenshot compose, list and detail in dark and light.
