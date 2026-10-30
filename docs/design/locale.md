# Locale (P2): the ledger speaks the wiki's language

## Problem

The gateway writes two kinds of words, and today both are Korean literals spread over 12 files.

- Words that code reads back. The third field of every `log.md` line (`실패 1/3`, `중단 2/3`, `포기 3/3`, `재시도`, `이동 → <domain>`, and the verdicts), the feed memo lines `원문:` and `토론:`, and the ingest verdict enum that the model answers in.
- Words that only a person or a model reads. The prompt sections, `index.md`, `_review.md`, commit subjects, sidecar labels, the answer page, and feed memo labels.

So a stranger with `locale: en` gets a Korean ingest prompt, `포기 3/3` in their `log.md`, `# learning 색인` on their index page, and `새 페이지` in the app.

The first kind is a file format. The author's live wiki has months of ledger lines in one grammar. `git.appended()` attributes the n-th appended line of a job to its commit, so `finishedAt` and the ingest pages of every memo depend on old lines never being rewritten. The model's verdict goes into that same field and then onto the wire, where the app shows it verbatim.

Constraints, from the grounding:

- Old lines must fold exactly as before, mixed with new lines for the same job.
- `locale` decides how code writes, never how it reads. Changing `locale` must not break a wiki.
- A preset in one locale produces generated files in that locale only.
- No new dependency. Type stripping, no build step.
- An app one version behind must keep working.

Stance C answers one question differently from a plain token design. `log.md` is a file people open in Obsidian, so it stays in the wiki's language. The meaning of each line becomes language-free instead of its words.

## Usage

A stranger's English wiki, after one memo failed twice, gave up, was retried, and then filed:

```
# log
## [2026-10-29] ingest | 01JB90M2 | failed 1/3 | broken-link learning/wiki/RAG.md: [[RAG tuning]] does not resolve
## [2026-10-29] ingest | 01JB90M2 | interrupted 2/3 | gateway stopped mid-job
## [2026-10-29] ingest | 01JB90M2 | gave up 3/3 | frontmatter learning/wiki/RAG.md: summary missing
## [2026-10-30] ingest | 01JB90M2 | retry | -
## [2026-10-30] ingest | 01JB90M2 | new page | RAG.md, insights/2026.md
```

The same job in the author's Korean wiki, byte for byte what the gateway writes today:

```
# log
## [2026-10-29] ingest | 01JB8ZQ4 | 실패 1/3 | broken-link 스터디/wiki/RAG.md: [[RAG 튜닝]] does not resolve
## [2026-10-29] ingest | 01JB8ZQ4 | 중단 2/3 | gateway stopped mid-job
## [2026-10-29] ingest | 01JB8ZQ4 | 포기 3/3 | frontmatter 스터디/wiki/RAG.md: summary missing
## [2026-10-30] ingest | 01JB8ZQ4 | 재시도 | -
## [2026-10-30] ingest | 01JB8ZQ4 | 새 페이지 | RAG.md, 인사이트/2026.md
```

Both fold to one history, line indexes counted from 0 within the job:

| Line | Ko word | En word | Attempts after | Terminal after | Last failure after |
| --- | --- | --- | --- | --- | --- |
| 0 | `실패 1/3` | `failed 1/3` | 1 | none | failed 1/3 |
| 1 | `중단 2/3` | `interrupted 2/3` | 2 | none | interrupted 2/3 |
| 2 | `포기 3/3` | `gave up 3/3` | 2 | gave-up, line 2 | gave up 3/3 |
| 3 | `재시도` | `retry` | 0 | none | gave up 3/3 (kept) |
| 4 | `새 페이지` | `new page` | 0 | applied `created`, line 4 | gave up 3/3 |

`GET /memos` then reports `state: ingested`, `verdict: "new page"` (or `"새 페이지"`), `verdict_id: "created"`, and `first_page: "RAG"`. `finished_at` is the commit time of the fifth line `git.appended()` saw for `ingest:01JB…`, as today.

