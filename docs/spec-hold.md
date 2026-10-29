# Spec: hold low-confidence memos until the user confirms

Requirement: `docs/design/요구사항-확인대기.md`. Memos the classifier is unsure about stop before ingest. The user confirms or moves them from the app. Ingested memos are never moved, because undoing a wiki edit that later edits built on is not safe.

## State: a folder, not a flag

Held memos live in their own folder, so "the folder is the queue" stays literal and `raw/` stays write-once.

| Path | Meaning | Written by |
| --- | --- | --- |
| `<d>/hold/<id>.md` | routed to `d`, waiting for the user | `routeNext`, when held |
| `<d>/raw/<id>.md` | routed, queued for ingest | `routeNext` (not held), `confirm`, `move` |

- `routeNext` writes to `hold/` instead of `raw/` when `routing.by` is `fallback`, or `classifier` with `confidence < reviewBelowConfidence`. `hint` and `user` never hold. The file content is identical to what `raw/` would have received.
- `#pick` is unchanged: it scans only `raw/`, so held memos are never picked.
- `hold/` files are untracked, like pending `raw/` files. Manual commits must not pick them up (same rule as the router's tmp files and pending raw files). Add `hold/` handling wherever "id exists anywhere" is checked: `accept` dedup, `routeNext` step 1, `MemoState` derivation.
- The `_review.md` "라우팅 확인" note in `#commitJob` is removed. Held memos are confirmed in the app instead, and hint/user memos never needed it.
- Enrichment runs at ingest, so held memos have no sidecar. Gave-up memos may have one.

## Routing gains a user variant

```ts
type Routing =
  | { by: 'hint' }
  | { by: 'classifier'; confidence: number; reason: string }
  | { by: 'fallback'; reason: string }
  | { by: 'user'; from: DomainName; previous: Routing };   // set by move
```

Written into the new `raw/<id>.md` frontmatter by `move`. `confirm` keeps the file byte-identical (a rename).

## Operations on `Wiki`

```ts
held(): Promise<readonly HeldMemo[]>;                       // all domains, oldest captured first
confirm(id: MemoId): Promise<ReleaseResult>;
move(id: MemoId, to: DomainName): Promise<ReleaseResult>;

type HeldMemo = { id: MemoId; domain: DomainName; text: string; capturedAt: string; source: MemoSource; routing: Routing };
type ReleaseResult =
  | { kind: 'released'; domain: DomainName }
  | { kind: 'not-found' }
  | { kind: 'conflict'; state: 'routed' | 'running' | 'ingested' | 'failed' | 'held'; domain: DomainName };
```

- **confirm.** Only a held memo. Rename `<d>/hold/<id>.md` → `<d>/raw/<id>.md` (link then unlink, same crash rule as `routeNext`: if both exist, the hold copy is the leftover).
- **move**, from a held memo. Write `<to>/raw/<id>.md` with `routing: { by: 'user', from, previous }` via tmp + link, then unlink `<from>/hold/<id>.md`. If both exist after a crash, the raw copy wins and the hold copy is removed on the next scan.
- **move**, from a gave-up memo (`포기` is its latest terminal line in `L(from)`). Its raw and sidecar are tracked in git. Inside `from`'s lane (the same busy guard and git mutex as `runNext`, so it cannot interleave with a job): `git rm` `<from>/raw/<id>.md` and `<id>.source.md`, append the ledger line `이동 → <to>` for `ingest:<id>`, commit `move(<from>→<to>): <id>`. Then write `<to>/raw/<id>.md` (new routing) and `<to>/raw/<id>.source.md` (same bytes, so enrichment is skipped). `이동` is a new terminal ledger outcome. `failedCount` must not count a memo whose latest terminal line is `이동`.
- **Conflicts.** `routed` (queued, not held), `running` (inflight marker names it), `ingested`, or a move to the domain it is already in → `conflict`. A gave-up memo is not confirmable; `/jobs/retry` already covers retrying in place.
- Crash safety for all three: add kill points to the crash test (after link before unlink; for the gave-up move, after the commit before writing the target raw). Reopen and assert the memo exists in exactly one place and is queued or held, never lost and never ingested twice.

## HTTP and wire types (`src/api.ts`)

```ts
export type HeldMemoWire = {
  id: string; domain: string; text: string;           // text: first 280 characters
  captured_at: string; source: MemoSourceWire;
  confidence: number | null;                          // null for fallback
  reason: string;
};
export type HeldResponse = { held: HeldMemoWire[] };
export type MoveRequest = { domain: string };
export type ReleaseResponse = { id: string; status: 'released'; domain: string };
```

- `GET /held` → `HeldResponse`.
- `POST /memos/:id/confirm` → 200 `ReleaseResponse`.
- `POST /memos/:id/move` with `MoveRequest` → 200 `ReleaseResponse`.
- Errors: unknown id 404 `not_found`; wrong state 409 `conflict` with `detail` naming the state; unknown domain 400 `bad_request`. Bad id format is 400 as elsewhere.
- `StatusResponse.domains[d]` gains `held: number` for the app badge.
- `MemoStateWire` gains `'held'`, so a duplicate POST of a held memo reports it.

## Verification

- Unit and HTTP tests for every row above, including each 404/409/400.
- Crash tests for the new kill points.
- A test that a low-confidence classification lands in `hold/`, is not ingested by `runNext`, and is ingested after `confirm`.
- Against a copy of the live wiki with a fake LLM, and with real `claude` if cheap: one held memo confirmed, one moved, one gave-up memo moved.
