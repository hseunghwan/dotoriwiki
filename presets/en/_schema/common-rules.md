# Rules for every domain

## Folders

- `raw/` holds the memos, one file each. Never edit or delete them.
- `raw/<id>.source.md` holds the article or transcript a memo links to. Never edit it either.
- `wiki/` holds the pages you keep.
- `wiki/answers/` holds saved chat answers. Do not build on them.
- `wiki/index.md` and `wiki/log.md` are written by the server. Read them only.
- `wiki/_review.md` collects judgment calls for me to look at later.

## Page frontmatter

```yaml
type: <one of this domain's page types>
summary: One line. It goes into index.md as is
aliases: [other names]
status: active | outdated | disputed
sources: [memo ids]
updated: 2026-10-29
```

## How to work a memo

1. Read the memo and its `.source.md`.
2. Decide first: a new page, a change to an existing page, a conflict, or nothing to keep.
3. Before making a page, look for the same subject in `index.md` and every page's `aliases`. Change that page if it exists.
4. Rewrite a fact that changed instead of appending to it.
5. Put conflicts and unsure calls in `_review.md`, and mark the page `status: disputed`.
6. Do not invent facts. Every claim names the memo ids it comes from.

## Links

- Link pages with `[[Page name]]`. Do not link to a page that does not exist.
- A page in another domain is `[[domain/wiki/Page name]]`.
