import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { BackHandler, KeyboardAvoidingView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { GeoFix } from '../lib/capture';
import { locate } from '../lib/location';
import { canSend } from '../lib/photos';
import { memoText, parseShared, preview } from '../lib/shared';
import { fromShare } from '../pick';
import { capture, getApp } from '../state';
import { DomainChips } from '../ui/domain-chips';
import { Icon } from '../ui/icon';
import { goBack, PrimaryButton, Sheet } from '../ui/parts';
import { PhotoButtons, PhotoStrip, usePhotoDraft } from '../ui/photos';
import { useTheme } from '../ui/theme';
import { copy } from '../text';

/** How long Save waits for the send before handing the user back to the app they came from. The row stays queued either way. */
const SEND_GRACE_MS = 4_000;

export default function Compose() {
  const t = useTheme();
  const params = useLocalSearchParams<{ source?: string; text?: string; subject?: string; photos?: string }>();
  const shared = parseShared(params);
  const draft = usePhotoDraft();
  const [note, setNote] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [fix, setFix] = useState<GeoFix | null>(null);

  useEffect(() => {
    if (getApp().settings.location) void locate().then(setFix);
  }, []);

  const sharedPhotos = params.photos;
  const { add } = draft;
  useEffect(() => {
    const uris = parseShared({ source: 'share', photos: sharedPhotos })?.photos ?? [];
    if (uris.length > 0) void fromShare(uris).then(add);
  }, [sharedPhotos, add]);

  function close() {
    draft.discard();
    goBack();
  }

  if (!shared) return <Sheet onClose={goBack}><Text style={{ color: t.muted, fontSize: 14 }}>{copy.compose.nothing}</Text></Sheet>;
  const card = shared.text ? preview(shared) : null;
  const text = memoText(shared, note);

  async function save() {
    if (!shared || !canSend(text, draft.photos)) return;
    setSaving(true);
    const { sent } = await capture({ text, source: shared.source, domainHint: hint, location: fix, photos: draft.photos });
    await Promise.race([sent, new Promise((r) => setTimeout(r, SEND_GRACE_MS))]);
    // Back to the app the text came from: the memo is already safe in the outbox.
    BackHandler.exitApp();
  }

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
      <Sheet onClose={close}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text style={{ color: t.fg, fontSize: 17, fontWeight: '600' }}>{copy.compose.title}</Text>
          <PhotoButtons draft={draft} />
        </View>
        {card && (
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
        )}
        <PhotoStrip draft={draft} />

        <View style={{ gap: 6 }}>
          <Text style={{ color: t.faint, fontSize: 12, fontWeight: '500' }}>{copy.compose.note}</Text>
          <TextInput
            accessibilityLabel={copy.compose.noteLabel}
            value={note}
            onChangeText={setNote}
            placeholder={copy.compose.notePlaceholder}
            placeholderTextColor={t.faint}
            style={[st.input, { borderColor: t.line2, backgroundColor: t.bg, color: t.fg }]}
          />
        </View>

        <View style={{ gap: 8 }}>
          <Text style={{ color: t.faint, fontSize: 12, fontWeight: '500' }}>{copy.common.whereToFile}</Text>
          <DomainChips value={hint} onChange={setHint} wrap />
        </View>

        <PrimaryButton label={saving ? copy.common.saving : copy.common.save} busy={saving} disabled={!canSend(text, draft.photos) || draft.busy} onPress={save} />
      </Sheet>
      {draft.sheet}
    </KeyboardAvoidingView>
  );
}

const st = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 10, borderWidth: 1 },
  thumb: { width: 40, height: 40, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  input: { height: 44, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, fontSize: 15 },
});
