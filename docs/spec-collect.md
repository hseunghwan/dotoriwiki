# Spec: link enrichment and feed collector

Both slots were reserved by the base design (see "Fit for later work" in the gateway rationale). This adds them without reshaping `Wiki`.

## 1. Link enrichment

**When.** Inside `runNext` for an `ingest` job, before the LLM runs, for any memo in any domain whose text contains `http(s)://` URLs. At most 3 URLs per memo, in order of appearance.

**Output.** `<d>/raw/<id>.source.md`, written once (exists means skip, so a retry or crash recovery never refetches). It is a job input like `raw/<id>.md`: never modified afterwards, committed with the job, and survives rollback.

```markdown
---
memo: <id>
fetched_at: 2026-10-29T10:00:00+09:00
sources:
  - url: https://youtu.be/xxxx
    kind: video            # video | article
    status: ok             # ok | failed
    title: "..."
    detail: null           # failure reason when status is failed
---

## https://youtu.be/xxxx

<plain text: video = title, channel, duration, description, then subtitle text; article = readable main text>
```

**Fetchers** (one table keyed by `kind`, chosen by URL):

- `video`: YouTube URLs. `yt-dlp` (on PATH at `/opt/homebrew/bin`) with `--skip-download`, manual subs preferred over auto subs, languages `ko` then `en`, metadata via `--print`/`-J`. Convert VTT to plain text and drop the repeated rolling lines auto subs produce. No subs is not a failure: description and metadata alone are `ok`.
- `article`: everything else. `fetch` with a desktop UA, 15 s timeout, 5 MB cap, then `@mozilla/readability` over `linkedom` (new dependencies allowed for this). Non-HTML responses (PDF etc.) are `failed` with the content type as detail.
- Each source's text is capped at 30,000 characters with a visible truncation marker.

**Failures.** A fetch failure is recorded as `status: failed` with a reason and the job proceeds. Domain CLAUDE.md files already tell the model not to invent a summary when the source is missing. A whole-sidecar write failure (disk) fails the attempt like any other error.

**Prompt.** The ingest prompt names the sidecar path when it exists.

## 2. Feed collector

**Shape.** A `Feed` table (one entry per source: name, fetch, parse into items). A collector loop in `loops.ts` polls every 3 hours (first poll 1 minute after start) and calls `wiki.accept` for each item with `source: 'feed'` and `domain_hint: '개발소식지식베이스'`. No collector state: each poll looks at a recent window and relies on deterministic ids plus `accept` dedup.

**Id.** UUID-formatted SHA-1 of `<feed name>:<canonical item key>` (version nibble 5, variant bits set) so `parseMemoId` accepts it. Same item, same id, forever.

**captured_at.** The item's published time in `+09:00`. `tz: Asia/Seoul`. No location.

**Sources and default filters** (constants in one place, easy to change):

| Feed | Endpoint | Window | Filter | Cap per poll |
| --- | --- | --- | --- | --- |
| `geeknews` | `https://news.hada.io/rss/news` (Atom) | last 36 h | none | 15 |
| `hackernews` | Algolia `https://hn.algolia.com/api/v1/search_by_date?tags=story&numericFilters=points>=300,created_at_i>=<now-36h>` | last 36 h | points ≥ 300 | 10 |
| `ghsa` | `https://api.github.com/advisories?type=reviewed&severity=<critical,high>&per_page=50&sort=published&direction=desc` | last 36 h | severity critical or high | 15 |

**Memo text** (the model copies these into `article` frontmatter, so keep labels fixed):

```
[GeekNews] <title>
원문: <article url>
게시: <YYYY-MM-DD>
토론: <news.hada.io topic url>

<summary text from the feed, if any>
```

GHSA adds `CVE: <id>`, `심각도: <severity>`, `패키지: <ecosystem>/<name> <vulnerable range>`. HN adds `점수: <points>`. For HN and GeekNews the `원문` link is what enrichment fetches; for GHSA the advisory text in the memo is enough, so put the advisory URL on a `토론:` line and do not enrich it (enrichment skips URLs on `토론:` lines).

**Failure.** A feed that errors or times out is logged and skipped for that poll. It never blocks other feeds or the wiki.

## Verification

- Unit tests: VTT to text dedup, URL extraction and the `토론:` skip, sidecar render/parse, id determinism, each feed parser against a saved fixture response (save real responses fetched today under `test/fixtures/`), cap and window filtering.
- Crash test: kill after the sidecar is written and before the LLM runs; reopen; the sidecar is reused, not refetched, and the job completes once.
- E2E (`scripts/e2e-collect.ts`, against a copy of the wiki, real network and real `claude`): one YouTube link memo to 미루기, one article link memo, and one collector poll with caps lowered to 2 per feed. Show the sidecars, the resulting pages, and the commits.
