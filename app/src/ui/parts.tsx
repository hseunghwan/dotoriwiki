import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { FailureSentence } from '../lib/failure';
import type { Tone } from '../lib/memos';
import { TitleMark } from './acorn-mark';
import { Icon, type IconName } from './icon';
import { useTheme, type Theme } from './theme';
import { copy } from '../text';

export function Screen({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return <View style={[{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }, style]}>{children}</View>;
}

export function Header({ title, back, mark, right }: { title: string; back?: boolean; mark?: boolean; right?: ReactNode }) {
  const t = useTheme();
  return (
    <View style={[s.header, { borderBottomColor: t.line, paddingHorizontal: back ? 8 : 16, justifyContent: back ? 'flex-start' : 'space-between' }]}>
      {back && (
        <Pressable accessibilityRole="button" accessibilityLabel={copy.common.back} onPress={goBack} style={s.iconButton}>
          <Icon name="back" color={t.fg} />
        </Pressable>
      )}
      <ScreenTitle title={title} mark={mark} />
      {right}
    </View>
  );
}

/** A screen title, with the app icon in front of it on the tabs. */
export function ScreenTitle({ title, mark }: { title: string; mark?: boolean }) {
  const t = useTheme();
  return (
    <View style={s.title}>
      {mark && <TitleMark />}
      <Text style={[s.h1, { color: t.fg }]}>{title}</Text>
    </View>
  );
}

export function goBack(): void {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

export function SectionTitle({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  const t = useTheme();
  return <Text style={[s.h2, { color: t.faint }, style]}>{children}</Text>;
}

export function Chip({ label, on, onPress, small }: { label: string; on: boolean; onPress: () => void; small?: boolean }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      onPress={onPress}
      style={[
        small ? s.chipSmall : s.chip,
        { backgroundColor: on ? t.onBg : 'transparent', borderColor: on ? t.onLine : t.line2 },
      ]}
    >
      <Text style={{ color: on ? t.onFg : t.muted, fontSize: small ? 13 : 14, fontWeight: '500' }}>{label}</Text>
    </Pressable>
  );
}

const toneColors = (t: Theme, tone: Tone) =>
  ({
    wait: { fg: t.muted, bg: t.bg3 },
    route: { fg: t.onFg, bg: t.onBg },
    done: { fg: t.okFg, bg: t.okBg },
    warn: { fg: t.warn, bg: t.warnBg },
    bad: { fg: t.bad, bg: t.badBg },
  })[tone];

export function Pill({ label, tone }: { label: string; tone: Tone }) {
  const t = useTheme();
  const c = toneColors(t, tone);
  return (
    <View style={[s.pill, { backgroundColor: c.bg }]}>
      <Text style={{ color: c.fg, fontSize: 12, fontWeight: '500' }}>{label}</Text>
    </View>
  );
}

type ButtonProps = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
};

export function PrimaryButton({ label, onPress, disabled, busy, icon, style, tall }: ButtonProps & { tall?: boolean }) {
  const t = useTheme();
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      disabled={off}
      onPress={onPress}
      style={[s.primary, { height: tall ? 52 : 48, borderRadius: tall ? 12 : 10, backgroundColor: off && !busy ? t.btnOff : t.btn }, style]}
    >
      {busy ? <ActivityIndicator color={t.btnFg} size="small" /> : icon ? <Icon name={icon} size={18} color={off ? t.btnOffFg : t.btnFg} /> : null}
      <Text style={{ color: off && !busy ? t.btnOffFg : t.btnFg, fontSize: tall ? 16 : 15, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}

export function QuietButton({ label, onPress }: { label: string; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={s.quiet}>
      <Text style={{ color: t.muted, fontSize: 15 }}>{label}</Text>
    </Pressable>
  );
}

export function SmallButton({ label, onPress, icon, filled, disabled, busy, color }: ButtonProps & { filled?: boolean; color?: string }) {
  const t = useTheme();
  const fg = filled ? t.btnFg : (color ?? t.fg);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!(disabled || busy) }}
      disabled={disabled || busy}
      onPress={onPress}
      style={[s.small, filled ? { backgroundColor: t.btn, borderWidth: 0 } : { borderColor: t.line2 }, (disabled || busy) && { opacity: 0.6 }]}
    >
      {busy ? <ActivityIndicator color={fg} size="small" /> : icon && <Icon name={icon} size={14} color={fg} />}
      <Text style={{ color: fg, fontSize: 13, fontWeight: filled ? '500' : '400' }}>{label}</Text>
    </Pressable>
  );
}

/** The failure sentence with the missing page name in link color, as the canvas draws it. */
export function FailureLine({ sentence, note, style }: { sentence: FailureSentence; note: string | null; style: StyleProp<TextStyle> }) {
  const t = useTheme();
  const [before, after] = sentence.link ? sentence.text.split(sentence.link) : [sentence.text, ''];
  return (
    <Text accessibilityRole="alert" style={style}>
      {before}
      {sentence.link && <Text style={{ color: t.link }}>{sentence.link}</Text>}
      {after}
      {note ? ` ${note}` : ''}
    </Text>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return <View style={[s.card, { backgroundColor: t.bg2, borderColor: t.cardLine }, style]}>{children}</View>;
}

export function Notice({ tone, children }: { tone: 'ok' | 'bad' | 'plain'; children: ReactNode }) {
  const t = useTheme();
  const bg = tone === 'ok' ? t.okBg : tone === 'bad' ? t.badBg : t.bg2;
  return <View style={[s.notice, { backgroundColor: bg }, tone === 'plain' && { borderWidth: 1, borderColor: t.cardLine }]}>{children}</View>;
}

export function Sheet({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, justifyContent: 'flex-end' }}>
      <Pressable accessibilityLabel={copy.common.close} onPress={onClose} style={[StyleSheet.absoluteFill, { backgroundColor: t.scrim }]} />
      <View style={[s.sheet, { backgroundColor: t.bg2, paddingBottom: 24 + insets.bottom }]}>
        <View style={[s.handle, { backgroundColor: t.handle }]} />
        {children}
      </View>
    </View>
  );
}

export const s = StyleSheet.create({
  header: { height: 56, flexDirection: 'row', alignItems: 'center', gap: 4, borderBottomWidth: 1 },
  title: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  h1: { fontSize: 18, fontWeight: '600', letterSpacing: -0.18 },
  h2: { fontSize: 12, fontWeight: '500' },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  chip: { height: 36, paddingHorizontal: 14, borderRadius: 18, borderWidth: 1, justifyContent: 'center' },
  chipSmall: { height: 32, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1, justifyContent: 'center' },
  pill: { height: 22, paddingHorizontal: 8, borderRadius: 6, justifyContent: 'center' },
  primary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  quiet: { height: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  small: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 36, paddingHorizontal: 14, borderRadius: 8, borderWidth: 1 },
  card: { borderRadius: 12, borderWidth: 1 },
  notice: { padding: 14, borderRadius: 12, gap: 10 },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingTop: 12, paddingHorizontal: 16, gap: 16 },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2 },
});