A wiki that switches `locale` from `ko` to `en` keeps its old lines and appends English ones. This history folds to applied `created` at line 4, with one attempt and the English failure as the last failure:

```
## [2026-10-29] ingest | A | 실패 1/3 | empty x.md: page has no body
## [2026-10-29] ingest | A | 포기 3/3 | empty x.md: page has no body
## [2026-11-02] ingest | A | retry | -
## [2026-11-02] ingest | A | failed 1/3 | broken-link x.md: [[y]] does not resolve
## [2026-11-02] ingest | A | new page | x.md
```

The rest of a stranger's English wiki:

```
# index.md
# learning index

The server builds this page from page frontmatter. Do not edit it.

## concept

- [[learning/wiki/RAG|RAG]] - Retrieval before generation

## Other

- [[learning/wiki/insights/2026|insights/2026]]

## Saved answers

- [[learning/wiki/answers/2026-10-30 What is RAG|answers/2026-10-30 What is RAG]] - What is RAG?
```

```
# _review.md
# To review

- [2026-10-29] ingest `01JB90M2` gave up 3/3: frontmatter learning/wiki/RAG.md: summary missing
```

```
# commit subjects
ingest(learning): 01JB90M2 failed 1/3
ingest(learning): 01JB90M2 interrupted 2/3
ingest(learning): 01JB90M2 gave up 3/3
```

```
# raw/<id>.source.md body for a video
Title: Intro to RAG
Channel: Some Channel
Length: 12:04
Published: 2026-10-01

Description:
…

Captions (en, automatic):
…

[… kept the first 30000 of 41200 characters]
```

```
# feed memo body
[Hacker News] Show HN: A wiki that files itself
Link: https://example.com/post
Published: 2026-10-29
Discussion: https://news.ycombinator.com/item?id=1
Points: 312
```

The ingest system prompt ends with the page-type table and these rules:

```
## Rules the server sets

- Today is 2026-10-30. Put it in `updated` on every page you create or change.
- Write only under `wiki/`. Do not change `raw/`, `CLAUDE.md`, or any other domain folder.
- The server writes `wiki/index.md` and `wiki/log.md`. Only read them.
- `wiki/answers/` holds saved chat answers. Do not build pages on them, and do not change them.
- Give every page frontmatter with `type`, `summary`, `aliases`, `status`, `sources`, `updated`. `type` is one of `concept`, `case`, `project`.
- Link with `[[…]]` only to wiki pages that exist or that you create in this run. Write memo ids as plain text in `sources` and in the body, not as links.
- Embed only the photos attached to the memo, as `![[file name]]`. When a page states something you saw in a photo, say that it comes from the photo.
- Do not create empty files or pages without a body.
- When you finish, return a structured answer: `verdict`, and `pages`, the paths under `wiki/` of the pages you created or changed. `verdict` is one of:
  - `created`: you made a new page
  - `updated`: you changed an existing page
  - `conflict`: the memo contradicts what a page says
  - `unchanged`: nothing in the memo is worth keeping
```

The classifier and the root chat get the domain catalog under `## Domains`, with the columns `Folder` and `What belongs here`. Every chat also gets `## Chat rules` (the text is in `sketch/text.en.ts`). The Korean rules are today's text, with one sentence and the same four-line verdict list added to the last rule. `sketch/text.test.ts` checks that.

## Shape

**Two kinds of words, two homes.** One rule decides where a word lives.

- A word that code reads back lives next to its parser and never changes. The ledger's words are `LEDGER_WORDS` in `src/wiki/ledger.ts`. The memo link labels are `MEMO_LINK_LABELS` in `src/wiki/sources.ts`.
- A sentence that nothing parses lives in `src/wiki/text.ko.ts` or `src/wiki/text.en.ts`, and anyone can reword it in any release.

Translation files are where people reword freely. A ledger word reworded there would change the meaning of every old line, so ledger words stay out of them.

