import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { attemptsNote, failureSentence } from '../../lib/failure';
import { gateway } from '../../lib/gateway';
import { clock12, monthDay, verdictText } from '../../lib/memos';
import type { Pairing } from '../../lib/pairing';
import type { MemoDetailWire } from '../../lib/wire';
import { useMove } from '../../moves';
import { useApp } from '../../state';
import { useFocusPoll } from '../../ui/hooks';
import { Icon } from '../../ui/icon';
import { Card, FailureLine, Header, Notice, PrimaryButton, Screen, SectionTitle, SmallButton } from '../../ui/parts';
import { useTheme, type Theme } from '../../ui/theme';
import { copy } from '../../text';

/** The gateway's reviewBelowConfidence (src/main.ts): below it a classifier verdict is held for the user. */
const REVIEW_BELOW_CONFIDENCE = 0.6;

type Node = 'done' | 'now' | 'bad';
type Step = { title: string; sub: string; node: Node };

function routingStep(m: MemoDetailWire): Step | null {
  if (m.state === 'inbox' || !m.domain) return { title: copy.detail.waitingRoute, sub: copy.detail.waitingRouteSub, node: 'now' };
  const r = m.routing;
  const reason = r?.reason ? ` · ${r.reason}` : '';
  switch (r?.by) {
    case 'hint':
      return { title: copy.detail.filedTo(m.domain), sub: copy.detail.picked, node: 'done' };
    case 'user':
      return { title: copy.detail.movedTo(m.domain), sub: copy.detail.moved, node: 'done' };
    case 'fallback':
      return { title: copy.detail.parked(m.domain), sub: `${copy.detail.couldNotRoute}${reason}`, node: 'done' };
    case 'classifier': {
      const sub = `${copy.detail.sure((r.confidence ?? 0) >= REVIEW_BELOW_CONFIDENCE)}${reason}`;
      return { title: m.state === 'held' ? copy.detail.probably(m.domain) : copy.detail.filedTo(m.domain), sub, node: 'done' };
    }
    default:
      return { title: copy.detail.filedTo(m.domain), sub: copy.common.auto, node: 'done' };
  }
}

function lastStep(m: MemoDetailWire): Step | null {
  const note = attemptsNote(m.state, m.failure);
  switch (m.state) {
    case 'inbox':
      return null;
    case 'held':
      return { title: copy.detail.waitingConfirm, sub: copy.detail.waitingConfirmSub, node: 'now' };
    case 'routed':
      return { title: copy.stage.routed, sub: note ?? copy.detail.queuedSub, node: 'now' };
    case 'running':
      return { title: copy.stage.running, sub: note ?? copy.detail.runningSub, node: 'now' };
    case 'ingested':
      return { title: copy.stage.ingested, sub: [m.finished_at && clock12(new Date(m.finished_at)), verdictText(m)].filter(Boolean).join(' · '), node: 'done' };
    case 'failed':
      return { title: copy.detail.failed, sub: m.failure ? copy.failure.tried(m.failure.attempts) : '', node: 'bad' };
  }
}

function Timeline({ steps }: { steps: Step[] }) {
  const t = useTheme();
  return (
    <View>
      {steps.map((s, i) => (
        <View key={s.title} style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ width: 20, alignItems: 'center' }}>
            <View style={[st.node, nodeStyle(t, s.node)]} />
            {i < steps.length - 1 && <View style={[st.rail, { backgroundColor: t.line2 }]} />}
          </View>
          <View style={{ flex: 1, gap: 2, paddingBottom: 16 }}>
            <Text style={{ color: t.fg, fontSize: 14, fontWeight: '500' }}>{s.title}</Text>
            {s.sub ? <Text style={{ color: t.faint, fontSize: 12, lineHeight: 18 }}>{s.sub}</Text> : null}
          </View>
        </View>
      ))}
    </View>
  );
}

