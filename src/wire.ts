/**
 * The memo write path and the domain → wire mappings shared by the two boundaries that speak
 * api.ts: the HTTP routes (http.ts) and the MCP tools (mcp.ts).
 */

import type { MemoDetailWire, MemoListItemWire, MemoResponse } from './api.ts';
import { parseMemo, type MemoDetail, type MemoSummary, type Parsed, type Routing, type Wiki } from './wiki/index.ts';

/** The one way a memo is written: parse the MemoRequest body, then accept. */
export async function acceptMemo(wiki: Wiki, body: unknown): Promise<Parsed<MemoResponse>> {
  const parsed = parseMemo(body);
  if (!parsed.ok) return parsed;
  const r = await wiki.accept(parsed.value);
  const id = parsed.value.id;
  return { ok: true, value: r.kind === 'created' ? { id, status: 'accepted' } : { id, status: 'duplicate', state: r.state, domain: r.domain } };
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
    verdict: s.state === 'ingested' ? s.verdict : null,
    first_page: s.state === 'ingested' ? s.firstPage : null,
    finished_at: s.state === 'ingested' || s.state === 'failed' ? s.finishedAt : null,
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
  };
}
