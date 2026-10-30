# My wiki

One person's file-based wiki. Each folder named under `domains` in `dotoriwiki.yaml` is one domain with its own `CLAUDE.md`. Rules every domain follows are in `_schema/common-rules.md`.

You read this file for two jobs.

- Routing one memo. Pick the domain it belongs to.
- A question that spans domains. Read each domain's `wiki/index.md` first and open only the pages you need.

## How to route

Go in order and stop at the first match.

1. Feelings, the day, people, plans with friends, thoughts about myself: `journal`.
2. Something to do, watch, or read later, or a bare link with no comment: `someday`.
3. Something I tried and learned, at work or on my own, even if it is technical: `learning`.
4. Nothing fits for sure: `journal`, with low confidence.
