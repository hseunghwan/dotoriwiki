/**
 * One photo memo end to end, against a copy of the real wiki with the real models:
 *
 *   node scripts/e2e-photo.ts [source wiki, default $WIKI_ROOT]
 *
 * Uploads two macOS desktop pictures: a small coastline JPEG given phone-style EXIF (GPS,
 * offset, make/model), and a 6016 px HEIC sent as-is, so sips has to convert and shrink it. Then
 * posts the memo and waits for its ingest. Prints the raw frontmatter, the pages that embed a
 * photo, and what git holds. The source wiki is only read.
 */

import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { MemoDetailWire, MemoRequest, StatusResponse } from '../src/api.ts';
import { envLine } from '../src/machine.ts';
import { jpegWithExif } from '../test/exif.ts';

const source = process.argv[2] ?? process.env.WIKI_ROOT;
if (!source) throw new Error('pass the source wiki as the first argument or set WIKI_ROOT');
const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const token = `e2e-${randomUUID()}`;
const section = (title: string) => console.log(`\n━━━━ ${title} ━━━━`);
const git = (root: string, ...args: string[]) => execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: root, encoding: 'utf8' });
const PICTURES = '/System/Library/Desktop Pictures';

const work = await fs.mkdtemp(join(process.env.E2E_TMP ?? tmpdir(), 'dotoriwiki-e2e-photo-'));
const root = join(work, 'wiki');
// .gateway/ holds the live gateway's lock and inflight markers, which belong to that process only.
await fs.cp(source, root, { recursive: true, filter: (src) => !src.startsWith(join(source, '.gateway')) });
// The copy may predate photos; the gateway refuses a vault that would commit originals.
const ignore = (await fs.readFile(join(root, '.gitignore'), 'utf8').catch(() => '')).split('\n');
if (!ignore.includes('_originals/')) await fs.appendFile(join(root, '.gitignore'), '_originals/\n');
section(`wiki copy at ${root}`);

const coastJpeg = join(work, 'coast.jpg');
execFileSync('/usr/bin/sips', ['-s', 'format', 'jpeg', join(PICTURES, '.thumbnails', 'Big Sur Coastline.heic'), '--out', coastJpeg], { stdio: 'ignore' });
const coast = jpegWithExif({
  make: 'Apple', model: 'iPhone 15 Pro', taken: '2026:09:20 17:42:05', offset: '-07:00',
  exposure: [1, 500], fNumber: [178, 100], iso: 64, focal35: 24, gps: { lat: 36.2704, lon: -121.8081 },
}, await fs.readFile(coastJpeg));
const sonoma = await fs.readFile(join(PICTURES, 'Sonoma.heic'));

const logFile = join(work, 'gateway.log');
const envFile = join(work, 'gateway.env');
await fs.writeFile(envFile, `${envLine('WIKI_ROOT', root)}\n${envLine('GATEWAY_TOKEN', token)}\n`, { mode: 0o600 });
const server = spawn(process.execPath, [join(app, 'src', 'cli.ts'), 'start'], {
  env: { ...process.env, DOTORIWIKI_ENV: envFile, CHATS_DIR: join(work, 'chats'), PORT: '0', COLLECT_FEEDS: 'off' },
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

const auth = { authorization: `Bearer ${token}` };
async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, { method, headers: { ...auth, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: (await res.json()) as T };
}
const put = async (path: string, bytes: Uint8Array) => {
  const res = await fetch(`${base}${path}`, { method: 'PUT', headers: auth, body: new Uint8Array(bytes) });
  return { status: res.status, body: await res.json() };
};

const id = randomUUID();
const memo: MemoRequest = {
  id,
  text: '지난달 빅서 해안도로 드라이브. 두 번째는 소노마 쪽 언덕',
  captured_at: new Date().toISOString().replace('Z', '+00:00'),
  tz: 'Asia/Seoul',
  source: 'typed',
  domain_hint: '일상',
  attachments: [{ n: 1, origin: 'gallery', place: 'Big Sur, CA', address: 'Highway 1, Big Sur, CA 93920, USA' }, { n: 2, origin: 'share' }],
};

try {
  section('PUT /attachments, POST /memos');
  console.log('coast.jpg', coast.length, 'bytes →', JSON.stringify(await put(`/attachments/${id}/1`, coast)));
  console.log('Sonoma.heic', sonoma.length, 'bytes →', JSON.stringify(await put(`/attachments/${id}/2`, sonoma)));
  console.log('memo →', JSON.stringify(await call('POST', '/memos', memo)));

  section('waiting for the ingest');
  const until = Date.now() + 15 * 60_000;
  let detail: MemoDetailWire;
  for (;;) {
    detail = (await call<MemoDetailWire>('GET', `/memos/${id}`)).body;
    if (detail.state === 'ingested' || detail.state === 'failed' || detail.state === 'held') break;
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(JSON.stringify(detail, null, 2));

  const domain = detail.domain!;
  section(`${domain}/raw/${id}.md`);
  console.log(await fs.readFile(join(root, domain, 'raw', `${id}.md`), 'utf8'));
  section('copies');
  for (const f of await fs.readdir(join(root, '_attachments'))) {
    console.log(f, execFileSync('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'format', join(root, '_attachments', f)], { encoding: 'utf8' }).split('\n').slice(1).join(' ').replace(/\s+/g, ' '));
  }
  section('in git at HEAD');
  console.log(git(root, 'ls-files', '--', '_attachments', '_originals') || '(none)');
  section(`${domain}/wiki/log.md tail`);
  console.log((await fs.readFile(join(root, domain, 'wiki', 'log.md'), 'utf8')).trim().split('\n').slice(-3).join('\n'));
  for (const p of detail.pages) {
    section(`page ${domain}/wiki/${p.path}.md (${p.change})`);
    console.log(await fs.readFile(join(root, domain, 'wiki', `${p.path}.md`), 'utf8'));
  }
} finally {
  server.kill('SIGTERM');
  log.end();
}
