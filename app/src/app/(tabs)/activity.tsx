import { router } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { attemptsNote, failureSentence } from '../../lib/failure';
import { gateway } from '../../lib/gateway';
import { activityCounts, clock24, groupByDay, STAGE, verdictText } from '../../lib/memos';
import type { HeldMemoWire, MemoDetailWire, MemoListItemWire, StatusResponse } from '../../lib/wire';
import { refreshStatus, useApp } from '../../state';
import { useFocusPoll, useNow } from '../../ui/hooks';
import { Icon } from '../../ui/icon';
import { Card, FailureLine, Header, s as ui, Screen, SectionTitle, SmallButton } from '../../ui/parts';
import { PhotoCount } from '../../ui/photos';
import { useTheme } from '../../ui/theme';
import { copy } from '../../text';

type Row = { kind: 'day'; label: string } | { kind: 'memo'; memo: MemoListItemWire };

function mergeById(existing: MemoListItemWire[], fresh: MemoListItemWire[]): MemoListItemWire[] {
  const byId = new Map(existing.map((m) => [m.id, m]));
  for (const m of fresh) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => Date.parse(b.captured_at) - Date.parse(a.captured_at) || (a.id < b.id ? 1 : -1));
}

function heldLine(h: HeldMemoWire): string {
  if (h.confidence === null) return copy.activity.heldFallback(h.domain);
  return copy.activity.heldGuess(h.domain, h.reason.trim());
}

