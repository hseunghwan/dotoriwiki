/**
 * Which model answers which call: the `models.json` shape, its parser, and the router that
 * implements the wiki's one Llm port by picking a provider per call.
 *
 * The file is optional and belongs to the machine. Each role it leaves out keeps the Claude
 * default. `edit` maps profile names to choices; a domain names its profile in dotoriwiki.yaml,
 * so this file never names a domain.
 */

import { readFileSync } from 'node:fs';
import type { ClassifyRequest, EditRequest, Llm } from './wiki/index.ts';

const EFFORTS = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['minimal', 'low', 'medium', 'high', 'xhigh'],
} as const;

export type Provider = keyof typeof EFFORTS;
export type ModelChoice = {
  readonly [P in Provider]: { readonly provider: P; readonly model: string; readonly effort?: (typeof EFFORTS)[P][number] };
}[Provider];
export type ClaudeChoice = Extract<ModelChoice, { provider: 'claude' }>;
export type CodexChoice = Extract<ModelChoice, { provider: 'codex' }>;

export type Models = {
  readonly classify: ModelChoice;
  /** Chat streams partial text and resumes sessions, which only the Claude adapter does. */
  readonly chat: ClaudeChoice;
  readonly edit: { readonly default: ModelChoice; readonly profiles: ReadonlyMap<string, ModelChoice> };
};

export const DEFAULT_MODELS: Models = {
  classify: { provider: 'claude', model: 'haiku', effort: 'low' },
  chat: { provider: 'claude', model: 'sonnet' },
  edit: { default: { provider: 'claude', model: 'sonnet' }, profiles: new Map() },
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isProvider = (p: unknown): p is Provider => typeof p === 'string' && Object.hasOwn(EFFORTS, p);

function onlyKeys(v: Record<string, unknown>, allowed: readonly string[], at: string): void {
  const extra = Object.keys(v).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`${at}: unknown key ${extra.map((k) => `"${k}"`).join(', ')}`);
}

function parseChoice(v: unknown, at: string): ModelChoice {
  if (!isObj(v)) throw new Error(`${at}: expected {"provider", "model", "effort"?}`);
  onlyKeys(v, ['provider', 'model', 'effort'], at);
  const { provider, model, effort } = v;
  if (!isProvider(provider)) throw new Error(`${at}.provider: expected one of ${Object.keys(EFFORTS).join(', ')}, got ${JSON.stringify(provider)}`);
  if (typeof model !== 'string' || !model.trim() || model.startsWith('-')) throw new Error(`${at}.model: expected a model name`);
  const efforts: readonly string[] = EFFORTS[provider];
  if (effort !== undefined && (typeof effort !== 'string' || !efforts.includes(effort))) {
    throw new Error(`${at}.effort: ${provider} takes one of ${efforts.join(', ')}, got ${JSON.stringify(effort)}`);
  }
  return { provider, model, ...(effort === undefined ? {} : { effort }) } as ModelChoice;
}

/** Throws a message naming the bad entry. */
export function parseModels(raw: unknown): Models {
  if (!isObj(raw)) throw new Error('models.json: expected an object');
  onlyKeys(raw, ['classify', 'chat', 'edit'], 'models.json');
  const classify = raw.classify === undefined ? DEFAULT_MODELS.classify : parseChoice(raw.classify, 'classify');
  const chat = raw.chat === undefined ? DEFAULT_MODELS.chat : parseChoice(raw.chat, 'chat');
  if (chat.provider !== 'claude') throw new Error('chat: only the claude provider can run chat');
  if (raw.edit === undefined) return { classify, chat, edit: DEFAULT_MODELS.edit };
  if (!isObj(raw.edit) || raw.edit.default === undefined) throw new Error('edit: expected {"default", "<profile>"?...}');
  const profiles = new Map<string, ModelChoice>();
  for (const [key, value] of Object.entries(raw.edit)) if (key !== 'default') profiles.set(key.normalize('NFC'), parseChoice(value, `edit."${key}"`));
  return { classify, chat, edit: { default: parseChoice(raw.edit.default, 'edit.default'), profiles } };
}

/** The profile names a domain's model_profile may use. */
export const profileNames = (m: Models) => ['default', ...m.edit.profiles.keys()];

/** An absent file means the defaults; an unreadable or invalid one throws. */
export function loadModels(path: string): Models {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_MODELS;
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`);
  }
  try {
    return parseModels(raw);
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`);
  }
}

/** The one Llm the wiki sees. `llmFor` binds a provider adapter to one choice. */
export function routeLlm(models: Models, llmFor: (choice: ModelChoice) => Llm): Llm {
  const classifier = llmFor(models.classify);
  const editDefault = llmFor(models.edit.default);
  const editors = new Map([...models.edit.profiles].map(([p, c]) => [p, llmFor(c)] as const));
  return {
    classify: (req: ClassifyRequest) => classifier.classify(req),
    edit: (req: EditRequest) => (editors.get(req.modelProfile ?? 'default') ?? editDefault).edit(req),
  };
}

/** What every provider is asked to answer in, so a wiki check never depends on the provider. */
export const classifySchema = (domains: readonly string[]) => ({
  type: 'object',
  properties: {
    domain: { type: 'string', enum: domains },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: 'string' },
  },
  required: ['domain', 'confidence', 'reason'],
  additionalProperties: false,
});

export const editSchema = (verdicts: readonly string[]) => ({
  type: 'object',
  properties: { verdict: { type: 'string', enum: verdicts }, pages: { type: 'array', items: { type: 'string' } } },
  required: ['verdict', 'pages'],
  additionalProperties: false,
});
