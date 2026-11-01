import { normalizeUrl, pairingFailureCopy, parseManual, parseQr, parseStoredPairing } from '../pairing';

describe('parseQr', () => {
  it('decodes the payload `npm run pair` prints', () => {
    const qr = JSON.stringify({ v: 1, url: 'http://macmini.tail-1234.ts.net:8787', token: 'abcdefghijklmnopqrstuvwxyz012345', server: '0.1.0' });
    expect(parseQr(qr)).toEqual({ mode: 'qr', url: 'http://macmini.tail-1234.ts.net:8787', token: 'abcdefghijklmnopqrstuvwxyz012345' });
  });

  it.each([
    ['another version', JSON.stringify({ v: 2, url: 'http://a.b:1', token: 't', server: '0.1.0' })],
    ['a missing token', JSON.stringify({ v: 1, url: 'http://a.b:1', token: ' ', server: '0.1.0' })],
    ['a missing server', JSON.stringify({ v: 1, url: 'http://a.b:1', token: 't' })],
    ['a non-http url', JSON.stringify({ v: 1, url: 'ftp://a.b', token: 't', server: '0.1.0' })],
    ['a plain URL QR', 'https://example.com'],
    ['a JSON array', '[1]'],
  ])('rejects %s', (_name, text) => {
    expect(parseQr(text)).toBeNull();
  });
});

describe('normalizeUrl', () => {
  it.each([
    ['macmini.tail-xxxx.ts.net:8787', 'http://macmini.tail-xxxx.ts.net:8787'],
    ['  100.64.0.7:8787/ ', 'http://100.64.0.7:8787'],
    ['HTTP://10.0.2.2:8799', 'http://10.0.2.2:8799'],
    ['https://wiki.example.com/gw/', 'https://wiki.example.com/gw'],
  ])('%s → %s', (raw, url) => {
    expect(normalizeUrl(raw)).toBe(url);
  });

  it.each(['', 'ftp://a.b', 'http://', 'a b:1'])('rejects %j', (raw) => {
    expect(normalizeUrl(raw)).toBeNull();
  });
});

it('needs both an address and a token for manual entry', () => {
  expect(parseManual('10.0.2.2:8799', ' tok ')).toEqual({ mode: 'manual', url: 'http://10.0.2.2:8799', token: 'tok' });
  expect(parseManual('10.0.2.2:8799', '  ')).toBeNull();
});

it('reads a stored pairing back, and treats a corrupt one as unpaired', () => {
  const p = { url: 'http://10.0.2.2:8799', token: 't', server: '0.1.0' };
  expect(parseStoredPairing(JSON.stringify(p))).toEqual(p);
  expect(parseStoredPairing('{"url":1}')).toBeNull();
  expect(parseStoredPairing('not json')).toBeNull();
  expect(parseStoredPairing(null)).toBeNull();
});

describe('failure copy', () => {
  it('tells a QR user to bring the QR up again, and a manual user to check address and token', () => {
    expect(pairingFailureCopy('qr', 'unreachable')).toBe('연결하지 못했어요. Tailscale이 켜져 있는지 확인하고, 컴퓨터에서 QR을 다시 띄워 주세요.');
    expect(pairingFailureCopy('qr', 'unauthorized')).toContain('QR을 다시 띄워 주세요');
    expect(pairingFailureCopy('manual', 'unreachable')).toContain('Tailscale');
    expect(pairingFailureCopy('manual', 'unauthorized')).toContain('토큰');
  });

  it('separates a connection failure from a token error', () => {
    for (const mode of ['qr', 'manual'] as const) {
      expect(pairingFailureCopy(mode, 'unreachable')).not.toBe(pairingFailureCopy(mode, 'unauthorized'));
      expect(pairingFailureCopy(mode, 'unauthorized')).not.toContain('Tailscale');
    }
  });
});