function HeldCard({ held, onDone }: { held: HeldMemoWire; onDone: () => void }) {
  const t = useTheme();
  const pairing = useApp((a) => a.pairing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function confirm() {
    if (!pairing) return;
    setBusy(true);
    const r = await gateway.confirm(pairing, held.id);
    setBusy(false);
    if (r.ok) onDone();
    else setError(r.failure.kind === 'http' && r.failure.status === 409 ? copy.activity.stale : copy.activity.confirmFailed);
  }
  return (
    <Card style={st.cardBody}>
      <View style={st.inline6}>
        <Icon name="alert" size={14} color={t.warn} />
        <Text style={{ color: t.warn, fontSize: 12 }}>{copy.activity.unsure}</Text>
      </View>
      <Text style={{ color: t.fg, fontSize: 14, lineHeight: 21 }}>{held.text}</Text>
      <Text numberOfLines={3} style={{ color: t.muted, fontSize: 13, lineHeight: 19 }}>{heldLine(held)}</Text>
      {error && <Text style={{ color: t.bad, fontSize: 12 }}>{error}</Text>}
      <View style={st.buttons}>
        <SmallButton label={copy.activity.yes} busy={busy} onPress={confirm} />
        <SmallButton
          label={copy.activity.elsewhere}
          color={t.muted}
          onPress={() => router.push({ pathname: '/move/[id]', params: { id: held.id, from: held.domain, text: held.text } })}
        />
      </View>
    </Card>
  );
}

function FailedCard({ memo, onDone }: { memo: MemoDetailWire; onDone: () => void }) {
  const t = useTheme();
  const pairing = useApp((a) => a.pairing);
  const [busy, setBusy] = useState(false);
  const sentence = memo.failure ? failureSentence(memo.failure) : { text: copy.failure.unknown, link: null };
  async function retry() {
    if (!pairing || !memo.domain) return;
    setBusy(true);
    const r = await gateway.retry(pairing, { domain: memo.domain, kind: 'ingest', id: memo.id });
    setBusy(false);
    if (r.ok) onDone();
  }
  return (
    <Card style={st.cardBody}>
      <Pressable onPress={() => router.push({ pathname: '/memo/[id]', params: { id: memo.id } })} style={{ gap: 10 }}>
        <View style={st.inline6}>
          <Icon name="x" size={14} color={t.bad} />
          <Text style={{ color: t.bad, fontSize: 12 }}>{copy.activity.failedLine}{memo.failure ? ` · ${copy.failure.tried(memo.failure.attempts)}` : ''}</Text>
        </View>
        <Text numberOfLines={3} style={{ color: t.fg, fontSize: 14, lineHeight: 21 }}>{memo.text}</Text>
        <FailureLine sentence={sentence} note={attemptsNote('failed', memo.failure)} style={{ color: t.muted, fontSize: 13, lineHeight: 19 }} />
      </Pressable>
      <View style={st.buttons}>
        <SmallButton label={copy.common.retry} icon="retry" filled busy={busy} onPress={retry} />
      </View>
    </Card>
  );
}

function Entry({ memo }: { memo: MemoListItemWire }) {
  const t = useTheme();
  const what = memo.state === 'ingested' ? (verdictText(memo) ?? STAGE.ingested.label) : STAGE[memo.state].label;
  return (
    <Pressable onPress={() => router.push({ pathname: '/memo/[id]', params: { id: memo.id } })} style={[st.entry, { borderBottomColor: t.line }]}>
      <Text style={{ width: 48, color: t.faint, fontSize: 12, paddingTop: 2 }}>{clock24(new Date(memo.captured_at))}</Text>
      <View style={{ flex: 1, gap: 6, minWidth: 0 }}>
        <View style={st.entryHead}>
          <Text style={{ color: t.muted, fontSize: 13 }}>{memo.domain ?? copy.activity.unrouted}</Text>
          <Text style={{ color: t.faint, fontSize: 13 }}>·</Text>
          <Text style={{ color: memo.state === 'failed' ? t.bad : t.fg, fontSize: 13 }}>{what}</Text>
          {memo.first_page && <Text style={{ color: t.link, fontSize: 13 }}>{memo.first_page}</Text>}
          <PhotoCount count={memo.photos} />
        </View>
        <Text numberOfLines={1} style={{ color: t.faint, fontSize: 13, lineHeight: 19 }}>{memo.text.replace(/\s+/g, ' ')}</Text>
      </View>
    </Pressable>
  );
}

export default function Activity() {
  const t = useTheme();
  const pairing = useApp((a) => a.pairing);
  const now = useNow(60_000);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [held, setHeld] = useState<HeldMemoWire[]>([]);
  const [failed, setFailed] = useState<MemoDetailWire[]>([]);
  const [memos, setMemos] = useState<MemoListItemWire[]>([]);
  const [next, setNext] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    if (!pairing) return;
    const [s, h, m] = await Promise.all([refreshStatus(), gateway.held(pairing), gateway.memos(pairing, null)]);
    if (s) setStatus(s);
    if (h.ok) setHeld(h.data.held);
    if (!m.ok) return;
    setMemos((old) => mergeById(old, m.data.memos));
    setNext((old) => (old === undefined ? m.data.next_before : old));
    const failedIds = m.data.memos.filter((x) => x.state === 'failed').map((x) => x.id);
    const details = await Promise.all(failedIds.map((id) => gateway.memo(pairing, id)));
    setFailed(details.flatMap((d) => (d.ok && d.data.state === 'failed' ? [d.data] : [])));
  }, [pairing]);

  const counts = status ? activityCounts(status) : null;
  useFocusPoll(refresh, 5_000, (counts?.working ?? 0) > 0);

  async function loadMore() {
    if (!pairing || !next || loadingMore) return;
    setLoadingMore(true);
    const r = await gateway.memos(pairing, next);
    setLoadingMore(false);
    if (!r.ok) return;
    setMemos((old) => mergeById(old, r.data.memos));
    setNext(r.data.next_before);
  }

  const rows = useMemo<Row[]>(
    () => groupByDay(memos, now, (m) => m.captured_at).flatMap((g) => [{ kind: 'day' as const, label: g.label }, ...g.items.map((memo) => ({ kind: 'memo' as const, memo }))]),
    [memos, now],
  );

  const confirmCards = held.length + failed.length > 0 && (
    <View style={{ gap: 8, marginBottom: 24 }}>
      <SectionTitle>{copy.activity.needsYou}</SectionTitle>
      {held.map((h) => (
        <HeldCard key={h.id} held={h} onDone={refresh} />
      ))}
      {failed.map((f) => (
        <FailedCard key={f.id} memo={f} onDone={refresh} />
      ))}
    </View>
  );

  return (
    <Screen>
      <Header title={copy.activity.title} mark right={counts && <Text style={{ color: t.faint, fontSize: 12 }}>{copy.activity.counts(counts.working, counts.confirm)}</Text>} />
      <FlatList
        data={rows}
        keyExtractor={(r) => (r.kind === 'day' ? `day:${r.label}` : r.memo.id)}
        contentContainerStyle={{ padding: 16 }}
        ListHeaderComponent={confirmCards || undefined}
        renderItem={({ item, index }) =>
          item.kind === 'day' ? (
            <SectionTitle style={{ marginTop: index === 0 ? 0 : 24, marginBottom: 4 }}>{item.label}</SectionTitle>
          ) : (
            <Entry memo={item.memo} />
          )
        }
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        ListFooterComponent={loadingMore ? <Text style={[ui.h2, { color: t.faint, textAlign: 'center', padding: 16 }]}>{copy.common.loadingMore}</Text> : undefined}
        ListEmptyComponent={<Text style={{ color: t.muted, fontSize: 14, textAlign: 'center', paddingVertical: 24 }}>{copy.activity.empty}</Text>}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await refresh();
              setRefreshing(false);
            }}
            tintColor={t.muted}
            colors={[t.btn]}
            progressBackgroundColor={t.bg2}
          />
        }
      />
    </Screen>
  );
}

const st = StyleSheet.create({
  cardBody: { padding: 14, gap: 10 },
  inline6: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  buttons: { flexDirection: 'row', gap: 8 },
  entry: { flexDirection: 'row', gap: 12, paddingVertical: 12, borderBottomWidth: 1 },
  entryHead: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
});
