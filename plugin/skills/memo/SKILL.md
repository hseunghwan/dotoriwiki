---
name: memo
description: Save a memo to the LLM wiki with where you are working attached, like a memo typed on the phone. Runs only when the user invokes it.
disable-model-invocation: true
argument-hint: "[메모 내용]"
allowed-tools: mcp__plugin_dotoriwiki_dotoriwiki__write_memo, mcp__plugin_dotoriwiki_dotoriwiki__memo_status, Bash(git branch --show-current)
---

# /memo

The user wants `$ARGUMENTS` in their wiki. The `dotoriwiki` MCP server files it.

## Context

Build `context` before the call:

- `project`: the basename of the current working directory.
- `cwd`: the absolute current working directory.
- `branch`: the output of `git branch --show-current`. Use null when it fails or prints nothing.

## With arguments

1. Call `write_memo` with `text` set to the arguments exactly as typed, and `context`. Do not fix, translate, summarize, or add to the text. Pass `domain_hint` only when the user named a domain.
2. Call `memo_status` with the returned `id` and `wait_seconds: 30`.
3. Reply with one Korean line:
   - `ingested`: `<domain> › <first_page> 에 정리됨`.
   - `held`: `받음, <domain> 에서 확인 대기 중 (앱에서 확인)`.
   - `failed`: `받음, 정리 실패: <failure.detail>`.
   - anything else: `받음, 정리 대기 중`.

## Without arguments

Draft a short memo, one to three lines in Korean, of what the user learned or decided in this conversation. Show the draft and ask whether to send it. Send it as above only after the user confirms, with any edits they ask for.

## Not connected

If the `write_memo` tool is missing, reply in one line that the dotoriwiki MCP server is not connected: Tailscale must be on, and the token is set with `claude plugin configure dotoriwiki@dotoriwiki`.
