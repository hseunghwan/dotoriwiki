# The dotoriwiki command

```sh
npm install -g dotoriwiki
dotoriwiki init ~/wiki
dotoriwiki doctor
dotoriwiki install
dotoriwiki pair
```

`init` makes a new wiki and points this machine's gateway at it. `doctor` says whether the machine and the wiki are ready. `install` runs the gateway as a service of your user, and `pair` shows the QR the phone app scans. `uninstall` removes the service. `start` runs the gateway in the terminal, and it is what the service runs.

In a checkout of this repo, `npm run dotoriwiki -- <command>` runs the same command from `src/`, with no build.

## The env file

The machine's settings live in `~/.config/dotoriwiki/gateway.env`, or the file `DOTORIWIKI_ENV` names. It holds `KEY=value` lines and stays valid shell. `init` creates it with mode 0600, and `install` adds to it. Neither ever changes a value already there, with one exception: `install` replaces `HOST=127.0.0.1`. Edit the file by hand for anything else.

`start`, `doctor`, and `pair` read the file and put the environment over it, so a variable set in your shell wins. `PORT=9000 dotoriwiki start` runs once on port 9000 without editing the file. The service sets only `PATH`, `HOME`, and `DOTORIWIKI_ENV`, so it runs on the file alone.

### Who pays for Claude

`CLAUDE_BILLING` picks who pays for the `claude -p` calls.

- `subscription`, the default: claude uses the subscription you logged in to with `claude`. The gateway removes `ANTHROPIC_API_KEY` from claude's environment, so a key exported in your shell never switches billing to the API.
- `api`: claude bills the Anthropic API key in `ANTHROPIC_API_KEY`, and needs no login. Put both lines in the env file, because the service does not see your shell.

```sh
CLAUDE_BILLING=api
ANTHROPIC_API_KEY=sk-ant-...
```

The gateway reads `ANTHROPIC_API_KEY` only when `CLAUDE_BILLING=api`. `api` without a key is a settings error, so `start`, `doctor`, and `install` stop and say to add it. `install` copies the key nowhere: the service file names the env file and holds no key. Codex keeps its own login, and the gateway removes `CODEX_API_KEY` and `OPENAI_API_KEY` from codex's environment in either mode.

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

Set `DOTORIWIKI_ENV` to use another env file. It then prints the next steps: `doctor`, a Claude Code login, `install`, and `pair`.

## doctor

```
doctor
```

`doctor` reads the env file the way `start` does and checks:

- Node is at least the version `engines` in package.json names, and `git` runs.
- The env file exists, is not readable by others, and passes the gateway's own settings check. `HOST=127.0.0.1` is a warning, because a phone cannot reach it. When the file is missing and `~/.config/llmwiki/gateway.env` exists, from before the rename, a warning gives the commands that move the settings and the chats.
- `models.json`, if present, parses.
- `WIKI_ROOT` is a git work tree, `dotoriwiki.yaml` parses with every problem listed by key, each domain has its `CLAUDE.md`, and `_originals/` is gitignored.
- `claude --version` runs (`CLAUDE_BIN`), and which billing `CLAUDE_BILLING` picks is shown. Neither the login nor the API key is checked, because that would spend a request, and the key is never printed. `codex --version` is checked only when `models.json` uses codex.
- `yt-dlp` is a warning when missing: video links get no transcript.
- `/usr/bin/sips` is a warning when missing, as on Linux: a memo with photos cannot be saved there. Text memos work.

Whether a gateway is running on the wiki is shown as information. Each failed or warned check prints a one-line fix. `doctor` exits 1 when any check fails.

`doctor` is read-only. It takes no lock, writes nothing to the wiki, and commits nothing, so it is safe to run beside a running gateway.

## install

```
install
```

`install` runs the gateway as a service of the user who runs it, never as root: a launchd agent named `dotoriwiki.gateway` on macOS, a systemd user unit named `dotoriwiki.service` on Linux. It needs the env file `init` wrote. Each run does the same steps, so running it again after an upgrade or a change is safe.

1. Finds this machine's Tailscale IPv4 address with `tailscale ip -4`, from `tailscale` on `PATH` or, on macOS, the Tailscale app's own binary. It sets `HOST` to that address when the env file has no `HOST` or has `127.0.0.1`. Any other `HOST` is kept. A `HOST` set in your shell is used instead of the detected one, so `HOST=127.0.0.1 dotoriwiki install` keeps the gateway on this machine.
2. Adds `CLAUDE_BIN` and `CODEX_BIN` as absolute paths, when found on `PATH` and not set already.
3. Checks the result with the gateway's own settings check. A setting the gateway would refuse stops `install` before it writes anything.
4. Writes the service file. It runs `node <package>/dist/cli.js start` with the absolute path of the Node that ran `install`, and sets `PATH` to the folders of node, claude, codex, yt-dlp, and git, then the usual system folders. A gateway that exits is started again 15 s later.
   - macOS: `~/Library/LaunchAgents/dotoriwiki.gateway.plist`. The log is `~/Library/Logs/dotoriwiki.log`.
   - Linux: `~/.config/systemd/user/dotoriwiki.service`. The log is `journalctl --user -u dotoriwiki.service`.
5. Restarts the service: `launchctl bootout` and `bootstrap` in the `gui/<uid>` domain, or `systemctl --user daemon-reload`, `enable`, and `restart`. On Linux it turns on lingering with `loginctl enable-linger`, so the gateway runs while you are logged out and starts at boot. When that needs more rights, it prints the `sudo` command.
6. Waits up to 30 s for `GET /status` to answer at `HOST:PORT`, and exits 1 with the log's location when it does not.

On Linux, `systemctl --user` needs your user's session bus. Run `install` from an ssh login or a desktop terminal, not through `su` or `sudo -u`.

Rerun `install` after upgrading dotoriwiki or switching Node versions, because the service file names the paths of both.

## uninstall

```
uninstall
```

Stops the service, removes its file, and leaves the env file, `models.json`, the chats, and the wiki as they are.

## pair

```
pair [--show-token]
```

Prints the QR the Android app scans on its first screen. The QR holds the gateway's address and token, as `src/api.ts` `PairingPayload`. `pair` first tries the address with `GET /status`, the MagicDNS name before `HOST`, and puts only an address that answers in the QR. It exits 1 when none answers. `--show-token` also prints the token. There is no pairing web page, because the gateway listens on the Tailscale address and a page would put the token on it.

## start

```
start
```

Runs the gateway in this process until SIGTERM or SIGINT, on the env file's settings under the environment's. Without the env file it exits 1 and says to run `init`. The service runs this command, and `npm start` runs it in a checkout.

## Publishing

`npm pack` and `npm publish` run `prepack`, which compiles `src/` to `dist/` with `tsconfig.build.json`. Node does not strip types from files under `node_modules`, so the package ships JavaScript. Development runs the `.ts` files directly. `npm run check:pack` packs the checkout, installs the tarball into a temp prefix, and runs the installed `init` and `doctor` under a temp HOME.
