/**
 * The markdown file formats and the deterministic rules over them. Pure: index.ts reads files
 * and runs git, then hands this module strings and paths.
 *
 * Paths here are repo-relative and NFC, e.g. "미루기 아카이빙/wiki/항목/LLM 강의.md", or relative to
 * a domain's wiki/ where the name says `UnderWiki`.
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { AnswerFiling, AnswerId, DomainName, GeoPoint, Memo, MemoContext, MemoId, MemoSource, PageRef, Routing } from './index.ts';

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly detail: string };
const bad = (detail: string): { ok: false; detail: string } => ({ ok: false, detail });


const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** ULID (Crockford base32, stored upper case) or UUID (stored lower case). Safe as a bare filename. */
function clientId(s: string): string | null {
  const t = s.trim();
  if (ULID.test(t.toUpperCase())) return t.toUpperCase();
  if (UUID.test(t.toLowerCase())) return t.toLowerCase();
  return null;
}

export const parseMemoId = (s: string) => clientId(s) as MemoId | null;
export const parseAnswerId = (s: string) => clientId(s) as AnswerId | null;


export type Frontmatter = Readonly<Record<string, unknown>>;

/** Never throws: a broken yaml block comes back as `error`. */
export function splitFrontmatter(text: string): { data: Frontmatter | null; body: string; error: string | null } {
  const m = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { data: null, body: text, error: null };
  const body = text.slice(m[0].length);
  try {
    const data: unknown = parseYaml(m[1] ?? '');
    if (data === null || data === undefined) return { data: {}, body, error: null };
    if (typeof data !== 'object' || Array.isArray(data)) return { data: null, body, error: 'frontmatter is not a mapping' };
    return { data: data as Frontmatter, body, error: null };
  } catch (e) {
    return { data: null, body, error: `yaml: ${(e as Error).message.split('\n')[0]}` };
  }
}

export const withFrontmatter = (data: Record<string, unknown>, body: string) => `---\n${stringifyYaml(data, { lineWidth: 0 })}---\n${body}`;


/**
 * The frontmatter every page and answer carries. A fixed contract, not configuration: the server
 * writes all six on answer pages, builds index.md from `type` and `summary`, and tells each ingest
 * to set `updated`.
 */
export const PAGE_FIELDS = ['type', 'summary', 'aliases', 'status', 'sources', 'updated'] as const;


export type FileRole = 'page' | 'answer' | 'derived' | 'ledger' | 'review' | 'other';

export function roleOf(pathUnderWiki: string): FileRole {
  if (pathUnderWiki === 'index.md') return 'derived';
  if (pathUnderWiki === 'log.md') return 'ledger';
  if (pathUnderWiki === '_review.md') return 'review';
  if (!pathUnderWiki.endsWith('.md')) return 'other';
  return pathUnderWiki.startsWith('answers/') ? 'answer' : 'page';
}


export const MEMO_SOURCES = ['typed', 'share', 'selection', 'voice', 'chat', 'feed', 'agent'] as const;
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The memo shape of 공통규칙 "원본 메모 frontmatter", with `text` as a field. The HTTP body and the
 * inbox file share it, so outside producers and the API are validated by the same code.
 */
