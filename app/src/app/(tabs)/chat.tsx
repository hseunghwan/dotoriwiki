import * as Clipboard from 'expo-clipboard';
import * as Crypto from 'expo-crypto';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type ScrollViewInstance } from 'react-native';
import { answerId, EMPTY, fromDetail, isStreaming, ROOT, type Conversation, type Turn } from '../../lib/chats';
import { gateway, type Failure } from '../../lib/gateway';
import { answerSpans, pageLabel } from '../../lib/markdown';
import type { ChatFrame } from '../../lib/wire';
import { capture, useApp } from '../../state';
import { Icon, type IconName } from '../../ui/icon';
import { Chip, Screen, ScreenTitle } from '../../ui/parts';
import { useTheme } from '../../ui/theme';
import { copy } from '../../text';

function chatFailure(f: Failure): string {
  if (f.kind === 'unreachable') return copy.chat.unreachable;
  if (f.kind === 'http' && f.status === 404) return copy.chat.gone;
  if (f.kind === 'http' && f.status === 409) return copy.chat.busy;
  return copy.chat.noAnswer;
}

const citedDomain = (cited: string) => (cited.includes('/wiki/') ? cited.split('/wiki/')[0]! : null);

/** Where Save answer files it: the asked domain, or for all wikis the domain of the first cited page. */
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

function HeaderButton({ icon, label, onPress, disabled }: { icon: IconName; label: string; onPress: () => void; disabled?: boolean }) {
  const t = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress} style={st.headerButton}>
      <Icon name={icon} size={20} color={disabled ? t.faint : t.muted} />
    </Pressable>
  );
}

