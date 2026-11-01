# Wiki configuration (P1)

## Problem

The gateway finds its configuration in six places that do not know about each other:

- The domain list is the set of folders that hold a `CLAUDE.md`, and again the `## 도메인 목록` table in the root `CLAUDE.md`. Only startup compares the two.
- Page types are a `## 페이지 종류` table in each domain's `CLAUDE.md`.
- Required page fields are a yaml block under a Korean heading in `_schema/공통규칙.md`.
- The fallback domain (`'일상'`), the feed target (`'개발소식지식베이스'`), and the time zone (`'Asia/Seoul'`) are literals in `main.ts`, `feeds.ts`, and `mcp.ts`.
- Per-domain models are keys of a machine-level `models.json`, and each key must name a folder.

So a stranger with English domain names fails at startup with `fallbackDomain 일상 is not a domain`. A stranger with no `개발소식지식베이스` folder gets about 40 feed memos every three hours classified into their own domains.

Constraints:

- The wiki is a git repo and an Obsidian vault edited by hand while the gateway runs.
- Machine values (token, port, programs, which LLM account) are never committed to the wiki.
- `CLAUDE.md` stays free prose in any language.
- The author's live wiki migrates once and keeps its history.
- The test fixture becomes the `init` preset in P3.

## Usage

A stranger's wiki after `dotoriwiki init --preset en`:

```yaml
# dotoriwiki.yaml, committed with the wiki
version: 1
locale: en
time_zone: America/Chicago
fallback_domain: journal
domains:
  journal:
    description: My days, the people in them, and what I make of it all
    page_types:
      person:
        description: One person. What they like, what we did, what they told me
        example: people/Sam.md
  learning:
    description: What I learned by doing it myself, at work or on my own
    agents_may_read: true
    model_profile: strong
    page_types:
      concept:
        description: One idea. What I understood, what I tried, what confused me
        example: RAG.md
feeds:
  hackernews: { domain: learning }
```

```jsonc
// ~/.config/dotoriwiki/models.json, on the machine, never committed
{ "classify": { "provider": "claude", "model": "haiku", "effort": "low" },
  "edit": { "default": { "provider": "claude", "model": "sonnet" },
            "strong":  { "provider": "claude", "model": "opus" } } }
```

To add a domain, write `recipes/CLAUDE.md` in prose and add a `recipes` entry under `domains`. The running gateway picks it up on the next request. A mistake in the file pauses routing and ingest. Memos sent in the meantime wait in `inbox/`, and `GET /status` and the log list each problem with its file, key, and fix.

## Shape

**One file, one parse.** `src/wiki/config.ts` holds `parseWikiConfig(text, known)`. It is pure and the only code that knows the format. It returns either a `WikiConfig` or every problem it found, each with a key and a fix.

```ts
type WikiConfig = {
  locale: 'ko' | 'en';
  timeZone: TimeZone;                                  // branded, checked with Intl
  domains: ReadonlyMap<DomainName, DomainConfig>;      // written order, at least one
  fallbackDomain: DomainName;                          // a key of domains
  feeds: ReadonlyMap<FeedName, { domain: DomainName }>;
};
type DomainConfig = {
  name: DomainName;
  description: string;
  agentsMayRead: boolean;
  modelProfile: ModelProfile | null;                   // a key of the machine's models.json edit map
  pageTypes: readonly [PageTypeSpec, ...PageTypeSpec[]];
};
```

The file is YAML because `init` writes comments into it and `yaml` is already a dependency. Keys are ASCII and values can be in any language. The parser reads through yaml's `parseDocument`, because plain `parse` moves an integer-like key such as `2026` to the front.

**Domains are declared.** A folder is a domain only when the file names it, and a declared domain must have `<d>/CLAUDE.md`. The folder scan, the table check, and `listDomainDirs` are deleted. A domain name may not start with `_` or `.`, may not be `inbox` or `root`, and may not hold characters that break a file name or a `[[link]]`.

**CLAUDE.md is prose only.** The gateway renders the domain catalog (names and descriptions) into the classifier prompt and the page-type table into the ingest and chat prompts. Nothing parses a `CLAUDE.md`. The `@` import line still works, so the common-rules file can have any name.

**Required page fields are code.** The six fields (`type`, `summary`, `aliases`, `status`, `sources`, `updated`) become `PAGE_FIELDS` in `pages.ts`. The server writes all six on its own answer pages and builds `index.md` from `type` and `summary`, so making them configurable could only break the server's own pages.

**Model choice is split at the machine line.** A domain names a profile. The machine's `models.json` maps profile names to providers and models, keeps its current shape, and never names a domain. An unknown profile is a problem in `/status` and the domain runs on `edit.default`.

**The same rule at startup and at runtime.** `Wiki.config()` replaces `domains()` and `parseDomain()`. It reads the file on every call and re-parses only when the text changed. A broken file pauses routing, ingest, and chat. `accept()` writes to `inbox/` before it reads the config, so no memo is lost. `openWiki` throws only for faults that are not configuration: the root is not git, the lock is held, `dotoriwiki.yaml` is missing, or its `version` is unknown. A wiki whose file is broken at startup starts paused, so a launchd gateway does not crash-loop with HTTP down. `dotoriwiki doctor` (P3) is the strict check that exits nonzero. A domain added while running gets the same `init(<d>)` commit on its first job.

**What changes.** New `src/wiki/config.ts`. Changed `src/wiki/index.ts`, `layout.ts`, `pages.ts`, `src/models.ts`, `feeds.ts`, `mcp.ts`, `chat.ts`, `http.ts`, `loops.ts`, and `main.ts`. The fixture gains `dotoriwiki.yaml` and loses its tables. A new English fixture holds the P1 check. `scripts/migrate-config.ts` converts the live wiki once.

