/**
 * End-to-end run on a fresh `init` of a preset with the real `claude`:
 *
 *   node scripts/e2e.ts [--locale en|ko]   (default en)
 *
 * Inits the preset in a temp dir (E2E_TMP or the OS temp dir), its env file beside it, and starts
 * the gateway with that env file, a port of its own, and no models.json, so the Claude defaults
 * apply. Posts four memos plus one resend, waits until /status shows nothing pending, prints the
 * git history and pages, then runs two chat turns in one session and saves the first answer. On
 * an English wiki it last checks every file at HEAD and every commit subject for Hangul, and
 * exits 1 when it finds any.
 */

import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { ChatFrame, MemoRequest, StatusResponse } from '../src/api.ts';
import { initWiki } from '../src/init.ts';
import { parseEnvFile } from '../src/machine.ts';

const { values } = parseArgs({ options: { locale: { type: 'string', default: 'en' } } });
const locale = values.locale;
if (locale !== 'en' && locale !== 'ko') throw new Error('--locale takes en or ko');
const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const section = (title: string) => console.log(`\n━━━━ ${title} ━━━━`);
const git = (root: string, ...args: string[]) => execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: root, encoding: 'utf8' });
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;

const SCRIPT = {
  en: {
    memos: [
      'Changed the RAG chunk size to 512 today and retrieval got more accurate. At 256 the context was cut off and it pulled the wrong paragraphs',
      'Found why Postgres skipped the index: the WHERE clause wrapped the column in lower(). A function index fixed it',
      'I want to try a pottery workshop some weekend',
      'Went to the lakefront with a friend. What she likes best is a picnic blanket and sandwiches on the grass',
    ],
    someday: 'someday',
    learning: 'learning',
    place: { lat: 41.89, lon: -87.61, place: 'Lakefront Trail' },
    question: 'What did I find out about RAG?',
    followUp: 'Why was 256 worse in that experiment? One sentence.',
  },
  ko: {
    memos: [
      '오늘 RAG 청크 크기를 512로 바꾸니 검색 정확도가 올라감. 256일 때는 문맥이 잘려서 엉뚱한 문단을 가져왔음',
      'Postgres 인덱스를 안 타던 이유를 찾아보니 WHERE 절에서 컬럼에 lower()를 씌워서였음. 함수 인덱스를 만드니 해결',
      '주말에 도자기 공방 가보고 싶다',
      '친구랑 한강 갔는데 돗자리 깔고 김밥 먹는 걸 제일 좋아하더라',
    ],
    someday: '미루기 아카이빙',
    learning: '스터디',
    place: { lat: 37.52, lon: 126.93, place: '여의도 한강공원' },
    question: '내가 RAG에 대해 알아낸 게 뭐였지?',
    followUp: '그 실험에서 256은 왜 안 좋았다고 했지? 한 문장으로.',
  },
}[locale];

const work = await fs.mkdtemp(join(process.env.E2E_TMP ?? tmpdir(), 'dotoriwiki-e2e-'));
const root = join(work, 'wiki');
const envFile = join(work, 'gateway.env');
await initWiki(root, locale, { ...process.env, DOTORIWIKI_ENV: envFile });
const machineEnv = Object.fromEntries(parseEnvFile(await fs.readFile(envFile, 'utf8')));
const token = machineEnv.GATEWAY_TOKEN!;
section(`fresh ${locale} wiki at ${root}, env file ${envFile}`);

const logFile = join(work, 'gateway.log');
const server = spawn(process.execPath, [join(app, 'src', 'main.ts')], {
  env: { ...process.env, ...machineEnv, PORT: '0', CHATS_DIR: join(work, 'chats'), MODELS_FILE: join(work, 'models.json'), COLLECT_FEEDS: 'off' },
  stdio: ['ignore', 'inherit', 'pipe'],
});
const log = createWriteStream(logFile);
const base = await new Promise<string>((resolveBase, reject) => {
  createInterface({ input: server.stderr! }).on('line', (line) => {
    log.write(`${line}\n`);
    const m = /"listening":"(http:[^"]+)"/.exec(line);
    if (m) resolveBase(m[1]!);
    if (line.includes('"fatal"')) reject(new Error(line));
  });
  server.on('exit', (code) => reject(new Error(`gateway exited ${code}; see ${logFile}`)));
});
console.log(`gateway ${base}, log ${logFile}`);

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as T };
}

const idle = (s: StatusResponse) => s.inbox === 0 && Object.values(s.domains).every((d) => d.pending === 0 && d.running === null);
async function waitIdle(timeoutMs: number): Promise<StatusResponse> {
  const until = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    const { body } = await call<StatusResponse>('GET', '/status');
    const line = JSON.stringify(body);
    if (line !== last) console.log(`[${new Date().toISOString().slice(11, 19)}] /status ${line}`);
    last = line;
    if (idle(body)) return body;
    if (Date.now() > until) throw new Error('timed out waiting for the gateway to go idle');
    await new Promise((r) => setTimeout(r, 3000));
  }
}

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const now = () => {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const hhmm = `${String(Math.floor(Math.abs(off) / 60)).padStart(2, '0')}:${String(Math.abs(off) % 60).padStart(2, '0')}`;
  return `${new Date(d.getTime() + off * 60_000).toISOString().slice(0, 19)}${off >= 0 ? '+' : '-'}${hhmm}`;
};
const memos: MemoRequest[] = [
  { id: randomUUID(), text: SCRIPT.memos[0]!, captured_at: now(), tz, source: 'typed' },
  { id: randomUUID(), text: SCRIPT.memos[1]!, captured_at: now(), tz, source: 'typed' },
  { id: randomUUID(), text: SCRIPT.memos[2]!, captured_at: now(), tz, source: 'typed', domain_hint: SCRIPT.someday },
  { id: randomUUID(), text: SCRIPT.memos[3]!, captured_at: now(), tz, source: 'typed', location: SCRIPT.place },
];

