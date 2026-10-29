# Spec: keep chat sessions on the gateway

Goal: the user can reopen a past 질문 conversation in the app, read it, and continue it, after closing the app, reinstalling it, or switching phones. Chat transcripts never enter the wiki. Only the existing 답 저장 button files an answer into the wiki.

## Where it lives

- The gateway owns a chat store outside the wiki: `CHATS_DIR`, default `~/.local/share/llmwiki/chats/`. Not under the wiki root, not in git, not in `.gateway/`, whose contents are advisory and safe to delete. Chats are not.
- One append-only JSONL file per session, `<session_id>.jsonl`:

```ts
type ChatLine =
  | { type: 'meta'; session_id: string; target: string; created_at: string }    // first line, written once
  | { type: 'turn'; at: string; question: string; answer: string; cited: string[] }
  | { type: 'error'; at: string; question: string; message: string };          // a turn that failed mid-stream
```

- The session id is the Claude session id the chat stream already reports. The `meta` line is written when the first `session` frame arrives. A `turn` line is appended when the stream finishes. A turn the client aborts is not recorded.
- The store is the source of truth for which target a session belongs to. `POST /chat` with a `session_id` must find that session in the store and use its stored `target`. An unknown id is 404. A request whose `target` disagrees with the stored one is 409. This matters because `--resume` only works from the same cwd.
- One writer per session file: appends happen in the request handler after the stream ends. Two concurrent turns on one session are rejected with 409 while one is in flight.

## API (`src/api.ts`)

```ts
export type ChatSummaryWire = { session_id: string; target: string; title: string; created_at: string; updated_at: string; turns: number };
export type ChatListResponse = { chats: ChatSummaryWire[]; next_before: string | null };   // newest updated first
export type ChatTurnWire = { at: string; question: string; answer: string; cited: string[] } | { at: string; question: string; error: string };
export type ChatDetailWire = { session_id: string; target: string; created_at: string; turns: ChatTurnWire[] };
```

- `GET /chats?limit=&before=` returns the list. `title` is the first question, about 40 characters.
- `GET /chats/:id` returns the detail, or 404.
- `DELETE /chats/:id` deletes the store file and returns 204. Claude's own transcript under `~/.claude/projects` is left alone.

## App

- The 질문 tab gets a way to open past conversations, such as a history button in the header that opens a list, grouped by date like 기록. Opening one shows its turns and continues it: the next message goes with that `session_id`. Starting a new conversation stays one tap away. Deleting is available from the list with a confirmation.
- There is no artboard for this. Follow the existing 기록 list and chat styles. Report what you built so the design session can review it.
- The in-memory `threads` state is no longer the record: after a turn completes, the server copy is the truth. Reopening the tab shows the most recent conversation for the selected target.

## Verification

- Gateway tests: store append and read, `meta` written once, an aborted stream not recorded, resume with the stored target, 404 for an unknown session, 409 for a target mismatch and for a concurrent turn, list order and paging, delete.
- Emulator, against a test gateway on a wiki copy: two turns, kill and relaunch the app, open the conversation from history, continue with a third turn that remembers the first two, delete a conversation. Screenshots in dark and light.
- The release APK path and sha256.
