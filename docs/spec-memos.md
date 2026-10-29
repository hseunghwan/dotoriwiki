# Spec: memo list and detail for the app

Requested by the design session for the 기록 tab, the 메모 tab's "방금 보낸 메모", and the memo detail screen. Builds on `docs/spec-hold.md` (held state). Chat answers (`file-answer`) are not listed.

## Wiki read side

```ts
memos(opts: { limit: number; before: string | null }): Promise<readonly MemoSummary[]>;   // newest captured_at first, strictly before the cursor
memo(id: MemoId): Promise<MemoDetail | null>;
```

Both are pure reads. No new stored state: everything is derived from the folders, the ledger at HEAD, and git history.

**State**, one per memo, in this precedence:

| state | derived from |
| --- | --- |
| `running` | the domain's inflight marker names `ingest:<id>` |
| `inbox` | `inbox/<id>.md` exists and no copy is routed |
| `held` | `<d>/hold/<id>.md` exists |
| `ingested` | latest terminal ledger line for `ingest:<id>` in `L(d)` is applied |
| `failed` | latest terminal line is `포기` (after any `재시도`) |
| `routed` | `<d>/raw/<id>.md` exists and none of the above |

A memo moved away (`이동` in the source domain) is listed once, under its target domain.

**Fields.**

- `verdict` and `firstPage` come from the applied ledger line (verdict and changed page list). `firstPage` is the first page path, relative to `wiki/`, without `.md`.
- `finishedAt` is the committer time of the commit that added the terminal ledger line. Read it from one `git log` pass over the ledger commits, cached by HEAD sha, not one git call per memo.
- Detail `pages` come from the ingest commit's name-status, filtered to `<d>/wiki/` pages and answers (no `index.md`, `log.md`, `_review.md`), as `{ path, type, change: 'created' | 'modified' }`, with `path` relative to `wiki/` and without `.md`, like `firstPage`. `type` is read from that file at that commit.
- Detail `failure` is set for `failed`, and also for `routed` or `running` memos that already have failed attempts, so the app can say "2번째 시도 중". It is `{ attempts, max, code, detail }`. `code` is the leading rule word of the ledger reason (`llm`, `scope`, `input-modified`, `append-only`, `frontmatter`, `type`, `empty`, `broken-link`), `interrupted` for 중단 lines or a 포기 caused by one, and `unknown` for anything else. `detail` is the rest, e.g. `개발소식지식베이스/wiki/기사/x.md: [[...]] does not resolve`. Attempts count since the latest 재시도, so a just-retried memo has `failure: null`.
- `routing` is read from the raw or hold frontmatter. `null` while in the inbox.

**Cost.** One readdir per folder and one frontmatter read per memo per call. That is fine at personal scale (thousands of memos). Do not add an index file. If it gets slow, measure first.

## HTTP and wire types (`src/api.ts`)

```ts
export type MemoStateWire = 'inbox' | 'held' | 'routed' | 'running' | 'ingested' | 'failed';

export type MemoListItemWire = {
  id: string;
  text: string;                    // first 140 characters
  captured_at: string;
  tz: string;
  source: MemoSourceWire;
  domain: string | null;           // null while in the inbox
  state: MemoStateWire;
  verdict: string | null;          // ingested only
  first_page: string | null;
  finished_at: string | null;      // ingested or failed
};
export type MemoListResponse = { memos: MemoListItemWire[]; next_before: string | null };

export type MemoFailureWire = { attempts: number; max: number; code: string; detail: string };
export type MemoDetailWire = Omit<MemoListItemWire, 'text'> & {
  text: string;                    // full text
  place: string | null;
  routing: { by: 'hint' | 'classifier' | 'fallback' | 'user'; confidence: number | null; reason: string | null } | null;
  pages: { path: string; type: string | null; change: 'created' | 'modified' }[];
  failure: MemoFailureWire | null;
};
```

- `GET /memos?limit=<1..100, default 30>&before=<captured_at>` → `MemoListResponse`. `next_before` is the last item's `captured_at`, or `null` at the end. Ties on `captured_at` break by id, so the cursor is `captured_at` plus `|` plus id when a tie exists. Keep the cursor opaque to the app.
- `GET /memos/:id` → `MemoDetailWire`. 404 for an unknown id.
- The duplicate-POST reply (`MemoResponse`) uses the same `MemoStateWire`, so `held` and `running` appear there too.

## Verification

- Tests that each state row is derived correctly, including a moved memo, a retried memo, and a memo mid-run.
- Pagination: newest first, the cursor is stable across a new memo arriving, ties broken by id.
- Detail `pages` created vs modified, `failure.code` for a check failure and for an interrupted run.
- HTTP tests for the wire shapes and the 404.
