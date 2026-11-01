import type { Asset } from 'expo-media-library/legacy';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Image, Modal, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { DraftPhoto } from '../lib/photos';
import { fromGallery, galleryAccess, recentPhotos, widenAccess, type GalleryAccess } from '../pick';
import { Icon } from './icon';
import { PrimaryButton, s as ui, SmallButton } from './parts';
import { useTheme } from './theme';
import { copy } from '../text';

const COLUMNS = 4;
const GAP = 2;

/** Recent photos from MediaStore, multi-select in tap order up to `room`. */
export function GallerySheet({ visible, room, onClose, onDone }: { visible: boolean; room: number; onClose: () => void; onDone: (photos: DraftPhoto[]) => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const size = (width - GAP * (COLUMNS - 1)) / COLUMNS;
  const [access, setAccess] = useState<GalleryAccess | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [picked, setPicked] = useState<Asset[]>([]);
  const [copying, setCopying] = useState(false);
  const after = useRef<string | null>(null);
  const loading = useRef(false);

  const load = useCallback(async (reset: boolean) => {
    if (loading.current || (!reset && after.current === null)) return;
    loading.current = true;
    try {
      const page = await recentPhotos(reset ? null : after.current);
      after.current = page.after;
      setAssets((a) => (reset ? page.assets : [...a, ...page.assets]));
    } catch {
      after.current = null;
    } finally {
      loading.current = false;
    }
  }, []);

  const start = useCallback(async (next: GalleryAccess) => {
    setAccess(next);
    if (next.kind !== 'denied') await load(true);
  }, [load]);

  useEffect(() => {
    if (!visible) return;
    setPicked([]);
    void galleryAccess(true).then(start);
  }, [visible, start]);

  function toggle(a: Asset) {
    setPicked((p) => (p.some((x) => x.id === a.id) ? p.filter((x) => x.id !== a.id) : p.length < room ? [...p, a] : p));
  }

  async function done() {
    setCopying(true);
    const photos = await fromGallery(picked);
    setCopying(false);
    onDone(photos);
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top, paddingBottom: insets.bottom }}>
        <View style={[st.header, { borderBottomColor: t.line }]}>
          <Pressable accessibilityRole="button" accessibilityLabel={copy.common.close} onPress={onClose} style={ui.iconButton}>
            <Icon name="x" color={t.fg} />
          </Pressable>
          <Text style={[ui.h1, { color: t.fg, flex: 1 }]}>{copy.photos.pick}</Text>
          <Text style={{ color: t.faint, fontSize: 13, marginRight: 16 }}>
            {picked.length}/{room}
          </Text>
        </View>

        {access?.kind === 'limited' && (
          <View style={[st.banner, { backgroundColor: t.bg2, borderBottomColor: t.line }]}>
            <Text style={{ color: t.muted, fontSize: 13, flex: 1 }}>{copy.photos.onlyAllowed}</Text>
            <SmallButton label={copy.photos.allowMore} onPress={() => void widenAccess(access).then(start)} />
          </View>
        )}

        {access?.kind === 'denied' ? (
          <View style={st.empty}>
            <Text style={{ color: t.muted, fontSize: 14, textAlign: 'center', lineHeight: 21 }}>
              {copy.photos.needAccess}
            </Text>
            <SmallButton label={access.canAskAgain ? copy.photos.allow : copy.photos.openSettings} onPress={() => void widenAccess(access).then(start)} />
          </View>
        ) : (
          <FlatList
            data={assets}
            keyExtractor={(a) => a.id}
            numColumns={COLUMNS}
            columnWrapperStyle={{ gap: GAP }}
            contentContainerStyle={{ gap: GAP }}
            onEndReached={() => void load(false)}
            onEndReachedThreshold={1}
            ListEmptyComponent={access ? <Text style={[st.none, { color: t.faint }]}>{copy.photos.empty}</Text> : undefined}
            renderItem={({ item }) => {
              const order = picked.findIndex((p) => p.id === item.id);
              return (
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: order >= 0 }}
                  accessibilityLabel={item.filename}
                  onPress={() => toggle(item)}
                  style={{ width: size, height: size }}
                >
                  <Image source={{ uri: item.uri }} resizeMethod="resize" style={{ width: size, height: size, backgroundColor: t.bg3, opacity: order >= 0 ? 0.7 : 1 }} />
                  <View style={[st.mark, order >= 0 ? { backgroundColor: t.btn, borderColor: t.btn } : { borderColor: '#ffffff', backgroundColor: 'rgba(0,0,0,0.2)' }]}>
                    {order >= 0 && <Text style={st.markText}>{order + 1}</Text>}
                  </View>
                </Pressable>
              );
            }}
          />
        )}

        <View style={[st.footer, { borderTopColor: t.line }]}>
          <PrimaryButton
            label={copying ? copy.photos.importing : picked.length > 0 ? copy.photos.attachN(picked.length) : copy.photos.attach}
            busy={copying}
            disabled={picked.length === 0}
            onPress={done}
          />
        </View>
      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  header: { height: 56, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 4, borderBottomWidth: 1 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: 1 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 32 },
  none: { textAlign: 'center', padding: 32, fontSize: 14 },
  mark: { position: 'absolute', top: 6, right: 6, width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  markText: { color: '#ffffff', fontSize: 12, fontWeight: '600' },
  footer: { padding: 16, borderTopWidth: 1 },
});
