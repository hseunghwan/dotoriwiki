import * as Clipboard from 'expo-clipboard';
import * as Crypto from 'expo-crypto';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type ScrollViewInstance } from 'react-native';
import { gateway } from '../../lib/gateway';
import { answerSpans, pageLabel } from '../../lib/markdown';
import type { ChatFrame } from '../../lib/wire';
import { capture, useApp } from '../../state';
import { Icon } from '../../ui/icon';
import { Chip, Screen, ScreenTitle } from '../../ui/parts';
import { useTheme } from '../../ui/theme';

const ROOT = 'root';

type Turn = {
  id: string;
  question: string;
  answer: string;
  cited: string[];
  status: 'streaming' | 'done' | 'error';
  error: string | null;
  saved: 'no' | 'saving' | 'saved' | 'failed';
  remembered: 'no' | 'saved';
};
/** One conversation per target, kept for the screen's life so switching chips does not lose it. */
type Thread = { sessionId: string | null; turns: Turn[] };

const citedDomain = (cited: string) => (cited.includes('/wiki/') ? cited.split('/wiki/')[0]! : null);

/** Where 답 저장 files the answer: the asked domain, or for 전체 the domain of the first cited page. */
function answerDomain(target: string, turn: Turn): string | null {
  if (target !== ROOT) return target;
  for (const c of turn.cited) {
    const d = citedDomain(c);
    if (d) return d;
  }
  return null;
}

function ActButton({ label, icon, on, onPress, small }: { label: string; icon: 'bookmark' | 'copy' | 'pencil'; on?: boolean; onPress: () => void; small?: boolean }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!on }}
      onPress={onPress}
      style={[st.act, { height: small ? 30 : 32, paddingHorizontal: small ? 10 : 12, backgroundColor: on ? t.okBg : 'transparent', borderColor: on ? t.okLine : t.line2 }]}
    >
      <Icon name={icon} size={14} color={on ? t.okFg : t.muted} />
      <Text style={{ color: on ? t.okFg : t.muted, fontSize: small ? 12 : 13 }}>{label}</Text>
    </Pressable>
  );
}

