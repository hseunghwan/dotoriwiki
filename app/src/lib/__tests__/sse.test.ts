import { createSseParser } from '../sse';
import type { ChatFrame } from '../wire';

/** The gateway's serialization in http.ts postChat. */
const wire = (f: ChatFrame) => {
  const { type, ...data } = f;
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
};

const turn: ChatFrame[] = [
  { type: 'session', session_id: '3f1c2b9e-8a7d-4c6e-9b5a-1d2e3f4a5b6c' },
  { type: 'delta', text: '스터디 위키에 두 가지가 기록돼 있어요.\n' },
  { type: 'delta', text: '1. 청크 크기를 512로 줄이자 정확도가 올랐어요.' },
  { type: 'done', session_id: '3f1c2b9e-8a7d-4c6e-9b5a-1d2e3f4a5b6c', cited: ['스터디/wiki/개념/RAG', '인사이트/2026'] },
];

it('parses a whole turn delivered in one chunk', () => {
  expect(createSseParser().push(turn.map(wire).join(''))).toEqual(turn);
});

it('parses a turn split at every possible byte boundary', () => {
  const text = turn.map(wire).join('');
  for (let cut = 1; cut < text.length; cut += 7) {
    const p = createSseParser();
    expect([...p.push(text.slice(0, cut)), ...p.push(text.slice(cut))]).toEqual(turn);
  }
});

it('holds a frame until its blank line arrives', () => {
  const p = createSseParser();
  expect(p.push('event: delta\ndata: {"text":"안녕"}\n')).toEqual([]);
  expect(p.push('\n')).toEqual([{ type: 'delta', text: '안녕' }]);
});

it('accepts CRLF line endings', () => {
  expect(createSseParser().push('event: error\r\ndata: {"message":"claude exited 1"}\r\n\r\n')).toEqual([{ type: 'error', message: 'claude exited 1' }]);
});

it('drops unknown events and malformed data without losing the frames around them', () => {
  const text = 'event: ping\ndata: {}\n\n' + 'event: delta\ndata: {not json\n\n' + 'event: done\ndata: {"session_id":"s"}\n\n' + wire({ type: 'delta', text: 'ok' });
  expect(createSseParser().push(text)).toEqual([{ type: 'delta', text: 'ok' }]);
});