### The ledger grammar

The line shape and `LINE` regex do not change, so `lineKey()` and `git.appended()` attribution do not change either.

```
line   = "## [" date "] " job " | " id " | " third " | " fourth
date   = YYYY-MM-DD in the wiki's time zone
job    = "ingest" | "file-answer" | "lint"        ASCII in every locale, as today
id     = \S+
fourth = pages joined by ", " | a reason | "-"
```

The third field, per locale:

| Meaning | `ko` writes | `en` writes |
| --- | --- | --- |
| attempt failed | `실패 k/N` | `failed k/N` |
| attempt interrupted | `중단 k/N` | `interrupted k/N` |
| gave up (terminal) | `포기 k/N` | `gave up k/N` |
| retry | `재시도` | `retry` |
| moved (terminal) | `이동 → <domain>` | `moved → <domain>` |
| applied `created` | `새 페이지` | `new page` |
| applied `updated` | `기존 페이지 수정` | `updated page` |
| applied `conflict` | `충돌` | `conflict` |
| applied `unchanged` | `정리할 거리 없음` | `nothing to file` |
| applied `saved` (file-answer) | `저장` | `saved` |

The Korean column is exactly what the gateway writes today. Both locales use the U+2192 arrow.

**One read table.** `readTable(Object.values(LEDGER_WORDS))` builds one map from every word of every locale to its meaning. `parseOutcome(third, fourth)` tries, in order:

1. An exact word. A retry word gives `retry`. A verdict word gives `applied` with that `VerdictId`.
2. `^(.+?) → (.+)$` whose first group is a move word. That gives `moved` with the rest as `to`.
3. `^(.+) (\d+)/(\d+)$` whose first group is an attempt word. That gives `attempt-failed` or `gave-up`. If the word is no locale's attempt word, the line is inert.
4. Anything else gives `applied` with `verdict: { unknown: third }`.

The table refuses to load when one word has two meanings across locales, and when a retry or verdict word is shaped like an attempt or a move. Every test that imports the ledger runs that check.

**Inert lines.** A `<word> k/N` whose word no locale has, such as `失敗 1/3` from a newer gateway, keeps its place in the job's line list and changes no state. It stays in the list because `lineCount()` and the n-th-line attribution count every `LINE` match. Today such a line would read as applied, which marks a memo ingested that never was. Inert is the safe direction, because the worst case is a re-run.

**Text the gateway never wrote stays applied.** A pre-gateway line such as `기존 내용과 충돌` reads as applied with `verdict: { unknown: '기존 내용과 충돌' }`, as today. Its wire `verdict` is that text and its `verdict_id` is null.

**Names that look like words.** Only the third field is matched, and the only free text in it is the domain of a move line. A domain cannot contain `|` or `/` (`domainNameProblem` in `config.ts`), so the third field always ends at the first ` | ` and can never contain ` k/N`. The move pattern matches before anything else that could see the name, so `moved → retry`, `이동 → 새 페이지`, and `moved → a → b` keep their names. Page names live in the fourth field and are never matched against words. A page named `실패 1/3.md` or `gave up 3|3.md` round-trips. The old limit stays. A page name containing `, ` splits wrongly, and only `pages[0]` is read, for display.

**Writing.** `renderThird(locale, outcome)` is the only function that turns an outcome into words. `renderLine` uses it for the ledger. `#commitFailure` and `#recoverInflight` use it for the commit subject and the `_review.md` note, which deletes the three `gaveUp ? '포기' : '실패'` ternaries in `index.ts`.

**Types.** One outcome shape with the verdict as a parameter:

```ts
export const VERDICTS = ['created', 'updated', 'conflict', 'unchanged', 'saved'] as const;
export type VerdictId = (typeof VERDICTS)[number];
export type Verdict = VerdictId | { readonly unknown: string };
export type LedgerOutcome = Outcome<Verdict>;   // what a committed line says
export type NewOutcome = Outcome<VerdictId>;    // what the gateway writes
```

