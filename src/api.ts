/**
 * Wire contract shared with clients: HTTP Shortcuts and the Expo app. Plain JSON shapes in
 * snake_case. No imports, no logic. http.ts parses these into domain types, and nothing past
 * http.ts sees them. The app builds without this tree, so it keeps a byte copy at
 * app/src/lib/wire.ts, and test/app-wire.test.ts fails when the two differ.
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
  /** Each n must already be uploaded with PUT /attachments/:id/:n. `text` may be empty when this is non-empty. */
  attachments?: MemoAttachmentWire[] | null;
};

/** `place` and `address` are geocoded on the phone from the photo's own GPS, in the same formats as location. */
export type MemoAttachmentWire = {
  /** 1..10, unique within the memo. */
  n: number;
  origin: 'gallery' | 'camera' | 'share';
  place?: string | null;
  address?: string | null;
};

/** PUT /attachments/:id/:n, body the raw image bytes (JPEG, HEIC, PNG or WebP; at most 40 MB). Same bytes again is 200; other bytes are 409. */
export type AttachmentUploadResponse = { name: string; sha256: string; bytes: number };

/** `running`: the ingest is mid-run now. `failed`: it gave up and waits for a retry or a move. */
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
  /** The ingest verdict as the wiki's locale words it. Ingested only. Old apps show this. */
  verdict: string | null;
  /** The same verdict as a token. Ingested only. null for a verdict from before the gateway. Absent from gateways before P2. */
  verdict_id?: 'created' | 'updated' | 'conflict' | 'unchanged' | 'saved' | null;
  /** The first page the ingest wrote, under the domain's wiki/, without .md. Ingested only. */
  first_page: string | null;
  /** When the ingest committed or gave up. Ingested or failed only. */
  finished_at: string | null;
  /** How many photos the memo carries. */
  photos: number;
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
  /** Fetch each with GET /attachments/:file (the 2048 px JPEG). `device` is "make model". */
  attachments: { file: string; taken_at: string | null; place: string | null; device: string | null }[];
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

/**
 * The gateway keeps each chat session, outside the wiki. A POST /chat with a session_id runs on
 * the session's stored target: an unknown session is 404, a different target or a turn already in
 * flight on it is 409. A turn the client aborts is not kept.
 */
export type ChatSummaryWire = {
  session_id: string;
  target: string;
  /** The first question, about 40 characters. */
  title: string;
  created_at: string;
  updated_at: string;
  turns: number;
};

/** GET /chats?limit=<1..100, default 30>&before=<next_before>: newest updated first. */
export type ChatListResponse = { chats: ChatSummaryWire[]; next_before: string | null };

/** A turn that failed mid-stream carries `error` instead of `answer`. */
export type ChatTurnWire = { at: string; question: string; answer: string; cited: string[] } | { at: string; question: string; error: string };

/** GET /chats/:id, or 404. DELETE /chats/:id answers 204, or 404. */
export type ChatDetailWire = { session_id: string; target: string; created_at: string; turns: ChatTurnWire[] };

export type StatusResponse = {
  server: string;
  inbox: number;
  domains: Record<string, {
    pending: number;
    /** Memos waiting for the user to confirm or move them: the app's badge. */
    held: number;
    failed: number;
    running: { kind: string; id: string; since: string } | null;
    /** Absent from gateways older than dotoriwiki.yaml, as is `config`. */
    agents_may_read?: boolean;
    model_profile?: string | null;
  }>;
  /**
   * paused: dotoriwiki.yaml is broken, `domains` is empty, and memos wait in the inbox until it is
   * fixed. ok: `problems` are warnings, such as a model_profile this machine does not have.
   */
  config?: { state: 'ok' | 'paused'; problems: { key: string; problem: string; fix: string }[] };
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

/** POST /jobs/retry: reopen a job that gave up. */
export type RetryRequest = { domain: string; kind: 'ingest' | 'file-answer'; id: string };
export type RetryResponse = { status: 'retrying' };

export type ErrorResponse = {
  error: 'unauthorized' | 'bad_request' | 'not_found' | 'unprocessable' | 'conflict' | 'too_large' | 'internal' | 'paused';
  detail?: string;
};

/** The QR that `dotoriwiki pair` prints. The app scans it, then confirms with GET /status. */
export type PairingPayload = { v: 1; url: string; token: string; server: string };
