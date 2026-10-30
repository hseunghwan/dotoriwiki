import { MAX_PHOTOS } from './photos';

/**
 * Text and photos another app handed us through the share sheet, or text from the text-selection menu.
 * `photos` are file:// copies CaptureActivity already made, since the sender's URI grant ends with it.
 */
export type Shared = { source: 'share' | 'selection'; text: string; subject: string | null; photos: string[] };

const URL_RE = /https?:\/\/[^\s<>"']+/i;

/** The `photos` param is a JSON array of file:// URIs. Anything else is dropped, never trusted as a path. */
function parsePhotos(raw: string | undefined): string[] {
  try {
    const v: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((u): u is string => typeof u === 'string' && u.startsWith('file:///')).slice(0, MAX_PHOTOS) : [];
  } catch {
    return [];
  }
}

export function parseShared(params: { source?: string; text?: string; subject?: string; photos?: string }): Shared | null {
  const text = params.text?.trim() ?? '';
  const photos = params.source === 'share' ? parsePhotos(params.photos) : [];
  if ((!text && photos.length === 0) || (params.source !== 'share' && params.source !== 'selection')) return null;
  const subject = params.subject?.trim() || null;
  return { source: params.source, text, subject, photos };
}

/** What the compose card shows: a link with its title and host, or the passage itself. */
export function preview(s: Omit<Shared, 'photos'>): { kind: 'link'; title: string; host: string } | { kind: 'text'; text: string } {
  const url = URL_RE.exec(s.text)?.[0];
  if (!url) return { kind: 'text', text: s.text };
  const host = /^https?:\/\/(?:www\.)?([^/:?#]+)/i.exec(url)?.[1] ?? url;
  const rest = s.text.replace(url, '').trim();
  return { kind: 'link', title: s.subject ?? (rest || url), host };
}

/** The memo body: the title a share carried when the text lacks it, the shared text, then the user's note. */
export function memoText(s: Omit<Shared, 'photos'>, note: string): string {
  const parts = [];
  if (s.subject && !s.text.includes(s.subject)) parts.push(s.subject);
  if (s.text) parts.push(s.text);
  if (note.trim()) parts.push(note.trim());
  return parts.join('\n');
}
