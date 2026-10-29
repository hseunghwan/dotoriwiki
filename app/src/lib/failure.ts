import type { MemoFailureWire, MemoStateWire } from './wire';

// Copy owned by docs/design/앱-실패문구.md.
const SENTENCE: Record<string, string> = {
  llm: '정리하다가 멈췄어요. 시간이 너무 오래 걸렸거나 실행이 실패했어요.',
  scope: '위키 폴더 밖에 쓰려고 해서 막았어요.',
  'input-modified': '정리하는 사이에 원본 메모가 바뀌었어요.',
  'append-only': '확인 목록에 이미 있던 줄을 고치려고 해서 막았어요.',
  frontmatter: '페이지 정보에 꼭 필요한 항목이 빠졌어요.',
  type: '이 도메인에 없는 종류의 페이지를 만들려고 했어요.',
  empty: '내용이 빈 페이지를 만들었어요.',
  interrupted: '정리하는 도중 맥미니 서버가 다시 시작됐어요.',
};
const UNKNOWN = '정리하지 못했어요.';

/** The name inside the first [[...]] of a broken-link detail, or null. */
export function brokenLinkTarget(detail: string): string | null {
  const m = /\[\[([^\]]+)\]\]/.exec(detail);
  return m ? m[1]! : null;
}

export type FailureSentence = { text: string; link: string | null };

/** `link` is the missing page name, shown highlighted inside the sentence. */
export function failureSentence(f: Pick<MemoFailureWire, 'code' | 'detail'>): FailureSentence {
  if (f.code === 'broken-link') {
    const link = brokenLinkTarget(f.detail);
    return link ? { text: `없는 페이지 '${link}'으로 링크를 걸었어요.`, link } : { text: '없는 페이지로 링크를 걸었어요.', link: null };
  }
  return { text: SENTENCE[f.code] ?? UNKNOWN, link: null };
}

/** The attempts suffix: on a failed memo after the sentence, on a retrying memo in its progress step. */
export function attemptsNote(state: MemoStateWire, f: MemoFailureWire | null): string | null {
  if (!f) return null;
  if (state === 'failed') return `${f.max}번 모두 막혔어요`;
  if (state === 'routed' || state === 'running') return `${f.attempts + 1}번째 시도 중`;
  return null;
}
