/**
 * End-to-end run against a copy of the real wiki with the real `claude`:
 *
 *   node scripts/e2e.ts [source wiki, default $WIKI_ROOT]
 *
 * Copies the wiki into a temp dir (E2E_TMP or the OS temp dir), starts the gateway on it,
 * posts four memos plus one resend, waits until /status shows nothing pending, prints the
 * copy's git history and pages, then runs two chat turns in one session and saves the first
 * answer. The source wiki is only read.
 */

import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { ChatFrame, MemoRequest, StatusResponse } from '../src/api.ts';

const source = process.argv[2] ?? process.env.WIKI_ROOT;
if (!source) throw new Error('pass the source wiki as the first argument or set WIKI_ROOT');
const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const token = `e2e-${randomUUID()}`;
const section = (title: string) => console.log(`\n━━━━ ${title} ━━━━`);
const git = (root: string, ...args: string[]) => execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: root, encoding: 'utf8' });

const work = await fs.mkdtemp(join(process.env.E2E_TMP ?? tmpdir(), 'llmwiki-e2e-'));
const root = join(work, 'wiki');
await fs.cp(source, root, { recursive: true });
section(`wiki copy at ${root}`);

const logFile = join(work, 'gateway.log');
const server = spawn(process.execPath, [join(app, 'src', 'main.ts')], {
  env: { ...process.env, WIKI_ROOT: root, PORT: '0', GATEWAY_TOKEN: token },
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
  { id: randomUUID(), text: '오늘 RAG 청크 크기를 512로 바꾸니 검색 정확도가 올라감. 256일 때는 문맥이 잘려서 엉뚱한 문단을 가져왔음', captured_at: now(), tz, source: 'typed' },
  { id: randomUUID(), text: 'Postgres 인덱스를 안 타던 이유를 찾아보니 WHERE 절에서 컬럼에 lower()를 씌워서였음. 함수 인덱스를 만드니 해결', captured_at: now(), tz, source: 'typed' },
  { id: randomUUID(), text: '주말에 도자기 공방 가보고 싶다', captured_at: now(), tz, source: 'typed', domain_hint: '미루기 아카이빙' },
  { id: randomUUID(), text: '친구랑 한강 갔는데 돗자리 깔고 김밥 먹는 걸 제일 좋아하더라', captured_at: now(), tz, source: 'typed', location: { lat: 37.52, lon: 126.93, place: '여의도 한강공원' } },
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

  section('git log --stat (copy)');
  console.log(git(root, 'log', '--stat', '--format=%h %s'));
  section('스터디/wiki/index.md');
  const index = await fs.readFile(join(root, '스터디', 'wiki', 'index.md'), 'utf8');
  console.log(index);
  const first = /\[\[([^\]]+)\]\]/.exec(index)?.[1];
  const pagePath = first ? git(root, 'ls-files', '--', `스터디/wiki/*${first}.md`).trim().split('\n')[0] : '';
  section(`one created page: ${pagePath}`);
  if (pagePath) console.log(await fs.readFile(join(root, pagePath), 'utf8'));
  for (const d of ['스터디', '미루기 아카이빙', '일상', '개발소식지식베이스']) {
    section(`${d}/wiki/log.md at HEAD`);
    console.log(git(root, 'show', `HEAD:${d}/wiki/log.md`));
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
      body: JSON.stringify({ target: '스터디', message, session_id: sessionId }),
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

  section('POST /chat turn 1 (스터디)');
  const question = '내가 RAG에 대해 알아낸 게 뭐였지?';
  const t1 = await chat(question, null);
  section('POST /chat turn 2 (same session)');
  const t2 = await chat('그 실험에서 256은 왜 안 좋았다고 했지? 한 문장으로.', t1.sessionId);
  console.log(`same session: ${t2.sessionId === t1.sessionId}`);

  section('POST /answers');
  const answerId = randomUUID();
  const saved = await call('POST', '/answers', { id: answerId, domain: '스터디', question, answer: t1.text, cited: t1.cited, session_id: t1.sessionId });
  console.log(JSON.stringify(saved));
  console.log('resend →', JSON.stringify(await call('POST', '/answers', { id: answerId, domain: '스터디', question, answer: t1.text, cited: t1.cited, session_id: t1.sessionId })));
  await waitIdle(5 * 60_000);
  section('git log -1 --stat');
  console.log(git(root, 'log', '-1', '--stat', '--format=%h %s'));
  const answerFile = git(root, 'ls-files', '--', '스터디/wiki/answers/*.md').trim();
  section(answerFile);
  console.log(await fs.readFile(join(root, answerFile), 'utf8'));
  section('final /status');
  console.log(JSON.stringify((await call('GET', '/status')).body));
} finally {
  server.kill('SIGTERM');
  await new Promise((r) => server.once('exit', r));
  log.end();
  console.log(`\ngateway stopped; copy kept at ${root}`);
}
