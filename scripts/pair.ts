/**
 * Prints the pairing QR for the Android app in this terminal. There is deliberately no pairing web
 * page: the gateway listens only on the Tailscale address, and a page would put the token on it.
 *
 *   npm run pair                 QR plus the address for manual entry
 *   npm run pair -- --show-token also print the token in plain text
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import QRCode from 'qrcode';
import type { PairingPayload, StatusResponse } from '../src/api.ts';
import { machinePaths, parseEnvFile } from '../src/machine.ts';

const TAILSCALE = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const envPath = machinePaths(process.env).envFile;

const env = Object.fromEntries(parseEnvFile(readFileSync(envPath, 'utf8')));
const { HOST: host, PORT: port = '8787', GATEWAY_TOKEN: token } = env;
if (!host || !token) throw new Error(`${envPath} must set HOST and GATEWAY_TOKEN; run scripts/install-launchd.sh first`);

const server = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

function magicDnsName(): string | null {
  try {
    const name = (JSON.parse(execFileSync(TAILSCALE, ['status', '--json'], { encoding: 'utf8' })) as { Self?: { DNSName?: string } }).Self?.DNSName;
    return name ? name.replace(/\.$/, '') : null;
  } catch {
    return null;
  }
}

async function reachable(url: string): Promise<StatusResponse | null> {
  try {
    const res = await fetch(`${url}/status`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    return res.ok ? ((await res.json()) as StatusResponse) : null;
  } catch {
    return null;
  }
}

// The name survives a Tailscale IP change, but only if MagicDNS resolves it; otherwise use the address the gateway binds.
const candidates = [magicDnsName(), host].filter((h): h is string => !!h).map((h) => `http://${h}:${port}`);
let url: string | null = null;
let status: StatusResponse | null = null;
for (const c of candidates) {
  status = await reachable(c);
  if (status) { url = c; break; }
}
if (!url || !status) {
  console.error(`게이트웨이에 연결되지 않아요: ${candidates.join(', ')}\n서버 로그 ~/Library/Logs/llmwiki-gateway.log 와 Tailscale 상태를 확인해 주세요.`);
  process.exit(1);
}

const payload: PairingPayload = { v: 1, url, token, server };
console.log(await QRCode.toString(JSON.stringify(payload), { type: 'terminal', small: true, errorCorrectionLevel: 'L' }));
console.log(`앱 첫 화면에서 이 QR을 찍어 주세요.`);
console.log(`연결 확인됨: 서버 ${status.server}, 위키 ${Object.keys(status.domains).length}개 (${Object.keys(status.domains).join(', ')})`);
console.log(`직접 입력할 때 주소: ${url}`);
console.log(process.argv.includes('--show-token') ? `토큰: ${token}` : `토큰은 ${envPath} 의 GATEWAY_TOKEN 값이에요. 화면에 띄우려면 npm run pair -- --show-token`);