export default function Chat() {
  const t = useTheme();
  const pairing = useApp((a) => a.pairing);
  const domains = useApp((a) => a.domains);
  const [target, setTarget] = useState(ROOT);
  const [threads, setThreads] = useState<Record<string, Thread>>({});
  const [draft, setDraft] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const scroll = useRef<ScrollViewInstance>(null);
  const aborts = useRef(new Set<AbortController>());

  useEffect(() => () => aborts.current.forEach((a) => a.abort()), []);
  useEffect(() => {
    if (!toast) return;
    // The toast takes room above the input; keep the buttons it would cover in view.
    requestAnimationFrame(() => scroll.current?.scrollToEnd({ animated: true }));
    const timer = setTimeout(() => setToast(null), 3_000);
    return () => clearTimeout(timer);
  }, [toast]);

  const thread = threads[target] ?? { sessionId: null, turns: [] };
  const busy = thread.turns.at(-1)?.status === 'streaming';

  function update(key: string, f: (th: Thread) => Thread) {
    setThreads((all) => ({ ...all, [key]: f(all[key] ?? { sessionId: null, turns: [] }) }));
  }
  const updateTurn = (key: string, id: string, f: (turn: Turn) => Turn) => update(key, (th) => ({ ...th, turns: th.turns.map((x) => (x.id === id ? f(x) : x)) }));

  async function ask() {
    const message = draft.trim();
    if (!message || !pairing || busy) return;
    const key = target;
    const id = Crypto.randomUUID();
    setDraft('');
    update(key, (th) => ({ ...th, turns: [...th.turns, { id, question: message, answer: '', cited: [], status: 'streaming', error: null, saved: 'no', remembered: 'no' }] }));

    const onFrame = (f: ChatFrame) => {
      if (f.type === 'session') update(key, (th) => ({ ...th, sessionId: f.session_id }));
      else if (f.type === 'delta') updateTurn(key, id, (x) => ({ ...x, answer: x.answer + f.text }));
      else if (f.type === 'done') {
        update(key, (th) => ({ ...th, sessionId: f.session_id }));
        updateTurn(key, id, (x) => ({ ...x, cited: f.cited, status: 'done' }));
      } else updateTurn(key, id, (x) => ({ ...x, status: 'error', error: f.message }));
    };
    const abort = new AbortController();
    aborts.current.add(abort);
    const r = await gateway.chat(pairing, { target: key, message, session_id: threads[key]?.sessionId ?? null }, abort.signal, onFrame);
    aborts.current.delete(abort);
    updateTurn(key, id, (x) =>
      x.status !== 'streaming'
        ? x
        : r.ok
          ? { ...x, status: 'done' }
          : { ...x, status: 'error', error: r.failure.kind === 'unreachable' ? '맥미니에 연결하지 못했어요.' : '답을 받지 못했어요.' },
    );
  }

  async function saveAnswer(key: string, turn: Turn) {
    const domain = answerDomain(key, turn);
    if (!pairing || !domain || turn.saved === 'saving' || turn.saved === 'saved') return;
    updateTurn(key, turn.id, (x) => ({ ...x, saved: 'saving' }));
    const r = await gateway.answer(pairing, { id: turn.id, domain, question: turn.question, answer: turn.answer, cited: turn.cited, session_id: threads[key]?.sessionId ?? null });
    updateTurn(key, turn.id, (x) => ({ ...x, saved: r.ok ? 'saved' : 'failed' }));
    setToast(r.ok ? `${domain} 위키의 answers에 저장했어요` : '저장하지 못했어요. 연결을 확인해 주세요.');
  }

  async function remember(key: string, turn: Turn) {
    if (turn.remembered === 'saved') return;
    await capture({ text: turn.question, source: 'chat', domainHint: key === ROOT ? null : key, location: null });
    updateTurn(key, turn.id, (x) => ({ ...x, remembered: 'saved' }));
  }

  return (
    <Screen>
      <View style={[st.header, { borderBottomColor: t.line }]}>
        <ScreenTitle title="질문" mark />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }} accessibilityLabel="질문할 위키">
          <Chip small label="전체" on={target === ROOT} onPress={() => setTarget(ROOT)} />
          {domains.map((d) => (
            <Chip small key={d} label={d} on={target === d} onPress={() => setTarget(d)} />
          ))}
        </ScrollView>
      </View>

      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <ScrollView ref={scroll} contentContainerStyle={st.main} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })} keyboardShouldPersistTaps="handled">
          {thread.turns.length === 0 && (
            <View style={{ paddingVertical: 24, gap: 6, alignItems: 'center' }}>
              <Text style={{ color: t.muted, fontSize: 14 }}>{target === ROOT ? '위키 전체에 물어봐요' : `${target} 위키에 물어봐요`}</Text>
              <Text style={{ color: t.faint, fontSize: 13, lineHeight: 21, textAlign: 'center' }}>예: 내가 RAG에 대해 알아낸 게 뭐였지?</Text>
            </View>
          )}
          {thread.turns.map((turn) => {
            const domain = answerDomain(target, turn);
            return (
              <View key={turn.id} style={{ gap: 20 }}>
                <View style={st.mine}>
                  <View style={[st.bubble, { backgroundColor: t.bubble }]}>
                    <Text selectable style={{ color: t.fg, fontSize: 15, lineHeight: 22.5 }}>{turn.question}</Text>
                  </View>
                  <ActButton
                    small
                    icon="pencil"
                    label={turn.remembered === 'saved' ? (target === ROOT ? '메모로 남겼어요' : `${target}에 메모로 남겼어요`) : '기억하기'}
                    on={turn.remembered === 'saved'}
                    onPress={() => remember(target, turn)}
                  />
                </View>
                <View style={{ gap: 12 }}>
                  {turn.answer ? (
                    <Text selectable style={{ color: t.fg, fontSize: 15, lineHeight: 24.75 }}>
                      {answerSpans(turn.answer).map((span, i) =>
                        span.kind === 'text' ? span.text : (
                          <Text key={i} style={span.kind === 'bold' ? { fontWeight: '600' } : { color: t.link }}>
                            {span.text}
                          </Text>
                        ),
                      )}
                    </Text>
                  ) : turn.status === 'streaming' ? (
                    <Text style={{ color: t.faint, fontSize: 15 }}>위키를 읽는 중…</Text>
                  ) : null}
                  {turn.error && <Text style={{ color: t.bad, fontSize: 14, lineHeight: 21 }}>{turn.error}</Text>}
                  {turn.cited.length > 0 && (
                    <View style={st.cites}>
                      {turn.cited.map((c) => (
                        <View key={c} style={[st.cite, { backgroundColor: t.bg2 }]}>
                          <Icon name="file" size={12} color={t.link} />
                          <Text style={{ color: t.link, fontSize: 12 }}>{pageLabel(c)}</Text>
                        </View>
                      ))}
                    </View>
                  )}
                  {turn.status === 'done' && turn.answer !== '' && (
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      {domain && (
                        <ActButton icon="bookmark" label={turn.saved === 'saved' ? '저장됨' : turn.saved === 'saving' ? '저장하는 중' : '답 저장'} on={turn.saved === 'saved'} onPress={() => saveAnswer(target, turn)} />
                      )}
                      <ActButton icon="copy" label="복사" onPress={() => void Clipboard.setStringAsync(turn.answer)} />
                    </View>
                  )}
                </View>
              </View>
            );
          })}
        </ScrollView>

        {toast && (
          <View accessibilityRole="alert" style={[st.toast, { backgroundColor: t.bg2, borderColor: t.cardLine }]}>
            <Text style={{ color: t.muted, fontSize: 13 }}>{toast}</Text>
          </View>
        )}
        <View style={st.form}>
          <TextInput
            accessibilityLabel="질문 입력"
            value={draft}
            onChangeText={setDraft}
            placeholder="위키에 물어보기"
            placeholderTextColor={t.faint}
            onSubmitEditing={ask}
            returnKeyType="send"
            style={[st.input, { borderColor: t.line2, backgroundColor: t.bg2, color: t.fg }]}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="보내기"
            accessibilityState={{ disabled: busy || draft.trim() === '' }}
            onPress={ask}
            style={[st.send, { backgroundColor: busy || draft.trim() === '' ? t.btnOff : t.btn }]}
          >
            <Icon name="arrowUp" size={20} strokeWidth={2} color={busy || draft.trim() === '' ? t.btnOffFg : t.btnFg} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const st = StyleSheet.create({
  header: { paddingVertical: 12, paddingHorizontal: 16, gap: 12, borderBottomWidth: 1 },
  main: { paddingVertical: 20, paddingHorizontal: 16, gap: 20 },
  mine: { alignSelf: 'flex-end', maxWidth: '80%', alignItems: 'flex-end', gap: 6 },
  bubble: { paddingVertical: 10, paddingHorizontal: 14, borderTopLeftRadius: 14, borderTopRightRadius: 14, borderBottomLeftRadius: 14, borderBottomRightRadius: 4 },
  act: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 8, borderWidth: 1 },
  cites: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  cite: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 26, paddingHorizontal: 8, borderRadius: 6 },
  toast: { marginHorizontal: 16, marginBottom: 8, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1 },
  form: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 8, paddingHorizontal: 16, paddingBottom: 12 },
  input: { flex: 1, height: 44, paddingHorizontal: 14, borderRadius: 22, borderWidth: 1, fontSize: 15 },
  send: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
});