The writer cannot write an unknown verdict, and every `NewOutcome` is a `LedgerOutcome`.

### Verdicts

`INGEST_VERDICTS` becomes `['created', 'updated', 'conflict', 'unchanged']`, and it is the JSON-schema enum for both providers. The model answers in ids in every locale. The localized ingest rules gloss each id in the wiki's language, so a Korean user's own common rules ("새 페이지 / 기존 페이지 수정 / 기존 내용과 충돌 / 정리할 거리 없음") still match what the model is told.

The adapters stay untrusted and keep returning `verdict: string`. `performIngest` parses it at the wiki boundary. An id passes. Anything else fails the attempt with rule `llm` and detail `verdict "<x>" is not one of created, updated, conflict, unchanged`. Both CLIs get the enum as a JSON schema, so I expect this to fire rarely (inferred, not measured). It keeps the ledger from writing a word it cannot read back. `performFileAnswer` returns `'saved'`.

The ledger writes the verdict's word in the wiki's locale (`새 페이지` or `new page`).

### The wire

`verdict` keeps its meaning. It is the display text, set for ingested memos only. It is now the current locale's word for the id, or the line's text when the id is unknown. A new optional field carries the id:

```ts
/** The ingest verdict as the wiki's locale words it. Ingested only. Old apps show this. */
verdict: string | null;
/** The same verdict as a token. Ingested only. null for a verdict from before the gateway. Absent from gateways before P2. */
verdict_id?: 'created' | 'updated' | 'conflict' | 'unchanged' | 'saved' | null;
```

`GET /memos`, `GET /memos/:id`, and MCP `memo_status` all gain `verdict_id`.

- The app today, against a Korean wiki, shows `새 페이지` exactly as now. Against an English wiki it shows `new page` inside Korean app chrome until P6.
- The P6 app words `verdict_id` in the phone's language and falls back to `verdict` when the id is null or absent.
- After a locale switch, old memos show the new locale's word, because the text comes from the id, not from the line.

### Templates

```
src/wiki/text.ts      type Text, textFor(locale). Re-exported by src/wiki/index.ts.
src/wiki/text.ko.ts   export const ko: Text
src/wiki/text.en.ts   export const en: Text
```

`Text` is one object type of strings and functions, with one entry per fragment. The entries are the catalog and page-type headings, the classifier context line, the photo line, the ingest rules and user prompt, the chat rules, both Codex wrappers, the `index.md` headings, the `_review.md` title, the answer page heading, the sidecar labels, and the feed labels nothing parses. It also holds the collation tag for sorting `index.md`, the `accept-language` header, and the caption language order. `sketch/text.ts` has the full type.

Templates are functions, not files with placeholders, because two of them loop (the photo lines and the verdict list) and English needs one plural (`one photo`, `2 photos`). A missing argument is a type error, not a runtime blank.

Callers take a `Text` or a `Locale`:

- Inside `src/wiki/`, a job reads `env.config.locale` once and passes `textFor(locale)` to `renderPageTypes`, `renderDomainCatalog`, `describePhoto`, `renderIndex`, `renderAnswerPage`, and `renderSourceFile`.
- `ClassifyRequest` and `EditRequest` gain `locale`, so `codex.ts` picks its wrapper. The Claude adapter ignores it.
- `ChatContext` gains `locale`, so `chat.ts` appends `chatRules`.
- `FetchSource` becomes `(url, locale)`, so `enrich.ts` writes sidecar labels and picks captions and `accept-language`.
- `renderFeedMemo` takes the locale for its labels.

**A missing translation is caught three ways.**

- `export const en: Text = { … }` fails `tsc` on a missing or extra key, and `npm test` runs `tsc --noEmit` first. `{ [L in Locale]: … }` on `TEXT`, `LEDGER_WORDS`, and `MEMO_LINK_LABELS` makes a new locale fail in all three places until it is complete.
- A Korean string pasted into `en.ts` as a placeholder passes `tsc`. `test/text.test.ts` renders every English template with sample arguments and fails on any Hangul.
- The English end-to-end test runs real jobs on `tempWiki('en')` and fails on Hangul in any file the gateway wrote or any commit subject.