try {
  section('POST /memos');
  for (const m of memos) console.log(m.text.slice(0, 30), '→', JSON.stringify(await call('POST', '/memos', m)));
  console.log('resend of the first →', JSON.stringify(await call('POST', '/memos', memos[0])));

  section('waiting for /status to show nothing pending');
  const started = Date.now();
  await waitIdle(25 * 60_000);
  console.log(`idle after ${Math.round((Date.now() - started) / 1000)}s`);
  console.log('resend of the first after ingest →', JSON.stringify(await call('POST', '/memos', memos[0])));
  console.log('raw files for the first id:', git(root, 'ls-files', '--', `*/raw/${memos[0]!.id}.md`).trim());

  section('git log --stat');
  console.log(git(root, 'log', '--stat', '--format=%h %s'));
  section(`${SCRIPT.learning}/wiki/index.md`);
  const index = await fs.readFile(join(root, SCRIPT.learning, 'wiki', 'index.md'), 'utf8');
  console.log(index);
  // index.md links each page by its path from the wiki root: [[<domain>/wiki/<page>|<page>]].
  const first = /\[\[([^\]|]+)/.exec(index)?.[1];
  const pagePath = first ? `${first}.md` : '';
  section(`one created page: ${pagePath}`);
  if (pagePath) console.log(await fs.readFile(join(root, pagePath), 'utf8'));
  for (const log of git(root, 'ls-files', '--', '*/wiki/log.md').trim().split('\n')) {
    section(`${log} at HEAD`);
    console.log(git(root, 'show', `HEAD:${log}`));
  }
  const review = git(root, 'ls-files', '--', '*/wiki/_review.md').trim();
  for (const r of review ? review.split('\n') : []) {
    section(`${r} at HEAD`);
    console.log(git(root, 'show', `HEAD:${r}`));
  }

  async function chat(message: string, sessionId: string | null): Promise<{ sessionId: string; text: string; cited: string[] }> {
    const res = await fetch(`${base}/chat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ target: SCRIPT.learning, message, session_id: sessionId }),
    });
    console.log(`> ${message}   (HTTP ${res.status}, ${res.headers.get('content-type')})`);
    let buffer = '';
    let text = '';
    let done: Extract<ChatFrame, { type: 'done' }> | null = null;
    const decoder = new TextDecoder();
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let cut: number;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const type = /^event: (.+)$/m.exec(raw)?.[1];
        const frame = { type, ...JSON.parse(/^data: (.+)$/m.exec(raw)?.[1] ?? '{}') } as ChatFrame;
        if (frame.type === 'session') console.log(`[event: session] ${frame.session_id}`);
        else if (frame.type === 'delta') {
          text += frame.text;
          process.stdout.write(frame.text);
        } else if (frame.type === 'done') {
          done = frame;
          console.log(`\n[event: done] ${JSON.stringify(frame)}`);
        } else if (frame.type === 'error') throw new Error(`chat error: ${frame.message}`);
      }
    }
    if (!done) throw new Error('chat stream ended without done');
    return { sessionId: done.session_id, text, cited: done.cited };
  }

  section(`POST /chat turn 1 (${SCRIPT.learning})`);
  const question = SCRIPT.question;
  const t1 = await chat(question, null);
  section('POST /chat turn 2 (same session)');
  const t2 = await chat(SCRIPT.followUp, t1.sessionId);
  console.log(`same session: ${t2.sessionId === t1.sessionId}`);

  section('POST /answers');
  const answerId = randomUUID();
  const saved = await call('POST', '/answers', { id: answerId, domain: SCRIPT.learning, question, answer: t1.text, cited: t1.cited, session_id: t1.sessionId });
  console.log(JSON.stringify(saved));
  console.log('resend →', JSON.stringify(await call('POST', '/answers', { id: answerId, domain: SCRIPT.learning, question, answer: t1.text, cited: t1.cited, session_id: t1.sessionId })));
  await waitIdle(5 * 60_000);
  section('git log -1 --stat');
  console.log(git(root, 'log', '-1', '--stat', '--format=%h %s'));
  const answerFile = git(root, 'ls-files', '--', `${SCRIPT.learning}/wiki/answers/*.md`).trim();
  section(answerFile);
  console.log(await fs.readFile(join(root, answerFile), 'utf8'));
  section('final /status');
  console.log(JSON.stringify((await call('GET', '/status')).body));
} finally {
  server.kill('SIGTERM');
  await new Promise((r) => server.once('exit', r));
  log.end();
  console.log(`\ngateway stopped; wiki kept at ${root}`);
}

if (locale === 'en') {
  section('Hangul in the English wiki');
  const files = git(root, 'ls-tree', '-r', '--name-only', '-z', 'HEAD').split('\0').filter(Boolean);
  const inFiles = files.filter((p) => HANGUL.test(p) || HANGUL.test(git(root, 'show', `HEAD:${p}`)));
  const inSubjects = git(root, 'log', '--format=%s').trim().split('\n').filter((s) => HANGUL.test(s));
  console.log(`${files.length} files at HEAD, Hangul in: ${inFiles.length ? inFiles.join(', ') : 'none'}`);
  console.log(`commit subjects with Hangul: ${inSubjects.length ? inSubjects.join(' | ') : 'none'}`);
  if (inFiles.length || inSubjects.length) process.exitCode = 1;
}
