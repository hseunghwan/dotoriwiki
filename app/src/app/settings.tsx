import Constants from 'expo-constants';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { outbox } from '../lib/db';
import type { OutboxRow } from '../lib/outbox';
import type { MemoRequest } from '../lib/wire';
import { flushNow, refreshStatus, updateSettings, useApp, type ThemePref } from '../state';
import { useOutbox } from '../ui/hooks';
import { Card, Header, Screen, SectionTitle, SmallButton } from '../ui/parts';
import { useTheme } from '../ui/theme';

const THEMES: { pref: ThemePref; label: string }[] = [
  { pref: 'system', label: '시스템' },
  { pref: 'dark', label: '다크' },
  { pref: 'light', label: '라이트' },
];

function Row({ label, children, last, style }: { label: string; children?: ReactNode; last?: boolean; style?: object }) {
  const t = useTheme();
  return (
    <View style={[st.row, !last && { borderBottomWidth: 1, borderBottomColor: t.line }, style]}>
      <Text style={{ color: t.fg, fontSize: 14 }}>{label}</Text>
      {children}
    </View>
  );
}

function Switch({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: on }}
      onPress={onToggle}
      style={[st.switch, { backgroundColor: on ? t.btn : t.seg, justifyContent: on ? 'flex-end' : 'flex-start' }]}
    >
      <View style={[st.knob, { backgroundColor: t.knob }]} />
    </Pressable>
  );
}

function DeadRow({ row }: { row: OutboxRow }) {
  const t = useTheme();
  let text = '';
  try {
    text = (JSON.parse(row.body) as MemoRequest).text;
  } catch {}
  return (
    <View style={[st.dead, { borderTopColor: t.line }]}>
      <Text numberOfLines={2} style={{ color: t.fg, fontSize: 14, lineHeight: 21 }}>{text}</Text>
      <Text style={{ color: t.bad, fontSize: 12 }}>{row.last_error ?? '맥미니가 받지 않았어요'}</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <SmallButton
          label="다시 보내기"
          icon="retry"
          onPress={async () => {
            await outbox.requeue(row.id);
            void flushNow();
          }}
        />
        <SmallButton label="지우기" color={t.muted} onPress={() => outbox.discard(row.id)} />
      </View>
    </View>
  );
}