### What an English wiki shows, and what stays Korean

Everything the gateway writes into an English wiki or sends to the model is English. That covers prompts, `log.md`, `index.md`, `_review.md`, commit subjects, the answer page, sidecars, and feed memos. The Usage section shows each one.

What stays Korean, and why:

- Text that came in from outside. The GeekNews feed is a Korean source, and a user's own memos and `CLAUDE.md` are in their language.
- Code, not output. The read table holds the Korean words, because every wiki must read every locale. An English wiki never writes them.
- The app UI, until P6.
- `scripts/pair.ts` console text. It is operator text, and P4 replaces it with `dotoriwiki pair`.
- `scripts/migrate-config.ts` reads the author's legacy Korean headings by design.
- `scripts/e2e.ts` and `scripts/confinement.ts` run against a copy of the author's wiki. P3 or P8 points them at the presets.
- Source comments with Korean example names. P2 rewrites the comments that name ledger words, such as the derived-state table at the top of `index.ts`.

Some text stays English in a Korean wiki, as today. It is the job names, the problem rule codes and their details in ledger reasons (`broken-link …: [[y]] does not resolve`), the `gateway stopped mid-job` sentinel, commit prefixes (`init`, `manual`, `retry`, `move`), the `# log` header, and frontmatter keys. Code compares the sentinel and the rule prefix, and the app words a failure by `failure.code`, so these stay fixed.

### The couplings in the Constraints

- **The live wiki's history.** The Korean words are the `ko` words, and the read table holds them. No line is rewritten, so there is no migration commit and `git.appended()` attribution is untouched. `scripts/ledger-audit.ts <wiki>` is a read-only check for P8. It folds every `log.md` at HEAD with a verbatim copy of the pre-P2 parser and with the new one, and prints every job whose history differs. The golden test runs it on `test/fixture/ledger/ko.md`.
- **Lines from before the gateway.** Free text stays applied. The only lines the new parser reads differently are a third field that is exactly an English word, or a `<word> k/N` whose word no locale has. The audit finds both.
- **`locale` decides writing, never reading.** One read table. The tests fold the same job rendered in `ko` and in `en` and assert the histories are equal, and fold a mixed history.
- **Changing `locale`.** Old ledger lines keep folding. `index.md` is regenerated whole, so it switches on the next job in that domain. `_review.md` keeps its old title, because it is append-only and humans write in it too, and new notes are in the new language. Existing sidecars and feed memos keep their labels, and the link labels of both locales are read. Prompts switch on the next request. The wire's `verdict` text switches at once, because it comes from the id.
- **Presets.** The English fixture's `_schema/common-rules.md` never names a ledger word, so the English preset writes English only. The Korean preset's `공통규칙.md` describes the Korean ledger grammar, and under C that paragraph stays true. P2 also adds the missing `이동 → <도메인>` to it.
- **No new dependency.** Plain TypeScript objects. `erasableSyntaxOnly` rules out `enum`, so ids are `as const` tuples.
- **The app one version behind.** `verdict` keeps its type and meaning. `verdict_id` is optional, following P1's precedent for `/status`.
- **`scripts/confinement.ts:57`.** The scope rule becomes its own template field, `Text['ingest']['writeScope']`, and `rules()` puts it on its own line. Confinement removes `textFor(config.locale).ingest.writeScope` from the system prompt and throws if it was not there. A rewording or a locale change can no longer turn the confinement check into a silent no-op. `test/text.test.ts` checks the line is present in every locale.

### What changes

New:

- `src/wiki/text.ts`, `src/wiki/text.ko.ts`, `src/wiki/text.en.ts`.
- `scripts/ledger-audit.ts`.
- `test/fixture/ledger/ko.md`, `test/fixture/ledger/en.md`. Each holds every word of its locale.
- `test/text.test.ts`.
- `docs/design/locale.md` (this design).

Changed:

- `src/wiki/ledger.ts`. `LEDGER_WORDS`, `readTable`, the parse order, inert lines, `renderThird`, `verdictText`, and `locale` on `renderLine` and `appendLine`. `VERDICTS`, `INGEST_VERDICTS`, `VerdictId`, `Verdict`, `NewOutcome`.
- `src/wiki/index.ts`. `performIngest` through `Text`, the verdict boundary, `'saved'` for file-answer, `classifierText`, `#commitLedger` writing with `env.config.locale` (its six callers already pass `env`), `#appendReview`'s title, commit subjects from `renderThird`, `MemoSummary.verdict` as `{ id, text }`, `RunReport.verdict` as `VerdictId`, `locale` on `ClassifyRequest`, `EditRequest`, `ChatContext`, and `FetchSource`, and re-exports of `textFor`, `Text`, `VerdictId`, and `MEMO_LINK_LABELS`.
- `src/wiki/config.ts`. `renderDomainCatalog` and `renderPageTypes` take their headings from `Text`.
- `src/wiki/pages.ts`. `renderIndex` and `renderAnswerPage` take `Text`. The sort uses `Text.collation`.
- `src/wiki/photos.ts`. `describePhoto(a, i, t)`.
- `src/wiki/sources.ts`. `MEMO_LINK_LABELS`, `linksToFetch` over both locales, and `renderSourceFile(f, t)`.
- `src/chat.ts`, `src/codex.ts`, `src/enrich.ts`, `src/feeds.ts`. Their Korean literals move to `Text`.
- `src/api.ts`, `src/wire.ts`, `src/mcp.ts`. `verdict_id`.
- `scripts/confinement.ts`. The scope line from `Text`.
- `test/fixture/wiki/_schema/공통규칙.md`. Adds `이동 → <도메인>` to the ledger paragraph.
- `docs/plan.md`, `docs/spec-memos.md`, `docs/spec-mcp.md`. The P2 row wording, and `verdict_id`.

### Test plan

Each item names the behavior it pins. The sketches of the first two run today (`sketch/ledger.test.ts`, `sketch/text.test.ts`).

1. `test/ledger.test.ts`, rewritten.
   - The Korean golden log folds to literal expected histories, and the pre-P2 parser agrees on every job.
   - The English golden log folds to the same histories, job for job.
   - One job rendered in `ko` and in `en` folds alike, and the `ko` rendering is what the pre-P2 gateway wrote.
   - A mixed history (Korean `포기`, then English `retry`, `failed`, `new page`) folds right.
   - Names that look like words round-trip: moves to `retry`, `gave up`, `새 페이지`, `이동`, `a → b`, and pages named `실패 1/3.md` and `retry.md`.
   - Free text stays applied with an unknown verdict. An unknown `<word> k/N` is inert and still counted by `lineCount`.
   - `readTable` refuses a word with two meanings across locales and a verdict shaped like an attempt.
   - The audit reports a pre-gateway `retry` line that the old parser read as applied.
2. `test/text.test.ts`, new.
   - No Hangul in any English template.
   - The Korean ingest rules equal today's text plus the verdict list.
   - The confinement scope line is in every locale's rules.
   - Feed memos written in either locale are fetched by their link line in any wiki, and a typed memo skips a `Discussion:` line.