## Synthesis decision

Three candidates were sketched:

- A put everything in one root file.
- B put the facts in the frontmatter of each `CLAUDE.md`.
- C gave each domain folder its own `domain.yaml`.

All three agreed on several points:

- Page types move out of prose.
- The required page fields become code.
- The gateway renders the catalog into prompts.
- Feeds and the time zone become explicit settings.
- Startup and runtime follow one rule.
- The migration is one commit with no folder renamed.

A is the base. It has one place to read and edit every setting, the simplest states (the config is valid, or the wiki is paused), and prose files that no parser reads. B put machine facts inside the prompt file, where a prose edit can break them. C spreads settings over one file per domain and adds partial states (a per-domain block, a stand-in fallback) that every reader must handle.

Grafted from B and C:

- **Model profiles.** A committed provider and model choices into the wiki, against the constraint that the LLM account stays on the machine. B and C both named a profile from the wiki and resolved it in the machine's `models.json`.
- **Start paused instead of refusing.** A threw at startup on a broken file. B and C showed that under launchd that is a crash loop with HTTP down, and that it gives the same edit two behaviors depending on when it was saved.

Rejected:

- **"No file outside a domain names it"** (B and C). A rename costs one more edit in A, and the parser reports a stale name at once.
- **C's stand-in fallback.** A missing fallback is a parse problem, not a routing state.

No cross-family judge ran, because only Claude models are available in this setup. Candidates A and C reported reading the picker's rubric partway through, so the pick weighed their own claims against the rubric less and their examples and sketches more.

## Tradeoffs accepted

- We accept that renaming a domain means renaming its folder and its key in `dotoriwiki.yaml`, in exchange for one file that shows every setting. The parser names a stale reference immediately.
- We accept that one broken file pauses the whole wiki, in exchange for no partial states and no last-good copy that hides a typo.
- We accept that `dotoriwiki.yaml` does not show in Obsidian's file list by default, in exchange for a format that needs no markdown conventions.
- We accept that the core page fields are fixed.
- We accept that the rendered prompt sections keep Korean headings until P2 localizes every prompt at once.

## Alternatives considered

- **Folders discover domains and the file only annotates them.** The file-versus-folders check survives, so the user still keeps two lists in sync.
- **A last-good reload.** The phone never shows the typo, the change silently does not apply, and the next restart fails anyway.
- **JSON** has no comments for `init` to explain the keys. **TOML** needs a new dependency.

## Open questions

- What reads `agents_may_read` first: MCP read tools limited to those domains, or a generated agent skill that replaces the hand-written one? P1 only parses it and shows it in `/status`.

Settled: the gateway commits hand edits of `dotoriwiki.yaml` itself, as `manual(config)`, at open and before each job, the same way it commits manual edits inside a domain folder.

## Implementation notes

Choices made while building P1 that the sections above leave open or that differ from them:

- `parseWikiConfig(text, machine)` takes the machine's model profile names. An unknown `model_profile` is a warning, not a problem: the config stays usable, the domain's `modelProfile` is null, and the warning shows in `/status` with its key and fix. Every other problem pauses the wiki.
- `Wiki.domains()` and `Wiki.parseDomain()` are gone. Callers read `Wiki.config()` and look a name up with `domainIn(config, name)`. `EditRequest.domain` became `EditRequest.modelProfile`, so `routeLlm` needs no domain at all.
- Paused, `routeNext` returns `{ kind: 'paused', problems }` and `runNext` returns `{ kind: 'paused' }` instead of throwing. The router logs a set of problems once, not on every rescan. An edit of `dotoriwiki.yaml` wakes the router and every worker. Calls that need the domain list (`memos`, `held`, `confirm`, `move`, `retry`, answers, chat) throw `WikiConfigError`, which HTTP answers with 503 and the new error code `paused`.
- `GET /status` gains `config: { state: 'ok' | 'paused', problems: [{ key, problem, fix }] }` and, per domain, `agents_may_read` and `model_profile`. The fields are optional in `api.ts`, because the app may still talk to a gateway that predates them.
- `openWiki` also refuses a file with no `version`, as an unknown version. A missing root `CLAUDE.md` or `<d>/CLAUDE.md` pauses with its own problem.
- `models.json` keeps its shape. Each role or `edit.default` it leaves out runs on the Claude default, as before, so a machine file written for llmwiki-app (profiles only, no `edit.default`) loads unchanged.
- MCP `write_memo` keeps accepting while paused: the domain hint is checked once the wiki resumes, and the memo is stamped in the machine's time zone.
- `pollFeeds` polls only the feeds the config names. `COLLECT_FEEDS=off` still turns the collector off for the process.
- `scripts/migrate-config.ts` replaces each legacy table with a line pointing at `dotoriwiki.yaml` and keeps the prose around it. A section left with nothing else loses its heading. A `models.json` `edit` key that names a domain becomes that domain's `model_profile`, so the machine file works unchanged. `test/fixture/legacy-wiki/` holds the pre-P1 `CLAUDE.md` files, and a test checks that migrating them yields the current fixture byte for byte.
- `scripts/e2e.ts` and `scripts/confinement.ts` still name the author's Korean domains, because they run against a copy of the live wiki. P3 or P8 should point them at the presets.

## Next step

Write `parseWikiConfig` with table tests over the English example, the fixture, and broken variants. Then move `openWiki` onto it and delete the three table parsers in the same change.

The candidate sketches stay outside the repo, because the live-wiki examples hold personal content.
