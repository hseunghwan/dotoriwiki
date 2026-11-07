import { checkForUpdate, compareVersions } from '../update';

function replying(status: number, body: unknown): typeof fetch {
  return (async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as typeof fetch;
}

test('versions compare by number, not by text', () => {
  expect(compareVersions('v0.10.0', '0.9.0')).toBe(1);
  expect(compareVersions('0.1.0', 'v0.1.0')).toBe(0);
  expect(compareVersions('0.1', '0.1.1')).toBe(-1);
  expect(compareVersions('v1.0.0-beta.1', '1.0.0')).toBe(0);
});

test('a newer tag comes back with its release page', async () => {
  const release = { tag_name: 'v0.2.0', html_url: 'https://github.com/o/r/releases/tag/v0.2.0' };
  expect(await checkForUpdate('0.1.0', replying(200, release))).toEqual({ kind: 'newer', version: 'v0.2.0', url: release.html_url });
});

test('the same or an older tag means this build is current', async () => {
  expect(await checkForUpdate('0.1.0', replying(200, { tag_name: 'v0.1.0', html_url: 'x' }))).toEqual({ kind: 'current' });
  expect(await checkForUpdate('0.2.0', replying(200, { tag_name: 'v0.1.0', html_url: 'x' }))).toEqual({ kind: 'current' });
});

test('an error status, a strange body, or a thrown fetch all fail', async () => {
  expect(await checkForUpdate('0.1.0', replying(404, {}))).toEqual({ kind: 'failed' });
  expect(await checkForUpdate('0.1.0', replying(200, { message: 'rate limited' }))).toEqual({ kind: 'failed' });
  const throwing = (async () => {
    throw new Error('offline');
  }) as unknown as typeof fetch;
  expect(await checkForUpdate('0.1.0', throwing)).toEqual({ kind: 'failed' });
});
