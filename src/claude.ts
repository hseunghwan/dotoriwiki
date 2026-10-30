/**
 * Every `claude -p` spawn lives here: the Llm port for the wiki, plus read-only chat. It knows
 * flags, stream-json events, and how to tell "rate limited" from "bad job". It knows nothing
 * about the wiki folder.
 *
 * Every call runs with --safe-mode (no user plugins, hooks, or CLAUDE.md, so prompts are passed
 * in) and --permission-prompts none, never --bare (it breaks subscription auth). The prompt
 * goes on stdin, so a memo that starts with "-" is never read as a flag.
 */

import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { cliRunner, isObj, type Finished, type Json } from './cli-run.ts';
import { classifySchema, editSchema, type ClaudeChoice } from './models.ts';
import type { Classification, ClassifyRequest, EditRequest, EditResult, Llm, Unavailable } from './wiki/index.ts';

export type ClaudeConfig = { readonly bin: string; readonly chat: ClaudeChoice };

export type ChatRequest = {
  readonly cwd: string;
  readonly systemPrompt: string;
  readonly message: string;
  readonly resume: string | null;
  readonly signal?: AbortSignal;
};

export type ChatEvent =
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'done'; readonly sessionId: string; readonly fullText: string }
  | { readonly kind: 'error'; readonly message: string };

export type Claude = {
  llm(choice: ClaudeChoice): Llm;
  chat(req: ChatRequest): AsyncIterable<ChatEvent>;
  stopAll(): void;
};


const COMMON = ['-p', '--safe-mode', '--permission-prompts', 'none'] as const;
const modelArgs = (c: ClaudeChoice) => ['--model', c.model, ...(c.effort ? ['--effort', c.effort] : [])];

export function classifyArgv(req: ClassifyRequest, choice: ClaudeChoice): readonly string[] {
  return [
    ...COMMON, ...modelArgs(choice), '--tools', '', '--no-session-persistence',
    '--system-prompt', req.systemPrompt, '--output-format', 'json', '--json-schema', JSON.stringify(classifySchema(req.domains)),
  ];
}

/**
 * Path-scoped allow rules, not acceptEdits: acceptEdits let a model write ../escape.md outside
 * cwd, while `Write(./wiki/**)` with no prompt surface denies it and reports the denial.
 * --safe-mode confines Read to the working directories, so the photos' folder is added; writes
 * there are still denied by the allow rules.
 */
export function editArgv(req: EditRequest, choice: ClaudeChoice): readonly string[] {
  const scope = `./${req.writableDir}/**`;
  const photoDirs = [...new Set(req.images.map((p) => dirname(p)))];
  return [
    ...COMMON, ...modelArgs(choice), '--tools', 'Read,Edit,Write,Glob,Grep',
    ...photoDirs.flatMap((d) => ['--add-dir', d]),
    '--allowedTools', 'Read', 'Glob', 'Grep', `Edit(${scope})`, `Write(${scope})`,
    '--no-session-persistence', '--append-system-prompt', req.systemPrompt,
    '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(editSchema(req.verdicts)),
  ];
}

/** Sessions persist (no --no-session-persistence), so --resume works from the same cwd. */
export function chatArgv(req: ChatRequest, choice: ClaudeChoice): readonly string[] {
  return [
    ...COMMON, ...modelArgs(choice), '--tools', 'Read,Glob,Grep', '--allowedTools', 'Read', 'Glob', 'Grep',
    '--append-system-prompt', req.systemPrompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    ...(req.resume ? ['--resume', req.resume] : []),
  ];
}


const MINUTE = 60_000;
const WRITE_TOOLS: Record<string, string> = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };

/** Paths every Write/Edit tool_use tried to touch, allowed or denied. */
export function writeAttempts(event: Json): readonly string[] {
  const message = event.message;
  if (event.type !== 'assistant' || !isObj(message) || !Array.isArray(message.content)) return [];
  const out: string[] = [];
  for (const block of message.content) {
    if (!isObj(block) || block.type !== 'tool_use' || typeof block.name !== 'string' || !isObj(block.input)) continue;
    const key = WRITE_TOOLS[block.name];
    const path = key ? block.input[key] : undefined;
    if (typeof path === 'string') out.push(path);
  }
  return out;
}

const resultText = (r: Json) =>
  [typeof r.result === 'string' ? r.result : '', ...(Array.isArray(r.errors) ? r.errors.map(String) : [])].join(' ').trim() || String(r.subtype ?? 'error');

