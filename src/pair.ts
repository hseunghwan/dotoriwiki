/**
 * `dotoriwiki pair`: the QR the phone app scans, printed in this terminal. There is deliberately no
 * pairing web page: the gateway listens only on the Tailscale address, and a page would put the
 * token on it.
 */

import QRCode from 'qrcode';
import type { PairingPayload, StatusResponse } from './api.ts';
import type { Run } from './enrich.ts';
import { gatewayStatus, tailscaleCandidates } from './install.ts';
import { LOOPBACK, type Config } from './machine.ts';

/** The machine's MagicDNS name, which survives a Tailscale address change, or null. */
async function magicDnsName(pathEnv: string, run: Run): Promise<string | null> {
  for (const bin of await tailscaleCandidates(pathEnv)) {
    const r = await run(bin, ['status', '--json'], 10_000);
    if (r.code !== 0) continue;
    try {
      const name = (JSON.parse(r.stdout) as { Self?: { DNSName?: string } }).Self?.DNSName;
      if (name) return name.replace(/\.$/, '');
    } catch {}
  }
  return null;
}

export type Pairing = { readonly url: string; readonly status: StatusResponse; readonly qr: string } | { readonly tried: readonly string[] };

/** The first address the gateway answers on, the MagicDNS name before HOST, and its QR. */
export async function pairing(cfg: Config, server: string, pathEnv: string, run: Run): Promise<Pairing> {
  const hosts = cfg.host === LOOPBACK ? [cfg.host] : [await magicDnsName(pathEnv, run), cfg.host];
  const tried = hosts.filter((h): h is string => h !== null).map((h) => `http://${h}:${cfg.port}`);
  for (const url of tried) {
    const status = (await gatewayStatus(url, cfg.token)) as StatusResponse | null;
    if (!status) continue;
    const payload: PairingPayload = { v: 1, url, token: cfg.token, server };
    return { url, status, qr: await QRCode.toString(JSON.stringify(payload), { type: 'terminal', small: true, errorCorrectionLevel: 'L' }) };
  }
  return { tried };
}