export default function Settings() {
  const t = useTheme();
  const pairing = useApp((a) => a.pairing);
  const reachable = useApp((a) => a.reachable);
  const settings = useApp((a) => a.settings);
  const rows = useOutbox();
  const [checking, setChecking] = useState(false);
  const queued = rows.filter((r) => r.state === 'queued');
  const dead = rows.filter((r) => r.state === 'dead');

  async function toggleLocation() {
    if (settings.location) return updateSettings({ location: false });
    const { granted } = await Location.requestForegroundPermissionsAsync();
    await updateSettings({ location: granted });
  }

  async function recheck() {
    setChecking(true);
    await refreshStatus();
    setChecking(false);
  }

  return (
    <Screen>
      <Header title="설정" back />
      <ScrollView contentContainerStyle={st.main}>
        <View style={st.section}>
          <SectionTitle style={st.h2}>연결</SectionTitle>
          <Card>
            <Row label="상태">
              <View style={st.inline6}>
                <View style={[st.dot, { backgroundColor: reachable === false ? t.warn : t.okFg }]} />
                <Text style={{ color: reachable === false ? t.warn : t.okFg, fontSize: 14 }}>{reachable === false ? '연결 안 됨' : '연결됨'}</Text>
              </View>
            </Row>
            <Row label="맥미니 주소">
              <Text numberOfLines={1} style={{ flexShrink: 1, color: t.muted, fontSize: 14 }}>{pairing?.url.replace(/^https?:\/\//, '')}</Text>
            </Row>
            <Row label="토큰" style={{ paddingRight: 8 }}>
              <View style={st.inline6}>
                <Text style={{ color: t.muted, fontSize: 14, letterSpacing: 2 }}>••••••••</Text>
                <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: '/onboarding', params: { repair: 'settings' } })} style={st.link}>
                  <Text style={{ color: t.link, fontSize: 14 }}>QR로 다시 연결</Text>
                </Pressable>
              </View>
            </Row>
            <Pressable accessibilityRole="button" onPress={recheck} disabled={checking} style={st.action}>
              <Text style={{ color: t.link, fontSize: 14 }}>{checking ? '확인하는 중' : '연결 다시 확인'}</Text>
            </Pressable>
          </Card>
        </View>

        <View style={st.section}>
          <SectionTitle style={st.h2}>메모</SectionTitle>
          <Card>
            <View style={[st.row, { minHeight: 60, paddingVertical: 8 }]}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ color: t.fg, fontSize: 14 }}>위치 붙이기</Text>
                <Text style={{ color: t.faint, fontSize: 12 }}>메모를 쓰는 순간의 위치만 남겨요</Text>
              </View>
              <Switch label="위치 붙이기" on={settings.location} onToggle={toggleLocation} />
            </View>
          </Card>
        </View>

        <View style={st.section}>
          <SectionTitle style={st.h2}>화면</SectionTitle>
          <Card style={{ padding: 16, gap: 12 }}>
            <Text style={{ color: t.fg, fontSize: 14 }}>테마</Text>
            <View accessibilityRole="radiogroup" style={[st.segs, { backgroundColor: t.seg }]}>
              {THEMES.map(({ pref, label }) => {
                const on = settings.theme === pref;
                return (
                  <Pressable
                    key={pref}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                    onPress={() => updateSettings({ theme: pref })}
                    style={[st.seg, on && { backgroundColor: t.bg, elevation: 1 }]}
                  >
                    <Text style={{ color: on ? t.fg : t.muted, fontSize: 13, fontWeight: '500' }}>{label}</Text>
                  </Pressable>
                );
              })}
            </View>
          </Card>
        </View>

        <View style={st.section}>
          <SectionTitle style={st.h2}>전송 대기함</SectionTitle>
          <Card>
            <View style={[st.row, { minHeight: 60, paddingVertical: 8, paddingRight: 8 }]}>
              <View style={{ gap: 2, flexShrink: 1 }}>
                <Text style={{ color: t.fg, fontSize: 14 }}>보내지 못한 메모 {queued.length}개</Text>
                <Text style={{ color: t.faint, fontSize: 12 }}>연결되면 자동으로 보내요</Text>
              </View>
              <SmallButton label="지금 보내기" disabled={queued.length === 0} onPress={() => void flushNow()} />
            </View>
            {dead.length > 0 && (
              <View style={{ paddingHorizontal: 16, paddingBottom: 4 }}>
                <Text style={{ color: t.faint, fontSize: 12, paddingTop: 4, paddingBottom: 8 }}>맥미니가 받지 않은 메모 {dead.length}개</Text>
                {dead.map((r) => (
                  <DeadRow key={r.id} row={r} />
                ))}
              </View>
            )}
          </Card>
        </View>

        <View style={st.section}>
          <SectionTitle style={st.h2}>정보</SectionTitle>
          <Card>
            <Row label="게이트웨이 버전">
              <Text style={{ color: t.muted, fontSize: 14 }}>{pairing?.server ?? '-'}</Text>
            </Row>
            <Row label="앱 버전" last>
              <Text style={{ color: t.muted, fontSize: 14 }}>{Constants.expoConfig?.version ?? '-'}</Text>
            </Row>
          </Card>
        </View>
      </ScrollView>
    </Screen>
  );
}

const st = StyleSheet.create({
  main: { padding: 16, gap: 24 },
  section: { gap: 8 },
  h2: { marginHorizontal: 4 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, minHeight: 52, paddingHorizontal: 16 },
  inline6: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  link: { height: 36, paddingHorizontal: 10, justifyContent: 'center' },
  action: { minHeight: 52, paddingHorizontal: 16, justifyContent: 'center' },
  switch: { width: 52, height: 32, borderRadius: 16, padding: 3, flexDirection: 'row', alignItems: 'center' },
  knob: { width: 26, height: 26, borderRadius: 13, elevation: 2 },
  segs: { flexDirection: 'row', gap: 4, padding: 4, borderRadius: 10 },
  seg: { flex: 1, height: 36, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  dead: { gap: 6, paddingVertical: 12, borderTopWidth: 1 },
});
