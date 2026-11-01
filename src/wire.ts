/**
 * The memo write path and the domain → wire mappings shared by the two boundaries that speak
 * api.ts: the HTTP routes (http.ts) and the MCP tools (mcp.ts).
 */

import type { MemoDetailWire, MemoListItemWire, MemoResponse } from './api.ts';
import { describeDevice, parseMemo, type MemoDetail, type MemoSummary, type Routing, type Wiki } from './wiki/index.ts';

/** 400 for a body that does not parse, 422 for photos named but never uploaded. */
export type AcceptReply = { readonly ok: true; readonly value: MemoResponse } | { readonly ok: false; readonly status: 400 | 422; readonly detail: string };

/** The one way a memo is written: parse the MemoRequest body, then accept. */
export async function acceptMemo(wiki: Wiki, body: unknown): Promise<AcceptReply> {
  const parsed = parseMemo(body);
  if (!parsed.ok) return { ok: false, status: 400, detail: parsed.detail };
  const r = await wiki.accept(parsed.value);
  const id = parsed.value.id;
  switch (r.kind) {
    case 'created': return { ok: true, value: { id, status: 'accepted' } };
    case 'duplicate': return { ok: true, value: { id, status: 'duplicate', state: r.state, domain: r.domain } };
    case 'missing-photo': return { ok: false, status: 422, detail: `attachments: photo ${r.n} was not uploaded` };
  }
}

export function listItem(s: MemoSummary): MemoListItemWire {
  return {
    id: s.memo.id,
    text: Array.from(s.memo.text).slice(0, 140).join(''),
    captured_at: s.memo.capturedAt,
    tz: s.memo.tz,
    source: s.memo.source,
    domain: s.domain,
    state: s.state,
    verdict: s.state === 'ingested' ? s.verdict.text : null,
    verdict_id: s.state === 'ingested' ? s.verdict.id : null,
    first_page: s.state === 'ingested' ? s.firstPage : null,
    finished_at: s.state === 'ingested' || s.state === 'failed' ? s.finishedAt : null,
    photos: s.memo.attachments.length,
  };
}

const routingWire = (r: Routing): NonNullable<MemoDetailWire['routing']> => ({
  by: r.by,
  confidence: r.by === 'classifier' ? r.confidence : null,
  reason: r.by === 'classifier' || r.by === 'fallback' ? r.reason : null,
});

export function detailWire(d: MemoDetail): MemoDetailWire {
  return {
    ...listItem(d),
    text: d.memo.text,
    place: d.memo.location?.place ?? null,
    routing: d.routing && routingWire(d.routing),
    pages: d.pages.map((p) => ({ path: p.path, type: p.type, change: p.change })),
    failure: d.failure && { attempts: d.failure.attempts, max: d.failure.max, code: d.failure.code, detail: d.failure.detail },
    attachments: d.memo.attachments.map((a) => ({ file: a.file, taken_at: a.takenAt, place: a.location?.place ?? null, device: describeDevice(a.device) })),
  };
}
