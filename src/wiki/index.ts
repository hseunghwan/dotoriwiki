/**
 * Wiki: the only module that writes the wiki folder, and the only place that computes job state.
 *
 * There is no queue store. Each call recomputes every state below from the files, so "after a
 * restart" is simply "the next call". Each transition is one atomic filesystem step (link,
 * rename, or git commit) and first checks whether it has already happened.
 *
 * Folder contract (relative to the wiki root):
 *
 *   inbox/<id>.md                     memo awaiting routing       accept(), or any producer via tmp + link
 *   inbox/answers/<domain>/<id>.md    answer awaiting filing      fileAnswer()
 *   <domain>/hold/<id>.md             memo waiting for the user   routeNext() when unsure; confirm() renames it to raw/
 *   <domain>/raw/<id>.md              routed memo, immutable      routeNext() when sure, confirm(), or move(); written once
 *   <domain>/raw/<id>.source.md       enrichment sidecar          runNext(), written once after the marker, before the LLM runs
 *   _originals/<id>-<n>.<ext>         a photo as uploaded         storePhoto(); never committed (openWiki checks .gitignore)
 *   _attachments/<id>-<n>.jpg         its 2048 px copy            storePhoto(), remade by accept() if gone; committed with the ingest
 *   <domain>/wiki/**                  pages                       changed only inside runNext(domain)
 *   <domain>/wiki/log.md              THE LEDGER                  appended by runNext/retry/move; anything the LLM writes to it is reset
 *   dotoriwiki.yaml                   the wiki's configuration    written by the user; committed as manual(config) before a job
 *   .gateway/inflight/<domain>.json   "a job is mid-flight"       exists only while runNext(domain) is mid-job
 *   .gateway/lock                     one gateway process         (pid, process start time)
 *
 * Derived state. L(d) is the ledger parsed from HEAD:<d>/wiki/log.md, so only committed lines count.
 *
 *   memo inbox        inbox/<id>.md exists, and no <d>/raw/<id>.md or <d>/hold/<id>.md exists
 *   memo held         <d>/hold/<id>.md exists, and no <d'>/raw/<id>.md exists (else the hold copy is a leftover)
 *   memo routed       <d>/raw/<id>.md exists, and L(d) has no terminal line for ingest:<id>
 *   memo running      memo routed in d, and .gateway/inflight/<d>.json names ingest:<id>
 *   memo ingested     L(d) has an applied line for ingest:<id>
 *   memo failed       L(d) has a gave-up line for ingest:<id>
 *   memo moved out    L(d) has a moved-to-<d'> line for ingest:<id>, and <d>/raw/<id>.md is gone from HEAD
 *   move unfinished   memo failed in d, and some <d'>/raw/<id>.md has routing {by: user, from: d}
 *   attempts          failed and interrupted lines for ingest:<id> in L(d) since its latest retry
 *   answer pending    inbox/answers/<d>/<id>.md exists, and L(d) has no terminal line for file-answer:<id>
 *   domain running    .gateway/inflight/<d>.json exists
 *
 * Done means committed. A log.md line in the working tree but not in HEAD counts for nothing.
 * hold/ is never committed and never picked: a held memo has no job until the user releases it.
 *
 * Config rule. Every call that needs the configuration reads dotoriwiki.yaml (re-parsed only when
 * its text changed) and checks each declared domain has its CLAUDE.md. While that fails the wiki
 * is paused: routeNext and runNext report `paused`, the calls that need the domain list throw
 * WikiConfigError, and accept() still writes the inbox. The next call after a fix resumes.
 *
 * Only this file is importable from outside src/wiki/ (test/boundary.test.ts). git.ts in
 * particular must stay unreachable: a commit made outside runNext would break the ledger.
 */

import { createHash, randomBytes } from 'node:crypto';
import { promises as fs, watch as fsWatch } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import {
  CONFIG_FILE, domainIn, parseWikiConfig, renderDomainCatalog, renderPageTypes, WikiConfigError, type ConfigParse, type ConfigProblem, type DomainConfig,
  type Locale, type MachineFacts, type ModelProfile, type WikiConfig,
} from './config.ts';
import { openGit, type AppendedLine, type Git } from './git.ts';
import {
  acquireLock, clearInflight, composeSystemPrompt, exists, layout, linkExclusive, listMarkdown, listNames,
  readIfExists, readInflight, sweepTmp, unlinkQuiet, writeExclusive, writeInflight, type InflightMarker, type Layout,
} from './layout.ts';
import {
  appendLine, INGEST_VERDICTS, lineKey, parseLedger, renderThird, verdictText, type Failure, type JobHistory, type Ledger, type NewOutcome, type VerdictId,
} from './ledger.ts';
import {
  check, describeProblems, firstProblem, extractWikilinks, linkResolves, namesOf, PAGE_FIELDS, pageMeta, pageRefString, parseAnswerId,
  parseAnswerStaging, parseMemoFile, parseMemoId, renderAnswerPage, renderAnswerStaging, renderIndex, renderMemoFile,
  roleOf, type MEMO_SOURCES, type PageNameIndex, type Problem,
} from './pages.ts';
import {
  attachmentName, describePhoto, photoFacts, photoLocation, photoStem, sha256Hex, sniffPhoto, type Attachment, type AttachmentRequest,
} from './photos.ts';
import { isoWithOffset, linksToFetch, renderSourceFile } from './sources.ts';

export type { ConfigParse, ConfigProblem, DomainConfig, FeedName, Locale, MachineFacts, ModelProfile, PageTypeSpec, TimeZone, WikiConfig } from './config.ts';
export { CONFIG_FILE, CONFIG_VERSION, FEED_NAMES, WikiConfigError, domainIn, parseWikiConfig } from './config.ts';
export type { JobHistory, VerdictId } from './ledger.ts';
export { lineKey, parseLedger, verdictText } from './ledger.ts';
export type { Parsed, Problem } from './pages.ts';
export { pageRefString, parseAnswerId, parseMemo, parseMemoId } from './pages.ts';
export type { SourceEntry, SourceFile } from './sources.ts';
export type { Attachment, AttachmentRequest, PhotoDevice, PhotoOrigin } from './photos.ts';
export { describeDevice, MAX_PHOTO_BYTES, MAX_PHOTOS } from './photos.ts';
export { isoWithOffset, parseSourceFile } from './sources.ts';


/** A domain declared in dotoriwiki.yaml. NFC. Minted only by parseWikiConfig. */
export type DomainName = string & { readonly __brand: 'DomainName' };
/** Client-made ULID or UUID, normalized. Minted only by parseMemoId / parseAnswerId. */
export type MemoId = string & { readonly __brand: 'MemoId' };
export type AnswerId = string & { readonly __brand: 'AnswerId' };


export type MemoSource = (typeof MEMO_SOURCES)[number];
export type GeoPoint = { readonly lat: number; readonly lon: number; readonly place: string | null; readonly address: string | null };
export type MemoContext = { readonly project: string; readonly cwd: string; readonly branch: string | null };

/** A memo as captured. Mirrors 공통규칙 "원본 메모 frontmatter"; `text` is the file body. */
export type Memo = {
  readonly id: MemoId;
  readonly text: string;
  readonly capturedAt: string;
  readonly tz: string;
  readonly location: GeoPoint | null;
  readonly source: MemoSource;
  /** Unvalidated user text. Checked at routing, not at accept, because outside producers write the inbox too. */
  readonly domainHint: string | null;
  /** Set by agents writing from a working directory; null for phone memos. */
  readonly context: MemoContext | null;
  readonly attachments: readonly Attachment[];
};

/** A memo as sent, before accept reads its photos: they are named by number only. */
export type NewMemo = Omit<Memo, 'attachments'> & { readonly attachments: readonly AttachmentRequest[] };

/** How a memo reached its domain. Written once into raw/<id>.md frontmatter as `routing:`. */
export type Routing =
  | { readonly by: 'hint' }
  | { readonly by: 'classifier'; readonly confidence: number; readonly reason: string }
  | { readonly by: 'fallback'; readonly reason: string }
  | { readonly by: 'user'; readonly from: DomainName; readonly previous: Routing | null };

export type MemoState = 'inbox' | 'held' | 'routed' | 'running' | 'ingested' | 'failed';

export type HeldMemo = {
  readonly id: MemoId;
  readonly domain: DomainName;
  readonly text: string;
  readonly capturedAt: string;
  readonly source: MemoSource;
  readonly routing: Routing;
};

export type ReleaseResult =
  | { readonly kind: 'released'; readonly domain: DomainName }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'conflict'; readonly state: Exclude<MemoState, 'inbox'>; readonly domain: DomainName };

/** Memo lists are newest captured first; a cursor without an id excludes everything captured at that instant. */
export type MemoCursor = { readonly capturedAt: string; readonly id: MemoId | null };

/** An applied line's verdict: its id, null for text from before the gateway, and that verdict in the wiki's current words. */
export type MemoVerdict = { readonly id: VerdictId | null; readonly text: string };

/** A memo and how far it got. `finishedAt` is the committer time of the commit that wrote the terminal ledger line. */
export type MemoSummary = { readonly memo: Memo } & (
  | { readonly state: 'inbox'; readonly domain: null }
  | { readonly state: 'held' | 'routed' | 'running'; readonly domain: DomainName }
  | { readonly state: 'ingested'; readonly domain: DomainName; readonly verdict: MemoVerdict; readonly firstPage: string | null; readonly finishedAt: string | null }
  | { readonly state: 'failed'; readonly domain: DomainName; readonly finishedAt: string | null }
);

/** A page the ingest commit wrote. `path` is under <d>/wiki/, without `.md`. */
export type MemoPage = { readonly path: string; readonly type: string | null; readonly change: 'created' | 'modified' };

/** Why the memo gave up, or why its earlier attempts failed while it waits for the next. `code` is a Problem rule or `interrupted`. */
export type MemoFailure = { readonly attempts: number; readonly max: number; readonly code: string; readonly detail: string };

