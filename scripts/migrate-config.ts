/**
 * One-time: gives a wiki made before dotoriwiki.yaml its config file, keeping its history.
 *
 *   node scripts/migrate-config.ts <wiki root> --fallback 일상 [--feeds-to <domain>] \
 *     [--time-zone Asia/Seoul] [--locale ko] [--models ~/.config/llmwiki/models.json]
 *
 * Stop the old gateway first. The root CLAUDE.md `## 도메인 목록` table becomes `domains` with
 * descriptions and agents_may_read (허용 → true). Each domain's `## 페이지 종류` table becomes its
 * page_types. A models.json `edit` key that names a domain becomes that domain's model_profile,
 * so the machine file keeps working unchanged. Each table is replaced by a line pointing at the
 * new file, and the prose around it stays. Nothing under raw/, wiki/, hold/, or inbox/ changes
 * and no domain is renamed, so every ledger line still names a declared domain.
 *
 * The written file must parse and say what the tables said, or nothing is written. Then one
 * commit. A wiki that already has dotoriwiki.yaml is left alone.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Document } from 'yaml';
import { CONFIG_FILE, CONFIG_VERSION, FEED_NAMES, parseWikiConfig, type WikiConfig } from '../src/wiki/index.ts';

export type LegacyPageType = { readonly type: string; readonly example: string | null; readonly description: string };
export type LegacyDomain = { readonly name: string; readonly description: string; readonly agentsMayRead: boolean; readonly pageTypes: readonly LegacyPageType[] };

export type MigrateFlags = {
  readonly fallback: string;
  readonly feedsTo: string | null;
  readonly timeZone: string;
  readonly locale: string;
  /** The parsed models.json, or null when the machine has none. */
  readonly models: unknown;
};

const ROOT_HEADING = '도메인 목록';
const TYPES_HEADING = '페이지 종류';
const ROOT_POINTER = `도메인 목록과 각 도메인의 정의는 \`${CONFIG_FILE}\`에 있다.`;
const TYPES_POINTER = `페이지 종류와 예시 파일은 \`../${CONFIG_FILE}\`에 있다.`;

const nfc = (s: string) => s.normalize('NFC');

/** The section under `## heading`, as line indices [start, end). */
function sectionAt(lines: readonly string[], heading: string): [number, number] | null {
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^##? /.test(l));
  return [start, end < 0 ? lines.length : end];
}

const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replaceAll('\\|', '|'));
const code = (c: string) => /^`([^`]+)`$/.exec(c)?.[1] ?? null;

/** Rows of the table under `## heading` whose first cell is a code span, as cells. */
function tableRows(markdown: string, heading: string): string[][] {
  const lines = markdown.split('\n');
  const at = sectionAt(lines, heading);
  if (!at) return [];
  return lines.slice(...at).filter((l) => l.trim().startsWith('|')).map(cells).filter((c) => code(c[0] ?? '') !== null);
}

export function readLegacy(rootClaudeMd: string, domainClaudeMd: (name: string) => string): LegacyDomain[] {
  const rows = tableRows(rootClaudeMd, ROOT_HEADING);
  if (!rows.length) throw new Error(`the root CLAUDE.md has no ## ${ROOT_HEADING} table`);
  return rows.map(([first, description = '', exposure = '']) => {
    const name = nfc(code(first!)!);
    if (exposure !== '허용' && exposure !== '금지' && exposure !== '') throw new Error(`${name}: 다른 에이전트 공개 is ${exposure}, expected 허용 or 금지`);
    const pageTypes = tableRows(domainClaudeMd(name), TYPES_HEADING).map(([t, example = '', desc = '']) => ({ type: code(t!)!, example: code(example) ?? (example || null), description: desc }));
    if (!pageTypes.length) throw new Error(`${name}/CLAUDE.md has no ## ${TYPES_HEADING} table; if a run stopped part way, restore it with git checkout and run again`);
    return { name, description, agentsMayRead: exposure === '허용', pageTypes };
  });
}

/** edit keys of models.json that name a domain become that domain's profile. */
function profiles(models: unknown): Set<string> {
  const edit = (models as { edit?: unknown } | null)?.edit;
  return new Set(['default', ...(edit && typeof edit === 'object' ? Object.keys(edit).map(nfc) : [])]);
}

export function configText(domains: readonly LegacyDomain[], flags: MigrateFlags): string {
  const known = profiles(flags.models);
  const doc = new Document(new Map<string, unknown>([
    ['version', CONFIG_VERSION],
    ['locale', flags.locale],
    ['time_zone', flags.timeZone],
    ['fallback_domain', nfc(flags.fallback)],
    ['domains', new Map(domains.map((d) => [d.name, new Map<string, unknown>([
      ['description', d.description],
      ...(d.agentsMayRead ? [['agents_may_read', true] as const] : []),
      ...(known.has(d.name) ? [['model_profile', d.name] as const] : []),
      ['page_types', new Map(d.pageTypes.map((t) => [t.type, new Map([['description', t.description], ...(t.example ? [['example', t.example] as const] : [])])]))],
    ])]))],
    ...(flags.feedsTo ? [['feeds', new Map(FEED_NAMES.map((f) => [f, new Map([['domain', nfc(flags.feedsTo!)]])]))] as const] : []),
  ]));
  doc.commentBefore = ' This wiki\'s settings, read by the gateway on every request. Machine settings stay in the env file.';
  return doc.toString({ lineWidth: 0 });
}

