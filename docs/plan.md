# Generalization plan

dotoriwiki started as one person's setup: an Android app sends memos to a gateway on a Mac mini, the gateway routes each memo to a domain folder, and `claude -p` keeps a wiki in each folder. This plan turns that setup into something a stranger can install with their own domains, machine, and LLM account.

## Done when

1. `dotoriwiki init` creates a working wiki from an English or Korean preset, and the user does not have to edit any file to start. `dotoriwiki doctor` passes on macOS and Linux.
2. The gateway starts on that wiki with domain names the user chose, routes a memo sent over HTTP or MCP, ingests it, and commits. The unit tests check this with a fake LLM, and `scripts/e2e.ts` checks it against a real `claude -p`.
3. The Android app builds from this repo under its own package id, pairs by QR, sends a memo, and shows English or Korean by device locale.
4. `npm run check:private -- --history` is clean.
5. The author's live wiki can be described by a dotoriwiki config without losing its log history.

## Phases

Each phase ends in a check. A later phase starts only after the earlier one passes.

| Phase | Change | Check |
| --- | --- | --- |
| P0 | Import a clean snapshot. Personal strings and third-party fixtures removed, MIT license. | Gateway tests 96/96, app tests 95/95, `check:private` clean |
| P1 | One config file in the wiki root holds the domain list, the fallback domain, which domains other agents may read, feed targets, time zone, and locale. The gateway stops reading Korean headings to find them and drops the hardcoded `일상`, `개발소식지식베이스`, and `Asia/Seoul`. | A wiki with English domain names and no `일상` folder starts and ingests |
| P2 | State the code parses back (ledger keywords, ingest verdicts) becomes fixed ASCII tokens. Prompts and display strings move to ko and en templates. | Ledger round-trip tests in both locales |
| P3 | `dotoriwiki init` and `dotoriwiki doctor`, with presets. The presets are also the test fixtures. | A fresh preset passes `doctor` and the gateway tests |
| P4 | Publish to npm with a `dotoriwiki` command. Development keeps running `.ts` directly, and only publishing compiles `src/` to `dist/` with `rewriteRelativeImportExtensions`, because Node does not strip types under `node_modules`. Install on launchd and systemd, find Tailscale through its CLI, merge the env file instead of overwriting it, rename `llmwiki` and `com.cycle` identifiers. | `npm install -g` from a packed tarball, then install, pair, and restart on macOS and a Linux VM |
| P5 | API-key billing as an opt-in next to the subscription login. | `claude.ts` tests for both modes |
| P6 | App: package id and name from config, ko and en strings, wire types that build without the server tree, release APK from CI. | App tests, a release build, an emulator run in English |
| P7 | README in English and Korean with a ten-minute quick start. | A walkthrough on a clean user account |
| P8 | The author's live setup runs on dotoriwiki. | The live wiki starts with its history intact |

P1 and P2 fix the on-disk format other people's wikis will depend on, so they get a design review before code. The rest are reversible.

## Source

Imported from the author's private `llmwiki-app` at `166f90e`. Changes made there are ported by hand until P8 joins the two. Ported through `5d47cf7`.
