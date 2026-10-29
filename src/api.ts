/**
 * Wire contract shared with clients: HTTP Shortcuts today, the Expo app later, which imports
 * this file as-is. Plain JSON shapes in snake_case. No imports, no logic. http.ts parses these
 * into domain types, and nothing past http.ts sees them.
 */

export type MemoSourceWire = 'typed' | 'share' | 'selection' | 'voice' | 'chat' | 'feed' | 'agent';

/** Where a coding agent was working when it sent the memo. `project` is the cwd's folder name. */
export type MemoContextWire = { project: string; cwd: string; branch: string | null };

/** POST /memos. A fact stated in chat is sent here too, with source "chat" and the chat's domain as domain_hint. */
export type MemoRequest = {
  id: string;
  text: string;
  captured_at: string;
  tz: string;
  /** `place` is the short name the app shows; `address` is the full one, recorded but not returned. */
  location?: { lat: number; lon: number; place?: string | null; address?: string | null } | null;
  source: MemoSourceWire;
  domain_hint?: string | null;
  context?: MemoContextWire | null;
};

/** `running`: the ingest is mid-run now. `failed`: it gave up (포기) and waits for a retry or a move. */
export type MemoStateWire = 'inbox' | 'held' | 'routed' | 'running' | 'ingested' | 'failed';

export type MemoResponse =
  | { id: string; status: 'accepted' }
  | { id: string; status: 'duplicate'; state: MemoStateWire; domain: string | null };

/**
 * GET /memos?limit=<1..100, default 30>&before=<next_before>: newest captured first. Pass
 * next_before back as-is (percent-encoded); it is null on the last page. Chat answers are not listed.
 */
export type MemoListItemWire = {
  id: string;
  /** The first 140 characters. */
  text: string;
  captured_at: string;
  tz: string;
  source: MemoSourceWire;
  /** null while in the inbox. */
  domain: string | null;
  state: MemoStateWire;
  /** The ingest verdict, ingested only. */
  verdict: string | null;
  /** The first page the ingest wrote, under the domain's wiki/, without .md. Ingested only. */
  first_page: string | null;
  /** When the ingest committed or gave up. Ingested or failed only. */
  finished_at: string | null;
};
export type MemoListResponse = { memos: MemoListItemWire[]; next_before: string | null };

/**
 * Set for a failed memo, and for a routed or running memo that already failed attempts
 * (attempts + 1 is the attempt now queued or running). `code` is llm, scope, input-modified,
 * append-only, frontmatter, type, empty, broken-link, or interrupted.
 */
export type MemoFailureWire = { attempts: number; max: number; code: string; detail: string };

/** GET /memos/:id. Unknown id 404. */
export type MemoDetailWire = Omit<MemoListItemWire, 'text'> & {
  /** The full text. */
  text: string;
  place: string | null;
  /** null while in the inbox. */
  routing: { by: 'hint' | 'classifier' | 'fallback' | 'user'; confidence: number | null; reason: string | null } | null;
  /** The pages the ingest commit created or modified, under wiki/ without .md. */
  pages: { path: string; type: string | null; change: 'created' | 'modified' }[];
  failure: MemoFailureWire | null;
};

/** POST /answers. `cited` entries are "도메인/wiki/페이지", or "페이지" meaning `domain`. */
export type AnswerRequest = {
  id: string;
  domain: string;
  question: string;
  answer: string;
  cited: string[];
  session_id?: string | null;
};

export type AnswerResponse = { id: string; status: 'accepted' | 'duplicate' };

/** POST /chat, answered as text/event-stream. `target` is a domain folder name or "root". */
export type ChatRequest = {
  target: string;
  message: string;
  session_id?: string | null;
};

/** One SSE frame: `event: <type>\ndata: <JSON of the other fields>\n\n`. */
export type ChatFrame =
  | { type: 'session'; session_id: string }
  | { type: 'delta'; text: string }
  | { type: 'done'; session_id: string; cited: string[] }
  | { type: 'error'; message: string };

export type StatusResponse = {
  server: string;
  inbox: number;
  domains: Record<string, {
    pending: number;
    /** Memos waiting for the user to confirm or move them: the app's badge. */
    held: number;
    failed: number;
    running: { kind: string; id: string; since: string } | null;
  }>;
};

/** GET /held. Memos the classifier was unsure of wait here, oldest captured first, until confirmed or moved. */
export type HeldMemoWire = {
  id: string;
  domain: string;
  /** The first 280 characters. */
  text: string;
  captured_at: string;
  source: MemoSourceWire;
  /** null when classification failed and the memo went to the fallback domain. */
  confidence: number | null;
  reason: string;
};
export type HeldResponse = { held: HeldMemoWire[] };

/**
 * POST /memos/:id/confirm (no body) queues a held memo where it is. POST /memos/:id/move with
 * MoveRequest queues a held or gave-up memo in another domain. Unknown id 404, a memo in any
 * other state 409 with the state as `detail`, unknown domain 400.
 */
export type MoveRequest = { domain: string };
export type ReleaseResponse = { id: string; status: 'released'; domain: string };

/** POST /jobs/retry: reopen a job that gave up (포기). */
export type RetryRequest = { domain: string; kind: 'ingest' | 'file-answer'; id: string };
export type RetryResponse = { status: 'retrying' };

export type ErrorResponse = {
  error: 'unauthorized' | 'bad_request' | 'not_found' | 'unprocessable' | 'conflict' | 'too_large' | 'internal';
  detail?: string;
};

/** The QR that `npm run pair` prints. The app scans it, then confirms with GET /status. */
export type PairingPayload = { v: 1; url: string; token: string; server: string };
