/** Just enough Markdown for chat answers: bold, wikilinks, headings and bullets. Anything else stays plain text. */
export type Span = { kind: 'text' | 'bold' | 'link'; text: string };

/** "스터디/wiki/개념/RAG" shows as "개념/RAG"; a bare page name is already relative to the asked domain. */
export const pageLabel = (ref: string): string => ref.split('/wiki/').at(-1) ?? ref;

const INLINE = /\*\*(.+?)\*\*|\[\[([^\]]+)\]\]/g;

function inline(line: string): Span[] {
  const out: Span[] = [];
  let last = 0;
  for (const m of line.matchAll(INLINE)) {
    if (m.index > last) out.push({ kind: 'text', text: line.slice(last, m.index) });
    out.push(m[1] !== undefined ? { kind: 'bold', text: m[1] } : { kind: 'link', text: pageLabel(m[2]!.split('|')[0]!) });
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push({ kind: 'text', text: line.slice(last) });
  return out;
}

export function answerSpans(text: string): Span[] {
  return text.split('\n').flatMap((line, i) => {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
    const spans = heading ? [{ kind: 'bold' as const, text: heading[1]! }] : bullet ? [{ kind: 'text' as const, text: `${bullet[1]}• ` }, ...inline(bullet[2]!)] : inline(line);
    return i === 0 ? spans : [{ kind: 'text' as const, text: '\n' }, ...spans];
  });
}
