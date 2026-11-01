import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputInstance } from 'react-native';
import type { GeoFix } from '../../lib/capture';
import { gateway } from '../../lib/gateway';
import { locate } from '../../lib/location';
import { clock12, mergeRecent, recentTime, STAGE, type RecentMemo } from '../../lib/memos';
import { canSend } from '../../lib/photos';
import type { MemoListItemWire } from '../../lib/wire';
import { capture, getApp, useApp } from '../../state';
import { useFocusPoll, useNow, useOutbox, useOutboxFiles } from '../../ui/hooks';
import { Icon } from '../../ui/icon';
import { Header, Pill, PrimaryButton, s as ui, Screen, SectionTitle } from '../../ui/parts';
import { DomainChips } from '../../ui/domain-chips';
import { LocalThumbs, PhotoButtons, PhotoCount, PhotoStrip, usePhotoDraft } from '../../ui/photos';
import { useTheme } from '../../ui/theme';
import { copy } from '../../text';

const SETTLED = new Set(['ingested', 'failed', 'dead', 'held']);

type Fix = { kind: 'off' } | { kind: 'finding' } | { kind: 'found'; fix: GeoFix } | { kind: 'none' };

/** Location for the memo being written, fetched while typing so sending never waits for it. */
function useCompositionFix(): [Fix, () => void] {
  const enabled = useApp((a) => a.settings.location);
  const [fix, setFix] = useState<Fix>({ kind: enabled ? 'finding' : 'off' });
  const refresh = useCallback(() => {
    if (!getApp().settings.location) return setFix({ kind: 'off' });
    setFix((f) => (f.kind === 'found' ? f : { kind: 'finding' }));
    void locate().then((g) => setFix(g ? { kind: 'found', fix: g } : { kind: 'none' }));
  }, []);
  useEffect(refresh, [enabled, refresh]);
  return [fix, refresh];
}

function ConnectionBadge({ waiting }: { waiting: number }) {
  const t = useTheme();
  const reachable = useApp((a) => a.reachable);
  const authLost = useApp((a) => a.authLost);
  if (authLost) {
    return (
      <Pressable
        accessibilityRole="button"
        onPress={() => router.push({ pathname: '/onboarding', params: { repair: '401' } })}
        style={[st.badge, { backgroundColor: t.bg3 }]}
      >
        <Icon name="alert" size={14} color={t.warn} />
        <Text style={{ color: t.warn, fontSize: 12 }}>{copy.memoTab.reconnect(waiting)}</Text>
      </Pressable>
    );
  }
  if (reachable === null) return null;
  return reachable ? (
    <View style={[st.badge, { backgroundColor: t.bg2 }]}>
      <View style={[st.dot, { backgroundColor: t.okFg }]} />
      <Text style={{ color: t.muted, fontSize: 12 }}>{copy.memoTab.online}</Text>
    </View>
  ) : (
    <View style={[st.badge, { backgroundColor: t.bg3 }]}>
      <Icon name="wifiOff" size={14} color={t.warn} />
      <Text style={{ color: t.warn, fontSize: 12 }}>{copy.memoTab.offline(waiting)}</Text>
    </View>
  );
}

