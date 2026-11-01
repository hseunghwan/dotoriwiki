import { useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { startMove, useMove } from '../../moves';
import { useApp } from '../../state';
import { goBack, PrimaryButton, QuietButton, Sheet } from '../../ui/parts';
import { useTheme } from '../../ui/theme';
import { copy } from '../../text';

export default function MoveSheet() {
  const t = useTheme();
  const { id, from, text } = useLocalSearchParams<{ id: string; from: string; text?: string }>();
  const domains = useApp((a) => a.domains);
  const [picked, setPicked] = useState(from);
  const move = useMove(id);
  const shown = useRef(true);
  useEffect(() => () => void (shown.current = false), []);

  async function go() {
    const done = await startMove(id, picked);
    // The user may have left while it waited for the lane; only a sheet still on screen closes itself.
    if (done.status === 'moved' && shown.current) goBack();
  }

  return (
    <Sheet onClose={goBack}>
      <View style={{ gap: 6 }}>
        <Text style={{ color: t.fg, fontSize: 17, fontWeight: '600' }}>{copy.move.title}</Text>
        {text ? (
          <Text numberOfLines={3} style={{ color: t.muted, fontSize: 14, lineHeight: 21 }}>
            {text}
          </Text>
        ) : null}
      </View>

      {move?.status === 'moving' ? (
        <View style={[st.progress, { backgroundColor: t.bg, borderColor: t.cardLine }]}>
          <Text style={{ color: t.fg, fontSize: 15, fontWeight: '500' }}>{copy.move.moving(move.to)}</Text>
          <Text style={{ color: t.muted, fontSize: 13, lineHeight: 20 }}>
            {copy.move.movingNote}
          </Text>
        </View>
      ) : (
        <View accessibilityRole="radiogroup" style={{ gap: 8 }}>
          {domains.map((d) => {
            const on = picked === d;
            return (
              <Pressable
                key={d}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                onPress={() => setPicked(d)}
                style={[st.option, { backgroundColor: on ? t.onBg : 'transparent', borderColor: on ? t.onLine : t.line2 }]}
              >
                <View style={[st.radio, { borderColor: on ? t.onFg : t.line2, borderWidth: on ? 6 : 2 }]} />
                <Text style={{ flex: 1, color: t.fg, fontSize: 15, fontWeight: '500' }}>{d}</Text>
                {d === from && <Text style={{ color: t.faint, fontSize: 12 }}>{copy.move.current}</Text>}
              </Pressable>
            );
          })}
        </View>
      )}

      {move?.status === 'failed' && <Text style={{ color: t.bad, fontSize: 13, lineHeight: 20 }}>{move.message}</Text>}
      {move?.status !== 'moving' && <Text style={{ color: t.faint, fontSize: 12, lineHeight: 18 }}>{copy.move.restarts}</Text>}
      {move?.status === 'moving' ? <QuietButton label={copy.common.close} onPress={goBack} /> : <PrimaryButton label={copy.move.go} disabled={picked === from} onPress={go} />}
    </Sheet>
  );
}

const st = StyleSheet.create({
  option: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: 14, borderRadius: 12, borderWidth: 1 },
  radio: { width: 20, height: 20, borderRadius: 10 },
  progress: { padding: 14, borderRadius: 12, borderWidth: 1, gap: 6 },
});
