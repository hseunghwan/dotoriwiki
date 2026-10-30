import type { MemoAttachmentWire } from './wire';

/** The gateway takes n = 1..10. */
export const MAX_PHOTOS = 10;

export type PhotoOrigin = MemoAttachmentWire['origin'];

/** A photo on the memo being written. Its bytes are already a file of ours, so the source app or grant can go away. */
export type DraftPhoto = {
  /** file:// under the app's files dir. */
  uri: string;
  origin: PhotoOrigin;
  /** From the photo's own GPS, never the phone's position now. */
  place: string | null;
  address: string | null;
};

/** n follows the strip order, so removing a photo before sending leaves no gap. */
export function attachmentsOf(photos: readonly DraftPhoto[]): MemoAttachmentWire[] {
  return photos.map((p, i) => ({ n: i + 1, origin: p.origin, place: p.place, address: p.address }));
}

/** A photo alone is a memo; the gateway allows empty text when attachments are present. */
export const canSend = (text: string, photos: readonly DraftPhoto[]): boolean => text.trim() !== '' || photos.length > 0;

/** Appends up to the cap and reports how many did not fit. */
export function addPhotos(current: readonly DraftPhoto[], added: readonly DraftPhoto[]): { photos: DraftPhoto[]; dropped: DraftPhoto[] } {
  const room = Math.max(0, MAX_PHOTOS - current.length);
  return { photos: [...current, ...added.slice(0, room)], dropped: added.slice(room) };
}

/** outbox/<memoId>-<n>.<ext>, keeping the extension the copy got from its MIME type. */
export function outboxName(memoId: string, n: number, uri: string): string {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(uri)?.[1]?.toLowerCase() ?? 'jpg';
  return `${memoId}-${n}.${ext}`;
}

/** How many photos a frozen MemoRequest body carries. */
export function photoCount(body: { attachments?: readonly unknown[] | null }): number {
  return Array.isArray(body.attachments) ? body.attachments.length : 0;
}
