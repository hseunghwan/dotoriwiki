/**
 * Every `codex exec` spawn lives here: the Llm port for the wiki, with the same contract as
 * claude.ts. It knows flags, `--json` events, and how to tell "rate limited" from "bad job".
 *
 * Every call passes --ignore-user-config (the user's config.toml grants danger-full-access and
 * loads plugins, MCP servers, and a notify hook), disables hooks and the skills listing, and
 * never passes a sandbox bypass. The prompt goes on stdin.
 *
 * Codex has no system prompt flag, so the composed prompt goes first in the one prompt. Its
 * shell writes files, and its events don't name them, so an edit reports what `git status`
 * shows changed under the writable folder; the sandbox keeps writes inside that folder.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { cliRunner, isObj, type Finished, type Json } from './cli-run.ts';
import { classifySchema, editSchema, type CodexChoice } from './models.ts';
import { textFor, type Classification, type ClassifyRequest, type EditRequest, type EditResult, type Llm, type Unavailable } from './wiki/index.ts';

export type CodexConfig = {
  readonly bin: string;
  /** Every event of every run, for scripts that need to see what the model did. */
  readonly onEvent?: (e: Json) => void;
};

export type Codex = {
  llm(choice: CodexChoice): Llm;
  stopAll(): void;
};

const MINUTE = 60_000;
const execFileP = promisify(execFile);

const COMMON = ['exec', '--json', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--disable', 'hooks', '-c', 'skills.include_instructions=false'] as const;
const modelArgs = (c: CodexChoice) => ['-m', c.model, ...(c.effort ? ['-c', `model_reasoning_effort="${c.effort}"`] : [])];

export function classifyArgv(choice: CodexChoice, schemaFile: string): readonly string[] {
  return [...COMMON, ...modelArgs(choice), '-s', 'read-only', '--output-schema', schemaFile, '-'];
}

export function editArgv(req: EditRequest, choice: CodexChoice, schemaFile: string): readonly string[] {
  // `--image=` binds one value; a bare `-i` takes every following argument, the stdin `-` included.
  const images = req.images.map((p) => `--image=${p}`);
  return [...COMMON, ...modelArgs(choice), '-s', 'workspace-write', '-C', join(req.cwd, req.writableDir), ...images, '--output-schema', schemaFile, '-'];
}

export const classifyPrompt = (req: ClassifyRequest) => textFor(req.locale).codex.classify(req.systemPrompt, req.text);

export const editPrompt = (req: EditRequest) =>
  textFor(req.locale).codex.edit({ systemPrompt: req.systemPrompt, cwd: req.cwd, example: join(req.cwd, 'raw', 'x.md'), writable: join(req.cwd, req.writableDir), task: req.prompt });

const failureText = (f: Finished) =>
  [
    ...f.events.filter((e) => e.type === 'turn.failed' && isObj(e.error)).map((e) => String((e.error as Json).message)),
    ...f.events.filter((e) => e.type === 'error').map((e) => String(e.message)).slice(-1),
    f.stderr.trim().slice(-500),
  ].join(' ').trim();

/**
 * Infrastructure trouble that must not spend a job attempt, or null when the job itself failed.
 * Recorded: 401 without login, model_not_found, and a 500 (shown as "high demand"). Rate-limit
 * wording comes from strings in the codex binary, not from a recorded run.
 */
export function unavailableFrom(f: Finished): Unavailable | null {
  if (f.spawnError) return { kind: 'unavailable', reason: `codex did not start: ${f.spawnError}`, retryAfterMs: MINUTE };
  if (f.events.some((e) => e.type === 'turn.completed')) return null;
  const text = failureText(f);
  const brief = text.slice(0, 200);
  if (/usage limit|rate.?limit|too many requests|quota|\b429\b/i.test(text)) return { kind: 'unavailable', reason: `rate limited: ${brief}`, retryAfterMs: 5 * MINUTE };
  if (/\b401\b|\b403\b|unauthori[sz]ed|sign in again|log ?in again|not logged in|refresh token|authentication required/i.test(text)) {
    return { kind: 'unavailable', reason: `auth: ${brief}`, retryAfterMs: 10 * MINUTE };
  }
  // A model the account can't use is a config mistake; failing jobs for it would burn their attempts.
  if (/model_not_found|model is not supported/i.test(text)) return { kind: 'unavailable', reason: `model: ${brief}`, retryAfterMs: 10 * MINUTE };
  if (/high demand|overloaded|\b50[0-4]\b|stream disconnected|error sending request/i.test(text)) return { kind: 'unavailable', reason: `server: ${brief}`, retryAfterMs: 2 * MINUTE };
  if (!f.timedOut && !f.events.some((e) => e.type === 'turn.failed')) {
    return { kind: 'unavailable', reason: `codex exited ${f.code} without a result: ${f.stderr.trim().slice(-200)}`, retryAfterMs: MINUTE };
  }
  return null;
}

function finalAnswer(f: Finished): Json | string {
  const messages = f.events.flatMap((e) => (e.type === 'item.completed' && isObj(e.item) && e.item.type === 'agent_message' && typeof e.item.text === 'string' ? [e.item.text] : []));
  const last = messages.at(-1);
  if (last === undefined) return failureText(f).slice(0, 300) || 'no final message';
  try {
    const out: unknown = JSON.parse(last);
    return isObj(out) ? out : 'final message is not a JSON object';
  } catch {
    return `final message is not JSON: ${last.slice(0, 200)}`;
  }
}

export function toClassification(f: Finished): Classification | Unavailable {
  const unavailable = unavailableFrom(f);
  if (unavailable) return unavailable;
  const out = finalAnswer(f);
  if (typeof out === 'string') return { kind: 'no-answer', detail: out };
  if (typeof out.domain !== 'string' || typeof out.confidence !== 'number' || typeof out.reason !== 'string') {
    return { kind: 'no-answer', detail: 'final message has the wrong shape' };
  }
  return { kind: 'classified', domain: out.domain, confidence: out.confidence, reason: out.reason };
}

export function toEditResult(f: Finished): EditResult | Unavailable {
  if (f.timedOut) return { kind: 'failed', reason: 'edit run timed out' };
  const unavailable = unavailableFrom(f);
  if (unavailable) return unavailable;
  const out = finalAnswer(f);
  if (typeof out === 'string') return { kind: 'failed', reason: out };
  if (typeof out.verdict !== 'string') return { kind: 'failed', reason: 'no structured verdict in the final message' };
  return { kind: 'finished', verdict: out.verdict, pages: Array.isArray(out.pages) ? out.pages.map(String) : [] };
}

/** Absolute paths from `git status --porcelain=v1 -z --no-renames`, whose paths are relative to the repo top. */
export function porcelainPaths(out: string, top: string): readonly string[] {
  return out.split('\0').filter((e) => e.length > 3).map((e) => join(top, e.slice(3)));
}

async function changedUnder(dir: string): Promise<readonly string[]> {
  // Optional locks off: the wiki's own git calls must never meet an index.lock this status took.
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  const top = (await execFileP('git', ['rev-parse', '--show-toplevel'], { cwd: dir, env })).stdout.trim();
  const { stdout } = await execFileP('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--', '.'], { cwd: dir, env, maxBuffer: 16 * 1024 * 1024 });
  return porcelainPaths(stdout, top);
}

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // With an API key in the environment, codex exec bills the API instead of the ChatGPT plan.
  delete env.CODEX_API_KEY;
  delete env.OPENAI_API_KEY;
  return env;
}

