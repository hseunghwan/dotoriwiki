import { answerSpans, pageLabel } from '../markdown';

const render = (text: string) => answerSpans(text).map((s) => (s.kind === 'text' ? s.text : `<${s.kind}>${s.text}</${s.kind}>`)).join('');

it('renders bold, bullets, headings and wikilinks from a chat answer', () => {
  const answer = '## 요약\n- **직접 해본 결과:** 512 토큰으로 줄였어요.\n  - 기록에 없는 것\n\n근거: [[스터디/wiki/RAG]], [[인사이트/2026|2026 인사이트]]';
  expect(render(answer)).toBe(
    '<bold>요약</bold>\n• <bold>직접 해본 결과:</bold> 512 토큰으로 줄였어요.\n  • 기록에 없는 것\n\n근거: <link>RAG</link>, <link>인사이트/2026</link>',
  );
});

it('leaves unmatched markers as typed, so a half-streamed answer still reads', () => {
  expect(render('정확도가 **올')).toBe('정확도가 **올');
  expect(render('[[스터디/wiki/R')).toBe('[[스터디/wiki/R');
});

it('labels cited pages without the domain prefix', () => {
  expect(pageLabel('스터디/wiki/개념/RAG')).toBe('개념/RAG');
  expect(pageLabel('인사이트/2026')).toBe('인사이트/2026');
});
