import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openWiki, parseMemo, type ClassifyRequest, type Classification, type EditRequest, type EditResult, type FetchedSource, type FetchSource,
  type Llm, type Memo, type Unavailable, type Wiki, type WikiOptions,
} from '../src/wiki/index.ts';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixture', 'wiki');

/** A fresh git work tree holding a copy of the fixture wiki, with no commits. */
export async function tempWiki(): Promise<string> {
  const root = await fs.mkdtemp(join(process.env.LLMWIKI_TEST_TMP ?? tmpdir(), 'llmwiki-test-'));
  await fs.cp(FIXTURE, root, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  return root;
}

export type FakeLlm = Llm & {
  classifyCalls: ClassifyRequest[];
  editCalls: EditRequest[];
  classifyWith: (req: ClassifyRequest) => Promise<Classification | Unavailable>;
  editWith: (req: EditRequest) => Promise<EditResult | Unavailable>;
};

export function fakeLlm(): FakeLlm {
  const llm: FakeLlm = {
    classifyCalls: [],
    editCalls: [],
    classifyWith: async () => ({ kind: 'classified', domain: '스터디', confidence: 0.9, reason: 'fake' }),
    editWith: writesValidPage(),
    classify: (req) => {
      llm.classifyCalls.push(req);
      return llm.classifyWith(req);
    },
    edit: (req) => {
      llm.editCalls.push(req);
      return llm.editWith(req);
    },
  };
  return llm;
}

export const rawIdOf = (req: EditRequest) => /raw\/([^/.`]+)\.md/.exec(req.prompt)![1]!;

/** Writes a file the way the model would: relative to the run's cwd, reported through onTouch. */
export async function modelWrites(req: EditRequest, relPath: string, content: string): Promise<void> {
  const abs = join(req.cwd, relPath);
  req.onTouch(abs);
  await fs.mkdir(dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

export function page(fields: Record<string, unknown>, body = '본문.\n'): string {
  const fm = Object.entries(fields).map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`);
  return `---\n${fm.join('\n')}\n---\n${body}`;
}

export const validFields = (id: string, extra: Record<string, unknown> = {}) => ({
  type: 'concept', summary: `요약 ${id}`, aliases: [], status: 'active', sources: [id], updated: '2026-10-29', ...extra,
});

/** Default edit: one valid concept page named after the memo id. */
export function writesValidPage(name?: (id: string) => string) {
  return async (req: EditRequest): Promise<EditResult> => {
    const id = rawIdOf(req);
    await modelWrites(req, `wiki/${name ? name(id) : `메모 ${id}`}.md`, page(validFields(id)));
    return { kind: 'finished', verdict: '새 페이지', pages: [] };
  };
}

export type FakeFetch = FetchSource & { calls: string[]; respond: (url: string) => Promise<FetchedSource> };

export function fakeFetch(): FakeFetch {
  const f = Object.assign((url: string) => {
    f.calls.push(url);
    return f.respond(url);
  }, {
    calls: [] as string[],
    respond: async (url: string): Promise<FetchedSource> => ({ kind: 'article', status: 'ok', title: `제목 ${url}`, text: `본문 ${url}` }),
  });
  return f;
}

const noFetch: FetchSource = async (url) => {
  throw new Error(`unexpected fetch of ${url}`);
};

export const options = (llm: Llm, extra: Partial<WikiOptions> = {}): WikiOptions => ({
  llm,
  fetchSource: noFetch,
  maxAttempts: 3,
  reviewBelowConfidence: 0.6,
  fallbackDomain: '일상',
  ingestTimeoutMs: 5_000,
  committer: { name: 'llmwiki-test', email: 'test@localhost' },
  tz: 'Asia/Seoul',
  now: () => new Date('2026-10-29T00:00:00Z'),
  ...extra,
});

export async function open(root: string, llm: Llm, extra: Partial<WikiOptions> = {}): Promise<Wiki> {
  return openWiki(root, options(llm, extra));
}

export const ulid = (n: number) => `01JB8ZQ4M3T9X7K2W5R6N8P${String(n).padStart(3, '0')}`;

export function memo(n: number, text = `메모 ${n}`, extra: Record<string, unknown> = {}): Memo {
  const r = parseMemo({ id: ulid(n), text, captured_at: `2026-10-29T08:${String(n % 60).padStart(2, '0')}:00+09:00`, tz: 'Asia/Seoul', source: 'typed', ...extra });
  if (!r.ok) throw new Error(r.detail);
  return r.value;
}

export const git = (root: string, ...args: string[]) => execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: root, encoding: 'utf8' });
export const headFile = (root: string, path: string) => {
  try {
    return git(root, 'show', `HEAD:${path}`);
  } catch {
    return null;
  }
};
export const commitSubjects = (root: string) => git(root, 'log', '--format=%s').trim().split('\n').reverse();
export const ledgerLines = (root: string, d: string) => (headFile(root, `${d}/wiki/log.md`) ?? '').split('\n').filter((l) => l.startsWith('## ['));
export const readText = (path: string) => fs.readFile(path, 'utf8').catch(() => null);
export const listDir = (path: string) => fs.readdir(path).then((n) => n.filter((x) => !x.startsWith('.')).sort(), () => [] as string[]);