export function codexCli(cfg: CodexConfig): Codex {
  const { run, stopAll } = cliRunner(cfg.bin, childEnv);
  const scratch = mkdtempSync(join(tmpdir(), 'dotoriwiki-codex-'));
  const emptyDir = join(scratch, 'empty');
  mkdirSync(emptyDir);

  const written = new Set<string>();

  /** Written once per content, so a running call never reads a file another call is rewriting. */
  function schemaFile(schema: object): string {
    const text = JSON.stringify(schema);
    const file = join(scratch, `schema-${createHash('sha256').update(text).digest('hex').slice(0, 16)}.json`);
    if (!written.has(file)) writeFileSync(file, text);
    written.add(file);
    return file;
  }

  return {
    llm: (choice) => ({
      async classify(req) {
        const argv = classifyArgv(choice, schemaFile(classifySchema(req.domains)));
        return toClassification(await run(argv, emptyDir, classifyPrompt(req), { timeoutMs: 2 * MINUTE, onEvent: cfg.onEvent }));
      },

      async edit(req) {
        const argv = editArgv(req, choice, schemaFile(editSchema(req.verdicts)));
        const f = await run(argv, req.cwd, editPrompt(req), { timeoutMs: req.timeoutMs, onEvent: cfg.onEvent });
        for (const p of await changedUnder(join(req.cwd, req.writableDir))) req.onTouch(p);
        return toEditResult(f);
      },
    }),
    stopAll,
  };
}
