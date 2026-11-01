# init and doctor

`init` makes a new wiki and points this machine's gateway at it. `doctor` says whether the machine and the wiki are ready. Until P4 publishes the `dotoriwiki` command, run both from a checkout of this repo:

```sh
npm run dotoriwiki -- init ~/wiki --locale en
npm run dotoriwiki -- doctor
```

## init

```
init [dir] [--locale en|ko]
```

- `dir` defaults to the folder you ran the command in. It must be empty or not exist yet. `init` refuses a folder with anything in it.
- `--locale` picks the preset. Without it, `init` reads `LC_ALL`, then `LANG`: a value starting with `ko` gives the Korean preset, anything else the English one.

It does four things.

1. Copies `presets/<locale>` into `dir`. The English preset has the domains `journal`, `learning`, and `someday`. The Korean one has `일상`, `스터디`, and `미루기 아카이빙`. Rename or add domains later by editing `dotoriwiki.yaml` and the folders. The presets are also the wikis the gateway tests run on.
2. Sets `time_zone` in `dotoriwiki.yaml` to this machine's zone.
3. Runs `git init -b main` and commits everything except the domain folders as `init`. The commit uses your git identity, or the gateway's when you have none. The gateway commits each domain as `init(<domain>)`, with its `index.md`, the first time it opens the wiki.
4. Adds `WIKI_ROOT`, `PORT` (8787), `HOST` (127.0.0.1), and a random `GATEWAY_TOKEN` to the env file, `~/.config/dotoriwiki/gateway.env`, with mode 0600. A key the file already sets is kept. If it already names another `WIKI_ROOT`, `init` says so and leaves it, so the gateway keeps serving the old wiki until you change the line.

Set `DOTORIWIKI_ENV` to use another env file. It then prints the next steps: run `doctor`, log in to Claude Code once, start the gateway, and set `HOST` to the Tailscale address before pairing a phone.

## doctor

```
doctor
```

`doctor` reads the env file, merged over your environment the way the gateway's launcher reads it, and checks:

- Node is new enough to run TypeScript directly, and `git` runs.
- The env file exists, is not readable by others, and passes the gateway's own settings check. `HOST=127.0.0.1` is a warning, because a phone cannot reach it.
- `models.json`, if present, parses.
- `WIKI_ROOT` is a git work tree, `dotoriwiki.yaml` parses with every problem listed by key, each domain has its `CLAUDE.md`, and `_originals/` is gitignored.
- `claude --version` runs (`CLAUDE_BIN`). The login is not checked, because that would spend a request. `codex --version` is checked only when `models.json` uses codex.
- `yt-dlp` is a warning when missing: video links get no transcript.
- `/usr/bin/sips` is a warning when missing, as on Linux: a memo with photos cannot be saved there. Text memos work.

Whether a gateway is running on the wiki is shown as information. Each failed or warned check prints a one-line fix. `doctor` exits 1 when any check fails.

`doctor` is read-only. It takes no lock, writes nothing to the wiki, and commits nothing, so it is safe to run beside a running gateway.
