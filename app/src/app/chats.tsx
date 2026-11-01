import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { targetLabel } from '../lib/chats';
import { gateway } from '../lib/gateway';
import { clock24, groupByDay } from '../lib/memos';
import type { ChatSummaryWire } from '../lib/wire';
import { useApp } from '../state';
import { useNow } from '../ui/hooks';
import { Icon } from '../ui/icon';
import { Header, s as ui, Screen, SectionTitle } from '../ui/parts';
import { useTheme } from '../ui/theme';
import { copy } from '../text';

type Row = { kind: 'day'; label: string } | { kind: 'chat'; chat: ChatSummaryWire };

function Entry({ chat, onDelete }: { chat: ChatSummaryWire; onDelete: () => void }) {
  const t = useTheme();
  return (
    <View style={[st.entry, { borderBottomColor: t.line }]}>
      <Pressable
        accessibilityRole="button"
        onPress={() => router.navigate({ pathname: '/chat', params: { open: chat.session_id } })}
        style={st.open}
      >
        <Text style={{ width: 48, color: t.faint, fontSize: 12, paddingTop: 2 }}>{clock24(new Date(chat.updated_at))}</Text>
        <View style={{ flex: 1, gap: 6, minWidth: 0 }}>
          <View style={st.entryHead}>
            <Text style={{ color: t.muted, fontSize: 13 }}>{targetLabel(chat.target)}</Text>
            <Text style={{ color: t.faint, fontSize: 13 }}>·</Text>
            <Text style={{ color: t.faint, fontSize: 13 }}>{copy.chats.turns(chat.turns)}</Text>
          </View>
          <Text numberOfLines={1} style={{ color: t.fg, fontSize: 14, lineHeight: 20 }}>{chat.title}</Text>
        </View>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={copy.chats.remove(chat.title)} onPress={onDelete} style={st.delete}>
        <Icon name="trash" size={16} color={t.faint} />
      </Pressable>
    </View>
  );
}

export default function Chats() {
  const t = useTheme();
  const pairing = useApp((a) => a.pairing);
  const now = useNow(60_000);
  const [chats, setChats] = useState<ChatSummaryWire[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!pairing) return;
    const r = await gateway.chats(pairing, null);
    if (!r.ok) return setError(copy.chats.loadFailed);
    setError(null);
    setChats(r.data.chats);
    setNext(r.data.next_before);
  }, [pairing]);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  async function loadMore() {
    if (!pairing || !next || loadingMore) return;
    setLoadingMore(true);
    const r = await gateway.chats(pairing, next);
    setLoadingMore(false);
    if (!r.ok) return;
    setChats((old) => [...(old ?? []), ...r.data.chats.filter((c) => !old?.some((o) => o.session_id === c.session_id))]);
    setNext(r.data.next_before);
  }

  function confirmDelete(chat: ChatSummaryWire) {
    Alert.alert(copy.chats.confirmTitle, copy.chats.confirmBody, [
      { text: copy.common.cancel, style: 'cancel' },
      {
        text: copy.common.delete,
        style: 'destructive',
        onPress: async () => {
          if (!pairing) return;
          const r = await gateway.deleteChat(pairing, chat.session_id);
          if (r.ok || (r.failure.kind === 'http' && r.failure.status === 404)) setChats((old) => old?.filter((c) => c.session_id !== chat.session_id) ?? null);
          else setError(copy.chats.removeFailed);
        },
      },
    ]);
  }

  const rows = useMemo<Row[]>(
    () =>
      groupByDay(chats ?? [], now, (c) => c.updated_at).flatMap((g) => [
        { kind: 'day' as const, label: g.label },
        ...g.items.map((chat) => ({ kind: 'chat' as const, chat })),
      ]),
    [chats, now],
  );

  return (
    <Screen>
      <Header title={copy.chats.title} back />
      <FlatList
        data={rows}
        keyExtractor={(r) => (r.kind === 'day' ? `day:${r.label}` : r.chat.session_id)}
        contentContainerStyle={{ padding: 16 }}
        ListHeaderComponent={error ? <Text style={{ color: t.bad, fontSize: 13, marginBottom: 12 }}>{error}</Text> : undefined}
        renderItem={({ item, index }) =>
          item.kind === 'day' ? (
            <SectionTitle style={{ marginTop: index === 0 ? 0 : 24, marginBottom: 4 }}>{item.label}</SectionTitle>
          ) : (
            <Entry chat={item.chat} onDelete={() => confirmDelete(item.chat)} />
          )
        }
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        ListFooterComponent={loadingMore ? <Text style={[ui.h2, { color: t.faint, textAlign: 'center', padding: 16 }]}>{copy.common.loadingMore}</Text> : undefined}
        ListEmptyComponent={
          chats ? <Text style={{ color: t.muted, fontSize: 14, textAlign: 'center', paddingVertical: 24 }}>{copy.chats.empty}</Text> : undefined
        }
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
  entry: { flexDirection: 'row', alignItems: 'flex-start', borderBottomWidth: 1 },
  open: { flex: 1, flexDirection: 'row', gap: 12, paddingVertical: 12 },
  entryHead: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  delete: { width: 40, height: 44, alignItems: 'center', justifyContent: 'center', marginRight: -12 },
});
