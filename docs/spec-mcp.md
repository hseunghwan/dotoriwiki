# Spec: memo MCP served by the gateway

Goal: from Claude Code on any machine in the tailnet (Mac mini, Linux laptop, two Windows PCs), type `/memo <text>` and have the memo land in the wiki like a phone memo, with the working context attached. No per-machine install beyond registering one remote MCP URL and copying one skill file.

Decision: the MCP endpoint lives inside the gateway process (`/mcp` on the same port and token). It writes through the same path as `POST /memos` (`parseMemo` → `wiki.accept`), so there is still one way to write a memo.

## Wire changes (`src/api.ts`)

```ts
export type MemoSourceWire = 'typed' | 'share' | 'selection' | 'voice' | 'chat' | 'feed' | 'agent';
export type MemoContextWire = { project: string; cwd: string; branch: string | null };
// MemoRequest gains: context?: MemoContextWire | null
```

- Raw frontmatter gains `context:` when present (`project`, `cwd`, `branch`). Absent for phone memos.
- The classifier prompt includes the context line when present (for example "작성 맥락: 프로젝트 notes-app, 브랜치 main"), because the project is a strong hint for 스터디 versus 개발소식.
- The app compiles against `api.ts`: give `agent` a label wherever the app maps sources (for example 에이전트), and keep the app's jest suite green. An APK rebuild is not part of this change.

## MCP endpoint

- Streamable HTTP at `POST /mcp`, stateless (no session state), with `@modelcontextprotocol/sdk` as an allowed new dependency. Same bearer token check as every other route. An unauthenticated request gets 401 before any MCP handling.
- Tools:
  - `write_memo({ text, domain_hint?, context? })`. The server makes the id (UUID) and `captured_at` (server clock, `+09:00`, `tz: Asia/Seoul`), sets `source: 'agent'`, then runs the same parse and accept as `POST /memos`. Returns `{ id, status }`. Validation errors come back as MCP tool errors with the parse detail.
  - `memo_status({ id })`. Returns the `MemoDetailWire` fields the caller needs: state, domain, verdict, verdict_id, first_page, failure. Unknown id is a tool error.
- Tool descriptions are written for the calling model. `write_memo` says to pass the user's text verbatim and to fill `context` from the current working directory and git branch. `domain_hint` must be one of the domain folder names, which the description lists, derived from the wiki at startup.
- No MCP prompts. The `/memo` UX comes from the skill below.

## Skill (`docs/skill-memo/SKILL.md`, installed to `~/.claude/skills/memo/`)

- `disable-model-invocation: true`, so it only runs when the user types `/memo`.
- With arguments: call `write_memo` with the arguments verbatim and `context` from the session (project = cwd basename, cwd, `git branch --show-current` or null). Then check `memo_status` every few seconds, for up to about 30 s, and report in one Korean line where it landed ("스터디 › 인사이트/2026 에 정리됨"). If it isn't done in time, report "받음, 정리 대기 중".
- Without arguments: draft a short memo from what the user learned or decided in this conversation, show it, and send only after the user confirms.
- If the `llmwiki` MCP server is not connected, say so in one line, with the registration command.

## Verification

- Unit and HTTP tests: 401 on `/mcp` without a token; `write_memo` produces a raw file with `source: agent` and `context`; an invalid `domain_hint` returns a tool error; `memo_status` for a known and an unknown id. The existing suites stay green.
- End to end against a test gateway (wiki copy, another port, `HOST=127.0.0.1`): register it in a throwaway Claude Code config and drive it with `claude -p --mcp-config <file>`, calling `write_memo` and then `memo_status` until it is ingested. Show the raw file and the resulting commit.