const nodeStyle = (t: Theme, n: Node) =>
  ({ done: { backgroundColor: t.okFg, borderColor: t.okFg }, now: { backgroundColor: t.bg, borderColor: t.onFg }, bad: { backgroundColor: t.bad, borderColor: t.bad } })[n];

type Attachment = MemoDetailWire['attachments'][number];

/** The gateway's 2048 px copy, at its own aspect once loaded. Captioned with when, where and on what. */
function Photo({ pairing, photo }: { pairing: Pairing; photo: Attachment }) {
  const t = useTheme();
  const [ratio, setRatio] = useState(4 / 3);
  const taken = photo.taken_at ? new Date(photo.taken_at) : null;
  const caption = [taken && `${monthDay(taken)} ${clock12(taken)}`, photo.place, photo.device].filter(Boolean).join(' · ');
  return (
    <View style={{ gap: 6 }}>
      <Image
        source={gateway.attachmentSource(pairing, photo.file)}
        onLoad={(e) => {
          const { width, height } = e.nativeEvent.source;
          if (width > 0 && height > 0) setRatio(width / height);
        }}
        style={{ width: '100%', aspectRatio: ratio, borderRadius: 10, backgroundColor: t.bg3 }}
        accessibilityLabel={caption || copy.photos.photo}
      />
      {caption ? <Text style={{ color: t.faint, fontSize: 12 }}>{caption}</Text> : null}
    </View>
  );
}

function FailureNotice({ memo, onRetried }: { memo: MemoDetailWire; onRetried: () => void }) {
  const t = useTheme();
  const pairing = useApp((a) => a.pairing);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const f = memo.failure;
  const sentence = f ? failureSentence(f) : { text: copy.failure.unknown, link: null };
  async function retry() {
    if (!pairing || !memo.domain) return;
    setBusy(true);
    await gateway.retry(pairing, { domain: memo.domain, kind: 'ingest', id: memo.id });
    setBusy(false);
    onRetried();
  }
  return (
    <Notice tone="bad">
      <FailureLine sentence={sentence} note={attemptsNote('failed', f)} style={{ color: t.bad, fontSize: 14, lineHeight: 21 }} />
      {f?.detail ? (
        <Pressable onPress={() => setOpen((o) => !o)}>
          <Text style={{ color: t.faint, fontSize: 12, lineHeight: 18 }} numberOfLines={open ? undefined : 1}>
            {open ? f.detail : copy.detail.more(f.detail)}
          </Text>
        </Pressable>
      ) : null}
      <View style={{ flexDirection: 'row' }}>
        <SmallButton label={copy.common.retry} icon="retry" filled busy={busy} onPress={retry} />
      </View>
    </Notice>
  );
}

