/**
 * The MCP endpoint at POST /mcp: two tools for coding agents, served stateless (a fresh server
 * and transport per request) behind http.ts's token check. write_memo goes through the same
 * acceptMemo as POST /memos, so there is one way to write a memo.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { MemoDetailWire, MemoStateWire } from './api.ts';
import { isoWithOffset, parseMemoId, type DomainName, type Wiki } from './wiki/index.ts';
import { acceptMemo, detailWire } from './wire.ts';

export type McpDeps = { readonly wiki: Wiki; readonly now: () => Date; readonly serverVersion: string };

const TZ = 'Asia/Seoul';
const MAX_WAIT_SECONDS = 30;

export type MemoStatus = Pick<MemoDetailWire, 'id' | 'state' | 'domain' | 'verdict' | 'first_page' | 'failure'>;

function tools(domains: readonly DomainName[]): Tool[] {
  return [
    {
      name: 'write_memo',
      description: [
        "Saves a memo to the user's LLM wiki, the same way a memo typed on their phone is saved. The server files it into a domain and writes it into the wiki in the background.",
        "Pass the user's text verbatim: do not summarize, translate, or add to it.",
        'Fill `context` from where you are working: `project` is the basename of the current working directory, `cwd` its absolute path, `branch` the output of `git branch --show-current` (null outside a git repository or on a detached HEAD).',
        `Set \`domain_hint\` only when the user names the domain. It must be one of: ${domains.join(', ')}. Otherwise leave it out and the server classifies the memo.`,
        'Returns { id, status }. Pass the id to memo_status to see where the memo landed.',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: "The user's memo, verbatim." },
          domain_hint: { type: 'string', enum: [...domains], description: 'Only when the user named the domain.' },
          context: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Basename of the current working directory.' },
              cwd: { type: 'string', description: 'Absolute path of the current working directory.' },
              branch: { type: ['string', 'null'], description: '`git branch --show-current`, or null.' },
            },
            required: ['project', 'cwd', 'branch'],
          },
        },
        required: ['text'],
      },
    },
    {
      name: 'memo_status',
      description: [
        'Where a memo written with write_memo is now. `state` is one of:',
        'inbox: not classified yet. held: the classifier was unsure, and the memo waits in `domain` for the user to confirm it in the phone app.',
        'routed or running: queued in `domain`, or being written into its wiki now. ingested: done; `first_page` is the wiki page it went into, under `domain`.',
        'failed: the wiki edit gave up; `failure` says why.',
        `\`wait_seconds\` (0 to ${MAX_WAIT_SECONDS}) holds the call until the memo is ingested, held, or failed, or the time runs out. Prefer one call with a wait to repeated calls.`,
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The id write_memo returned.' },
          wait_seconds: { type: 'number', minimum: 0, maximum: MAX_WAIT_SECONDS },
        },
        required: ['id'],
      },
    },
  ];
}

const ok = (value: Record<string, unknown>): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const toolError = (detail: string): CallToolResult => ({ content: [{ type: 'text', text: detail }], isError: true });

async function writeMemo(deps: McpDeps, args: Record<string, unknown>): Promise<CallToolResult> {
  const hint = args.domain_hint;
  if (typeof hint === 'string' && hint.trim() !== '' && !(await deps.wiki.parseDomain(hint))) {
    return toolError(`domain_hint: one of ${(await deps.wiki.domains()).join(', ')}`);
  }
  const r = await acceptMemo(deps.wiki, {
    id: randomUUID(),
    text: args.text,
    captured_at: isoWithOffset(deps.now(), TZ),
    tz: TZ,
    source: 'agent',
    domain_hint: hint ?? null,
    context: args.context ?? null,
  });
  return r.ok ? ok({ id: r.value.id, status: r.value.status }) : toolError(r.detail);
}

const SETTLED: ReadonlySet<MemoStateWire> = new Set(['ingested', 'held', 'failed']);

async function memoStatus(deps: McpDeps, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult> {
  const id = typeof args.id === 'string' ? parseMemoId(args.id) : null;
  if (!id) return toolError('id: expected the id write_memo returned');
  const wait = args.wait_seconds ?? 0;
  if (typeof wait !== 'number' || !(wait >= 0 && wait <= MAX_WAIT_SECONDS)) return toolError(`wait_seconds: 0 to ${MAX_WAIT_SECONDS}`);
  const deadline = Date.now() + wait * 1000;
  for (;;) {
    const d = await deps.wiki.memo(id);
    if (!d) return toolError('no such memo');
    const w = detailWire(d);
    if (SETTLED.has(w.state) || Date.now() >= deadline || signal.aborted) {
      return ok({ id: w.id, state: w.state, domain: w.domain, verdict: w.verdict, first_page: w.first_page, failure: w.failure } satisfies MemoStatus);
    }
    await delay(Math.min(1000, deadline - Date.now()), undefined, { signal }).catch(() => undefined);
  }
}

export async function handleMcp(deps: McpDeps, body: unknown, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const server = new Server({ name: 'llmwiki', version: deps.serverVersion }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools(await deps.wiki.domains()) }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
    const args = params.arguments ?? {};
    switch (params.name) {
      case 'write_memo': return writeMemo(deps, args);
      case 'memo_status': return memoStatus(deps, args, extra.signal);
      default: return toolError(`unknown tool ${params.name}`);
    }
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => void server.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