export function parseMemo(input: unknown): Parsed<Memo> {
  if (!isRecord(input)) return bad('body: expected a JSON object');
  const id = typeof input.id === 'string' ? parseMemoId(input.id) : null;
  if (!id) return bad('id: expected a ULID or UUID');
  const { text, captured_at, tz, location, source, domain_hint, context } = input;
  if (typeof text !== 'string' || text.trim() === '') return bad('text: required');
  if (Buffer.byteLength(text) > 64 * 1024) return bad('text: over 64 KiB');
  if (typeof captured_at !== 'string' || !ISO_WITH_OFFSET.test(captured_at) || Number.isNaN(Date.parse(captured_at))) {
    return bad('captured_at: needs ISO-8601 with an offset');
  }
  if (typeof tz !== 'string' || !validTz(tz)) return bad('tz: expected an IANA time zone');
  let geo: GeoPoint | null = null;
  if (location !== undefined && location !== null) {
    if (!isRecord(location)) return bad('location: expected an object');
    const { lat, lon, place, address } = location;
    if (typeof lat !== 'number' || lat < -90 || lat > 90) return bad('location.lat: out of range');
    if (typeof lon !== 'number' || lon < -180 || lon > 180) return bad('location.lon: out of range');
    if (place !== undefined && place !== null && typeof place !== 'string') return bad('location.place: expected a string');
    if (address !== undefined && address !== null && typeof address !== 'string') return bad('location.address: expected a string');
    geo = { lat, lon, place: typeof place === 'string' ? place : null, address: typeof address === 'string' ? address : null };
  }
  if (!MEMO_SOURCES.includes(source as MemoSource)) return bad(`source: one of ${MEMO_SOURCES.join(', ')}`);
  if (domain_hint !== undefined && domain_hint !== null && typeof domain_hint !== 'string') return bad('domain_hint: expected a string');
  const hint = typeof domain_hint === 'string' && domain_hint.trim() !== '' ? domain_hint.trim().normalize('NFC') : null;
  let ctx: MemoContext | null = null;
  if (context !== undefined && context !== null) {
    if (!isRecord(context)) return bad('context: expected an object');
    const { project, cwd, branch } = context;
    if (typeof project !== 'string' || project.trim() === '') return bad('context.project: required');
    if (typeof cwd !== 'string' || cwd.trim() === '') return bad('context.cwd: required');
    if (branch !== undefined && branch !== null && typeof branch !== 'string') return bad('context.branch: expected a string or null');
    ctx = { project: project.trim(), cwd: cwd.trim(), branch: typeof branch === 'string' && branch.trim() !== '' ? branch.trim() : null };
  }
  return { ok: true, value: { id, text, capturedAt: captured_at, tz, location: geo, source: source as MemoSource, domainHint: hint, context: ctx } };
}

function parseRouting(v: unknown): Routing | null {
  if (!isRecord(v)) return null;
  if (v.by === 'hint') return { by: 'hint' };
  if (v.by === 'user' && typeof v.from === 'string') return { by: 'user', from: v.from.normalize('NFC') as DomainName, previous: parseRouting(v.previous) };
  if (v.by === 'fallback' && typeof v.reason === 'string') return { by: 'fallback', reason: v.reason };
  if (v.by === 'classifier' && typeof v.confidence === 'number' && typeof v.reason === 'string') {
    return { by: 'classifier', confidence: v.confidence, reason: v.reason };
  }
  return null;
}

/** inbox/<id>.md and <d>/raw/<id>.md. Body is the memo text, kept byte for byte. */
export function renderMemoFile(memo: Memo, routing: Routing | null): string {
  return withFrontmatter(
    {
      id: memo.id,
      captured_at: memo.capturedAt,
      tz: memo.tz,
      ...(memo.location ? { location: memo.location } : {}),
      source: memo.source,
      domain_hint: memo.domainHint,
      ...(memo.context ? { context: memo.context } : {}),
      ...(routing ? { routing } : {}),
    },
    `${memo.text}\n`,
  );
}

export function parseMemoFile(text: string): Parsed<{ memo: Memo; routing: Routing | null }> {
  const { data, body, error } = splitFrontmatter(text);
  if (!data) return bad(error ?? 'no frontmatter');
  const memo = parseMemo({ ...data, text: body.endsWith('\n') ? body.slice(0, -1) : body });
  return memo.ok ? { ok: true, value: { memo: memo.value, routing: parseRouting(data.routing) } } : memo;
}


export const pageRefString = (r: PageRef) => `${r.domain}/wiki/${r.page}`;

/** inbox/answers/<d>/<id>.md: the filing waiting for its domain worker. */
export function renderAnswerStaging(f: AnswerFiling): string {
  return withFrontmatter(
    { id: f.id, domain: f.domain, question: f.question, cited: f.cited.map(pageRefString), session_id: f.sessionId, asked_at: f.askedAt },
    `${f.answer}\n`,
  );
}

export function parseAnswerStaging(text: string): { id: string; domain: string; question: string; cited: readonly string[]; sessionId: string | null; askedAt: string; answer: string } | null {
  const { data, body } = splitFrontmatter(text);
  if (!data) return null;
  const { id, domain, question, cited, session_id, asked_at } = data;
  if (typeof id !== 'string' || typeof domain !== 'string' || typeof question !== 'string' || typeof asked_at !== 'string') return null;
  if (!Array.isArray(cited) || !cited.every((c) => typeof c === 'string')) return null;
  return { id, domain, question, cited, sessionId: typeof session_id === 'string' ? session_id : null, askedAt: asked_at, answer: body.replace(/\n$/, '') };
}