export default function MemoDetail() {
  const t = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const pairing = useApp((a) => a.pairing);
  const move = useMove(id);
  const [memo, setMemo] = useState<MemoDetailWire | null>(null);
  const [missing, setMissing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    if (!pairing) return;
    const r = await gateway.memo(pairing, id);
    if (r.ok) setMemo(r.data);
    else if (r.failure.kind === 'http' && r.failure.status === 404) setMissing(true);
  }, [pairing, id]);
  const settled = memo !== null && (memo.state === 'ingested' || memo.state === 'failed' || memo.state === 'held') && move?.status !== 'moving';
  useFocusPoll(load, 4_000, !settled);

  async function confirm() {
    if (!pairing || !memo) return;
    setConfirming(true);
    await gateway.confirm(pairing, memo.id);
    setConfirming(false);
    void load();
  }

  if (!memo) {
    return (
      <Screen>
        <Header title={copy.common.memo} back />
        <Text style={{ color: t.muted, fontSize: 14, padding: 16 }}>{missing ? copy.common.notFound : copy.common.loading}</Text>
      </Screen>
    );
  }

  const captured = new Date(memo.captured_at);
  const steps = [{ title: copy.stage.inbox, sub: clock12(captured), node: 'done' as const }, routingStep(memo), lastStep(memo)].filter((s): s is Step => s !== null);
  const canMove = (memo.state === 'held' || memo.state === 'failed') && move?.status !== 'moving';

  return (
    <Screen>
      <Header title={copy.common.memo} back />
      <ScrollView contentContainerStyle={st.main}>
        <View style={{ gap: 12 }}>
          {memo.text ? <Text selectable style={{ color: t.fg, fontSize: 17, lineHeight: 27 }}>{memo.text}</Text> : null}
          <View style={st.metaRow}>
            <Text style={st.meta(t)}>{`${monthDay(captured)} ${clock12(captured)}`}</Text>
            {memo.place && <Text style={st.meta(t)}>{memo.place}</Text>}
            <Text style={st.meta(t)}>{copy.source[memo.source]}</Text>
          </View>
        </View>

        {pairing && (memo.attachments ?? []).length > 0 && (
          <View style={{ gap: 16 }}>
            {memo.attachments.map((a) => (
              <Photo key={a.file} pairing={pairing} photo={a} />
            ))}
          </View>
        )}

        <View style={{ gap: 12 }}>
          <SectionTitle>{copy.detail.progress}</SectionTitle>
          <Timeline steps={steps} />
        </View>

        {move?.status === 'moving' && (
          <Notice tone="plain">
            <Text style={{ color: t.muted, fontSize: 13, lineHeight: 20 }}>{copy.detail.moving(move.to)}</Text>
          </Notice>
        )}
        {move?.status === 'failed' && (
          <Notice tone="bad">
            <Text style={{ color: t.bad, fontSize: 13, lineHeight: 20 }}>{move.message}</Text>
          </Notice>
        )}

        {memo.state === 'failed' && <FailureNotice memo={memo} onRetried={load} />}

        {memo.state === 'ingested' && memo.pages.length > 0 && (
          <View style={{ gap: 8 }}>
            <SectionTitle>{copy.detail.pages}</SectionTitle>
            <Card>
              {memo.pages.map((p, i) => (
                <View key={p.path} style={[st.page, i < memo.pages.length - 1 && { borderBottomWidth: 1, borderBottomColor: t.line }]}>
                  <Icon name="file" size={16} color={t.faint} />
                  <Text style={{ flex: 1, color: t.link, fontSize: 14 }}>{p.path}</Text>
                  <Text style={{ color: t.faint, fontSize: 12 }}>
                    {p.type ? `${p.type} · ` : ''}
                    {p.change === 'created' ? copy.detail.created : copy.detail.modified}
                  </Text>
                </View>
              ))}
            </Card>
            {memo.domain && <Text style={{ color: t.faint, fontSize: 12, lineHeight: 18, marginHorizontal: 4, marginTop: 4 }}>{copy.detail.rawKept(memo.domain)}</Text>}
          </View>
        )}

        {memo.state === 'held' && memo.domain && move?.status !== 'moving' && <PrimaryButton label={copy.detail.confirm(memo.domain)} busy={confirming} onPress={confirm} />}
        {canMove && memo.domain && (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push({ pathname: '/move/[id]', params: { id: memo.id, from: memo.domain!, text: memo.text } })}
            style={[st.outline, { borderColor: t.line2 }]}
          >
            <Text style={{ color: t.fg, fontSize: 15 }}>{copy.detail.moveElsewhere}</Text>
          </Pressable>
        )}
      </ScrollView>
    </Screen>
  );
}

const st = {
  ...StyleSheet.create({
    main: { paddingVertical: 20, paddingHorizontal: 16, gap: 28 },
    metaRow: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 6 },
    node: { width: 10, height: 10, marginTop: 5, borderRadius: 5, borderWidth: 2 },
    rail: { flex: 1, width: 2, minHeight: 24, marginVertical: 4 },
    page: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingHorizontal: 16 },
    outline: { height: 48, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  }),
  meta: (t: Theme) => ({ color: t.faint, fontSize: 12 }),
};