export default function Chat() {
  const t = useTheme();
  const pairing = useApp((a) => a.pairing);
  const domains = useApp((a) => a.domains);
  const { open } = useLocalSearchParams<{ open?: string }>();
  const [target, setTarget] = useState(ROOT);
  /** A target with no entry has not been loaded from the gateway yet. */
  const [convs, setConvs] = useState<Record<string, Conversation>>({});
  const convsRef = useRef(convs);
  convsRef.current = convs;
  const [draft, setDraft] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const scroll = useRef<ScrollViewInstance>(null);
  const aborts = useRef(new Set<AbortController>());

  useEffect(() => () => aborts.current.forEach((a) => a.abort()), []);

  /** Replaces the target's conversation with the gateway copy, unless a turn started meanwhile. 404 means it was deleted. */
  const reload = useCallback(
    async (key: string, sessionId: string) => {
      if (!pairing) return;
      const d = await gateway.chatDetail(pairing, sessionId);
      const gone = !d.ok && d.failure.kind === 'http' && d.failure.status === 404;
      if (!d.ok && !gone) return;
      setConvs((all) => {
        const c = all[key];
        if (c?.sessionId !== sessionId || isStreaming(c)) return all;
        return { ...all, [key]: d.ok ? fromDetail(d.data, c) : EMPTY };
      });
    },
    [pairing],
  );

  /** First visit to a target: its most recent conversation, or a new one. Offline leaves it unloaded to retry on focus. */
  const loadLatest = useCallback(
    async (key: string) => {
      if (!pairing) return;
      const list = await gateway.chats(pairing, null, 100);
      if (!list.ok) return;
      const latest = list.data.chats.find((c) => c.target === key);
      const d = latest ? await gateway.chatDetail(pairing, latest.session_id) : null;
      if (d && !d.ok) return;
      setConvs((all) => (all[key] ? all : { ...all, [key]: d ? fromDetail(d.data, undefined) : EMPTY }));
    },
    [pairing],
  );

  useFocusEffect(
    useCallback(() => {
      const c = convsRef.current[target];
      if (!c) void loadLatest(target);
      else if (c.sessionId && !isStreaming(c)) void reload(target, c.sessionId);
    }, [target, loadLatest, reload]),
  );

  useEffect(() => {
    if (!open || !pairing) return;
    router.setParams({ open: undefined });
    void (async () => {
      const d = await gateway.chatDetail(pairing, open);
      if (!d.ok) return setToast(copy.chat.openFailed);
      setTarget(d.data.target);
      setConvs((all) => (isStreaming(all[d.data.target]) ? all : { ...all, [d.data.target]: fromDetail(d.data, all[d.data.target]) }));
    })();
  }, [open, pairing]);
  useEffect(() => {
    if (!toast) return;
    // The toast takes room above the input; keep the buttons it would cover in view.
    requestAnimationFrame(() => scroll.current?.scrollToEnd({ animated: true }));
    const timer = setTimeout(() => setToast(null), 3_000);
    return () => clearTimeout(timer);
  }, [toast]);

  const conv = convs[target] ?? EMPTY;
  const busy = isStreaming(conv);

  function update(key: string, f: (c: Conversation) => Conversation) {
    setConvs((all) => ({ ...all, [key]: f(all[key] ?? EMPTY) }));
  }
  const updateTurn = (key: string, turnKey: string, f: (turn: Turn) => Turn) =>
    update(key, (c) => ({ ...c, turns: c.turns.map((x) => (x.key === turnKey ? f(x) : x)) }));

  async function ask() {
    const message = draft.trim();
    if (!message || !pairing || busy) return;
    const key = target;
    const turnKey = Crypto.randomUUID();
    let sessionId = convs[key]?.sessionId ?? null;
    setDraft('');
    update(key, (c) => ({ ...c, turns: [...c.turns, { key: turnKey, question: message, answer: '', cited: [], status: 'streaming', error: null, saved: 'no', remembered: 'no' }] }));

    const onFrame = (f: ChatFrame) => {
      if (f.type === 'session') {
        sessionId = f.session_id;
        update(key, (c) => ({ ...c, sessionId: f.session_id }));
      } else if (f.type === 'delta') updateTurn(key, turnKey, (x) => ({ ...x, answer: x.answer + f.text }));
      else if (f.type === 'done') updateTurn(key, turnKey, (x) => ({ ...x, cited: f.cited, status: 'done' }));
      else updateTurn(key, turnKey, (x) => ({ ...x, status: 'error', error: f.message }));
    };
    const abort = new AbortController();
    aborts.current.add(abort);
    const r = await gateway.chat(pairing, { target: key, message, session_id: sessionId }, abort.signal, onFrame);
    aborts.current.delete(abort);
    if (abort.signal.aborted) return;
    updateTurn(key, turnKey, (x) => (x.status !== 'streaming' ? x : r.ok ? { ...x, status: 'done' } : { ...x, status: 'error', error: chatFailure(r.failure) }));
    if (r.ok && sessionId) await reload(key, sessionId);
  }

  async function saveAnswer(key: string, turn: Turn, index: number) {
    const domain = answerDomain(key, turn);
    const sessionId = convs[key]?.sessionId;
    if (!pairing || !domain || !sessionId || turn.saved === 'saving' || turn.saved === 'saved') return;
    updateTurn(key, turn.key, (x) => ({ ...x, saved: 'saving' }));
    const r = await gateway.answer(pairing, {
      id: answerId(sessionId, index), domain, question: turn.question, answer: turn.answer, cited: turn.cited, session_id: sessionId,
    });
    updateTurn(key, turn.key, (x) => ({ ...x, saved: r.ok ? 'saved' : 'failed' }));
    setToast(r.ok ? copy.chat.savedTo(domain) : copy.chat.saveFailed);
  }

  async function remember(key: string, turn: Turn) {
    if (turn.remembered === 'saved') return;
    await capture({ text: turn.question, source: 'chat', domainHint: key === ROOT ? null : key, location: null });
    updateTurn(key, turn.key, (x) => ({ ...x, remembered: 'saved' }));
  }

  return (
    <Screen>
      <View style={[st.header, { borderBottomColor: t.line }]}>
        <View style={st.titleRow}>
          <ScreenTitle title={copy.chat.title} mark />
          <View style={{ flexDirection: 'row' }}>
            <HeaderButton icon="plus" label={copy.chat.newChat} disabled={busy || conv.turns.length === 0} onPress={() => update(target, () => EMPTY)} />
            <HeaderButton icon="history" label={copy.chat.pastChats} onPress={() => router.push('/chats')} />
          </View>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }} accessibilityLabel={copy.chat.targets}>
          <Chip small label={copy.common.all} on={target === ROOT} onPress={() => setTarget(ROOT)} />
          {domains.map((d) => (
            <Chip small key={d} label={d} on={target === d} onPress={() => setTarget(d)} />
          ))}
        </ScrollView>
      </View>

      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <ScrollView ref={scroll} contentContainerStyle={st.main} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })} keyboardShouldPersistTaps="handled">
          {conv.turns.length === 0 && (
            <View style={{ paddingVertical: 24, gap: 6, alignItems: 'center' }}>
              <Text style={{ color: t.muted, fontSize: 14 }}>{target === ROOT ? copy.chat.askAll : copy.chat.askDomain(target)}</Text>
              <Text style={{ color: t.faint, fontSize: 13, lineHeight: 21, textAlign: 'center' }}>{copy.chat.example}</Text>
            </View>
          )}
          {conv.turns.map((turn, index) => {
            const domain = answerDomain(target, turn);
            return (
              <View key={turn.key} style={{ gap: 20 }}>
                <View style={st.mine}>
                  <View style={[st.bubble, { backgroundColor: t.bubble }]}>
                    <Text selectable style={{ color: t.fg, fontSize: 15, lineHeight: 22.5 }}>{turn.question}</Text>
                  </View>
                  <ActButton
                    small
                    icon="pencil"
                    label={turn.remembered === 'saved' ? (target === ROOT ? copy.chat.remembered : copy.chat.rememberedIn(target)) : copy.chat.remember}
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
                    <Text style={{ color: t.faint, fontSize: 15 }}>{copy.chat.reading}</Text>
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
                        <ActButton icon="bookmark" label={turn.saved === 'saved' ? copy.chat.saved : turn.saved === 'saving' ? copy.common.saving : copy.chat.saveAnswer} on={turn.saved === 'saved'} onPress={() => saveAnswer(target, turn, index)} />
                      )}
                      <ActButton icon="copy" label={copy.chat.copy} onPress={() => void Clipboard.setStringAsync(turn.answer)} />
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
            accessibilityLabel={copy.chat.input}
            value={draft}
            onChangeText={setDraft}
            placeholder={copy.chat.placeholder}
            placeholderTextColor={t.faint}
            onSubmitEditing={ask}
            returnKeyType="send"
            style={[st.input, { borderColor: t.line2, backgroundColor: t.bg2, color: t.fg }]}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copy.common.send}
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
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 32 },
  headerButton: { width: 40, height: 40, marginVertical: -4, alignItems: 'center', justifyContent: 'center' },
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
