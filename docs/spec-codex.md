# Spec: choose Claude or Codex per role and domain

The user wants routing (classify) and 개발소식지식베이스 ingest on Codex. Everything else stays on Claude.

Since P1 (`docs/design/wiki-config.md`), an `edit` key other than `default` is a model profile. A domain picks one with `model_profile` in `dotoriwiki.yaml`, so a key named after a domain keeps working once that domain names it, and `EditRequest` carries the profile instead of the domain.

## Config: one file, parsed at startup

`~/.config/dotoriwiki/models.json`. Optional: when it is absent, the current Claude defaults apply.

```json
{
  "classify": { "provider": "codex", "model": "gpt-6-luna", "effort": "low" },
  "chat":     { "provider": "claude", "model": "sonnet" },
  "edit": {
    "default": { "provider": "claude", "model": "sonnet" },
    "개발소식지식베이스": { "provider": "codex", "model": "gpt-6.1-terra", "effort": "medium" }
  }
}
```

```ts
type ModelChoice =
  | { provider: 'claude'; model: string; effort?: Effort }
  | { provider: 'codex'; model: string; effort?: Effort };
```

- Parsed and validated once at the boundary (`main.ts`). An unknown provider, a malformed entry, or an `edit` key that names no domain fails startup with a clear message.
- The wiki keeps calling one `Llm` port. A small router implements it and picks the adapter per call. `edit` needs to know the domain, so `EditRequest` carries the `DomainName` rather than the router guessing it from `cwd`.
- `dotoriwiki install` never writes `models.json`.

## Codex adapter (`src/codex.ts`)

Spawn the real binary (`CODEX_BIN`, default the resolved `codex` path), never through a shell. The user's shell aliases `codex` to `codex --yolo`. Never pass `--yolo`, `--dangerously-bypass-approvals-and-sandbox` or `danger-full-access`.

Facts verified on this Mac (codex-cli 0.164.0, ChatGPT login):

- The user's `~/.codex/config.toml` sets `sandbox_mode = "danger-full-access"`, `approval_policy = "never"`, plugins and a notify hook. Every call passes `--ignore-user-config`, and login still works with it. Also check whether the global `~/.codex/AGENTS.md` still loads with that flag. If it does, find the supported way to keep it out of gateway runs, and verify it.
- `--output-schema <file>` plus `-o <file>` yields the final message as JSON matching the schema. A classify call with `gpt-6-luna`, low effort, read-only sandbox took 5.0 s and answered correctly.
- `-s workspace-write -C <dir>` blocked a write to `../escape.md` when `<dir>` was under `~`. It did not block it under `/tmp`, because `/tmp` is writable in that mode. Test fixtures that check confinement must therefore live under `~`, not `os.tmpdir()`.
- Codex writes files through shell commands. Its `--json` events do not name the files it wrote.

Calls:

- **classify.** `-s read-only --ephemeral --skip-git-repo-check`, cwd an empty dir, the root `CLAUDE.md` text plus the memo in the prompt, the same classify schema (domain enum built from the folder registry, confidence, reason).
- **edit.** `-s workspace-write -C <d>/wiki --ephemeral --skip-git-repo-check`. The composed domain prompt goes at the top of the prompt, because Codex has no system prompt flag. Reference input files by absolute path. Use the same edit schema (verdict, pages). The wiki root is a git repo, so verify that `-C <d>/wiki` inside a repo still confines writes to `<d>/wiki`: writes to `<d>/raw`, another domain and the wiki root must all fail. If they do not, stop and report rather than shipping.
- **Written paths.** Codex can't report them, so the adapter returns the changed and untracked files under `<d>/wiki` from `git status`. The sandbox guarantees nothing outside that folder.
- **Errors.** Rate limit, auth and spawn failures map to `Unavailable` (no attempt spent), as in the Claude adapter. Capture real error output to build the mapping where you can, and say which cases are guesses.
- Same timeout and stop-all-on-shutdown behaviour as the Claude adapter.

## Verification

- Unit tests: config parsing and its startup failures, per-call routing, the Codex argv for each call (asserting the forbidden flags never appear), and output parsing from recorded real Codex output.
- **Routing.** Run a set of labeled routing cases through the Codex classifier. Report accuracy and latency next to Haiku's 12/12 at about 3 s.
- **Ingest quality.** On a copy of the live wiki under `~`, reset the copy (only the copy) to just before the last three `ingest(개발소식지식베이스)` commits. Run a test gateway with this config and the feed collector off, let it re-ingest those three memos with Codex, then show each Codex page next to the live Claude page for the same memo. Report the time per ingest and whether the checks passed on the first attempt.
- **Confinement.** The `scripts/confinement.ts` scenario with Codex: an instruction to write outside `wiki/` fails and leaves nothing outside.