3. `test/wiki.test.ts`, new English scenario on `tempWiki('en')`. Ingest a memo, fail it to gave-up, retry, file it, and move another. Assert the English `log.md` lines, `index.md`, `_review.md`, and commit subjects (`git log --format=%s`). Then sweep every file the gateway's commits touched and every subject for Hangul.
4. `test/wiki.test.ts`, locale switch. A Korean wiki gives up a job. The test rewrites `dotoriwiki.yaml` to `locale: en`, retries, and lets the job succeed. Assert that HEAD's `log.md` starts with the old Korean text unchanged, that `GET /memos/:id` has `verdict: "new page"` and `verdict_id: "created"`, and that `finished_at` is the new commit's time.
5. `test/wiki.test.ts`, off-enum verdict. A fake model returns `'새 페이지'`. The attempt fails with `failure.code: llm`, and no line with that word is written.
6. Mechanical updates. The fake edit in `test/helpers.ts` and the 29 fake returns move from `'새 페이지'` to `'created'`. `MemoSummary.verdict` assertions become `{ id, text }`. The Korean ledger assertions (about 13) keep their Korean words, because the Korean fixture still writes them. `http.test.ts` and `mcp.test.ts` add `verdict_id`. `photos.test.ts`, `sources.test.ts`, `feeds.test.ts`, `codex.test.ts`, and `config.test.ts` get an English case beside each Korean one. The two provider JSONL fixtures keep `새 페이지`, because they are recordings of real CLI output and the adapters pass any string through.
7. Before P8, run `scripts/ledger-audit.ts` on a copy of the live wiki. It must print no differing job.

## Tradeoffs accepted

- We accept that every ledger word in every locale is frozen once a release writes it, in exchange for a `log.md` each user reads in their own language. The golden fixtures fail if a word changes, and the words live beside the parser, not in the translation files.
- We accept that each new locale adds words that every wiki's parser reads, in exchange for state that never depends on which locale wrote a line. The read table refuses a word with two meanings.
- We accept that a gateway one version behind a locale addition cannot read that locale's lines. An unknown attempt word is inert, so the worst case is a re-run, not a memo marked ingested. An unknown retry word still reads as an unknown applied verdict. A retry line is only ever written after a terminal line, so the fold ignores it, and the old gateway keeps the job's earlier terminal state.
- We accept that a pre-gateway line whose third field is exactly an English word now means that word. The audit finds such lines before P8.
- We accept mixed-language files after a locale change. Old ledger lines, `_review.md`'s title, sidecars, and feed memos keep the old language, and `index.md` switches on the next job.
- We accept that anything outside the gateway that greps `log.md` (a Dataview query, a shell script) must know each locale's words.
- We accept that the wire `verdict` is in the wiki's language, not the phone's, until P6 reads `verdict_id`.
- We accept that a verdict outside the enum now fails the attempt, instead of being written as is.
- We accept that a `Discussion:` line in any memo, in any wiki, is not fetched, as `토론:` is today.
- We accept that problem details, the interrupted sentinel, job names, and commit prefixes stay English in a Korean wiki.

## Alternatives considered

- **One ASCII token grammar on disk for every locale.** This is the plan's P2 wording. A Korean wiki would start writing `fail 1/3` under months of `실패 1/3`. The parser must read `실패`, `포기`, `이동 →`, `재시도`, and the five Korean verdicts forever anyway, because the live history has to fold. So the token design carries a Korean alias table too. C makes that table symmetric and writes in the wiki's language. The token design also makes the ledger paragraph in the user-owned `공통규칙.md` wrong, and C keeps it true. Its real advantages are one grammar for outside tools and no table that grows with each locale.
- **Rewrite old lines to tokens in one migration commit.** Each rewritten line shows as a `+` line in `git log -p`, so `git.appended()` would attribute every old memo's `finishedAt` and ingest pages to the migration commit. Teaching `appended()` to skip that commit is a special case kept forever.
- **A token with a gloss on each line** (`fail 1/3 (실패)`). Two languages on every line, and it still needs the old reader.
- **Localized labels as the model's enum.** A Korean wiki would keep its enum, and its prompt would stay byte-identical. The schema would then depend on the locale at request time, and the boundary would need a reverse lookup per locale. Ids give one schema for every wiki and every provider fixture. This was a close call.
- **The wire `verdict` becomes the id.** An app one version behind would show `created` in a Korean UI. Rejected for the author's own phone.
- **Ledger words in the translation files.** One place for every word, but it is the place people reword. A reworded ledger word would turn old failure lines into inert lines, and without the inert rule into applied ones.
- **Templates as markdown files with placeholders.** Easier for a translator to read. A missing placeholder becomes a runtime blank, and the photo lines and the verdict list need loops.
- **An i18n library** (i18next, messageformat). A new dependency for two locales and one plural.