export type MemoDetail = MemoSummary & {
  readonly routing: Routing | null;
  readonly pages: readonly MemoPage[];
  readonly failure: MemoFailure | null;
};

export type AcceptResult =
  | { readonly kind: 'created' }
  | { readonly kind: 'duplicate'; readonly state: MemoState; readonly domain: DomainName | null }
  | { readonly kind: 'missing-photo'; readonly n: number };

export type StorePhotoResult =
  | { readonly kind: 'stored' | 'same'; readonly name: string; readonly sha256: string; readonly bytes: number }
  | { readonly kind: 'conflict'; readonly name: string }
  | { readonly kind: 'unsupported' };


/** A wiki page: `page` is its path under <domain>/wiki/ without `.md`, or just its basename. */
export type PageRef = { readonly domain: DomainName; readonly page: string };

export type AnswerFiling = {
  readonly id: AnswerId;
  readonly domain: DomainName;
  readonly question: string;
  readonly answer: string;
  readonly cited: readonly PageRef[];
  readonly sessionId: string | null;
  readonly askedAt: string;
};

export type FileAnswerResult =
  | { readonly kind: 'created' }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'rejected'; readonly reason: string };

/** "도메인/wiki/페이지" names that domain's page; anything else is a page in `defaultDomain`. */
export function parsePageRef(s: string, defaultDomain: DomainName, domains: readonly DomainName[]): PageRef | null {
  const t = s.normalize('NFC').trim().replace(/^\[\[|\]\]$/g, '').replace(/\.md$/, '');
  if (!t) return null;
  const m = /^(.+?)\/wiki\/(.+)$/.exec(t);
  const domain = m ? domains.find((d) => d === m[1]) : undefined;
  return domain ? { domain, page: m![2]! } : { domain: defaultDomain, page: t };
}


export type JobKind = 'ingest' | 'file-answer' | 'lint';

/** `id` is the memo id or the answer id. Ledger key is `${kind}:${id}`. */
export type JobRef = { readonly kind: JobKind; readonly domain: DomainName; readonly id: string };

export type RouteReport =
  | { readonly kind: 'idle' }
  | { readonly kind: 'routed' | 'held'; readonly id: MemoId; readonly domain: DomainName; readonly routing: Routing }
  | { readonly kind: 'dropped-duplicate'; readonly id: MemoId }
  | { readonly kind: 'rejected'; readonly file: string; readonly reason: string }
  | { readonly kind: 'unavailable'; readonly reason: string; readonly retryAfterMs: number }
  | { readonly kind: 'paused'; readonly problems: readonly ConfigProblem[] };

export type RunReport =
  | { readonly kind: 'idle' }
  | { readonly kind: 'committed'; readonly job: JobRef; readonly commit: string; readonly verdict: VerdictId }
  | { readonly kind: 'retrying'; readonly job: JobRef; readonly attempt: number; readonly problems: readonly Problem[] }
  | { readonly kind: 'gave-up'; readonly job: JobRef; readonly problems: readonly Problem[] }
  | { readonly kind: 'unavailable'; readonly job: JobRef; readonly reason: string; readonly retryAfterMs: number }
  | { readonly kind: 'paused' };

export type RetryResult = { readonly kind: 'retrying' } | { readonly kind: 'not-failed' };


export type DomainStatus = {
  readonly domain: DomainName;
  readonly agentsMayRead: boolean;
  readonly modelProfile: ModelProfile | null;
  readonly pending: number;
  readonly held: number;
  readonly failed: number;
  readonly running: (JobRef & { readonly since: string }) | null;
};
/** Paused: `domains` is empty and `problems` say why. Running: `problems` are warnings, such as an unknown model profile. */
export type Status = { readonly inbox: number; readonly paused: boolean; readonly problems: readonly ConfigProblem[]; readonly domains: readonly DomainStatus[] };

export type ChatTarget = { readonly kind: 'root' } | { readonly kind: 'domain'; readonly domain: DomainName };
/** Where a read-only chat runs and what it is told. systemPrompt is CLAUDE.md with `@` imports inlined. */
export type ChatContext = { readonly cwd: string; readonly systemPrompt: string };

/** A file appeared that may create work. Only a hint: missing one costs latency, never correctness. */
export type Wake =
  | { readonly kind: 'router' }
  | { readonly kind: 'domain'; readonly domain: DomainName }
  | { readonly kind: 'config-changed' };


/** Infrastructure trouble: rate limit, auth, spawn failure. Never spends a job attempt. */
export type Unavailable = { readonly kind: 'unavailable'; readonly reason: string; readonly retryAfterMs: number };

export type ClassifyRequest = {
  readonly systemPrompt: string;
  readonly text: string;
  /** Becomes the JSON-schema enum, so the list is never hand-kept. */
  readonly domains: readonly DomainName[];
};
export type Classification =
  | { readonly kind: 'classified'; readonly domain: string; readonly confidence: number; readonly reason: string }
  | { readonly kind: 'no-answer'; readonly detail: string };

/** One agentic edit run in `cwd` with file tools only. */
export type EditRequest = {
  /** The domain's model_profile; null is edit.default. */
  readonly modelProfile: ModelProfile | null;
  readonly cwd: string;
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly timeoutMs: number;
  /** The one directory, relative to cwd, the run may write under. */
  readonly writableDir: string;
  /** The structured-output enum for `verdict`. */
  readonly verdicts: readonly VerdictId[];
  /** Called with every path the model tried to write, allowed or denied, absolute or relative to cwd. */
  readonly onTouch: (path: string) => void;
  /** Absolute paths of photos the model should look at; they sit outside cwd. */
  readonly images: readonly string[];
};
export type EditResult =
  | { readonly kind: 'finished'; readonly verdict: string; readonly pages: readonly string[] }
  | { readonly kind: 'failed'; readonly reason: string };

export type Llm = {
  classify(req: ClassifyRequest): Promise<Classification | Unavailable>;
  edit(req: EditRequest): Promise<EditResult | Unavailable>;
};


export type SourceKind = 'video' | 'article';
/** What one link held. A dead link is a `failed` value, not an error: the job goes on without it. */
export type FetchedSource =
  | { readonly kind: SourceKind; readonly status: 'ok'; readonly title: string; readonly text: string }
  | { readonly kind: SourceKind; readonly status: 'failed'; readonly title: string | null; readonly detail: string };
/** A rejection fails the job attempt like any other thrown error. */
export type FetchSource = (url: string) => Promise<FetchedSource>;

/** Writes `dst` as a JPEG no longer than 2048 px on its long edge. Rejects when it cannot read `src`. */
export type ShrinkPhoto = (src: string, dst: string) => Promise<void>;


export type WikiOptions = {
  readonly llm: Llm;
  /** Fills raw/<id>.source.md for the links in a memo before its ingest runs. */
  readonly fetchSource: FetchSource;
  readonly shrinkPhoto: ShrinkPhoto;
  readonly maxAttempts: number;
  /** A classifier answer below this confidence, like a fallback, waits in hold/ for the user. */
  readonly reviewBelowConfidence: number;
  readonly ingestTimeoutMs: number;
  readonly committer: { readonly name: string; readonly email: string };
  /** The keys of the machine's models.json edit map, which a domain's model_profile must name. */
  readonly modelProfiles: readonly string[];
  readonly now?: () => Date;
};

export interface Wiki {
  /**
   * dotoriwiki.yaml as of this call, or WikiConfigError while it is broken. A domain is added by
   * creating <d>/CLAUDE.md and its entry in the file; the next call sees it.
   */
  config(): Promise<WikiConfig>;
  /**
   * Makes the memo durable, never calls an LLM. Resending an id changes nothing on disk. Its
   * photos must be stored first; their metadata is read from the originals here.
   */
  accept(memo: NewMemo): Promise<AcceptResult>;
  /** Keeps photo n of a memo as sent. The same bytes again are `same`; other bytes are a conflict. */
  storePhoto(id: MemoId, n: number, bytes: Uint8Array): Promise<StorePhotoResult>;
  /** The absolute path of an _attachments/ file, or null when the name is not one. */
  attachmentPath(file: string): Promise<string | null>;
  /** Checks every cited page exists at HEAD, then stages the answer for its domain worker. */
  fileAnswer(filing: AnswerFiling): Promise<FileAnswerResult>;
  /** Routes the oldest inbox memo. Unavailable and paused leave it in the inbox untouched. */
  routeNext(): Promise<RouteReport>;
  /** Memos waiting in hold/, oldest captured first. */
  held(): Promise<readonly HeldMemo[]>;
  /** Every memo in the inbox, held, or in a domain, newest captured first, strictly after `before` in that order. */
  memos(opts: { readonly limit: number; readonly before: MemoCursor | null }): Promise<readonly MemoSummary[]>;
  memo(id: MemoId): Promise<MemoDetail | null>;
  /** Releases a held memo into its domain's queue unchanged. */
  confirm(id: MemoId): Promise<ReleaseResult>;
  /**
   * Queues a held or gave-up memo in another domain, with routing `by: user`. Never an ingested
   * one: its wiki edits may already be built on. A gave-up memo moves inside its domain's lane.
   */
  move(id: MemoId, to: DomainName): Promise<ReleaseResult>;
  /**
   * Runs the domain's next derived job as one transaction ending in exactly one commit: the
   * work, or a ledger line saying why not. Unavailable commits nothing and spends no attempt.
   * With `withLlm: false`, only jobs that need no LLM are picked. A domain declared since open
   * gets its init(<d>) commit first; a domain no longer declared is idle.
   */
  runNext(domain: DomainName, opts?: { readonly withLlm?: boolean }): Promise<RunReport>;
  /** Appends a retry line for a job that gave up, so the worker picks it again. */
  retry(job: JobRef): Promise<RetryResult>;
  status(): Promise<Status>;
  chatContext(target: ChatTarget): Promise<ChatContext>;
  /** The `[[links]]` in a chat answer that name pages existing at HEAD, deduped, in order. */
  citations(text: string, target: ChatTarget): Promise<readonly PageRef[]>;
  watch(onWake: (w: Wake) => void): () => void;
  close(): Promise<void>;
}

