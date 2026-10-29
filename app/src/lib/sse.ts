import type { ChatFrame } from './wire';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');

/** One `event: <type>\ndata: <json>` block into a ChatFrame; anything else is dropped. */
export function parseFrame(block: string): ChatFrame | null {
  let type: string | null = null;
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) type = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (!type || data.length === 0) return null;
  let d: unknown;
  try {
    d = JSON.parse(data.join('\n'));
  } catch {
    return null;
  }
  if (!isRecord(d)) return null;
  switch (type) {
    case 'session':
      return typeof d.session_id === 'string' ? { type, session_id: d.session_id } : null;
    case 'delta':
      return typeof d.text === 'string' ? { type, text: d.text } : null;
    case 'done':
      return typeof d.session_id === 'string' && isStrings(d.cited) ? { type, session_id: d.session_id, cited: d.cited } : null;
    case 'error':
      return typeof d.message === 'string' ? { type, message: d.message } : null;
    default:
      return null;
  }
}

/** Feed decoded text as it arrives; frames come out once their blank-line terminator has. */
export function createSseParser(): { push(text: string): ChatFrame[] } {
  let buffer = '';
  return {
    push(text) {
      buffer += text;
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? '';
      return blocks.map(parseFrame).filter((f): f is ChatFrame => f !== null);
    },
  };
}