/** Infrastructure trouble that must not spend a job attempt, or null when the job itself failed. */
export function unavailableFrom(f: Finished, now = Date.now()): Unavailable | null {
  if (f.spawnError) return { kind: 'unavailable', reason: `claude did not start: ${f.spawnError}`, retryAfterMs: MINUTE };
  const limited = f.events.find((e) => e.type === 'rate_limit_event' && isObj(e.rate_limit_info) && !String(e.rate_limit_info.status).startsWith('allowed'));
  const resetsAt = limited && isObj(limited.rate_limit_info) ? Number(limited.rate_limit_info.resetsAt) : NaN;
  const result = f.events.find((e) => e.type === 'result');
  const text = `${result ? resultText(result) : ''} ${f.stderr}`;
  if (limited || /usage limit|rate.?limit|overloaded|\b(429|529)\b/i.test(text) || (result && [429, 529].includes(Number(result.api_error_status)))) {
    const wait = Number.isFinite(resetsAt) ? resetsAt * 1000 - now : 5 * MINUTE;
    return { kind: 'unavailable', reason: `rate limited: ${text.trim().slice(0, 200)}`, retryAfterMs: Math.max(MINUTE, wait) };
  }
  if (/\/login|not logged in|authenticat|oauth|invalid api key|\b401\b|\b403\b/i.test(text)) {
    return { kind: 'unavailable', reason: `auth: ${text.trim().slice(0, 200)}`, retryAfterMs: 10 * MINUTE };
  }
  if (!result && !f.timedOut) return { kind: 'unavailable', reason: `claude exited ${f.code} without a result: ${f.stderr.trim().slice(-200)}`, retryAfterMs: MINUTE };
  return null;
}

export function toEditResult(f: Finished): EditResult | Unavailable {
  if (f.timedOut) return { kind: 'failed', reason: 'edit run timed out' };
  const unavailable = unavailableFrom(f);
  if (unavailable) return unavailable;
  const result = f.events.find((e) => e.type === 'result')!;
  if (result.is_error) return { kind: 'failed', reason: resultText(result).slice(0, 300) };
  const out = result.structured_output;
  if (!isObj(out) || typeof out.verdict !== 'string') return { kind: 'failed', reason: 'no structured verdict in the result' };
  return { kind: 'finished', verdict: out.verdict, pages: Array.isArray(out.pages) ? out.pages.map(String) : [] };
}

export function toClassification(f: Finished): Classification | Unavailable {
  const unavailable = unavailableFrom(f);
  if (unavailable) return unavailable;
  const result = f.events.find((e) => e.type === 'result');
  const out = result?.structured_output;
  if (!result || result.is_error || !isObj(out)) return { kind: 'no-answer', detail: result ? resultText(result).slice(0, 200) : 'no result' };
  if (typeof out.domain !== 'string' || typeof out.confidence !== 'number' || typeof out.reason !== 'string') {
    return { kind: 'no-answer', detail: 'structured_output has the wrong shape' };
  }
  return { kind: 'classified', domain: out.domain, confidence: out.confidence, reason: out.reason };
}


function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // With an API key in the environment, claude bills the API instead of the subscription.
  delete env.ANTHROPIC_API_KEY;
  return env;
}

export function claudeCli(cfg: ClaudeConfig): Claude {
  const { run, spawn, stopAll } = cliRunner(cfg.bin, childEnv);

  return {
    llm: (choice) => ({
      async classify(req) {
        return toClassification(await run(classifyArgv(req, choice), tmpdir(), req.text, { timeoutMs: 2 * MINUTE }));
      },

      async edit(req) {
        const f = await run(editArgv(req, choice), req.cwd, req.prompt, {
          timeoutMs: req.timeoutMs,
          onEvent: (e) => writeAttempts(e).forEach(req.onTouch),
        });
        return toEditResult(f);
      },
    }),

    async *chat(req) {
      const child = spawn(chatArgv(req, cfg.chat), req.cwd);
      let stderr = '';
      let spawnError: string | null = null;
      const abort = () => child.kill('SIGTERM');
      req.signal?.addEventListener('abort', abort);
      child.on('error', (e) => (spawnError = e.message));
      child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
      child.stdin.on('error', () => undefined);
      child.stdin.end(req.message);
      let sessionId: string | null = null;
      let full = '';
      let ended = false;
      try {
        for await (const line of createInterface({ input: child.stdout })) {
          let e: unknown;
          try {
            e = JSON.parse(line);
          } catch {
            continue;
          }
          if (!isObj(e)) continue;
          const ev = isObj(e.event) ? e.event : null;
          if (e.type === 'system' && e.subtype === 'init' && typeof e.session_id === 'string' && !sessionId) {
            sessionId = e.session_id;
            yield { kind: 'session', sessionId };
          } else if (ev?.type === 'content_block_start' && isObj(ev.content_block) && ev.content_block.type === 'text' && full) {
            full += '\n\n';
            yield { kind: 'text', text: '\n\n' };
          } else if (ev?.type === 'content_block_delta' && isObj(ev.delta) && ev.delta.type === 'text_delta' && typeof ev.delta.text === 'string') {
            full += ev.delta.text;
            yield { kind: 'text', text: ev.delta.text };
          } else if (e.type === 'result') {
            ended = true;
            if (e.is_error || !sessionId) yield { kind: 'error', message: resultText(e).slice(0, 300) };
            else yield { kind: 'done', sessionId: typeof e.session_id === 'string' ? e.session_id : sessionId, fullText: full };
          }
        }
        if (!ended) yield { kind: 'error', message: spawnError ? `claude did not start: ${spawnError}` : `claude ended without a result: ${stderr.trim().slice(-200)}` };
      } finally {
        req.signal?.removeEventListener('abort', abort);
        if (child.exitCode === null) child.kill('SIGTERM');
      }
    },

    stopAll,
  };
}
