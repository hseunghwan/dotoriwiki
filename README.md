<p align="center">
  <img src="docs/assets/logo.svg" width="112" height="112" alt="dotoriwiki">
</p>

<h1 align="center">dotoriwiki</h1>

<p align="center">
  <strong>Write it down in two seconds. Claude files it into your wiki.</strong>
</p>

<p align="center">
  A memo app for your phone and your coding agent. A gateway on your own computer reads each memo, files it into a Markdown wiki with Claude Code, and commits the change to git.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-7559dd" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A524.22-7559dd" alt="Node 24.22 or later">
  <img src="https://img.shields.io/badge/gateway-macOS%20%7C%20Linux-7559dd" alt="Gateway on macOS or Linux">
  <img src="https://img.shields.io/badge/app-Android-7559dd" alt="Android app">
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="docs/cli.md">Docs</a> ·
  <a href="README.ko.md">한국어</a>
</p>

---

## Why dotoriwiki

Notes pile up. A thought on the bus, a link a friend sent, a lesson from a bug at work. They land in a notes app, and nobody goes back to sort them, so you never find them again.

dotoriwiki does the sorting for you. You write one line and move on. Within a minute or two the memo is a page in the right part of your wiki, linked to what you already wrote, with a git commit you can read or undo. The wiki is plain Markdown on your own disk, so it stays yours after any app is gone.

Dotori is Korean for acorn. A squirrel buries acorns anywhere, digs them up in winter, and the ones it forgets grow into oaks.

## What you get

- **Capture first.** The Android app opens straight to the input box. A memo is saved on the phone before it is sent, so a bad connection loses nothing. Photos keep their EXIF, and links to videos get a transcript.
- **Filed for you.** A classifier picks the domain, such as `journal` or `learning`. When it is unsure, the memo waits for you to confirm it in the app. Then `claude -p` edits that domain's pages.
- **A record you can trust.** Each memo is one git commit, and each domain keeps a ledger in `wiki/log.md`. When you edit a page by hand, the gateway commits your edit first.
- **Plain files you own.** The wiki is a folder of Markdown pages and an Obsidian vault. The gateway never pushes it anywhere.
- **Private by default.** The gateway runs on your computer and answers only on your Tailscale address, with a token. There is no cloud service.
- **Your coding agent writes too.** The gateway serves MCP. In Claude Code, `/memo` saves a note with the project and branch it came from.
- **Your rules.** Domains, page types and the wiki's language live in `dotoriwiki.yaml`. A saved change applies without a restart. Wikis start in English or Korean.

## How it works

```mermaid
flowchart LR
  phone["Phone app"] --> gw
  agent["Coding agent<br/>(/memo, MCP)"] --> gw
  gw["Gateway<br/>on your computer"] --> classify["Pick the domain"]
  classify --> edit["claude -p edits<br/>the domain's pages"]
  edit --> wiki[("&lt;domain&gt;/wiki/*.md<br/>git commit")]
  wiki --> obsidian["Read in Obsidian<br/>or any editor"]
```

The gateway writes every memo to `inbox/` before it answers, so a memo survives a crash. Each domain has one worker, so two memos never edit the same domain at once, while different domains run in parallel. A failed edit is tried up to three times, and every attempt lands in the ledger.

## What you need

