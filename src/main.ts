/**
 * Wiring only. Run with `node src/main.ts` (Node 24 type stripping, no build step).
 *
 * Module map (→ = imports):
 *
 *   main.ts ─→ http.ts ─→ wiki/index.ts        public Wiki surface, domain types, Llm port
 *      │          ├────→ wire.ts ─→ wiki/index.ts   the memo write path, domain → wire mappings
 *      │          ├────→ mcp.ts ──→ wire.ts         POST /mcp: write_memo, memo_status for coding agents
 *      │          └────→ chat.ts ─→ claude.ts (types)
 *      ├────→ loops.ts ─→ wiki/index.ts
 *      ├────→ feeds.ts ─→ wiki/index.ts (accept only), enrich.ts (UA, entities)
 *      ├────→ models.ts ─→ wiki/index.ts (types only)  models.json, the router that implements Llm
 *      ├────→ claude.ts ─→ cli-run.ts, models.ts, wiki/index.ts (types only)
 *      ├────→ codex.ts ──→ cli-run.ts, models.ts, wiki/index.ts (types only)
 *      └────→ enrich.ts ─→ wiki/index.ts (types only: implements FetchSource)
 *
 *   wiki/index.ts ─→ wiki/ledger.ts   log.md line format → JobHistory     (pure)
 *                 ─→ wiki/pages.ts    file formats, schema tables, checks, index (pure)
 *                 ─→ wiki/sources.ts  raw/<id>.source.md format, which links get fetched (pure)
 *                 ─→ wiki/layout.ts   paths, atomic writes, marker, lock, prompt composition
 *                 ─→ wiki/git.ts      execFile git behind one mutex
 *   api.ts        wire types, no imports, shared with the Expo app
 *
 * Tracing a memo from POST to commit: http.ts (postMemo → wire.ts acceptMemo → wiki.accept), wiki/index.ts (accept →
 * routeNext → runNext, with the state derivations in its header), and loops.ts (who calls
 * routeNext and runNext, and when).
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { claudeCli } from './claude.ts';
import { chatTurn } from './chat.ts';
import { codexCli } from './codex.ts';
import { execRun, sourceFetcher } from './enrich.ts';
import { FEEDS, pollFeeds } from './feeds.ts';
import { startHttp } from './http.ts';
import { startLoops } from './loops.ts';
import { loadModels, routeLlm } from './models.ts';
import { listDomains, openWiki } from './wiki/index.ts';

export type Config = {
  readonly wikiRoot: string;
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly claudeBin: string;
  readonly codexBin: string;
  readonly ytDlpBin: string;
  readonly modelsFile: string;
  readonly collectFeeds: boolean;
};

/**
 * WIKI_ROOT, GATEWAY_TOKEN required; PORT (8787), HOST (127.0.0.1, set the Tailscale address),
 * CLAUDE_BIN (claude), CODEX_BIN (codex), YT_DLP_BIN (yt-dlp), MODELS_FILE
 * (~/.config/llmwiki/models.json), COLLECT_FEEDS (on; `off` for a test gateway) optional.
 */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const wikiRoot = env.WIKI_ROOT ?? '';
  if (!isAbsolute(wikiRoot)) throw new Error('WIKI_ROOT must be an absolute path');
  const token = env.GATEWAY_TOKEN ?? '';
  if (token.length < 16) throw new Error('GATEWAY_TOKEN must be at least 16 characters');
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be a port number');
  const host = env.HOST ?? '127.0.0.1';
  if (host === '0.0.0.0' || host === '::') throw new Error('HOST must be one address (the Tailscale one), not all interfaces');
  const modelsFile = env.MODELS_FILE ?? join(homedir(), '.config', 'llmwiki', 'models.json');
  if (!isAbsolute(modelsFile)) throw new Error('MODELS_FILE must be an absolute path');
  return { wikiRoot, host, port, token, claudeBin: env.CLAUDE_BIN ?? 'claude', codexBin: env.CODEX_BIN || 'codex', ytDlpBin: env.YT_DLP_BIN ?? 'yt-dlp', modelsFile, collectFeeds: env.COLLECT_FEEDS !== 'off' };
}

function serverVersion(): string {
  return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
}

const log = (where: string, data: object) => console.error(JSON.stringify({ t: new Date().toISOString(), where, ...data }));

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  const models = loadModels(cfg.modelsFile, await listDomains(cfg.wikiRoot));
  const claude = claudeCli({ bin: cfg.claudeBin, chat: models.chat });
  const codex = codexCli({ bin: cfg.codexBin });
  const llm = routeLlm(models, (c) => (c.provider === 'claude' ? claude.llm(c) : codex.llm(c)));
  const wiki = await openWiki(cfg.wikiRoot, {
    llm,
    fetchSource: sourceFetcher({ http: fetch, run: execRun, ytDlp: cfg.ytDlpBin }),
    maxAttempts: 3,
    reviewBelowConfidence: 0.6,
    fallbackDomain: '일상',
    ingestTimeoutMs: 10 * 60_000,
    committer: { name: 'llmwiki-gateway', email: 'gateway@localhost' },
  });
  const loops = startLoops(wiki, {
    rescanMs: 30_000,
    backoffMs: 30_000,
    collector: !cfg.collectFeeds ? null : { poll: () => pollFeeds(FEEDS, { http: fetch, accept: (m) => wiki.accept(m), now: () => new Date() }), firstMs: 60_000, everyMs: 3 * 3_600_000 },
    onReport: (where, r) => log(where, r),
  });
  const http = await startHttp(
    { wiki, chat: (turn, signal) => chatTurn({ wiki, claude }, turn, signal), token: cfg.token, serverVersion: serverVersion(), now: () => new Date(), maxBodyBytes: 256 * 1024 },
    { host: cfg.host, port: cfg.port },
  );
  log('main', { listening: `http://${cfg.host}:${http.port}`, wikiRoot: cfg.wikiRoot, models: { ...models, edit: { default: models.edit.default, ...Object.fromEntries(models.edit.byDomain) } } });

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log('main', { stopping: sig });
    await http.close();
    // A killed edit run returns Unavailable, so the job rolls back without spending an attempt.
    claude.stopAll();
    codex.stopAll();
    await loops.stop();
    await wiki.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => {
  log('main', { fatal: (e as Error).message });
  process.exit(1);
});
