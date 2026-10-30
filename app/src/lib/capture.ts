import type { MemoAttachmentWire, MemoRequest, MemoSourceWire } from './wire';

const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, '0');

/** Local wall time with its offset, e.g. 2026-10-29T15:12:03+09:00. `offsetMinutes` is east of UTC. */
export function formatCapturedAt(at: Date, offsetMinutes: number): string {
  const local = new Date(at.getTime() + offsetMinutes * 60_000);
  const date = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
  const time = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
  const sign = offsetMinutes < 0 ? '-' : '+';
  return `${date}T${time}${sign}${pad(offsetMinutes / 60)}:${pad(offsetMinutes % 60)}`;
}

export function deviceTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof tz === 'string' && tz.includes('/')) return tz;
  } catch {}
  return 'Asia/Seoul';
}

/** `place` is shown in the app (구 and 동); `address` is only recorded (down to the 번지 or building). */
export type GeoFix = { lat: number; lon: number; place: string | null; address: string | null };

export type CaptureInput = {
  id: string;
  text: string;
  at: Date;
  source: MemoSourceWire;
  domainHint: string | null;
  location: GeoFix | null;
  attachments: MemoAttachmentWire[];
};

/** Built once and frozen into the outbox; resending the same JSON is what makes the POST idempotent. */
export function buildMemoRequest(input: CaptureInput): MemoRequest {
  return {
    id: input.id,
    text: input.text,
    captured_at: formatCapturedAt(input.at, -input.at.getTimezoneOffset()),
    tz: deviceTimeZone(),
    location: input.location,
    source: input.source,
    domain_hint: input.domainHint,
    ...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
  };
}