- A Mac or a Linux computer with systemd that stays on. The gateway runs there as a service of your user.
- Node 24.22 or later, installed so that `npm install -g` works without `sudo`: Homebrew on macOS, or a version manager such as nvm. If `npm install -g` fails with `EACCES`, follow npm's guide [Resolving EACCES permissions errors](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally).
- git.
- Claude Code, logged in once with `claude`. An Anthropic API key works instead, see [Costs](#costs).
- For the phone: an Android phone, and Tailscale on the phone and the computer, in the same tailnet. Without Tailscale the gateway answers only on the computer itself.
- Optional: `yt-dlp` gives video links a transcript. Photos need macOS, because the gateway shrinks them with `sips`. Text memos work on Linux.

## Quick start

These steps take about ten minutes. They make a wiki in `~/wiki`.

1. Install the `dotoriwiki` command.

   ```sh
   npm install -g dotoriwiki
   ```

   Until the first release is on npm, install it from a clone of this repository instead:

   ```sh
   git clone <repo> dotoriwiki
   cd dotoriwiki
   npm ci
   npm pack
   npm install -g ./dotoriwiki-*.tgz
   cd ..
   ```

2. Make the wiki.

   ```sh
   dotoriwiki init ~/wiki
   ```

   `init` copies a preset with three domains and commits it. The preset is Korean when `LANG` starts with `ko` and English otherwise. Pick one with `--locale en` or `--locale ko`. It also writes this computer's settings to `~/.config/dotoriwiki/gateway.env`, with a random token.

3. Check the computer.

   ```sh
   dotoriwiki doctor
   ```

   The last line is `Ready.` A `warn` line is not a failure. Each `fail` line prints its fix.

4. Run the gateway as a service. Start Tailscale first if you use the phone.

   ```sh
   dotoriwiki install
   ```

   The last lines say where the gateway answers, such as `http://100.101.102.103:8787`. The service starts again when you log in, and on Linux also at boot. Without Tailscale it answers at `http://127.0.0.1:8787`, and `install` says so.

5. Pair the phone. Install Tailscale on the phone and log in to the same tailnet. Download the APK from the latest release on this repository's Releases page and open it on the phone. Android asks you to allow installs from that app. Until the first release, build the APK as [docs/spec-app.md](docs/spec-app.md) says. Then show the QR and scan it from the app's first screen.

   ```sh
   dotoriwiki pair
   ```

6. Send a memo. Type it in the app and send it. To try it without the phone, send one from the computer with `curl`:

   ```sh
   . ~/.config/dotoriwiki/gateway.env
   node -e 'console.log(JSON.stringify({ id: crypto.randomUUID(), text: process.argv[1], captured_at: new Date().toISOString(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone, source: "typed" }))' \
     'Tried pgvector today. An HNSW index made the search much faster than a full scan.' |
     curl -sS "http://$HOST:$PORT/memos" -H "Authorization: Bearer $GATEWAY_TOKEN" -H 'Content-Type: application/json' --data-binary @-
   ```

   The gateway answers `{"id":"…","status":"accepted"}`. The memo is safe on disk from this point.

7. Watch it get filed. A memo takes a minute or two. The app's activity tab shows it, and so does the gateway's status:

   ```sh
   curl -sS "http://$HOST:$PORT/status" -H "Authorization: Bearer $GATEWAY_TOKEN"
   ```

   The memo is filed when `inbox` is `0` and every domain shows `pending` `0` and `running` `null`. A `held` of `1` means the gateway was unsure of the domain, and the memo waits for you to confirm it in the app. The domain's `wiki/log.md` gets one line for the memo, and git gets one commit:

   ```sh
   tail -n 1 ~/wiki/*/wiki/log.md
   git -C ~/wiki log --oneline -3
   ```

8. Open the wiki in Obsidian. Choose **Open folder as vault** and pick `~/wiki`. The new page is under the domain's `wiki/` folder.

## Send memos from a coding agent

The gateway also serves MCP at `/mcp`, with the same token. Its tools are `write_memo` and `memo_status`. A memo sent this way records the project, folder, and git branch it came from.

For Claude Code, install the plugin from this repository. It adds the MCP server and a `/memo` command.

```sh
claude plugin marketplace add <repo>
claude plugin install dotoriwiki@dotoriwiki
```

On the gateway's computer, `dotoriwiki pair --show-token` prints the address and the token. In Claude Code, run `/plugin configure dotoriwiki@dotoriwiki` and enter both. Then type `/memo <text>`.

Without the plugin, register the endpoint as a remote MCP server. In Claude Code:

```sh
claude mcp add --transport http dotoriwiki http://<address>:8787/mcp --header "Authorization: Bearer <token>"
```

## Where things live

| What | Where |
| --- | --- |
| The `dotoriwiki` command | npm's global folder (`npm root -g`) |
| Your wiki | The folder you gave `init`. It is a git repository and an Obsidian vault. |
| This computer's settings | `~/.config/dotoriwiki/gateway.env` (port, address, token, programs, billing), and an optional `models.json` |
| Chat history from the app | `~/.local/share/dotoriwiki/chats` |
| The gateway's log | `~/Library/Logs/dotoriwiki.log` on macOS, `journalctl --user -u dotoriwiki.service` on Linux |

Inside the wiki, each domain is a folder with a `CLAUDE.md` that tells the model what the domain is for. Memos land in `<domain>/raw/`, pages in `<domain>/wiki/`, and the gateway's ledger in `<domain>/wiki/log.md`. `dotoriwiki.yaml` at the root lists the domains and the wiki's settings.

## Change domains and settings

Edit `dotoriwiki.yaml` while the gateway runs. It reads the file on every request, so a saved change applies without a restart. To add a domain, make a folder with a `CLAUDE.md` that describes it, and add an entry under `domains`.

A mistake in the file pauses filing. The gateway still accepts memos and keeps them in `inbox/` until you fix the file. `GET /status` and `dotoriwiki doctor` list each problem with the key to fix.

Settings for the computer, such as the port or which account pays for Claude, are in `gateway.env`, not in the wiki. [docs/cli.md](docs/cli.md) lists every command and setting.

## What the gateway commits

The gateway commits to the wiki's git repository and never pushes. Each filed memo is one commit with the memo, the pages `claude -p` changed, and the `log.md` line. When you edit pages or `dotoriwiki.yaml` by hand, the gateway commits your edit as `manual(...)` before its next job in that domain. Push the repository yourself if you want a copy elsewhere.

## Privacy

- The gateway listens on one address: the computer's Tailscale address, or `127.0.0.1` without Tailscale. Every request needs the token. There is no pairing web page.
- Each memo's text goes to Claude through `claude -p`, under your Claude Code account or API key.
- The memo file records the location the phone sent with it. A photo's original, with its EXIF, stays in `_originals/`, which the wiki's `.gitignore` excludes. The 2048 px copy the gateway commits keeps the EXIF too, GPS included. Keep the repository private if you push it.
- The token and any API key stay in `gateway.env`, which only your user can read. They never go into the wiki.

## Costs

Each memo runs `claude -p` at least twice: once to pick the domain (Haiku by default) and once to edit the pages (Sonnet by default). A failed edit is tried again, up to three attempts. A question in the app's chat runs it once more per turn. By default these calls use the subscription Claude Code is logged in to, and count toward its usage limits. With `CLAUDE_BILLING=api` and `ANTHROPIC_API_KEY` in `gateway.env`, they bill the API key per token instead. [docs/cli.md](docs/cli.md#who-pays-for-claude) has the details, and `models.json` picks other models.

## More

- [docs/cli.md](docs/cli.md): every command, the env file, and the service.
- [docs/spec-app.md](docs/spec-app.md): the Android app and how to build it.
- [docs/spec-mcp.md](docs/spec-mcp.md): the MCP endpoint and `/memo`.
- [docs/design/wiki-config.md](docs/design/wiki-config.md): `dotoriwiki.yaml` and why it looks this way.
- [docs/plan.md](docs/plan.md): the plan from one person's setup to this release.
- [docs/from-llmwiki-app.md](docs/from-llmwiki-app.md), in Korean: what changed from llmwiki-app, the private setup this project grew out of.

## Status

dotoriwiki is version 0.1. It grew out of one person's daily setup, which has filed several hundred memos so far. The phone app is Android only, and photos need a Mac. Expect the settings file and the API to change before 1.0.

## Contributing

Issues and pull requests are welcome. Before you send one:

```sh
npm ci
npm test
npm run check:private
```

`npm test` type-checks the gateway and runs its tests. The app has its own tests in `app/` (`npm ci && npm test` there). `check:private` fails if a file matches your list of private patterns, so a home path or a real address never lands in a commit. The pattern list lives in `~/.config/dotoriwiki/private-patterns`, outside the repository.

## License

MIT. See [LICENSE](LICENSE).