/** Replaces the table under `## heading` with `pointer`; a section left with nothing else loses its heading too. */
export function stripTable(markdown: string, heading: string, pointer: string): string {
  const lines = markdown.split('\n');
  const at = sectionAt(lines, heading);
  if (!at) return markdown;
  const body = lines.slice(at[0] + 1, at[1]);
  const first = body.findIndex((l) => l.trim().startsWith('|'));
  if (first < 0) return markdown;
  let end = first;
  while (end < body.length && body[end]!.trim().startsWith('|')) end++;
  const rest = [...body.slice(0, first), pointer, ...body.slice(end)];
  const onlyPointer = rest.every((l) => l.trim() === '' || l === pointer);
  const section = onlyPointer ? ['', pointer, ''] : [lines[at[0]]!, ...rest];
  const before = lines.slice(0, at[0]);
  while (onlyPointer && before.length && before.at(-1)!.trim() === '') before.pop();
  return [...before, ...section, ...lines.slice(at[1])].join('\n');
}

/** Every way the parsed config differs from the tables, as lines. */
export function differences(config: WikiConfig, legacy: readonly LegacyDomain[]): string[] {
  const out: string[] = [];
  const declared = [...config.domains.values()];
  if (declared.map((d) => d.name).join('\n') !== legacy.map((d) => d.name).join('\n')) out.push('domain list or order');
  for (const l of legacy) {
    const d = config.domains.get(l.name as never);
    if (!d) continue;
    if (d.description !== l.description) out.push(`${l.name}: description`);
    if (d.agentsMayRead !== l.agentsMayRead) out.push(`${l.name}: agents_may_read`);
    if (JSON.stringify(d.pageTypes) !== JSON.stringify(l.pageTypes.map((t) => ({ type: t.type, description: t.description, example: t.example })))) out.push(`${l.name}: page_types`);
  }
  return out;
}

export async function migrate(root: string, flags: MigrateFlags): Promise<'migrated' | 'already-migrated'> {
  if (existsSync(join(root, CONFIG_FILE))) return 'already-migrated';
  const rootMd = await fs.readFile(join(root, 'CLAUDE.md'), 'utf8');
  const legacy = readLegacy(rootMd, (d) => readFileSync(join(root, d, 'CLAUDE.md'), 'utf8'));
  const text = configText(legacy, flags);
  const parsed = parseWikiConfig(text, { modelProfiles: profiles(flags.models) });
  if (!parsed.ok) throw new Error(`the written config does not parse:\n${parsed.problems.map((p) => `  ${p.key}: ${p.problem}`).join('\n')}`);
  const diff = differences(parsed.config, legacy);
  if (diff.length) throw new Error(`the written config differs from the tables: ${diff.join(', ')}`);

  const changed = ['CLAUDE.md', ...legacy.map((d) => `${d.name}/CLAUDE.md`)];
  await fs.writeFile(join(root, 'CLAUDE.md'), stripTable(rootMd, ROOT_HEADING, ROOT_POINTER));
  for (const d of legacy) {
    const path = join(root, d.name, 'CLAUDE.md');
    await fs.writeFile(path, stripTable(await fs.readFile(path, 'utf8'), TYPES_HEADING, TYPES_POINTER));
  }
  await fs.writeFile(join(root, CONFIG_FILE), text);
  if (existsSync(join(root, '.git'))) {
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=dotoriwiki-migrate', '-c', 'user.email=migrate@localhost', ...args], { cwd: root });
    git('add', '--', CONFIG_FILE, ...changed);
    git('commit', '-q', '-m', `config: move the domain and page-type tables into ${CONFIG_FILE}`, '--', CONFIG_FILE, ...changed);
  }
  return 'migrated';
}

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { fallback: { type: 'string' }, 'feeds-to': { type: 'string' }, 'time-zone': { type: 'string' }, locale: { type: 'string', default: 'ko' }, models: { type: 'string' } },
  });
  const root = positionals[0];
  if (!root || !values.fallback) {
    console.error('usage: node scripts/migrate-config.ts <wiki root> --fallback <domain> [--feeds-to <domain>] [--time-zone <zone>] [--locale ko|en] [--models <models.json>]');
    process.exit(2);
  }
  const result = await migrate(root, {
    fallback: values.fallback,
    feedsTo: values['feeds-to'] ?? null,
    timeZone: values['time-zone'] ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: values.locale,
    models: values.models && existsSync(values.models) ? JSON.parse(readFileSync(values.models, 'utf8')) : null,
  });
  console.log(result);
}
