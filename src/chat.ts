/**
 * One chat turn. Read-only against the wiki: the model gets Read, Glob, and Grep only. Facts
 * the user wants kept are not extracted here; the client posts them to /memos.
 *
 * Claude keeps the transcript under ~/.claude/projects/<slug of cwd>/, so a session resumes
 * only from the same target. A mismatch surfaces as an `error` event.
 */

import type { ChatTarget, PageRef, Wiki } from './wiki/index.ts';
import type { Claude } from './claude.ts';
import type { ChatId } from './chats.ts';

export type ChatTurn = { readonly target: ChatTarget; readonly message: string; readonly sessionId: ChatId | null };

export type ChatOut =
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'done'; readonly sessionId: string; readonly cited: readonly PageRef[] }
  | { readonly kind: 'error'; readonly message: string };

export type ChatDeps = { readonly wiki: Wiki; readonly claude: Pick<Claude, 'chat'> };

const chatRules = (target: ChatTarget) => `## 채팅 규칙

- 이 채팅은 위키를 읽기만 한다. 파일을 만들거나 고치지 않는다.
- ${target.kind === 'root' ? '각 도메인의 `wiki/index.md`를' : '`wiki/index.md`를'} 먼저 읽고 필요한 페이지만 연다.
- 답의 근거가 된 위키 페이지를 \`[[도메인/wiki/페이지]]\` 형식으로 단다.
- 위키에 없는 내용은 없다고 말하고 지어내지 않는다.`;

export async function* chatTurn(deps: ChatDeps, turn: ChatTurn, signal?: AbortSignal): AsyncIterable<ChatOut> {
  const ctx = await deps.wiki.chatContext(turn.target);
  const stream = deps.claude.chat({
    cwd: ctx.cwd,
    systemPrompt: `${ctx.systemPrompt}\n\n${chatRules(turn.target)}`,
    message: turn.message,
    resume: turn.sessionId,
    ...(signal ? { signal } : {}),
  });
  for await (const ev of stream) {
    if (ev.kind === 'done') yield { kind: 'done', sessionId: ev.sessionId, cited: await deps.wiki.citations(ev.fullText, turn.target) };
    else yield ev;
  }
}
