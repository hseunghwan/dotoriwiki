/**
 * dotoriwiki.yaml: every fact about the wiki that code reads, in one committed file at the root.
 * The CLAUDE.md files are prose for the model and nothing parses them.
 *
 * Pure. index.ts reads the file and checks the folders it names; this module turns text into a
 * WikiConfig, or into every problem it found, each with its key and a fix.
 */

import { parseDocument } from 'yaml';
import type { DomainName } from './index.ts';
import { validTz } from './pages.ts';

export const CONFIG_FILE = 'dotoriwiki.yaml';
export const CONFIG_VERSION = 1;

export const LOCALES = ['ko', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export const FEED_NAMES = ['geeknews', 'hackernews', 'ghsa'] as const;
export type FeedName = (typeof FEED_NAMES)[number];

/** An IANA zone Intl accepts. Minted only by parseWikiConfig. */
export type TimeZone = string & { readonly __brand: 'TimeZone' };
/** A key of the machine's models.json `edit` map. */
export type ModelProfile = string & { readonly __brand: 'ModelProfile' };

export type PageTypeSpec = { readonly type: string; readonly description: string; readonly example: string | null };

export type DomainConfig = {
  readonly name: DomainName;
  readonly description: string;
  readonly agentsMayRead: boolean;
  /** null runs on edit.default, also when the named profile is unknown to this machine. */
  readonly modelProfile: ModelProfile | null;
  /** Written order, which is also index.md's section order. Never `answer`. */
  readonly pageTypes: readonly [PageTypeSpec, ...PageTypeSpec[]];
};

export type WikiConfig = {
  readonly locale: Locale;
  readonly timeZone: TimeZone;
  /** Written order, at least one, NFC keys. */
  readonly domains: ReadonlyMap<DomainName, DomainConfig>;
  readonly fallbackDomain: DomainName;
  readonly feeds: ReadonlyMap<FeedName, { readonly domain: DomainName }>;
};

/** `key` is the path as written, e.g. `domains.recipes.page_types`. */
export type ConfigProblem = { readonly key: string; readonly problem: string; readonly fix: string };

/** Warnings leave the config usable: an unknown model profile runs on edit.default. */
export type ConfigParse =
  | { readonly ok: true; readonly config: WikiConfig; readonly warnings: readonly ConfigProblem[] }
  | { readonly ok: false; readonly problems: readonly ConfigProblem[] };

/** What the machine knows that the wiki file refers to. */
export type MachineFacts = { readonly modelProfiles: ReadonlySet<string> };

/** Thrown by Wiki.config() while the file is broken. */
export class WikiConfigError extends Error {
  readonly problems: readonly ConfigProblem[];
  constructor(problems: readonly ConfigProblem[]) {
    super(describeConfigProblems(problems));
    this.problems = problems;
  }
}

export function describeConfigProblems(problems: readonly ConfigProblem[]): string {
  return [`${CONFIG_FILE} has ${problems.length} problem(s):`, ...problems.map((p) => `  ${p.key}: ${p.problem}. Fix: ${p.fix}`)].join('\n');
}

const TOP_KEYS = ['version', 'locale', 'time_zone', 'fallback_domain', 'domains', 'feeds'];
const DOMAIN_KEYS = ['description', 'agents_may_read', 'model_profile', 'page_types'];
const PAGE_TYPE_KEYS = ['description', 'example'];
const FEED_KEYS = ['domain'];
const BAD_NAME_CHARS = /[\\/:*?"<>|[\]#^\p{Cc}]/u;

/** Why `name` cannot be a domain folder, or null. */
function domainNameProblem(name: string): string | null {
  if (name.trim() === '') return 'is empty';
  if (name !== name.trim()) return 'starts or ends with a space';
  if (name.startsWith('_') || name.startsWith('.')) return 'starts with `_` or `.`, which the wiki keeps for its own folders';
  if (name === 'inbox' || name === 'root') return `is reserved: \`${name}\` means something else to the gateway`;
  if (BAD_NAME_CHARS.test(name)) return 'holds a character that breaks a file name or a [[link]] (\\ / : * ? " < > | [ ] # ^)';
  return null;
}

/**
 * Text to WikiConfig. Never throws. Every problem is collected, so one round of fixes is enough.
 * Keys are read through parseDocument with maps kept as Maps, because a plain object moves an
 * integer-like key such as `2026` to the front.
 */
export function parseWikiConfig(text: string, machine: MachineFacts): ConfigParse {
  const problems: ConfigProblem[] = [];
  const warnings: ConfigProblem[] = [];
  const add = (key: string, problem: string, fix: string) => void problems.push({ key, problem, fix });

  const doc = parseDocument(text);
  if (doc.errors.length) {
    return { ok: false, problems: doc.errors.map((e) => ({ key: CONFIG_FILE, problem: `YAML error: ${e.message.split('\n')[0]}`, fix: 'correct the YAML at that line' })) };
  }
  const top = fields(doc.toJS({ mapAsMap: true }), CONFIG_FILE, TOP_KEYS, add);
  if (!top) return { ok: false, problems };

  if (top.get('version') !== CONFIG_VERSION) {
    add('version', `is ${JSON.stringify(top.get('version') ?? null)}, and this gateway reads version ${CONFIG_VERSION}`, `set \`version: ${CONFIG_VERSION}\`, or update dotoriwiki if the file came from a newer one`);
  }
  const locale = top.get('locale');
  if (!LOCALES.includes(locale as Locale)) add('locale', `is ${JSON.stringify(locale ?? null)}`, `use one of ${LOCALES.join(', ')}`);
  const timeZone = top.get('time_zone');
  if (typeof timeZone !== 'string' || !validTz(timeZone)) add('time_zone', `is ${JSON.stringify(timeZone ?? null)}, not an IANA time zone`, 'use an IANA zone such as America/Chicago');

  const domains = new Map<DomainName, DomainConfig>();
  const written = new Set<string>();
  const rawDomains = top.get('domains');
  if (!(rawDomains instanceof Map) || rawDomains.size === 0) {
    add('domains', 'needs at least one domain', 'add an entry per domain folder, each with a description and page_types');
  } else {
    for (const [k, v] of rawDomains) {
      const name = String(k).normalize('NFC') as DomainName;
      const at = `domains.${name}`;
      written.add(name);
      const bad = domainNameProblem(name);
      if (bad) {
        add(at, `the name ${bad}`, 'rename the folder and this key');
        continue;
      }
      if (domains.has(name)) {
        add(at, 'is declared twice (the two keys differ only in Unicode normalization)', 'keep one entry');
        continue;
      }
      const d = parseDomain(name, v, machine, add, warnings);
      if (d) domains.set(name, d);
    }
  }
  const declared = (key: string, v: unknown): DomainName | null => {
    const name = typeof v === 'string' ? (v.normalize('NFC') as DomainName) : null;
    if (name && domains.has(name)) return name;
    if (name && written.has(name)) return null;
    add(key, `is ${JSON.stringify(v ?? null)}, which is not one of the domains (${[...domains.keys()].join(', ')})`, 'name a key under `domains`');
    return null;
  };

  const fallbackDomain = declared('fallback_domain', top.get('fallback_domain'));

  const feeds = new Map<FeedName, { domain: DomainName }>();
  const rawFeeds = top.get('feeds');
  if (rawFeeds !== undefined && rawFeeds !== null) {
    if (!(rawFeeds instanceof Map)) add('feeds', 'expected a mapping of feed names', `use keys from ${FEED_NAMES.join(', ')}`);
    else {
      for (const [k, v] of rawFeeds) {
        const name = String(k);
        if (!FEED_NAMES.includes(name as FeedName)) {
          add(`feeds.${name}`, 'is not a feed this gateway collects', `use one of ${FEED_NAMES.join(', ')}`);
          continue;
        }
        const f = fields(v, `feeds.${name}`, FEED_KEYS, add);
        const domain = f && declared(`feeds.${name}.domain`, f.get('domain'));
        if (domain) feeds.set(name as FeedName, { domain });
      }
    }
  }

  if (problems.length || !fallbackDomain) return { ok: false, problems: [...problems, ...warnings] };
  return {
    ok: true,
    config: { locale: locale as Locale, timeZone: timeZone as TimeZone, domains, fallbackDomain, feeds },
    warnings,
  };
}

type Add = (key: string, problem: string, fix: string) => void;

function parseDomain(name: DomainName, v: unknown, machine: MachineFacts, add: Add, warnings: ConfigProblem[]): DomainConfig | null {
  const at = `domains.${name}`;
  const f = fields(v, at, DOMAIN_KEYS, add);
  if (!f) return null;
  const description = line(f.get('description'), `${at}.description`, add, 'say in one line what belongs in this domain; the classifier routes by it');
  const agents = f.get('agents_may_read') ?? false;
  if (typeof agents !== 'boolean') add(`${at}.agents_may_read`, `is ${JSON.stringify(agents)}`, 'use true or false');
  let modelProfile: ModelProfile | null = null;
  const profile = f.get('model_profile');
  if (profile !== undefined && profile !== null) {
    if (typeof profile !== 'string' || profile.trim() === '') add(`${at}.model_profile`, `is ${JSON.stringify(profile)}`, 'name a key of the `edit` map in models.json');
    else if (!machine.modelProfiles.has(profile.normalize('NFC'))) {
      warnings.push({ key: `${at}.model_profile`, problem: `${profile} is not in this machine's models.json, so ${name} runs on edit.default`, fix: `add edit.${profile} to models.json, or remove model_profile` });
    } else modelProfile = profile.normalize('NFC') as ModelProfile;
  }
  const pageTypes: PageTypeSpec[] = [];
  const rawTypes = f.get('page_types');
  if (!(rawTypes instanceof Map) || rawTypes.size === 0) {
    add(`${at}.page_types`, 'needs at least one page type', 'add a type with a description, such as `concept: { description: One idea }`');
  } else {
    for (const [k, tv] of rawTypes) {
      const type = String(k);
      const tat = `${at}.page_types.${type}`;
      if (!/^[^\s`|[\]]+$/.test(type)) add(tat, 'the type name is empty or holds a space, backtick, `|`, or bracket', 'use one word');
      else if (type === 'answer') add(tat, '`answer` is the type of saved chat answers, which every domain has', 'pick another name');
      const t = fields(tv, tat, PAGE_TYPE_KEYS, add);
      if (!t) continue;
      const description = line(t.get('description'), `${tat}.description`, add, 'say in one line what a page of this type holds');
      const example = t.get('example') ?? null;
      if (example !== null && (typeof example !== 'string' || !example.endsWith('.md') || example.startsWith('/') || example.split('/').includes('..'))) {
        add(`${tat}.example`, `is ${JSON.stringify(example)}`, 'give a path under wiki/ ending in .md, such as `people/Sam.md`');
      }
      pageTypes.push({ type, description: description ?? '', example: typeof example === 'string' ? example : null });
    }
  }
  if (description === null || !pageTypes.length) return null;
  return { name, description, agentsMayRead: agents === true, modelProfile, pageTypes: pageTypes as [PageTypeSpec, ...PageTypeSpec[]] };
}

/** The mapping at `at` with string keys, unknown keys reported; null (reported) when it is not a mapping. */
function fields(v: unknown, at: string, allowed: readonly string[], add: Add): Map<string, unknown> | null {
  if (!(v instanceof Map)) {
    add(at, `expected a mapping of ${allowed.join(', ')}`, 'indent the keys under it');
    return null;
  }
  const out = new Map<string, unknown>();
  for (const [k, value] of v) {
    const key = String(k);
    if (allowed.includes(key)) out.set(key, value);
    else add(at === CONFIG_FILE ? key : `${at}.${key}`, 'is not a known key', `check the spelling, or remove it (known: ${allowed.join(', ')})`);
  }
  return out;
}

function line(v: unknown, at: string, add: Add, fix: string): string | null {
  if (typeof v === 'string' && v.trim() !== '' && !v.includes('\n')) return v.trim();
  add(at, v === undefined || v === null ? 'is missing' : 'must be one non-empty line', fix);
  return null;
}

/** NFC and trim, then a declared domain, or null. */
export function domainIn(config: WikiConfig, name: string): DomainName | null {
  const n = name.normalize('NFC').trim() as DomainName;
  return config.domains.has(n) ? n : null;
}

const cell = (s: string) => s.replaceAll('|', '\\|');

/** The domain list the classifier and the root chat read after the root CLAUDE.md. Korean until P2 localizes prompts. */
export function renderDomainCatalog(config: WikiConfig): string {
  return [
    '## 도메인 목록',
    '',
    '| 폴더 | 한 줄 정의 |',
    '| --- | --- |',
    ...[...config.domains.values()].map((d) => `| \`${d.name}\` | ${cell(d.description)} |`),
  ].join('\n');
}

/** The domain's page types, read by ingest and domain chat after its CLAUDE.md. */
export function renderPageTypes(domain: DomainConfig): string {
  return [
    '## 페이지 종류',
    '',
    '| type | 예시 파일 | 내용 |',
    '| --- | --- | --- |',
    ...domain.pageTypes.map((t) => `| \`${t.type}\` | ${t.example ? `\`${cell(t.example)}\`` : ''} | ${cell(t.description)} |`),
  ].join('\n');
}