function RecentRow({ memo, now }: { memo: RecentMemo; now: Date }) {
  const t = useTheme();
  const stage = STAGE[memo.stage];
  const unsent = memo.stage === 'queued' || memo.stage === 'dead';
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => (unsent ? router.push('/settings') : router.push({ pathname: '/memo/[id]', params: { id: memo.id } }))}
      style={[st.item, { borderBottomColor: t.line }]}
    >
      {memo.text ? (
        <Text numberOfLines={2} style={{ color: t.fg, fontSize: 14, lineHeight: 21 }}>
          {memo.text}
        </Text>
      ) : null}
      {unsent && <LocalThumbs uris={memo.local} />}
      <View style={st.meta}>
        <Text style={{ color: t.faint, fontSize: 12 }}>{recentTime(new Date(memo.captured_at), now)}</Text>
        <Pill label={stage.label} tone={stage.tone} />
        <PhotoCount count={memo.photos} />
        {memo.stage === 'ingested' && memo.first_page ? (
          <View style={st.page}>
            <Icon name="file" size={12} color={t.link} />
            <Text numberOfLines={1} style={{ color: t.link, fontSize: 12, flexShrink: 1 }}>{memo.first_page}</Text>
          </View>
        ) : memo.domain ? (
          <Text numberOfLines={1} style={{ color: t.faint, fontSize: 12, flexShrink: 1 }}>{memo.domain}</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

export default function MemoTab() {
  const t = useTheme();
  const input = useRef<TextInputInstance>(null);
  const [text, setText] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const [attach, setAttach] = useState(true);
  const [fix, refreshFix] = useCompositionFix();
  const [server, setServer] = useState<MemoListItemWire[]>([]);
  const rows = useOutbox();
  const files = useOutboxFiles();
  const draft = usePhotoDraft();
  const now = useNow();
  const pairing = useApp((a) => a.pairing);

  const recent = useMemo(() => mergeRecent(rows, server.filter((m) => m.source !== 'feed'), files).slice(0, 10), [rows, server, files]);
  const moving = recent.some((m) => !SETTLED.has(m.stage));
  const waiting = rows.filter((r) => r.state === 'queued').length;

  const load = useCallback(async () => {
    if (!pairing) return;
    const r = await gateway.memos(pairing, null, 30);
    if (r.ok) setServer(r.data.memos);
  }, [pairing]);
  useFocusPoll(load, 4_000, moving);
  // A flushed row leaves the outbox before the next poll would list it from the gateway.
  useEffect(() => {
    void load();
  }, [waiting, load]);

  useFocusEffect(
    useCallback(() => {
      const focus = setTimeout(() => input.current?.focus(), 250);
      refreshFix();
      return () => clearTimeout(focus);
    }, [refreshFix]),
  );

  async function send() {
    const body = text.trim();
    const photos = draft.photos;
    if (!canSend(body, photos)) return;
    setText('');
    draft.clear();
    const { sent } = await capture({
      text: body,
      source: 'typed',
      domainHint: hint,
      location: attach && fix.kind === 'found' ? fix.fix : null,
      photos,
    });
    setAttach(true);
    await sent;
    void load();
  }

  return (
    <Screen>
      <Header
        title={copy.common.memo}
        mark
        right={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <ConnectionBadge waiting={waiting} />
            <Pressable accessibilityRole="button" accessibilityLabel={copy.common.settings} onPress={() => router.push('/settings')} style={ui.iconButton}>
              <Icon name="settings" color={t.muted} />
            </Pressable>
          </View>
        }
      />
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={st.main} keyboardShouldPersistTaps="handled">
          <View style={[st.compose, { backgroundColor: t.bg2, borderColor: t.onLine }]}>
            <TextInput
              ref={input}
              accessibilityLabel={copy.memoTab.input}
              multiline
              value={text}
              onChangeText={setText}
              placeholder={copy.memoTab.placeholder}
              placeholderTextColor={t.faint}
              style={[st.textarea, { color: t.fg }]}
              textAlignVertical="top"
            />
            <PhotoStrip draft={draft} />
            <View style={st.composeMeta}>
              <View style={st.inline4}>
                <Icon name="clock" size={14} color={t.faint} />
                <Text style={{ color: t.faint, fontSize: 12 }}>{clock12(now)}</Text>
              </View>
              {fix.kind === 'none' && attach && (
                <Pressable accessibilityRole="button" onPress={refreshFix} style={[st.loc, { borderColor: t.line2, borderStyle: 'dashed' }]}>
                  <Icon name="pin" size={14} color={t.faint} />
                  <Text style={{ color: t.faint, fontSize: 12 }}>{copy.memoTab.findLocationAgain}</Text>
                </Pressable>
              )}
              {fix.kind !== 'off' &&
                !(fix.kind === 'none' && attach) &&
                (attach ? (
                  <Pressable accessibilityRole="button" accessibilityLabel={copy.memoTab.removeLocation} onPress={() => setAttach(false)} style={[st.loc, { borderColor: t.line2 }]}>
                    <Icon name="pin" size={14} color={t.muted} />
                    <Text style={{ color: t.muted, fontSize: 12 }}>
                      {fix.kind === 'found' ? (fix.fix.place ?? copy.memoTab.here) : copy.memoTab.findingLocation}
                    </Text>
                    <Icon name="x" size={12} color={t.muted} strokeWidth={2} />
                  </Pressable>
                ) : (
                  <Pressable accessibilityRole="button" onPress={() => setAttach(true)} style={[st.loc, { borderColor: t.line2, borderStyle: 'dashed' }]}>
                    <Icon name="pin" size={14} color={t.faint} />
                    <Text style={{ color: t.faint, fontSize: 12 }}>{copy.common.attachLocation}</Text>
                  </Pressable>
                ))}
              <PhotoButtons draft={draft} />
            </View>
          </View>

          <View style={{ gap: 8 }}>
            <SectionTitle>{copy.common.whereToFile}</SectionTitle>
            <DomainChips value={hint} onChange={setHint} />
          </View>

          <PrimaryButton label={copy.common.send} icon="send" disabled={!canSend(text, draft.photos) || draft.busy} onPress={send} />

          <View style={{ gap: 4 }}>
            <SectionTitle style={{ marginBottom: 4 }}>{copy.memoTab.recent}</SectionTitle>
            {recent.length === 0 ? (
              <View style={st.empty}>
                <Text style={{ color: t.muted, fontSize: 14 }}>{copy.memoTab.none}</Text>
                <Text style={{ color: t.faint, fontSize: 13, lineHeight: 21, textAlign: 'center' }}>
                  {copy.memoTab.noneHint}
                </Text>
              </View>
            ) : (
              recent.map((m) => <RecentRow key={m.id} memo={m} now={now} />)
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
      {draft.sheet}
    </Screen>
  );
}

const st = StyleSheet.create({
  main: { padding: 16, gap: 20 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 28, paddingHorizontal: 10, borderRadius: 14 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  compose: { padding: 16, borderRadius: 12, borderWidth: 1, gap: 12 },
  textarea: { minHeight: 154, fontSize: 16, lineHeight: 25.6, padding: 0 },
  composeMeta: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  inline4: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  loc: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 28, paddingHorizontal: 8, borderRadius: 8, borderWidth: 1 },
  item: { paddingVertical: 12, gap: 8, borderBottomWidth: 1 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  page: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1 },
  empty: { paddingVertical: 24, gap: 6, alignItems: 'center' },
});
