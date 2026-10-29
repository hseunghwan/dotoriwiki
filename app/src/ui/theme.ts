import { useColorScheme } from 'react-native';
import { useApp } from '../state';

/** Obsidian's default theme, as the design canvas tokens it. No domain colors. */
const dark = {
  bg: '#1e1e1e', bg2: '#262626', bg3: '#2c2c2c', seg: '#2c2c2c',
  line: '#2c2c2c', line2: '#363636', cardLine: '#333333',
  fg: '#dadada', muted: '#b3b3b3', faint: '#8a8a8a', link: '#a68ef5',
  btn: '#7559dd', btnFg: '#ffffff', btnOff: '#2c2c2c', btnOffFg: '#8a8a8a',
  onBg: 'rgba(138,108,239,0.18)', onFg: '#c4b5fa', onLine: 'rgba(138,108,239,0.55)',
  okBg: 'rgba(124,197,154,0.12)', okFg: '#8fd1aa', okLine: 'rgba(124,197,154,0.4)',
  warn: '#e0a25a', warnBg: 'rgba(224,162,90,0.12)',
  bad: '#e07a8f', badBg: 'rgba(224,122,143,0.12)',
  bubble: '#2f2a45', handle: '#4a4a4a', knob: '#dadada', scrim: 'rgba(0,0,0,0.5)',
};

export type Theme = typeof dark & { scheme: 'dark' | 'light' };

const light: typeof dark = {
  bg: '#ffffff', bg2: '#f6f6f6', bg3: '#ededed', seg: '#e6e6e6',
  line: '#e6e6e6', line2: '#d4d4d4', cardLine: '#e0e0e0',
  fg: '#222222', muted: '#5c5c5c', faint: '#6e6e6e', link: '#6b48d6',
  btn: '#7559dd', btnFg: '#ffffff', btnOff: '#ededed', btnOffFg: '#6e6e6e',
  onBg: 'rgba(117,89,221,0.12)', onFg: '#5b3fc4', onLine: 'rgba(117,89,221,0.5)',
  okBg: 'rgba(31,122,74,0.1)', okFg: '#1f7a4a', okLine: 'rgba(31,122,74,0.35)',
  warn: '#a55d00', warnBg: 'rgba(165,93,0,0.1)',
  bad: '#b3263e', badBg: 'rgba(179,38,62,0.08)',
  bubble: '#ece8fb', handle: '#c4c4c4', knob: '#ffffff', scrim: 'rgba(0,0,0,0.5)',
};

const THEMES = { dark: { ...dark, scheme: 'dark' as const }, light: { ...light, scheme: 'light' as const } };

export function useTheme(): Theme {
  const system = useColorScheme();
  const pref = useApp((a) => a.settings.theme);
  const scheme = pref === 'system' ? (system === 'light' ? 'light' : 'dark') : pref;
  return THEMES[scheme];
}