## Open questions

- Should problem details (`page has no body`) be localized? They reach the model on a retry and the app as `failure.detail`. This design says no, because the app words `failure.code`.
- Should P3's `init` write a localized line under `# log` telling Obsidian readers not to edit the file?
- Should a gave-up line carry "interrupted", so the equality check on `gateway stopped mid-job` can go? That is outside P2.
- Should English captions fall back to the video's spoken language? Today's Korean order is `ko`, then `en`. This design gives English `en` only.
- `docs/plan.md`'s P2 row says ledger keywords become fixed ASCII tokens. Under C it would read "the meaning of ledger lines and verdicts becomes fixed ids, and the words stay in the wiki's language".

## Synthesis decision

Three candidates were sketched from the same inventory:

- A wrote fixed ASCII words from now on and read the old Korean words forever.
- B kept one ASCII grammar, converted old lines in a migration commit, and changed `git.appended()` so a rewritten line keeps its original commit.
- C, this design, writes each wiki's own words and reads every locale's words through one table.

All three agreed on several points:

- Verdicts become ids in the model's schema, checked at the wiki boundary.
- Templates are typed `Text` objects per locale, with no dependency, so tsc catches a missing key.
- A no-Hangul test runs over English output.
- Confinement strips the scope line by value and throws if it is missing.

C is the base:

- A Korean wiki's `log.md` stays byte for byte what the gateway writes today. The pre-P2 gateway in `llmwiki-app` and this one can read the same wiki during P8 in either direction.
- The ledger paragraph in a user's own `공통규칙.md` stays true.
- Nothing is migrated.

A gives Korean users English words under months of Korean ones. Its runner checked that the pre-P2 parser reads `failed 1/3` and `gave-up 3/3` as applied, so a rollback during P8 would mark failed memos as ingested. B's runner showed against real git that rewriting old lines attributes old jobs to the migration commit. Its fix works, but it is new attribution logic, a version gate, and a required migration, all to avoid a word table that C needs anyway.

Kept from A and B: the wire `verdict` stays display text, with a new optional id field, as A and C both chose. B's variant would make an app one version behind show `new-page`. Rejected: B's report of unrecognized lines in `/status`, which stays an open question.

The runners did not see the picker's rubric. No cross-family judge ran, because only Claude models are available in this setup.

## Sketches

The candidate sketches stay outside the repo. In C's `sketch/`:

- `ledger.ts` is the full ledger module: word table, read table, parse, fold, render.
- `legacy-ledger.ts` is the pre-P2 parser, the audit's oracle.
- `ledger-audit.ts` is the read-only P8 check.
- `text.ts`, `text.ko.ts`, and `text.en.ts` are the template module, complete.
- `ingest.ts` is `performIngest` converted, with the verdict boundary, `describePhoto`, and `renderPageTypes`.
- `sources.ts` holds the memo link labels, `linksToFetch`, and `renderFeedMemo`.
- `callers.ts` holds `#commitLedger`, `#commitFailure`, `#appendReview`, the memo verdict, `renderIndex`, the answer page body, `ChatContext`, and the wire field.
- `ledger.test.ts` and `text.test.ts` run with `node --test ledger.test.ts text.test.ts` from `sketch/` (12 tests, passing). `tsc --noEmit -p .` there is clean. `node_modules` is a symlink to the repo's, for `yaml` and `@types/node`. `fixture-ledger/` holds the golden logs. `render-samples.ts` prints the English outputs shown in Usage.
