/** Text another app handed us through the share sheet or the text-selection menu. */
export type Shared = { source: 'share' | 'selection'; text: string; subject: string | null };

const URL_RE = /https?:\/\/[^\s<>"']+/i;

export function parseShared(params: { source?: string; text?: string; subject?: string }): Shared | null {
  const text = params.text?.trim();
  if (!text || (params.source !== 'share' && params.source !== 'selection')) return null;
  const subject = params.subject?.trim() || null;
  return { source: params.source, text, subject };
}

/** What the compose card shows: a link with its title and host, or the passage itself. */
export function preview(s: Shared): { kind: 'link'; title: string; host: string } | { kind: 'text'; text: string } {
  const url = URL_RE.exec(s.text)?.[0];
  if (!url) return { kind: 'text', text: s.text };
  const host = /^https?:\/\/(?:www\.)?([^/:?#]+)/i.exec(url)?.[1] ?? url;
  const rest = s.text.replace(url, '').trim();
  return { kind: 'link', title: s.subject ?? (rest || url), host };
}

/** The memo body: the title a share carried when the text lacks it, the shared text, then the user's note. */
export function memoText(s: Shared, note: string): string {
  const parts = [];
  if (s.subject && !s.text.includes(s.subject)) parts.push(s.subject);
  parts.push(s.text);
  if (note.trim()) parts.push(note.trim());
  return parts.join('\n');
}