/**
 * Takes .gateway/lock and checks the faults no edit of dotoriwiki.yaml can fix while running: the
 * root is a git work tree and the file exists with a version this gateway reads. A file broken in
 * any other way opens paused. Removes a stale .git/index.lock and orphaned .tmp-* files, and
 * commits `init(<d>)` for every declared domain not yet in HEAD. Inflight markers are left to
 * runNext, so a crash and a thrown exception take the same recovery path.
 */
export async function openWiki(root: string, opts: WikiOptions): Promise<Wiki> {
  // claude reports the paths it touched by real path, so a symlinked root (macOS tmpdir) must not count as outside.
  const lay = layout(await fs.realpath(root));
  const lock = await acquireLock(lay.lockFile);
  try {
    if (!(await exists(join(lay.root, '.git')))) throw new Error(`not a git work tree: ${lay.root}`);
    const text = await readIfExists(lay.configFile);
    if (text === null) throw new Error(`not a dotoriwiki wiki: ${lay.configFile} does not exist`);
    const version = parseWikiConfig(text, { modelProfiles: new Set() });
    const unknown = version.ok ? undefined : version.problems.find((p) => p.key === 'version');
    if (unknown) throw new Error(`${lay.configFile}: version ${unknown.problem}`);
    const git = openGit(lay.root, opts.committer);
    await git.clearIndexLock();
    if (!(await git.ignored('_originals/x.jpg'))) {
      throw new Error('_originals/ must be listed in the wiki .gitignore: original photos keep their GPS and are never committed');
    }
    await sweepTmp([lay.inboxDir, lay.inflightDir, lay.originalsDir, lay.attachmentsDir]);
    const wiki = new WikiImpl(lay, git, opts, lock);
    await wiki.bootstrap();
    await wiki.sweepOrphanPhotos();
    return wiki;
  } catch (e) {
    await lock.release();
    throw e;
  }
}


type Job =
  | { readonly kind: 'ingest'; readonly ref: JobRef; readonly order: string; readonly inputs: readonly string[] }
  | { readonly kind: 'file-answer'; readonly ref: JobRef; readonly order: string; readonly filing: AnswerFiling; readonly staging: string; readonly inputs: readonly [] }
  | { readonly kind: 'lint'; readonly ref: JobRef; readonly order: string; readonly inputs: readonly [] };

type Env = {
  readonly layout: Layout;
  readonly config: WikiConfig;
  readonly llm: Llm;
  readonly fetchSource: FetchSource;
  readonly ingestTimeoutMs: number;
  readonly today: () => string;
  readonly stamp: () => string;
};
type JobCtx = { readonly history: JobHistory; readonly touch: (path: string) => void; readonly domain: DomainConfig };
/** What a job hands to runNext: the verdict is already one the ledger can write. */
type Performed = { readonly kind: 'finished'; readonly verdict: VerdictId; readonly pages: readonly string[] } | Extract<EditResult, { kind: 'failed' }> | Unavailable;
type JobSpec<J extends Job> = {
  readonly needsLlm: boolean;
  /** Runs after the inflight marker is written, so a throw spends an attempt; may add job inputs. */
  prepare?(env: Env, job: J): Promise<J>;
  perform(env: Env, job: J, ctx: JobCtx): Promise<Performed>;
};

/** Adding a JobKind without an entry here fails type-checking. */
const JOBS: { readonly [K in JobKind]: JobSpec<Extract<Job, { kind: K }>> } = {
  ingest: { needsLlm: true, prepare: enrichIngest, perform: performIngest },
  'file-answer': { needsLlm: false, perform: performFileAnswer },
  lint: { needsLlm: true, perform: async () => ({ kind: 'failed', reason: 'lint not implemented' }) },
};

function specOf<K extends JobKind>(job: Extract<Job, { kind: K }>): JobSpec<Extract<Job, { kind: K }>> {
  return JOBS[job.kind as K] as JobSpec<Extract<Job, { kind: K }>>;
}

/**
 * Writes raw/<id>.source.md once. An existing sidecar is already a job input and is never
 * refetched, so a retry or crash recovery reuses it.
 */
async function enrichIngest(env: Env, job: Extract<Job, { kind: 'ingest' }>): Promise<Extract<Job, { kind: 'ingest' }>> {
  const { domain, id } = job.ref;
  const name = `${id}.source.md`;
  const rel = env.layout.rawRel(domain, name);
  if (job.inputs.includes(rel)) return job;
  const memo = parseMemoFile(await fs.readFile(env.layout.fromRel(env.layout.rawRel(domain, `${id}.md`)), 'utf8'));
  const urls = memo.ok ? linksToFetch(memo.value.memo.text, memo.value.memo.source) : [];
  if (!urls.length) return job;
  const sources = [];
  for (const url of urls) sources.push({ url, ...(await env.fetchSource(url)) });
  await writeExclusive(env.layout.rawDir(domain), name, renderSourceFile({ memo: id as MemoId, fetchedAt: env.stamp(), sources }));
  return { ...job, inputs: [...job.inputs, rel] };
}

const ingestRules = (date: string, types: readonly string[]) => `## 서버가 정한 작업 규칙

- 오늘 날짜는 ${date}다. 만들거나 고친 페이지의 \`updated\`에 쓴다.
- 쓰기는 \`wiki/\` 아래에서만 한다. \`raw/\`, \`CLAUDE.md\`, 다른 도메인 폴더는 고치지 않는다.
- \`wiki/index.md\`와 \`wiki/log.md\`는 서버가 쓴다. 읽기만 한다.
- \`wiki/answers/\`는 저장된 질문 답이다. 정리 근거로 쓰지 않고 고치지 않는다.
- 페이지 frontmatter에는 ${PAGE_FIELDS.map((f) => `\`${f}\``).join(', ')}를 모두 단다. \`type\`은 ${types.map((t) => `\`${t}\``).join(', ')} 중 하나다.
- \`[[링크]]\`는 이미 있거나 이번에 만드는 위키 페이지에만 건다. 원본 id는 링크로 걸지 말고 \`sources\`와 본문에 글자로 적는다.
- 사진은 원본에 붙은 것만 \`![[파일명]]\`으로 넣는다. 사진에서 보이는 내용은 사진에서 본 것이라고 밝혀 적는다.
- 빈 파일이나 본문 없는 페이지를 만들지 않는다.
- 끝나면 판정(\`verdict\`)과 만들거나 고친 페이지의 \`wiki/\` 기준 경로 목록(\`pages\`)을 구조화된 응답으로 돌려준다.`;

async function performIngest(env: Env, job: Extract<Job, { kind: 'ingest' }>, ctx: JobCtx): Promise<Performed> {
  const cwd = env.layout.domainDir(job.ref.domain);
  const id = job.ref.id;
  const memo = parseMemoFile(await fs.readFile(join(cwd, 'raw', `${id}.md`), 'utf8'));
  const photos = (memo.ok ? memo.value.memo.attachments : []).filter((a) => job.inputs.includes(env.layout.attachmentRel(a.file)));
  const images = photos.map((a) => join(env.layout.attachmentsDir, a.file));
  const prompt = [
    `원본 \`raw/${id}.md\` 하나를 정리 작업 순서대로 위키에 반영해라.`,
    job.inputs.some((p) => p.endsWith('.source.md')) ? `수집 자료 \`raw/${id}.source.md\`도 함께 읽는다.` : '',
    photos.length
      ? [
          `원본에 사진 ${photos.length}장이 붙어 있다. 각 파일을 Read로 열어 보고 무엇이 찍혔는지 정리에 반영한다. 페이지에 넣을 때는 \`![[파일명]]\`으로 쓴다.`,
          ...photos.map((a, i) => `- \`${images[i]}\` (\`![[${a.file}]]\`) ${describePhoto(a, i)}`),
        ].join('\n')
      : '',
    ctx.history.lastFailure ? `\n지난 시도는 서버 검사에서 실패해 되돌려졌다. 이유: ${ctx.history.lastFailure.reason}\n같은 문제가 없도록 처음부터 다시 해라.` : '',
  ].filter(Boolean).join('\n');
  const result = await env.llm.edit({
    modelProfile: ctx.domain.modelProfile,
    cwd,
    systemPrompt: `${await composeSystemPrompt(env.layout.domainSchema(job.ref.domain))}\n\n${renderPageTypes(ctx.domain)}\n\n${ingestRules(env.today(), ctx.domain.pageTypes.map((t) => t.type))}`,
    prompt,
    timeoutMs: env.ingestTimeoutMs,
    writableDir: 'wiki',
    verdicts: INGEST_VERDICTS,
    onTouch: ctx.touch,
    images,
  });
  return result.kind === 'finished' ? ingestVerdict(result) : result;
}

/** The schema enum asks for one of INGEST_VERDICTS, so this rarely fires; when it does, the attempt fails instead of writing a word the ledger cannot read back. */
function ingestVerdict(r: Extract<EditResult, { kind: 'finished' }>): Performed {
  const verdict = INGEST_VERDICTS.find((v) => v === r.verdict);
  return verdict ? { kind: 'finished', verdict, pages: r.pages } : { kind: 'failed', reason: `verdict ${JSON.stringify(r.verdict)} is not one of ${INGEST_VERDICTS.join(', ')}` };
}

