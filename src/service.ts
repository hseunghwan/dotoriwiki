/**
 * The gateway as a per-user service: a launchd agent on macOS, a systemd user unit on Linux. Pure:
 * where each file goes and its text. install.ts writes the file and drives launchctl or systemctl.
 */

import { isAbsolute, join } from 'node:path';

export type ServiceKind = 'launchd' | 'systemd';

/** What the service runs and the environment it runs in, the same on every platform. */
export type ServiceSpec = {
  /** `[node, cli, 'start']`, absolute paths. */
  readonly program: readonly string[];
  readonly path: string;
  readonly home: string;
  readonly envFile: string;
};

export type Platform = {
  readonly kind: ServiceKind;
  /** The service's name in its manager: the launchd label or the systemd unit. */
  readonly name: string;
  readonly file: (home: string, env: NodeJS.ProcessEnv) => string;
  readonly render: (spec: ServiceSpec) => string;
  /** Where the gateway's output goes, for a person reading it. */
  readonly logs: (home: string) => string;
  readonly basePath: readonly string[];
};

const LAUNCHD_LABEL = 'dotoriwiki.gateway';
const SYSTEMD_UNIT = 'dotoriwiki.service';
const RESTART_SECONDS = 15;

const launchdLog = (home: string) => join(home, 'Library', 'Logs', 'dotoriwiki.log');

export const PLATFORMS: { readonly [K in ServiceKind]: Platform } = {
  launchd: {
    kind: 'launchd',
    name: LAUNCHD_LABEL,
    file: (home) => join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`),
    render: renderPlist,
    logs: launchdLog,
    basePath: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'],
  },
  systemd: {
    kind: 'systemd',
    name: SYSTEMD_UNIT,
    file: (home, env) => join(env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, '.config'), 'systemd', 'user', SYSTEMD_UNIT),
    render: renderUnit,
    logs: () => `journalctl --user -u ${SYSTEMD_UNIT}`,
    basePath: ['/usr/local/bin', '/usr/bin', '/bin'],
  },
};

export function platformFor(os: NodeJS.Platform): Platform | null {
  return os === 'darwin' ? PLATFORMS.launchd : os === 'linux' ? PLATFORMS.systemd : null;
}

/** The folders of the programs the gateway runs, then the platform's usual ones, each once. */
export function servicePath(platform: Platform, programDirs: readonly string[]): string {
  return [...new Set([...programDirs, ...platform.basePath])].join(':');
}

/** HOME is set even though both managers set it, so an install under another HOME runs there too. */
const serviceEnv = (spec: ServiceSpec): [string, string][] => [['PATH', spec.path], ['HOME', spec.home], ['DOTORIWIKI_ENV', spec.envFile]];

const xml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

export function renderPlist(spec: ServiceSpec): string {
  const log = xml(launchdLog(spec.home));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${spec.program.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${serviceEnv(spec).map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`).join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>${RESTART_SECONDS}</integer>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
}

/** systemd expands `%` specifiers in both settings, and `$` variables in ExecStart only. */
const unitQuote = (s: string, dollar: boolean) => `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => (dollar ? '$$' : '$'))}"`;

export function renderUnit(spec: ServiceSpec): string {
  return `[Unit]
Description=dotoriwiki gateway

[Service]
ExecStart=${spec.program.map((a) => unitQuote(a, true)).join(' ')}
${serviceEnv(spec).map(([k, v]) => `Environment=${unitQuote(`${k}=${v}`, false)}`).join('\n')}
Restart=always
RestartSec=${RESTART_SECONDS}

[Install]
WantedBy=default.target
`;
}
