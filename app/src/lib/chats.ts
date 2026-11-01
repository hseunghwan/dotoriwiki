import { copy } from '../text';
import type { ChatDetailWire } from './wire';

export const ROOT = 'root';

export type Turn = {
  /** React key: local while streaming, kept once the server copy replaces the turn. */
  key: string;
  question: string;
  answer: string;
  cited: string[];
  status: 'streaming' | 'done' | 'error';
  error: string | null;
  saved: 'no' | 'saving' | 'saved' | 'failed';
  remembered: 'no' | 'saved';
};

/** The conversation open for one target. sessionId stays null until the first turn's session frame. */
export type Conversation = { sessionId: string | null; turns: Turn[] };

export const EMPTY: Conversation = { sessionId: null, turns: [] };

export const targetLabel = (target: string) => (target === ROOT ? copy.common.all : target);

export const isStreaming = (c: Conversation | undefined) => c?.turns.at(-1)?.status === 'streaming';

/**
 * The gateway's copy is the record. What only the phone knows (keys, 답 저장 and 기억하기 marks)
 * carries over by position when it is the same session.
 */
export function fromDetail(d: ChatDetailWire, local: Conversation | undefined): Conversation {
  const prev = local?.sessionId === d.session_id ? local.turns : [];
  return {
    sessionId: d.session_id,
    turns: d.turns.map((t, i): Turn => {
      const p = prev[i];
      const failed = 'error' in t;
      return {
        key: p?.key ?? `${d.session_id}:${i}`,
        question: t.question,
        answer: failed ? '' : t.answer,
        cited: failed ? [] : t.cited,
        status: failed ? 'error' : 'done',
        error: failed ? copy.chat.noAnswer : null,
        saved: p?.saved ?? 'no',
        remembered: p?.remembered ?? 'no',
      };
    }),
  };
}

/**
 * 답 저장's id, fixed per turn of a session, so saving an answer again after a reload is the
 * gateway's duplicate rather than a second page. A UUID: the session's first 24 characters, then the turn index.
 */
export const answerId = (sessionId: string, index: number) => `${sessionId.slice(0, 24)}${index.toString(16).padStart(12, '0')}`;