async function performFileAnswer(env: Env, job: Extract<Job, { kind: 'file-answer' }>, ctx: JobCtx): Promise<Performed> {
  const wikiDir = env.layout.wikiDir(job.ref.domain);
  const { pathUnderWiki, content } = renderAnswerPage(job.filing, env.today(), new Set(await listMarkdown(wikiDir)));
  const abs = join(wikiDir, ...pathUnderWiki.split('/'));
  ctx.touch(abs);
  await fs.mkdir(dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  return { kind: 'finished', verdict: 'saved', pages: [pathUnderWiki] };
}

function serializer(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

/** The memo ids filed as `<id>.md` in dir; sidecars, tmp files, and stray names are skipped. */
async function memoIdsIn(dir: string): Promise<ReadonlySet<MemoId>> {
  const out = new Set<MemoId>();
  for (const name of await listNames(dir)) {
    const id = name.endsWith('.md') ? parseMemoId(name.slice(0, -3)) : null;
    if (id && `${id}.md` === name) out.add(id);
  }
  return out;
}

/** Everything the memo state table reads, gathered once per call. */
type Places = {
  /** HEAD and the domain list: what the cached ledger reads depend on. */
  readonly key: string;
  readonly head: string | null;
  readonly inbox: ReadonlySet<MemoId>;
  readonly domains: readonly {
    readonly domain: DomainName;
    readonly raw: ReadonlySet<MemoId>;
    readonly hold: ReadonlySet<MemoId>;
    readonly ledger: Ledger;
    /** The memo whose ingest the inflight marker names. */
    readonly running: string | null;
  }[];
};

type Located = { readonly domain: DomainName; readonly state: Exclude<MemoState, 'inbox'> };

/**
 * Where a memo is once it has left the inbox. A raw copy wins over a hold copy, which is then a
 * crash leftover. A domain the memo was moved out of is skipped, and a failed copy loses to a
 * copy elsewhere, because that pair is a move the crash interrupted. A marker counts only while
 * no terminal line is committed: done means committed.
 */
function locate(p: Places, id: MemoId): Located | null {
  let failed: DomainName | null = null;
  for (const d of p.domains) {
    if (!d.raw.has(id)) continue;
    const t = d.ledger.history('ingest', id).terminal?.kind;
    if (t === 'moved') continue;
    if (t === 'gave-up') failed ??= d.domain;
    else return { domain: d.domain, state: t === 'applied' ? 'ingested' : d.running === id ? 'running' : 'routed' };
  }
  if (failed) return { domain: failed, state: 'failed' };
  const held = p.domains.find((d) => d.hold.has(id));
  return held ? { domain: held.domain, state: 'held' } : null;
}

/** The memo file wherever the memo is, and outside the inbox its state and that domain's ledger history for it. */
type Found = { readonly memo: Memo; readonly routing: Routing | null; readonly at: (Located & { readonly history: JobHistory }) | null };

const INTERRUPTED = 'gateway stopped mid-job';
/** An upload this old with no memo naming it was abandoned on the phone. */
const ORPHAN_PHOTO_MS = 7 * 24 * 3_600_000;

function failureOf(f: Failure, attempts: number): MemoFailure {
  const interrupted = (f.kind === 'attempt-failed' && f.interrupted) || f.reason === INTERRUPTED;
  const problem = interrupted ? null : firstProblem(f.reason);
  return { attempts, max: f.max, code: interrupted ? 'interrupted' : (problem?.rule ?? 'unknown'), detail: problem?.detail ?? f.reason };
}

/** One cached value, recomputed when the key (HEAD and the domain list) changes. A failed computation is not kept. */
function perHead<T>(): (key: string, make: () => Promise<T>) => Promise<T> {
  let last: { readonly key: string; readonly value: Promise<T> } | null = null;
  return (key, make) => {
    if (last?.key === key) return last.value;
    const value = make();
    last = { key, value };
    value.catch(() => {
      if (last?.value === value) last = null;
    });
    return value;
  };
}

async function asyncFilter<T>(xs: readonly T[], keep: (x: T) => Promise<boolean>): Promise<T[]> {
  const out: T[] = [];
  for (const x of xs) if (await keep(x)) out.push(x);
  return out;
}

const sha256 = (text: string | null) => (text === null ? 'absent' : createHash('sha256').update(text).digest('hex'));
const byOrder = (a: Job, b: Job) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0);
const orderKey = (iso: string, id: string) => `${String(Date.parse(iso) || 0).padStart(16, '0')}\0${id}`;

/**
 * The project is a strong hint the memo text alone may not carry, e.g. 스터디 versus 개발소식.
 * Photos go in as their metadata line; the classifier never sees pixels.
 */
const classifierText = (m: Memo) =>
  [
    m.text,
    m.context ? `작성 맥락: 프로젝트 ${m.context.project}${m.context.branch ? `, 브랜치 ${m.context.branch}` : ''}` : '',
    m.attachments.map(describePhoto).join('\n'),
  ].filter(Boolean).join('\n\n');

class WikiImpl implements Wiki {
  readonly #layout: Layout;
  readonly #git: Git;
  readonly #opts: WikiOptions;
  readonly #lock: { release(): Promise<void> };
  /** One writer of <d>/wiki/ at a time: held for a whole runNext. */
  readonly #jobLocks = new Map<string, ReturnType<typeof serializer>>();
  /** Held for each read-HEAD-log, append, commit section, so retry() never races a job's commit. */
  readonly #ledgerLocks = new Map<string, ReturnType<typeof serializer>>();
  /** Held for each release of a held memo, so two releases of one memo cannot both queue it. */
  readonly #holdLock = serializer();
  readonly #unwatch = new Set<() => void>();
  readonly #ledgersAtHead = perHead<ReadonlyMap<DomainName, Ledger>>();
  /** `${domain}\0${kind}:${id}` → the commit of each of that job's ledger lines, in ledger order. */
  readonly #ledgerCommits = perHead<ReadonlyMap<string, readonly AppendedLine[]>>();
  readonly #machine: MachineFacts;
  #parsed: { readonly text: string; readonly parse: ConfigParse } | null = null;
  /** Domains whose init(<d>) is known to be in HEAD. */
  readonly #ready = new Set<DomainName>();
  readonly #configLock = serializer();

  constructor(lay: Layout, git: Git, opts: WikiOptions, lock: { release(): Promise<void> }) {
    this.#layout = lay;
    this.#git = git;
    this.#opts = opts;
    this.#lock = lock;
    this.#machine = { modelProfiles: new Set(opts.modelProfiles.map((p) => p.normalize('NFC'))) };
  }

  #now(): Date {
    return this.#opts.now ? this.#opts.now() : new Date();
  }

  /** The config rule in the header: the file parsed when its text changed, then the CLAUDE.md files it needs. */
  async #readConfig(): Promise<ConfigParse> {
    const lay = this.#layout;
    const text = await readIfExists(lay.configFile);
    if (text === null) return { ok: false, problems: [{ key: CONFIG_FILE, problem: 'does not exist', fix: 'restore it from git' }] };
    if (this.#parsed?.text !== text) this.#parsed = { text, parse: parseWikiConfig(text, this.#machine) };
    const parsed = this.#parsed.parse;
    if (!parsed.ok) return parsed;
    const missing: ConfigProblem[] = [];
    if (!(await exists(lay.rootSchema))) missing.push({ key: 'CLAUDE.md', problem: 'the root CLAUDE.md does not exist', fix: 'create it; the classifier reads it to route memos' });
    for (const d of parsed.config.domains.keys()) {
      if (!(await exists(lay.domainSchema(d)))) missing.push({ key: `domains.${d}`, problem: `${d}/CLAUDE.md does not exist`, fix: `create ${d}/CLAUDE.md, or remove the entry` });
    }
    return missing.length ? { ok: false, problems: [...missing, ...parsed.warnings] } : parsed;
  }

  async config(): Promise<WikiConfig> {
    const r = await this.#readConfig();
    if (!r.ok) throw new WikiConfigError(r.problems);
    return r.config;
  }

  async #domains(): Promise<readonly DomainName[]> {
    return [...(await this.config()).domains.keys()];
  }

  #env(config: WikiConfig): Env {
    const tz = config.timeZone;
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    return {
      layout: this.#layout,
      config,
      llm: this.#opts.llm,
      fetchSource: this.#opts.fetchSource,
      ingestTimeoutMs: this.#opts.ingestTimeoutMs,
      today: () => day.format(this.#now()),
      stamp: () => isoWithOffset(this.#now(), tz),
    };
  }

  #locked(map: Map<string, ReturnType<typeof serializer>>, d: DomainName) {
    let s = map.get(d);
    if (!s) map.set(d, (s = serializer()));
    return s;
  }

  async #headLog(d: DomainName): Promise<string> {
    return (await this.#git.show('HEAD', this.#layout.logRel(d))) ?? '# log\n';
  }

  async #ledger(d: DomainName, rev = 'HEAD'): Promise<Ledger> {
    return parseLedger((await this.#git.show(rev, this.#layout.logRel(d))) ?? '');
  }

  /** The one place a ledger line is written: under the domain's ledger lock, on top of HEAD's log.md. */
  async #commitLedger(env: Env, d: DomainName, line: (head: Ledger) => { job: JobKind; id: string; outcome: NewOutcome } | null, paths: readonly string[], message: string): Promise<string | null> {
    return this.#locked(this.#ledgerLocks, d)(async () => {
      const text = await this.#headLog(d);
      const l = line(parseLedger(text));
      if (!l) return null;
      await fs.writeFile(this.#layout.fromRel(this.#layout.logRel(d)), appendLine(env.config.locale, text, { date: env.today(), ...l }));
      return this.#git.commit([this.#layout.logRel(d), ...paths], message);
    });
  }

  async #appendReview(d: DomainName, notes: readonly string[]): Promise<void> {
    if (!notes.length) return;
    const path = this.#layout.fromRel(this.#layout.reviewRel(d));
    const current = (await readIfExists(path)) ?? '# 검토할 것\n\n';
    await fs.writeFile(path, `${current.endsWith('\n') ? current : `${current}\n`}${notes.join('\n')}\n`);
  }

  async #reviewPathIfExists(d: DomainName): Promise<readonly string[]> {
    return (await exists(this.#layout.fromRel(this.#layout.reviewRel(d)))) ? [this.#layout.reviewRel(d)] : [];
  }

  /**
   * Commits every change under <d>/ except pending raw memos, held memos, and the router's
   * in-flight `.tmp-*` files, which can vanish between status and add: the human's Obsidian
   * edits, saved before a job can restore over them.
   */
  async #commitManual(d: DomainName, message: string): Promise<void> {
    await this.#locked(this.#ledgerLocks, d)(async () => {
      const raw = `${d}/raw/`;
      const paths = (await this.#git.status([d]))
        .map((c) => c.path)
        .filter((p) => !p.startsWith(`${d}/hold/`) && !(p.startsWith(raw) && (p.endsWith('.md') || p.slice(raw.length).startsWith('.tmp-'))));
      if (paths.length) await this.#git.commit(paths, message);
    });
  }

  /** Uploads whose memo never came: originals older than a week that no memo names, and their uncommitted copies. Paused, it waits for the next open. */
  async sweepOrphanPhotos(): Promise<void> {
    const names = await listNames(this.#layout.originalsDir);
    if (!names.length) return;
    const read = await this.#readConfig();
    if (!read.ok) return;
    const places = await this.#places([...read.config.domains.keys()]);
    const committed = new Set(places.head ? await this.#git.lsTree('HEAD', ['_attachments']) : []);
    const cutoff = this.#now().getTime() - ORPHAN_PHOTO_MS;
    for (const name of names) {
      const m = /^(.+)-(\d{1,2})\.[a-z]+$/.exec(name);
      const id = m ? parseMemoId(m[1]!) : null;
      if (!id || places.inbox.has(id) || locate(places, id)) continue;
      const original = join(this.#layout.originalsDir, name);
      if ((await fs.stat(original)).mtimeMs > cutoff) continue;
      await unlinkQuiet(original);
      const copy = attachmentName(id, Number(m![2]));
      if (!committed.has(this.#layout.attachmentRel(copy))) await unlinkQuiet(join(this.#layout.attachmentsDir, copy));
    }
  }

  /** Manual edits of dotoriwiki.yaml, committed like a domain's before a job reads it. */
  async #commitConfig(): Promise<void> {
    await this.#configLock(async () => {
      if ((await this.#git.status([CONFIG_FILE])).length) await this.#git.commit([CONFIG_FILE], 'manual(config)');
    });
  }

  /** At open, while no router or worker runs: clears crash leftovers and inits every declared domain. Paused, it waits for the first job. */
  async bootstrap(): Promise<void> {
    const r = await this.#readConfig();
    if (!r.ok) return;
    const lay = this.#layout;
    await sweepTmp([...r.config.domains.keys()].flatMap((d) => [lay.answersInboxDir(d), lay.rawDir(d), lay.holdDir(d)]));
    await this.#commitConfig();
    for (const d of r.config.domains.values()) await this.#init(d);
  }

  /** Commits `init(<d>)` unless HEAD has the domain's log.md. Idempotent. */
  async #init(d: DomainConfig): Promise<void> {
    if (this.#ready.has(d.name)) return;
    if (!(await this.#git.head()) || !(await this.#git.lsTree('HEAD', [this.#layout.logRel(d.name)])).length) {
      const log = this.#layout.fromRel(this.#layout.logRel(d.name));
      await fs.mkdir(dirname(log), { recursive: true });
      if ((await readIfExists(log)) === null) await fs.writeFile(log, '# log\n');
      await this.#writeIndex(d);
      await this.#commitManual(d.name, `init(${d.name})`);
    }
    this.#ready.add(d.name);
  }

  async #writeIndex(dc: DomainConfig): Promise<void> {
    const d = dc.name;
    const wikiDir = this.#layout.wikiDir(d);
    const pages = [];
    for (const p of await listMarkdown(wikiDir)) {
      const role = roleOf(p);
      if (role === 'page' || role === 'answer') pages.push(pageMeta(p, (await readIfExists(join(wikiDir, ...p.split('/')))) ?? ''));
    }
    await fs.writeFile(join(wikiDir, 'index.md'), renderIndex(d, pages, dc.pageTypes.map((t) => t.type)));
  }

  async #places(domains: readonly DomainName[]): Promise<Places> {
    const head = await this.#git.head();
    const key = `${head}\n${domains.join('\n')}`;
    const ledgers = await this.#ledgersAtHead(key, async () => {
      const out = new Map<DomainName, Ledger>();
      for (const d of domains) out.set(d, head ? await this.#ledger(d, head) : parseLedger(''));
      return out;
    });
    const out: Places['domains'][number][] = [];
    for (const d of domains) {
      const marker = await readInflight(this.#layout.inflightFile(d));
      out.push({
        domain: d,
        raw: await memoIdsIn(this.#layout.rawDir(d)),
        hold: await memoIdsIn(this.#layout.holdDir(d)),
        ledger: ledgers.get(d)!,
        running: marker?.job.kind === 'ingest' ? marker.job.id : null,
      });
    }
    return { key, head, inbox: await memoIdsIn(this.#layout.inboxDir), domains: out };
  }

  /** The commit that wrote the job's `line`-th ledger line in d, from one git log pass per HEAD. */
  async #ledgerCommit(places: Places, d: DomainName, key: string, line: number): Promise<AppendedLine | null> {
    const { head, domains } = places;
    if (!head) return null;
    const commits = await this.#ledgerCommits(places.key, async () => {
      const byLog = new Map(domains.map((x) => [this.#layout.logRel(x.domain), x.domain]));
      const out = new Map<string, AppendedLine[]>();
      for (const a of await this.#git.appended(head, [...byLog.keys()])) {
        const k = lineKey(a.line);
        const domain = byLog.get(a.path);
        if (!k || !domain) continue;
        const list = out.get(`${domain}\0${k}`);
        if (list) list.push(a);
        else out.set(`${domain}\0${k}`, [a]);
      }
      return out;
    });
    return commits.get(`${d}\0${key}`)?.[line] ?? null;
  }

  async #found(places: Places, id: MemoId): Promise<Found | null> {
    const at = locate(places, id);
    if (!at && !places.inbox.has(id)) return null;
    const dir = !at ? this.#layout.inboxDir : at.state === 'held' ? this.#layout.holdDir(at.domain) : this.#layout.rawDir(at.domain);
    const parsed = parseMemoFile((await readIfExists(join(dir, `${id}.md`))) ?? '');
    if (!parsed.ok) return null;
    if (!at) return { ...parsed.value, at: null };
    return { ...parsed.value, at: { ...at, history: places.domains.find((d) => d.domain === at.domain)!.ledger.history('ingest', id) } };
  }

  async #summary(places: Places, { memo, at }: Found, locale: Locale): Promise<MemoSummary> {
    if (!at) return { memo, state: 'inbox', domain: null };
    if (at.state !== 'ingested' && at.state !== 'failed') return { memo, state: at.state, domain: at.domain };
    // locate() named the state from this very line.
    const t = at.history.terminal!;
    const finishedAt = (await this.#ledgerCommit(places, at.domain, `ingest:${memo.id}`, t.line))?.committedAt ?? null;
    return t.kind === 'applied'
      ? { memo, state: 'ingested', domain: at.domain, verdict: { id: typeof t.verdict === 'string' ? t.verdict : null, text: verdictText(locale, t.verdict) }, firstPage: t.pages[0]?.replace(/\.md$/, '') ?? null, finishedAt }
      : { memo, state: 'failed', domain: at.domain, finishedAt };
  }

  async memos(opts: { readonly limit: number; readonly before: MemoCursor | null }): Promise<readonly MemoSummary[]> {
    const config = await this.config();
    const places = await this.#places([...config.domains.keys()]);
    const found: Found[] = [];
    for (const id of new Set([...places.inbox, ...places.domains.flatMap((d) => [...d.raw, ...d.hold])])) {
      const f = await this.#found(places, id);
      if (f) found.push(f);
    }
    const key = (f: Found) => orderKey(f.memo.capturedAt, f.memo.id);
    const before = opts.before && orderKey(opts.before.capturedAt, opts.before.id ?? '');
    const page = found.filter((f) => before === null || key(f) < before).sort((a, b) => (key(a) < key(b) ? 1 : -1)).slice(0, opts.limit);
    const out: MemoSummary[] = [];
    for (const f of page) out.push(await this.#summary(places, f, config.locale));
    return out;
  }

  async memo(id: MemoId): Promise<MemoDetail | null> {
    const config = await this.config();
    const places = await this.#places([...config.domains.keys()]);
    const f = await this.#found(places, id);
    if (!f) return null;
    const summary = await this.#summary(places, f, config.locale);
    const h = f.at?.history;
    const failure =
      summary.state === 'failed' && h?.terminal?.kind === 'gave-up' ? failureOf(h.terminal, h.terminal.attempt)
      : (summary.state === 'routed' || summary.state === 'running') && h?.lastFailure && h.attempts > 0 ? failureOf(h.lastFailure, h.attempts)
      : null;
    return { ...summary, routing: f.routing, pages: summary.state === 'ingested' && h?.terminal ? await this.#pages(places, summary.domain, f.memo.id, h.terminal.line) : [], failure };
  }

  /** The pages and answers the ingest commit wrote, with each one's type at that commit. */
  async #pages(places: Places, d: DomainName, id: MemoId, line: number): Promise<readonly MemoPage[]> {
    const commit = await this.#ledgerCommit(places, d, `ingest:${id}`, line);
    if (!commit) return [];
    const prefix = `${this.#layout.wikiRel(d)}/`;
    const out: MemoPage[] = [];
    for (const c of await this.#git.changed(commit.sha, [this.#layout.wikiRel(d)])) {
      const under = c.path.slice(prefix.length);
      const role = roleOf(under);
      if (c.status === 'deleted' || (role !== 'page' && role !== 'answer')) continue;
      const type = pageMeta(under, (await this.#git.show(commit.sha, c.path)) ?? '').type;
      out.push({ path: under.replace(/\.md$/, ''), type, change: c.status === 'added' ? 'created' : 'modified' });
    }
    return out;
  }

  async #locate(id: MemoId, domains?: readonly DomainName[]): Promise<Located | null> {
    return locate(await this.#places(domains ?? (await this.#domains())), id);
  }

  /** Paused, a memo already routed elsewhere is not found, and routeNext drops its inbox copy once the wiki resumes. */
  async accept(input: NewMemo): Promise<AcceptResult> {
    const attachments: Attachment[] = [];
    for (const req of input.attachments) {
      const original = await this.#original(input.id, req.n);
      if (!original) return { kind: 'missing-photo', n: req.n };
      attachments.push(await this.#attachment(input, req, original));
    }
    const memo: Memo = { ...input, attachments };
    const name = `${memo.id}.md`;
    const wrote = await writeExclusive(this.#layout.inboxDir, name, renderMemoFile(memo, null));
    const config = await this.#readConfig();
    const at = config.ok ? await this.#locate(memo.id, [...config.config.domains.keys()]) : null;
    if (at) {
      if (wrote === 'created') await unlinkQuiet(join(this.#layout.inboxDir, name));
      return { kind: 'duplicate', domain: at.domain, state: at.state };
    }
    return wrote === 'created' ? { kind: 'created' } : { kind: 'duplicate', state: 'inbox', domain: null };
  }

  async storePhoto(id: MemoId, n: number, bytes: Uint8Array): Promise<StorePhotoResult> {
    const ext = sniffPhoto(bytes);
    if (!ext) return { kind: 'unsupported' };
    const sha256 = sha256Hex(bytes);
    const same = async (name: string): Promise<StorePhotoResult> => {
      const kept = await fs.readFile(join(this.#layout.originalsDir, name));
      return sha256Hex(kept) === sha256 ? { kind: 'same', name, sha256, bytes: kept.length } : { kind: 'conflict', name };
    };
    const existing = await this.#original(id, n);
    if (existing) return same(existing);
    const name = `${photoStem(id, n)}.${ext}`;
    if ((await writeExclusive(this.#layout.originalsDir, name, bytes)) === 'exists') return same(name);
    // Making the copy now turns bytes that only look like an image into a 400 the phone stops resending, not a 500 on every memo POST.
    try {
      await this.#ensureCopy(id, n, name);
    } catch {
      await unlinkQuiet(join(this.#layout.originalsDir, name));
      return { kind: 'unsupported' };
    }
    return { kind: 'stored', name, sha256, bytes: bytes.length };
  }

  async attachmentPath(file: string): Promise<string | null> {
    const m = /^(.+)-(\d{1,2})\.jpg$/.exec(file);
    const id = m ? parseMemoId(m[1]!) : null;
    if (!id || attachmentName(id, Number(m![2])) !== file) return null;
    const path = join(this.#layout.attachmentsDir, file);
    return (await exists(path)) ? path : null;
  }

  /** The stored original for photo n, whatever its extension. */
  async #original(id: MemoId, n: number): Promise<string | null> {
    const stem = `${photoStem(id, n)}.`;
    return (await listNames(this.#layout.originalsDir)).find((name) => name.startsWith(stem) && !name.slice(stem.length).includes('.')) ?? null;
  }

  /** The 2048 px copy of an original, made once. */
  async #ensureCopy(id: MemoId, n: number, original: string): Promise<string> {
    const file = attachmentName(id, n);
    const dir = this.#layout.attachmentsDir;
    if (await exists(join(dir, file))) return file;
    await fs.mkdir(dir, { recursive: true });
    const tmp = join(dir, `.tmp-${file}-${randomBytes(6).toString('hex')}.jpg`);
    try {
      await this.#opts.shrinkPhoto(join(this.#layout.originalsDir, original), tmp);
      await linkExclusive(tmp, dir, file);
    } finally {
      await unlinkQuiet(tmp);
    }
    return file;
  }

  /** Everything here derives from the original's bytes, so an accept retried after a crash rebuilds the same record. */
  async #attachment(memo: NewMemo, req: AttachmentRequest, original: string): Promise<Attachment> {
    const bytes = await fs.readFile(join(this.#layout.originalsDir, original));
    const facts = await photoFacts(bytes, memo.tz);
    const file = await this.#ensureCopy(memo.id, req.n, original);
    return {
      file,
      original,
      sha256: sha256Hex(bytes),
      bytes: bytes.length,
      width: facts.width,
      height: facts.height,
      origin: req.origin,
      takenAt: facts.takenAt,
      location: photoLocation(facts.gps, req, memo.location),
      device: facts.device,
      camera: facts.camera,
    };
  }

  async #namesAt(rev: string, domains: readonly DomainName[]): Promise<Map<string, ReadonlySet<string>>> {
    const out = new Map<string, ReadonlySet<string>>();
    for (const d of domains) {
      const prefix = `${this.#layout.wikiRel(d)}/`;
      out.set(d, namesOf((await this.#git.lsTree(rev, [this.#layout.wikiRel(d)])).map((p) => p.slice(prefix.length))));
    }
    return out;
  }

  async fileAnswer(filing: AnswerFiling): Promise<FileAnswerResult> {
    const names = await this.#namesAt('HEAD', [...new Set([filing.domain, ...filing.cited.map((r) => r.domain)])]);
    for (const ref of filing.cited) {
      if (!linkResolves(pageRefString(ref), filing.domain, names)) return { kind: 'rejected', reason: `cited page ${pageRefString(ref)} does not exist` };
    }
    if ((await this.#ledger(filing.domain)).history('file-answer', filing.id).terminal) return { kind: 'duplicate' };
    const wrote = await writeExclusive(this.#layout.answersInboxDir(filing.domain), `${filing.id}.md`, renderAnswerStaging(filing));
    return wrote === 'created' ? { kind: 'created' } : { kind: 'duplicate' };
  }

  async routeNext(): Promise<RouteReport> {
    const read = await this.#readConfig();
    if (!read.ok) return { kind: 'paused', problems: read.problems };
    const config = read.config;
    const domains = [...config.domains.keys()];
    const inbox = this.#layout.inboxDir;
    const memos: Memo[] = [];
    for (const name of await listNames(inbox)) {
      if (!name.endsWith('.md')) continue;
      const text = await readIfExists(join(inbox, name));
      if (text === null) continue;
      const parsed = parseMemoFile(text);
      if (!parsed.ok || `${parsed.value.memo.id}.md` !== name) {
        await fs.mkdir(this.#layout.rejectedDir, { recursive: true });
        await fs.rename(join(inbox, name), join(this.#layout.rejectedDir, name));
        return { kind: 'rejected', file: name, reason: parsed.ok ? 'file name does not match id' : parsed.detail };
      }
      memos.push(parsed.value.memo);
    }
    const memo = memos.sort((a, b) => (orderKey(a.capturedAt, a.id) < orderKey(b.capturedAt, b.id) ? -1 : 1))[0];
    if (!memo) return { kind: 'idle' };
    const inboxFile = join(inbox, `${memo.id}.md`);
    if (await this.#locate(memo.id, domains)) {
      await unlinkQuiet(inboxFile);
      return { kind: 'dropped-duplicate', id: memo.id };
    }
    let domain = memo.domainHint ? domainIn(config, memo.domainHint) : null;
    let routing: Routing = { by: 'hint' };
    if (!domain) {
      const systemPrompt = `${await fs.readFile(this.#layout.rootSchema, 'utf8')}\n\n${renderDomainCatalog(config)}`;
      const req = { systemPrompt, text: classifierText(memo), domains };
      let detail = '';
      for (let i = 0; i < 2 && !domain; i++) {
        const c = await this.#opts.llm.classify(req);
        if (c.kind === 'unavailable') return c;
        if (c.kind === 'no-answer') detail = c.detail;
        else {
          domain = domains.find((d) => d === c.domain.normalize('NFC')) ?? null;
          detail = `classifier named unknown domain ${c.domain}`;
          if (domain) routing = { by: 'classifier', confidence: c.confidence, reason: c.reason };
        }
      }
      if (!domain) {
        domain = config.fallbackDomain;
        routing = { by: 'fallback', reason: detail };
      }
    }
    const held = routing.by === 'fallback' || (routing.by === 'classifier' && routing.confidence < this.#opts.reviewBelowConfidence);
    await writeExclusive(held ? this.#layout.holdDir(domain) : this.#layout.rawDir(domain), `${memo.id}.md`, renderMemoFile(memo, routing));
    await unlinkQuiet(inboxFile);
    return { kind: held ? 'held' : 'routed', id: memo.id, domain, routing };
  }

  /** Also removes hold copies whose memo is already queued: the leftovers of an interrupted release. */
  async held(): Promise<readonly HeldMemo[]> {
    return this.#held(await this.#domains());
  }

  async #held(domains: readonly DomainName[]): Promise<readonly HeldMemo[]> {
    const places = await this.#places(domains);
    const out: HeldMemo[] = [];
    for (const { domain: d, hold } of places.domains) {
      for (const id of hold) {
        const file = join(this.#layout.holdDir(d), `${id}.md`);
        if (locate(places, id)?.state !== 'held') {
          await unlinkQuiet(file);
          continue;
        }
        const parsed = parseMemoFile((await readIfExists(file)) ?? '');
        if (!parsed.ok || !parsed.value.routing) continue;
        const { memo, routing } = parsed.value;
        out.push({ id, domain: d, text: memo.text, capturedAt: memo.capturedAt, source: memo.source, routing });
      }
    }
    return out.sort((a, b) => (orderKey(a.capturedAt, a.id) < orderKey(b.capturedAt, b.id) ? -1 : 1));
  }

  async confirm(id: MemoId): Promise<ReleaseResult> {
    return this.#holdLock(async () => {
      const at = await this.#locate(id);
      if (!at) return { kind: 'not-found' };
      if (at.state !== 'held') return { kind: 'conflict', ...at };
      const hold = join(this.#layout.holdDir(at.domain), `${id}.md`);
      await linkExclusive(hold, this.#layout.rawDir(at.domain), `${id}.md`);
      await unlinkQuiet(hold);
      return { kind: 'released', domain: at.domain };
    });
  }

  async move(id: MemoId, to: DomainName): Promise<ReleaseResult> {
    const env = this.#env(await this.config());
    const first = await this.#locate(id);
    if (!first) return { kind: 'not-found' };
    if (first.domain === to || (first.state !== 'held' && first.state !== 'failed')) return { kind: 'conflict', ...first };
    const from = first.domain;
    const lane = first.state === 'held' ? this.#holdLock : this.#locked(this.#jobLocks, from);
    return lane(async () => {
      const at = await this.#locate(id);
      if (!at) return { kind: 'not-found' };
      if (at.domain !== from || at.state !== first.state) return { kind: 'conflict', ...at };
      if (at.state === 'held') {
        const hold = join(this.#layout.holdDir(from), `${id}.md`);
        await this.#place(env, id, from, to, await fs.readFile(hold, 'utf8'), null);
        await unlinkQuiet(hold);
      } else {
        const raw = this.#layout.rawDir(from);
        await this.#place(env, id, from, to, await fs.readFile(join(raw, `${id}.md`), 'utf8'), await readIfExists(join(raw, `${id}.source.md`)));
        await this.#closeMove(env, from, to, id);
      }
      return { kind: 'released', domain: to };
    });
  }

  /**
   * Writes the memo into <to>/raw/ with `by: user` routing, its sidecar first so the copy is
   * never enriched twice. A domain the memo once left has a terminal line for it, so that
   * ledger gets a retry line first, or the new copy would never be picked.
   */
  async #place(env: Env, id: MemoId, from: DomainName, to: DomainName, memoFile: string, sidecar: string | null): Promise<void> {
    const parsed = parseMemoFile(memoFile);
    if (!parsed.ok) throw new Error(`${from} memo ${id} does not parse: ${parsed.detail}`);
    await this.#commitLedger(
      env,
      to,
      (head) => (head.history('ingest', id).terminal ? { job: 'ingest', id, outcome: { kind: 'retry' } } : null),
      [],
      `retry(${to}): ingest ${id}`,
    );
    const dir = this.#layout.rawDir(to);
    if (sidecar !== null) await writeExclusive(dir, `${id}.source.md`, sidecar);
    await writeExclusive(dir, `${id}.md`, renderMemoFile(parsed.value.memo, { by: 'user', from, previous: parsed.value.routing }));
  }

  /** The commit that ends a gave-up memo's stay in `from`. Runs after #place, so a crash between leaves the evidence #finishMoves reads. */
  async #closeMove(env: Env, from: DomainName, to: DomainName, id: MemoId): Promise<void> {
    const files = [this.#layout.rawRel(from, `${id}.md`), this.#layout.rawRel(from, `${id}.source.md`)];
    for (const f of files) await unlinkQuiet(this.#layout.fromRel(f));
    await this.#commitLedger(
      env,
      from,
      (head) => (head.history('ingest', id).terminal?.kind === 'gave-up' ? { job: 'ingest', id, outcome: { kind: 'moved', to } } : null),
      await this.#git.lsTree('HEAD', files),
      `move(${from}→${to}): ${id}`,
    );
  }

  /** The domain a crashed move of this gave-up memo already placed it in. */
  async #movedTo(from: DomainName, id: MemoId, domains: readonly DomainName[]): Promise<DomainName | null> {
    for (const d of domains) {
      if (d === from) continue;
      const parsed = parseMemoFile((await readIfExists(join(this.#layout.rawDir(d), `${id}.md`))) ?? '');
      if (parsed.ok && parsed.value.routing?.by === 'user' && parsed.value.routing.from === from) return d;
    }
    return null;
  }

  async #finishMoves(env: Env, d: DomainName): Promise<void> {
    const ledger = await this.#ledger(d);
    for (const name of await listNames(this.#layout.rawDir(d))) {
      const id = name.endsWith('.md') && !name.endsWith('.source.md') ? parseMemoId(name.slice(0, -3)) : null;
      if (!id || ledger.history('ingest', id).terminal?.kind !== 'gave-up') continue;
      const to = await this.#movedTo(d, id, [...env.config.domains.keys()]);
      if (to) await this.#closeMove(env, d, to, id);
    }
  }

  /** Every pending job of the domain, in pick order: answers first (no LLM, the user is waiting), then memos. */
  async #candidates(d: DomainName, ledger: Ledger, domains: readonly DomainName[]): Promise<{ jobs: Job[]; filed: string[] }> {
    const answers: Job[] = [];
    const filed: string[] = [];
    const answersDir = this.#layout.answersInboxDir(d);
    for (const name of await listNames(answersDir)) {
      const id = name.endsWith('.md') ? parseAnswerId(name.slice(0, -3)) : null;
      if (!id || `${id}.md` !== name) continue;
      const terminal = ledger.history('file-answer', id).terminal;
      if (terminal?.kind === 'applied') filed.push(join(answersDir, name));
      if (terminal) continue;
      const s = parseAnswerStaging((await readIfExists(join(answersDir, name))) ?? '');
      if (!s) continue;
      const cited = s.cited.map((c) => parsePageRef(c, d, domains)).filter((r): r is PageRef => r !== null);
      const filing: AnswerFiling = { id, domain: d, question: s.question, answer: s.answer, cited, sessionId: s.sessionId, askedAt: s.askedAt };
      answers.push({ kind: 'file-answer', ref: { kind: 'file-answer', domain: d, id }, order: orderKey(s.askedAt, id), filing, staging: join(answersDir, name), inputs: [] });
    }
    const memos: Job[] = [];
    const rawDir = this.#layout.rawDir(d);
    for (const name of await listNames(rawDir)) {
      const id = name.endsWith('.md') && !name.endsWith('.source.md') ? parseMemoId(name.slice(0, -3)) : null;
      if (!id || `${id}.md` !== name || ledger.history('ingest', id).terminal) continue;
      const parsed = parseMemoFile((await readIfExists(join(rawDir, name))) ?? '');
      const source = `${id}.source.md`;
      const photos = parsed.ok ? parsed.value.memo.attachments.map((a) => a.file) : [];
      const inputs = [
        this.#layout.rawRel(d, name),
        ...((await exists(join(rawDir, source))) ? [this.#layout.rawRel(d, source)] : []),
        // A copy that is gone is left out rather than committed as a deletion; the ingest just runs without it.
        ...(await asyncFilter(photos, (f) => exists(join(this.#layout.attachmentsDir, f)))).map((f) => this.#layout.attachmentRel(f)),
      ];
      memos.push({ kind: 'ingest', ref: { kind: 'ingest', domain: d, id }, order: orderKey(parsed.ok ? parsed.value.memo.capturedAt : '', id), inputs });
    }
    return { jobs: [...answers.sort(byOrder), ...memos.sort(byOrder)], filed };
  }

  async runNext(domain: DomainName, opts: { readonly withLlm?: boolean } = {}): Promise<RunReport> {
    const read = await this.#readConfig();
    if (!read.ok) return { kind: 'paused' };
    const dc = read.config.domains.get(domain);
    if (!dc) return { kind: 'idle' };
    const env = this.#env(read.config);
    const domains = [...read.config.domains.keys()];
    return this.#locked(this.#jobLocks, domain)(async () => {
      await this.#init(dc);
      await this.#recoverInflight(env, domain);
      await this.#finishMoves(env, domain);
      const ledger = await this.#ledger(domain);
      const { jobs, filed } = await this.#candidates(domain, ledger, domains);
      for (const f of filed) await unlinkQuiet(f);
      const picked = jobs.find((j) => opts.withLlm !== false || !JOBS[j.kind].needsLlm);
      if (!picked) return { kind: 'idle' };

      await this.#commitConfig();
      await this.#commitManual(domain, `manual(${domain})`);
      const history = ledger.history(picked.ref.kind, picked.ref.id);
      const base = (await this.#git.head())!;
      const since = this.#now().toISOString();
      const markerFor = async (j: Job): Promise<InflightMarker> => {
        const inputs: Record<string, string> = {};
        for (const p of j.inputs) inputs[p] = sha256(await readIfExists(this.#layout.fromRel(p)));
        return { job: j.ref, base, attempt: history.attempts + 1, since, inputs };
      };
      let marker = await markerFor(picked);
      const markerFile = this.#layout.inflightFile(domain);
      await writeInflight(markerFile, marker);
      const job = (await specOf(picked).prepare?.(env, picked)) ?? picked;
      if (job !== picked) await writeInflight(markerFile, (marker = await markerFor(job)));

      const cwd = this.#layout.domainDir(domain);
      const touched = new Set<string>();
      const result = await specOf(job).perform(env, job, { history, touch: (p) => touched.add(resolve(cwd, p).normalize('NFC')), domain: dc });
      if (result.kind === 'unavailable') {
        await this.#rollback(domain, touched);
        await clearInflight(markerFile);
        return { kind: 'unavailable', job: job.ref, reason: result.reason, retryAfterMs: result.retryAfterMs };
      }

      await this.#git.resetPaths([this.#layout.logRel(domain), this.#layout.indexRel(domain)]);
      const problems = result.kind === 'failed' ? [{ rule: 'llm', path: '', detail: result.reason } as const] : await this.#check(dc, domains, touched, marker);
      const report = problems.length === 0 && result.kind === 'finished'
        ? await this.#commitJob(env, dc, job, result.verdict)
        : await this.#commitFailure(env, domain, job, marker.attempt, problems, touched);
      await clearInflight(markerFile);
      if (job.kind === 'file-answer' && report.kind === 'committed') await unlinkQuiet(job.staging);
      return report;
    });
  }

  async #check(dc: DomainConfig, domains: readonly DomainName[], touched: ReadonlySet<string>, marker: InflightMarker): Promise<readonly Problem[]> {
    const d = dc.name;
    const lay = this.#layout;
    const wikiPrefix = `${lay.wikiDir(d)}${sep}`;
    const outsideWrites = [...touched].filter((p) => !p.startsWith(wikiPrefix)).map((p) => lay.toRel(p) ?? p);
    const modifiedInputs: string[] = [];
    for (const [p, sum] of Object.entries(marker.inputs)) if (sha256(await readIfExists(lay.fromRel(p))) !== sum) modifiedInputs.push(p);
    const changes = await this.#git.status([lay.wikiRel(d)]);
    const contents = new Map<string, string>();
    for (const c of changes) if (c.status !== 'deleted') contents.set(c.path, (await readIfExists(lay.fromRel(c.path))) ?? '');
    const names: PageNameIndex = new Map([
      ...(await this.#namesAt('HEAD', domains.filter((o) => o !== d))),
      [d, namesOf(await listMarkdown(lay.wikiDir(d)))],
    ]);
    return check({
      domain: d,
      changes,
      contents,
      reviewAtHead: await this.#git.show('HEAD', lay.reviewRel(d)),
      names,
      allowedTypes: new Set([...dc.pageTypes.map((t) => t.type), 'answer']),
      outsideWrites,
      modifiedInputs,
      attachments: new Set(await listNames(lay.attachmentsDir)),
    });
  }

  async #commitJob(env: Env, dc: DomainConfig, job: Job, verdict: VerdictId): Promise<RunReport> {
    const d = dc.name;
    await this.#writeIndex(dc);
    const prefix = `${this.#layout.wikiRel(d)}/`;
    const pages = (await this.#git.status([this.#layout.wikiRel(d)]))
      .map((c) => c.path.slice(prefix.length))
      .filter((p) => roleOf(p) === 'page' || roleOf(p) === 'answer');
    const sha = await this.#commitLedger(
      env,
      d,
      () => ({ job: job.ref.kind, id: job.ref.id, outcome: { kind: 'applied', verdict, pages } }),
      [this.#layout.wikiRel(d), ...job.inputs],
      `${job.ref.kind}(${d}): ${job.ref.id}`,
    );
    return { kind: 'committed', job: job.ref, commit: sha!, verdict };
  }

  async #commitFailure(env: Env, d: DomainName, job: Job, attempt: number, problems: readonly Problem[], touched: ReadonlySet<string>): Promise<RunReport> {
    await this.#rollback(d, touched);
    const max = this.#opts.maxAttempts;
    const gaveUp = attempt >= max;
    const reason = describeProblems(problems);
    const outcome: NewOutcome = gaveUp ? { kind: 'gave-up', attempt, max, reason } : { kind: 'attempt-failed', attempt, max, reason, interrupted: false };
    const words = renderThird(env.config.locale, outcome);
    if (gaveUp) await this.#appendReview(d, [`- [${env.today()}] ${job.ref.kind} \`${job.ref.id}\` ${words}: ${reason}`]);
    await this.#commitLedger(
      env,
      d,
      () => ({ job: job.ref.kind, id: job.ref.id, outcome }),
      [...(await this.#reviewPathIfExists(d)), ...(gaveUp ? job.inputs : [])],
      `${job.ref.kind}(${d}): ${job.ref.id} ${words}`,
    );
    return gaveUp ? { kind: 'gave-up', job: job.ref, problems } : { kind: 'retrying', job: job.ref, attempt, problems };
  }

  /**
   * Restores what the job touched inside its domain (never raw/, which holds pending memos), plus
   * files created under wiki/ since the job began. A human edit elsewhere survives.
   */
  async #rollback(d: DomainName, touched: ReadonlySet<string>): Promise<void> {
    const lay = this.#layout;
    const paths = new Set([lay.logRel(d), lay.indexRel(d)]);
    for (const abs of touched) {
      const rel = lay.toRel(abs);
      if (rel && rel.startsWith(`${d}/`) && !rel.startsWith(`${d}/raw/`)) paths.add(rel);
    }
    for (const c of await this.#git.status([lay.wikiRel(d)])) if (c.status === 'untracked' || c.status === 'added') paths.add(c.path);
    await this.#git.resetPaths([...paths]);
  }

  /**
   * A marker means the previous runNext for this domain stopped mid-job. If HEAD has a line for
   * the job that the marker's base lacks, only the marker clear was lost. Otherwise the job's
   * leftovers are discarded and the attempt counts, so a job that kills the gateway every time
   * still stops after maxAttempts.
   */
  async #recoverInflight(env: Env, d: DomainName): Promise<void> {
    const file = this.#layout.inflightFile(d);
    const marker = await readInflight(file);
    if (!marker) return;
    const { kind, id } = marker.job;
    if ((await this.#ledger(d)).lineCount(kind, id) > (await this.#ledger(d, marker.base)).lineCount(kind, id)) {
      await clearInflight(file);
      return;
    }
    await this.#git.resetPaths((await this.#git.status([this.#layout.wikiRel(d)])).map((c) => c.path));
    const max = this.#opts.maxAttempts;
    const gaveUp = marker.attempt >= max;
    const reason = INTERRUPTED;
    const outcome: NewOutcome = gaveUp ? { kind: 'gave-up', attempt: marker.attempt, max, reason } : { kind: 'attempt-failed', attempt: marker.attempt, max, reason, interrupted: true };
    const words = renderThird(env.config.locale, outcome);
    if (gaveUp) await this.#appendReview(d, [`- [${env.today()}] ${kind} \`${id}\` ${words}: ${reason}`]);
    const inputs: string[] = [];
    if (gaveUp) for (const p of Object.keys(marker.inputs)) if (await exists(this.#layout.fromRel(p))) inputs.push(p);
    await this.#commitLedger(env, d, () => ({ job: kind, id, outcome }), [...(await this.#reviewPathIfExists(d)), ...inputs], `${kind}(${d}): ${id} ${words}`);
    await clearInflight(file);
  }

  async retry(job: JobRef): Promise<RetryResult> {
    const env = this.#env(await this.config());
    if (job.kind === 'ingest' && (await this.#movedTo(job.domain, job.id as MemoId, [...env.config.domains.keys()]))) return { kind: 'not-failed' };
    const sha = await this.#commitLedger(
      env,
      job.domain,
      (head) => (head.history(job.kind, job.id).terminal?.kind === 'gave-up' ? { job: job.kind, id: job.id, outcome: { kind: 'retry' } } : null),
      [],
      `retry(${job.domain}): ${job.kind} ${job.id}`,
    );
    return sha ? { kind: 'retrying' } : { kind: 'not-failed' };
  }

  async status(): Promise<Status> {
    const inbox = (await listNames(this.#layout.inboxDir)).filter((n) => n.endsWith('.md')).length;
    const read = await this.#readConfig();
    if (!read.ok) return { inbox, paused: true, problems: read.problems, domains: [] };
    const names = [...read.config.domains.keys()];
    const held = await this.#held(names);
    const domains: DomainStatus[] = [];
    for (const { name: d, agentsMayRead, modelProfile } of read.config.domains.values()) {
      const ledger = await this.#ledger(d);
      const marker = await readInflight(this.#layout.inflightFile(d));
      domains.push({
        domain: d,
        agentsMayRead,
        modelProfile,
        pending: (await this.#candidates(d, ledger, names)).jobs.length,
        held: held.filter((h) => h.domain === d).length,
        failed: ledger.failedCount(),
        running: marker ? { ...marker.job, since: marker.since } : null,
      });
    }
    return { inbox, paused: false, problems: read.warnings, domains };
  }

  async chatContext(target: ChatTarget): Promise<ChatContext> {
    const config = await this.config();
    if (target.kind === 'root') {
      return { cwd: this.#layout.root, systemPrompt: `${await fs.readFile(this.#layout.rootSchema, 'utf8')}\n\n${renderDomainCatalog(config)}` };
    }
    const dc = config.domains.get(target.domain);
    if (!dc) throw new Error(`${target.domain} is no longer a domain`);
    return { cwd: this.#layout.domainDir(dc.name), systemPrompt: `${await composeSystemPrompt(this.#layout.domainSchema(dc.name))}\n\n${renderPageTypes(dc)}` };
  }

  async citations(text: string, target: ChatTarget): Promise<readonly PageRef[]> {
    const domains = await this.#domains();
    const names = await this.#namesAt('HEAD', domains);
    const out = new Map<string, PageRef>();
    for (const link of extractWikilinks(text)) {
      const from = target.kind === 'domain' ? target.domain : null;
      const ref = from ? parsePageRef(link, from, domains) : /^(.+?)\/wiki\//.test(link) ? parsePageRef(link, domains[0]!, domains) : null;
      if (ref && linkResolves(pageRefString(ref), ref.domain, names)) out.set(pageRefString(ref), ref);
    }
    return [...out.values()];
  }

  watch(onWake: (w: Wake) => void): () => void {
    const watcher = fsWatch(this.#layout.root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = filename.normalize('NFC').split(sep).join('/');
      if (rel.startsWith('.git/') || rel.startsWith('.gateway/')) return;
      const wake = this.#layout.wakeFor(rel);
      if (!wake) return;
      if (wake.kind !== 'domain') onWake(wake);
      else void this.config().then((c) => domainIn(c, wake.name)).then((d) => d && onWake({ kind: 'domain', domain: d }), () => undefined);
    });
    const stop = () => watcher.close();
    this.#unwatch.add(stop);
    return () => {
      this.#unwatch.delete(stop);
      stop();
    };
  }

  async close(): Promise<void> {
    for (const stop of this.#unwatch) stop();
    this.#unwatch.clear();
    await this.#lock.release();
  }
}
