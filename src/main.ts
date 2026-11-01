/**
 * Wiring only. `dotoriwiki start` runs it, or `npm start` in a checkout (Node 24 type stripping, no
 * build step).
 *
 * Module map (→ = imports):
 *
 *   cli.ts ─→ main.ts, init.ts, doctor.ts, install.ts ─→ service.ts (pure), pair.ts
 *
 *   main.ts ─→ http.ts ─→ wiki/index.ts        public Wiki surface, domain types, Llm port
 *      │          ├────→ wire.ts ─→ wiki/index.ts   the memo write path, domain → wire mappings
 *      │          ├────→ mcp.ts ──→ wire.ts         POST /mcp: write_memo, memo_status for coding agents
 *      │          └────→ chat.ts ─→ claude.ts (types)
 *      ├────→ machine.ts                      env settings, the machine's file paths, the env file format
 *      ├────→ loops.ts ─→ wiki/index.ts
 *      ├────→ feeds.ts ─→ wiki/index.ts (accept only), enrich.ts (UA, entities)
 *      ├────→ models.ts ─→ wiki/index.ts (types only)  models.json, the router that implements Llm
 *      ├────→ claude.ts ─→ cli-run.ts, models.ts, wiki/index.ts (types only)
 *      ├────→ codex.ts ──→ cli-run.ts, models.ts, wiki/index.ts (types only)
 *      ├────→ enrich.ts ─→ wiki/index.ts (types only: implements FetchSource)
 *      └────→ shrink.ts ─→ enrich.ts (Run), wiki/index.ts (types only: implements ShrinkPhoto with sips)
 *
 *   wiki/index.ts ─→ wiki/config.ts   dotoriwiki.yaml → WikiConfig, prompt catalogs (pure)
 *                 ─→ wiki/ledger.ts   log.md line format → JobHistory     (pure)
 *                 ─→ wiki/pages.ts    file formats, page fields, checks, index (pure)
 *                 ─→ wiki/sources.ts  raw/<id>.source.md format, which links get fetched (pure)
 *                 ─→ wiki/photos.ts   photo EXIF → frontmatter, embeds, type sniffing (pure but for parsing bytes)
 *                 ─→ wiki/layout.ts   paths, atomic writes, marker, lock, prompt composition
 *                 ─→ wiki/git.ts      execFile git behind one mutex
 *   api.ts        wire types, no imports, shared with the Expo app
 *
 * Tracing a memo from POST to commit: http.ts (postMemo → wire.ts acceptMemo → wiki.accept), wiki/index.ts (accept →
 * routeNext → runNext, with the state derivations in its header), and loops.ts (who calls
 * routeNext and runNext, and when).
 */

import { claudeCli } from './claude.ts';
import { chatTurn } from './chat.ts';
import { openChatStore } from './chats.ts';
import { codexCli } from './codex.ts';
import { execRun, sourceFetcher } from './enrich.ts';
import { sipsShrink } from './shrink.ts';
import { FEEDS, pollFeeds } from './feeds.ts';
import { startHttp } from './http.ts';
import { startLoops } from './loops.ts';
import { GATEWAY_COMMITTER, loadConfig, machineEnv, packageJson, type Config } from './machine.ts';
import { loadModels, profileNames, routeLlm } from './models.ts';
import { openWiki } from './wiki/index.ts';

const log = (where: string, data: object) => console.error(JSON.stringify({ t: new Date().toISOString(), where, ...data }));

/** Runs the gateway until SIGTERM or SIGINT, on the env file's settings under `env`. */
export async function startGateway(env: NodeJS.ProcessEnv): Promise<void> {
  try {
    await serve(loadConfig(await machineEnv(env)));
  } catch (e) {
    log('main', { fatal: (e as Error).message });
    process.exit(1);
  }
}

async function serve(cfg: Config): Promise<void> {
  const models = loadModels(cfg.modelsFile);
  const claude = claudeCli({ bin: cfg.claudeBin, chat: models.chat, billing: cfg.claudeBilling });
  const codex = codexCli({ bin: cfg.codexBin });
  const llm = routeLlm(models, (c) => (c.provider === 'claude' ? claude.llm(c) : codex.llm(c)));
  const wiki = await openWiki(cfg.wikiRoot, {
    llm,
    fetchSource: sourceFetcher({ http: fetch, run: execRun, ytDlp: cfg.ytDlpBin }),
    shrinkPhoto: sipsShrink(execRun),
    maxAttempts: 3,
    reviewBelowConfidence: 0.6,
    ingestTimeoutMs: 10 * 60_000,
    committer: GATEWAY_COMMITTER,
    modelProfiles: profileNames(models),
  });
  const loops = startLoops(wiki, {
    rescanMs: 30_000,
    backoffMs: 30_000,
    collector: !cfg.collectFeeds ? null : { poll: async () => pollFeeds(FEEDS, await wiki.config(), { http: fetch, accept: (m) => wiki.accept(m), now: () => new Date() }), firstMs: 60_000, everyMs: 3 * 3_600_000 },
    onReport: (where, r) => log(where, r),
  });
  const chats = await openChatStore(cfg.chatsDir);
  const http = await startHttp(
    {
      wiki, chat: (turn, signal) => chatTurn({ wiki, claude }, turn, signal), chats, token: cfg.token, serverVersion: packageJson().version, now: () => new Date(),
      maxBodyBytes: 256 * 1024,
    },
    { host: cfg.host, port: cfg.port },
  );
  const { paused, problems } = await wiki.status();
  log('main', {
    listening: `http://${cfg.host}:${http.port}`, wikiRoot: cfg.wikiRoot, chatsDir: cfg.chatsDir, claudeBilling: cfg.claudeBilling.kind, config: { state: paused ? 'paused' : 'ok', problems },
    models: { ...models, edit: { default: models.edit.default, ...Object.fromEntries(models.edit.profiles) } },
  });

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
