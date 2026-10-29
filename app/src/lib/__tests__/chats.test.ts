import { answerId, fromDetail, type Conversation } from '../chats';
import type { ChatDetailWire } from '../wire';

const SID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const detail: ChatDetailWire = {
  session_id: SID,
  target: '스터디',
  created_at: '2026-10-29T00:00:00Z',
  turns: [
    { at: '2026-10-29T00:01:00Z', question: '첫 질문', answer: '첫 답', cited: ['스터디/wiki/RAG'] },
    { at: '2026-10-29T00:02:00Z', question: '실패한 질문', error: 'claude ended without a result' },
  ],
};

it('reads the gateway copy as the conversation, failed turns included', () => {
  expect(fromDetail(detail, undefined)).toEqual({
    sessionId: SID,
    turns: [
      { key: `${SID}:0`, question: '첫 질문', answer: '첫 답', cited: ['스터디/wiki/RAG'], status: 'done', error: null, saved: 'no', remembered: 'no' },
      { key: `${SID}:1`, question: '실패한 질문', answer: '', cited: [], status: 'error', error: '답을 받지 못했어요.', saved: 'no', remembered: 'no' },
    ],
  });
});

it('keeps the phone-only marks of the same session and drops those of another', () => {
  const local: Conversation = {
    sessionId: SID,
    turns: [{ key: 'local-1', question: '첫 질문', answer: '첫 답', cited: [], status: 'done', error: null, saved: 'saved', remembered: 'saved' }],
  };
  const same = fromDetail(detail, local).turns[0]!;
  expect([same.key, same.saved, same.remembered, same.cited]).toEqual(['local-1', 'saved', 'saved', ['스터디/wiki/RAG']]);
  const other = fromDetail(detail, { ...local, sessionId: '11111111-2222-4333-8444-555555555555' }).turns[0]!;
  expect([other.key, other.saved, other.remembered]).toEqual([`${SID}:0`, 'no', 'no']);
});

it('gives each turn of a session its own stable UUID for 답 저장', () => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  expect(answerId(SID, 0)).toMatch(uuid);
  expect(answerId(SID, 17)).toBe('0f8fad5b-d9cb-469f-a165-000000000011');
  expect(answerId(SID, 1)).toBe(answerId(SID, 1));
  expect(answerId(SID, 1)).not.toBe(answerId(SID, 2));
});