const fileSafe = (s: string) => s.replace(/[\\/:*?"<>|#^[\]\r\n\t]+/g, ' ').replace(/\s+/g, ' ').replace(/^\.+/, '').trim();
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** wiki/answers/<date> <question>.md. Deterministic for a given folder, so a rerun after a crash writes the same file. */
export function renderAnswerPage(f: AnswerFiling, date: string, existingUnderWiki: ReadonlySet<string>): { pathUnderWiki: string; content: string } {
  const stem = `${date} ${fileSafe(f.question).slice(0, 40).trim()}`.trim();
  const plain = `answers/${stem}.md`;
  const pathUnderWiki = existingUnderWiki.has(plain) ? `answers/${stem} ${f.id.slice(-6)}.md` : plain;
  const links = f.cited.map((r) => `[[${pageRefString(r)}]]`);
  const content = withFrontmatter(
    {
      type: 'answer',
      summary: oneLine(f.question).slice(0, 120),
      aliases: [],
      status: 'active',
      sources: [],
      updated: date,
      derived: true,
      question: f.question,
      cited: links,
      session_id: f.sessionId,
      asked_at: f.askedAt,
      answer_id: f.id,
    },
    `${f.answer.trim()}\n\n## 근거\n\n${links.length ? links.map((l) => `- ${l}`).join('\n') : '- 없음'}\n`,
  );
  return { pathUnderWiki, content };
}


export type PageMeta = { readonly pathUnderWiki: string; readonly name: string; readonly type: string | null; readonly summary: string };

export function pageMeta(pathUnderWiki: string, text: string): PageMeta {
  const { data } = splitFrontmatter(text);
  const name = pathUnderWiki.replace(/\.md$/, '').split('/').pop()!;
  return {
    pathUnderWiki,
    name,
    type: typeof data?.type === 'string' ? data.type : null,
    summary: typeof data?.summary === 'string' ? oneLine(data.summary) : '',
  };
}

/** Vault-relative target so a same-named page in another domain can't capture the link in Obsidian. */
function indexLink(domain: string, pathUnderWiki: string): string {
  const path = pathUnderWiki.replace(/\.md$/, '');
  return `[[${domain}/wiki/${path}|${path}]]`;
}

export function renderIndex(domain: string, pages: readonly PageMeta[], typeOrder: readonly string[]): string {
  const groups = new Map<string, PageMeta[]>();
  for (const p of pages) {
    const key = p.type === 'answer' ? 'answer' : p.type && typeOrder.includes(p.type) ? p.type : '';
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const sections: [string, string][] = [...typeOrder.map((t) => [t, t] as [string, string]), ['', '기타'], ['answer', '저장된 답']];
  const out = [`# ${domain} 색인`, '', '서버가 페이지 frontmatter에서 만든다. 고치지 않는다.', ''];
  for (const [key, title] of sections) {
    const list = groups.get(key);
    if (!list?.length) continue;
    out.push(`## ${title}`, '');
    for (const p of [...list].sort((a, b) => a.name.localeCompare(b.name, 'ko'))) out.push(`- ${indexLink(domain, p.pathUnderWiki)}${p.summary ? ` - ${p.summary}` : ''}`);
    out.push('');
  }
  return out.join('\n');
}


/** `[[target]]`, `[[target|label]]`, `[[target#heading]]`, `![[embed]]` → target. Skips fenced code. */
export function extractWikilinks(markdown: string): readonly string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    // Obsidian doesn't link inside code spans, and articles quote syntax like `[[...]]` there.
    for (const m of line.replace(/(`+)[^`]*?\1/g, '').matchAll(/\[\[([^[\]\n]+?)\]\]/g)) {
      const target = m[1]!.split('|')[0]!.split('#')[0]!.trim().replace(/\.md$/, '');
      if (target) out.push(target.normalize('NFC'));
    }
  }
  return out;
}

/** domain → every page name it answers to: its path under wiki/ without `.md`, and its basename. */
export type PageNameIndex = ReadonlyMap<string, ReadonlySet<string>>;

export function namesOf(pathsUnderWiki: readonly string[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const p of pathsUnderWiki) {
    if (!p.endsWith('.md')) continue;
    const stem = p.slice(0, -3);
    out.add(stem);
    out.add(stem.split('/').pop()!);
  }
  return out;
}

/** `도메인/wiki/페이지` resolves in that domain; anything else resolves in the linking page's own domain. */
export function linkResolves(target: string, fromDomain: string, names: PageNameIndex): boolean {
  const m = /^(.+?)\/wiki\/(.+)$/.exec(target);
  if (m && names.has(m[1]!)) return names.get(m[1]!)!.has(m[2]!);
  return names.get(fromDomain)?.has(target) ?? false;
}


export type Change = { readonly path: string; readonly status: 'added' | 'modified' | 'deleted' | 'untracked' };

export const PROBLEM_RULES = [
  'llm',             // the edit run itself failed: error result or timeout
  'scope',           // the model wrote, or tried to write, outside <d>/wiki/
  'input-modified',  // a job input (raw/<id>.md, .source.md) changed during the job
  'append-only',     // _review.md at HEAD is not a prefix of the new content
  'frontmatter',     // page or answer missing a required field, or yaml that does not parse
  'type',            // `type` is not one of the domain's page_types in dotoriwiki.yaml (or `answer`)
  'empty',           // empty file, or a page with an empty body
  'broken-link',     // a link in a changed page does not resolve
] as const;

export type Problem = {
  readonly rule: (typeof PROBLEM_RULES)[number];
  readonly path: string;
  readonly detail: string;
};

/**
 * log.md and index.md are not checked: index.ts resets both to HEAD before calling check(),
 * because the server owns them.
 */
export type CheckInput = {
  readonly domain: string;
  /** git status under <d>/wiki/, untracked included. */
  readonly changes: readonly Change[];
  /** Working-tree text of every changed, non-deleted file. */
  readonly contents: ReadonlyMap<string, string>;
  readonly reviewAtHead: string | null;
  /** The job's own domain from the working tree, every other domain from HEAD. */
  readonly names: PageNameIndex;
  readonly allowedTypes: ReadonlySet<string>;
  readonly outsideWrites: readonly string[];
  readonly modifiedInputs: readonly string[];
};

const missing = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/** Scoped to the job's diff: a page the job did not touch cannot fail it. [] means clean. */
export function check(input: CheckInput): readonly Problem[] {
  const problems: Problem[] = [];
  const add = (rule: Problem['rule'], path: string, detail: string) => problems.push({ rule, path, detail });
  for (const p of input.outsideWrites) add('scope', p, 'write outside wiki/');
  for (const p of input.modifiedInputs) add('input-modified', p, 'raw input changed');
  const prefix = `${input.domain}/wiki/`;
  for (const change of input.changes) {
    if (!change.path.startsWith(prefix)) continue;
    const role = roleOf(change.path.slice(prefix.length));
    if (role === 'ledger' || role === 'derived' || role === 'other') continue;
    if (change.status === 'deleted') {
      if (role === 'review') add('append-only', change.path, '_review.md was deleted');
      continue;
    }
    const text = input.contents.get(change.path) ?? '';
    if (text.trim() === '') {
      add('empty', change.path, 'empty file');
      continue;
    }
    if (role === 'review') {
      if (input.reviewAtHead !== null && !text.startsWith(input.reviewAtHead)) add('append-only', change.path, 'existing lines of _review.md were changed');
      continue;
    }
    const { data, body, error } = splitFrontmatter(text);
    if (!data) add('frontmatter', change.path, error ?? 'no frontmatter');
    else {
      for (const f of PAGE_FIELDS) if (missing(data[f])) add('frontmatter', change.path, `${f} missing`);
      if (typeof data.type === 'string' && !input.allowedTypes.has(data.type)) {
        add('type', change.path, `type ${data.type} is not one of ${[...input.allowedTypes].join(', ')}`);
      }
    }
    if (body.trim() === '') add('empty', change.path, 'page has no body');
    for (const target of extractWikilinks(text)) {
      if (!linkResolves(target, input.domain, input.names)) add('broken-link', change.path, `[[${target}]] does not resolve`);
    }
  }
  return problems;
}

export const describeProblems = (ps: readonly Problem[]) => ps.map((p) => `${p.rule} ${p.path}: ${p.detail}`.trim()).join('; ').slice(0, 500);

/** The first problem's rule in a describeProblems() reason, and the text after it; null when the reason names no rule. */
export function firstProblem(reason: string): { readonly rule: Problem['rule']; readonly detail: string } | null {
  const rule = PROBLEM_RULES.find((r) => reason === r || reason.startsWith(`${r} `) || reason.startsWith(`${r}:`));
  return rule ? { rule, detail: reason.slice(rule.length).replace(/^\s*:?\s*/, '') } : null;
}
