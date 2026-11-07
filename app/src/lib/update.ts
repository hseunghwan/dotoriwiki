/**
 * Whether GitHub has a newer release than this build. The app workflow tags releases vX.Y.Z from
 * package.json's version, the same number app.config.ts gives the build, so the two compare.
 */

const REPO = 'hseunghwan/dotoriwiki';
const TIMEOUT_MS = 10_000;

export type UpdateCheck = { kind: 'current' } | { kind: 'newer'; version: string; url: string } | { kind: 'failed' };

/** Numeric x.y.z order; a leading v and anything after a - or + are ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/i, '').split(/[-+]/)[0]!.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

export async function checkForUpdate(current: string, fetcher: typeof fetch = fetch): Promise<UpdateCheck> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const res = await fetcher(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: abort.signal,
    });
    if (!res.ok) return { kind: 'failed' };
    const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
    if (typeof body.tag_name !== 'string' || typeof body.html_url !== 'string') return { kind: 'failed' };
    if (compareVersions(body.tag_name, current) <= 0) return { kind: 'current' };
    return { kind: 'newer', version: body.tag_name, url: body.html_url };
  } catch {
    return { kind: 'failed' };
  } finally {
    clearTimeout(timer);
  }
}
