import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { BackHandler, KeyboardAvoidingView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { GeoFix } from '../lib/capture';
import { locate } from '../lib/location';
import { memoText, parseShared, preview } from '../lib/shared';
import { capture, getApp } from '../state';
import { DomainChips } from '../ui/domain-chips';
import { Icon } from '../ui/icon';
import { goBack, PrimaryButton, Sheet } from '../ui/parts';
import { useTheme } from '../ui/theme';

/** How long 저장 waits for the send before handing the user back to the app they came from. The row stays queued either way. */
const SEND_GRACE_MS = 4_000;

export default function Compose() {
  const t = useTheme();
  const params = useLocalSearchParams<{ source?: string; text?: string; subject?: string }>();
  const shared = parseShared(params);
  const [note, setNote] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [fix, setFix] = useState<GeoFix | null>(null);

  useEffect(() => {
    if (getApp().settings.location) void locate().then(setFix);
  }, []);

  if (!shared) return <Sheet onClose={goBack}><Text style={{ color: t.muted, fontSize: 14 }}>받은 글자가 없어요.</Text></Sheet>;
  const card = preview(shared);

  async function save() {
    if (!shared) return;
    setSaving(true);
    const { sent } = await capture({ text: memoText(shared, note), source: shared.source, domainHint: hint, location: fix });
    await Promise.race([sent, new Promise((r) => setTimeout(r, SEND_GRACE_MS))]);
    // Back to the app the text came from: the memo is already safe in the outbox.
    BackHandler.exitApp();
  }

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
      <Sheet onClose={goBack}>
        <Text style={{ color: t.fg, fontSize: 17, fontWeight: '600' }}>LLM 위키에 저장</Text>
        <View style={[st.card, { backgroundColor: t.bg, borderColor: t.cardLine }]}>
          <View style={[st.thumb, { backgroundColor: t.bubble }]}>
            <Icon name={card.kind === 'link' ? 'link' : 'quote'} size={18} color={t.onFg} />
          </View>
          <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
            {card.kind === 'link' ? (
              <>
                <Text numberOfLines={1} style={{ color: t.fg, fontSize: 14 }}>{card.title}</Text>
                <Text style={{ color: t.faint, fontSize: 12 }}>{card.host}</Text>
              </>
            ) : (
              <Text numberOfLines={3} style={{ color: t.fg, fontSize: 14, lineHeight: 21 }}>{card.text}</Text>
            )}
          </View>
        </View>

        <View style={{ gap: 6 }}>
          <Text style={{ color: t.faint, fontSize: 12, fontWeight: '500' }}>한 줄 덧붙이기 (선택)</Text>
          <TextInput
            accessibilityLabel="한 줄 덧붙이기"
            value={note}
            onChangeText={setNote}
            placeholder="왜 저장하는지 적어 두면 요약이 더 좋아져요"
            placeholderTextColor={t.faint}
            style={[st.input, { borderColor: t.line2, backgroundColor: t.bg, color: t.fg }]}
          />
        </View>

        <View style={{ gap: 8 }}>
          <Text style={{ color: t.faint, fontSize: 12, fontWeight: '500' }}>어디에 쌓을까요</Text>
          <DomainChips value={hint} onChange={setHint} wrap />
        </View>

        <PrimaryButton label={saving ? '저장하는 중' : '저장'} busy={saving} onPress={save} />
      </Sheet>
    </KeyboardAvoidingView>
  );
}

const st = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 10, borderWidth: 1 },
  thumb: { width: 40, height: 40, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  input: { height: 44, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, fontSize: 15 },
});
