import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { attemptsNote, failureSentence } from '../../lib/failure';
import { gateway } from '../../lib/gateway';
import { clock12, monthDay, withIGa, withRo } from '../../lib/memos';
import type { Pairing } from '../../lib/pairing';
import type { MemoDetailWire, MemoSourceWire } from '../../lib/wire';
import { useMove } from '../../moves';
import { useApp } from '../../state';
import { useFocusPoll } from '../../ui/hooks';
import { Icon } from '../../ui/icon';
import { Card, FailureLine, Header, Notice, PrimaryButton, Screen, SectionTitle, SmallButton } from '../../ui/parts';
import { useTheme, type Theme } from '../../ui/theme';

const SOURCE: Record<MemoSourceWire, string> = { typed: '직접 입력', share: '공유', selection: '텍스트 선택', voice: '음성', chat: '질문에서', feed: '자동 수집', agent: '에이전트' };

/** The gateway's reviewBelowConfidence (src/main.ts): below it a classifier verdict is held for the user. */
const REVIEW_BELOW_CONFIDENCE = 0.6;

type Node = 'done' | 'now' | 'bad';
type Step = { title: string; sub: string; node: Node };

function routingStep(m: MemoDetailWire): Step | null {
  if (m.state === 'inbox' || !m.domain) return { title: '분류 기다리는 중', sub: '곧 어디에 쌓을지 정해요', node: 'now' };
  const r = m.routing;
  const reason = r?.reason ? ` · ${r.reason}` : '';
  switch (r?.by) {
    case 'hint':
      return { title: `${withRo(m.domain)} 분류`, sub: '직접 고름', node: 'done' };
    case 'user':
      return { title: `${withRo(m.domain)} 옮김`, sub: '직접 옮김', node: 'done' };
    case 'fallback':
      return { title: `${m.domain}에 임시로 둠`, sub: `분류하지 못했어요${reason}`, node: 'done' };
    case 'classifier': {
      const sure = (r.confidence ?? 0) >= REVIEW_BELOW_CONFIDENCE ? '높음' : '낮음';
      return m.state === 'held'
        ? { title: `${m.domain}일 것 같아요`, sub: `자동 · 확신 ${sure}${reason}`, node: 'done' }
        : { title: `${withRo(m.domain)} 분류`, sub: `자동 · 확신 ${sure}${reason}`, node: 'done' };
    }
    default:
      return { title: `${withRo(m.domain)} 분류`, sub: '자동', node: 'done' };
  }
}

function lastStep(m: MemoDetailWire): Step | null {
  const note = attemptsNote(m.state, m.failure);
  switch (m.state) {
    case 'inbox':
      return null;
    case 'held':
      return { title: '확인을 기다려요', sub: '맞으면 정리를 시작해요', node: 'now' };
    case 'routed':
      return { title: '정리 대기', sub: note ?? '앞의 정리가 끝나면 시작해요', node: 'now' };
    case 'running':
      return { title: '정리 중', sub: note ?? '보통 1~2분 걸려요', node: 'now' };
    case 'ingested':
      return { title: '정리됨', sub: [m.finished_at && clock12(new Date(m.finished_at)), m.verdict].filter(Boolean).join(' · '), node: 'done' };
    case 'failed':
      return { title: '정리하지 못했어요', sub: m.failure ? `${m.failure.attempts}번 시도` : '', node: 'bad' };
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
        accessibilityLabel={caption || '사진'}
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
  const sentence = f ? failureSentence(f) : { text: '정리하지 못했어요.', link: null };
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
            {open ? f.detail : `자세히 · ${f.detail}`}
          </Text>
        </Pressable>
      ) : null}
      <View style={{ flexDirection: 'row' }}>
        <SmallButton label="다시 시도" icon="retry" filled busy={busy} onPress={retry} />
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
        <Header title="메모" back />
        <Text style={{ color: t.muted, fontSize: 14, padding: 16 }}>{missing ? '맥미니에서 이 메모를 찾지 못했어요.' : '불러오는 중'}</Text>
      </Screen>
    );
  }

  const captured = new Date(memo.captured_at);
  const steps = [{ title: '받음', sub: clock12(captured), node: 'done' as const }, routingStep(memo), lastStep(memo)].filter((s): s is Step => s !== null);
  const canMove = (memo.state === 'held' || memo.state === 'failed') && move?.status !== 'moving';

  return (
    <Screen>
      <Header title="메모" back />
      <ScrollView contentContainerStyle={st.main}>
        <View style={{ gap: 12 }}>
          {memo.text ? <Text selectable style={{ color: t.fg, fontSize: 17, lineHeight: 27 }}>{memo.text}</Text> : null}
          <View style={st.metaRow}>
            <Text style={st.meta(t)}>{`${monthDay(captured)} ${clock12(captured)}`}</Text>
            {memo.place && <Text style={st.meta(t)}>{memo.place}</Text>}
            <Text style={st.meta(t)}>{SOURCE[memo.source]}</Text>
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
          <SectionTitle>진행</SectionTitle>
          <Timeline steps={steps} />
        </View>

        {move?.status === 'moving' && (
          <Notice tone="plain">
            <Text style={{ color: t.muted, fontSize: 13, lineHeight: 20 }}>{withRo(move.to)} 옮기는 중이에요. 그 도메인의 정리가 끝나면 옮겨져요.</Text>
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
            <SectionTitle>바뀐 페이지</SectionTitle>
            <Card>
              {memo.pages.map((p, i) => (
                <View key={p.path} style={[st.page, i < memo.pages.length - 1 && { borderBottomWidth: 1, borderBottomColor: t.line }]}>
                  <Icon name="file" size={16} color={t.faint} />
                  <Text style={{ flex: 1, color: t.link, fontSize: 14 }}>{p.path}</Text>
                  <Text style={{ color: t.faint, fontSize: 12 }}>
                    {p.type ? `${p.type} · ` : ''}
                    {p.change === 'created' ? '새로 만듦' : '수정'}
                  </Text>
                </View>
              ))}
            </Card>
            {memo.domain && <Text style={{ color: t.faint, fontSize: 12, lineHeight: 18, marginHorizontal: 4, marginTop: 4 }}>원본 메모는 {memo.domain} raw 폴더에 그대로 남아요.</Text>}
          </View>
        )}

        {memo.state === 'held' && memo.domain && move?.status !== 'moving' && <PrimaryButton label={`${withIGa(memo.domain)} 맞아요`} busy={confirming} onPress={confirm} />}
        {canMove && memo.domain && (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push({ pathname: '/move/[id]', params: { id: memo.id, from: memo.domain!, text: memo.text } })}
            style={[st.outline, { borderColor: t.line2 }]}
          >
            <Text style={{ color: t.fg, fontSize: 15 }}>다른 도메인으로 옮기기</Text>
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
