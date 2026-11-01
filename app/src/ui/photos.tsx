import { useCallback, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { removeQuietly } from '../lib/files';
import { addPhotos, MAX_PHOTOS, type DraftPhoto } from '../lib/photos';
import { fromCamera } from '../pick';
import { GallerySheet } from './gallery';
import { Icon } from './icon';
import { useTheme } from './theme';
import { copy } from '../text';

/** The photos on the memo being written, shared by the 메모 tab and the compose sheet. */
export function usePhotoDraft() {
  const [photos, setPhotos] = useState<DraftPhoto[]>([]);
  const [gallery, setGallery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const add = useCallback((added: DraftPhoto[]) => setPhotos((p) => addPhotos(p, added).photos), []);
  const remove = useCallback((uri: string) => {
    setPhotos((p) => p.filter((x) => x.uri !== uri));
    removeQuietly([uri]);
  }, []);
  const camera = useCallback(async () => {
    setNotice(null);
    setBusy(true);
    try {
      const r = await fromCamera();
      if (r === 'denied') setNotice(copy.photos.cameraDenied);
      else if (r) add([r]);
    } catch {
      setNotice(copy.photos.importFailed);
    } finally {
      setBusy(false);
    }
  }, [add]);

  return {
    photos,
    busy,
    notice,
    add,
    remove,
    camera,
    openGallery: () => (setNotice(null), setGallery(true)),
    /** After capture the files belong to the outbox row, so only the list is cleared. */
    clear: () => setPhotos([]),
    /** Closing without saving: the copies go too. */
    discard: () => removeQuietly(photos.map((p) => p.uri)),
    sheet: (
      <GallerySheet
        visible={gallery}
        room={MAX_PHOTOS - photos.length}
        onClose={() => setGallery(false)}
        onDone={(picked) => {
          setGallery(false);
          add(picked);
        }}
      />
    ),
  };
}

export type PhotoDraft = ReturnType<typeof usePhotoDraft>;

/** Gallery and camera, as the small bordered buttons the compose meta row already uses. */
export function PhotoButtons({ draft }: { draft: PhotoDraft }) {
  const t = useTheme();
  const full = draft.photos.length >= MAX_PHOTOS;
  return (
    <View style={st.buttons}>
      {draft.busy && <ActivityIndicator size="small" color={t.faint} />}
      <Pressable accessibilityRole="button" accessibilityLabel={copy.photos.pick} disabled={full || draft.busy} onPress={draft.openGallery} style={[st.button, { borderColor: t.line2, opacity: full ? 0.4 : 1 }]}>
        <Icon name="image" size={16} color={t.muted} />
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={copy.photos.take} disabled={full || draft.busy} onPress={draft.camera} style={[st.button, { borderColor: t.line2, opacity: full ? 0.4 : 1 }]}>
        <Icon name="camera" size={16} color={t.muted} />
      </Pressable>
    </View>
  );
}

export function PhotoStrip({ draft }: { draft: PhotoDraft }) {
  const t = useTheme();
  if (draft.photos.length === 0 && !draft.notice) return null;
  return (
    <View style={{ gap: 6 }}>
      {draft.photos.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }} keyboardShouldPersistTaps="handled">
          {draft.photos.map((p, i) => (
            <View key={p.uri}>
              <Image source={{ uri: p.uri }} resizeMethod="resize" style={[st.thumb, { backgroundColor: t.bg3 }]} accessibilityLabel={copy.photos.nth(i + 1, p.place ?? null)} />
              <Pressable accessibilityRole="button" accessibilityLabel={copy.photos.remove(i + 1)} hitSlop={8} onPress={() => draft.remove(p.uri)} style={[st.remove, { backgroundColor: t.scrim }]}>
                <Icon name="x" size={12} color="#ffffff" strokeWidth={2.5} />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      )}
      {draft.notice && <Text style={{ color: t.warn, fontSize: 12 }}>{draft.notice}</Text>}
    </View>
  );
}

/** Local thumbnails on a row still in the outbox. */
export function LocalThumbs({ uris }: { uris: readonly string[] }) {
  const t = useTheme();
  if (uris.length === 0) return null;
  return (
    <View style={{ flexDirection: 'row', gap: 6 }}>
      {uris.slice(0, 4).map((uri) => (
        <Image key={uri} source={{ uri }} resizeMethod="resize" style={[st.small, { backgroundColor: t.bg3 }]} />
      ))}
      {uris.length > 4 && <Text style={{ color: t.faint, fontSize: 12, alignSelf: 'center' }}>+{uris.length - 4}</Text>}
    </View>
  );
}

/** The small photo count mark on a memo row. */
export function PhotoCount({ count }: { count: number }) {
  const t = useTheme();
  if (count <= 0) return null;
  return (
    <View style={st.count} accessibilityLabel={copy.photos.count(count)}>
      <Icon name="image" size={12} color={t.faint} />
      <Text style={{ color: t.faint, fontSize: 12 }}>{count}</Text>
    </View>
  );
}

const st = StyleSheet.create({
  buttons: { flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: 'auto' },
  button: { width: 32, height: 28, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  thumb: { width: 64, height: 64, borderRadius: 8 },
  remove: { position: 'absolute', top: 4, right: 4, width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  small: { width: 40, height: 40, borderRadius: 6 },
  count: { flexDirection: 'row', alignItems: 'center', gap: 3 },
});
