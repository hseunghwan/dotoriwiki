import { useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, useWindowDimensions, View, type LayoutChangeEvent } from 'react-native';
import Animated, { Easing, useAnimatedProps, useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { addTap } from '../lib/taps';
import { ACORN, ACORN_LINE_COLOR, ACORN_STROKE_WIDTH, ACORN_TILE_COLOR, ACORN_TILE_RADIUS, ACORN_VIEWBOX, pathLength, type AcornStroke } from './acorn';
import { copy } from '../text';

const STORY = copy.acorn.story;

// Android breaks Korean between any two syllables and React Native has no keep-all, so word
// joiners hold each word together and lines break only at spaces, as the design does.
const keepAll = (text: string) => text.split(' ').map((word) => [...word].join('⁠')).join(' ');

const STORY_TILE = 200;
const STORY_GLYPH = 132;
const SCRIM = { at: 0, ms: 300 };
const ZOOM = { at: 0, ms: 450 };
const CAPTION = { at: 3300, ms: 600 };
const STORY_END = CAPTION.at + CAPTION.ms;

const easeOut = Easing.bezierFn(0, 0, 0.58, 1);
const overshoot = Easing.bezierFn(0.2, 0.9, 0.3, 1.25);

// react-native-svg ignores pathLength on Android, so the dash runs over each stroke's real length.
// The margin covers what sampling the curves leaves out.
const LENGTHS = new Map(ACORN.map((s) => [s.name, pathLength(s.d) + 0.5]));

type Rect = { x: number; y: number; width: number; height: number };

function phase(t: number, step: { at: number; ms: number }, easing: (x: number) => number): number {
  'worklet';
  return easing(Math.min(1, Math.max(0, (t - step.at) / step.ms)));
}

function Tile({ size, children }: { size: number; children: ReactNode }) {
  return (
    <View style={[st.tile, { width: size, height: size, borderRadius: size * ACORN_TILE_RADIUS }]}>{children}</View>
  );
}

function Glyph({ size, children }: { size: number; children?: ReactNode }) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox={`0 0 ${ACORN_VIEWBOX} ${ACORN_VIEWBOX}`}
      fill="none"
      stroke={ACORN_LINE_COLOR}
      strokeWidth={ACORN_STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children ?? ACORN.map((s) => <Path key={s.name} d={s.d} strokeWidth={s.width} />)}
    </Svg>
  );
}

const AnimatedPath = Animated.createAnimatedComponent(Path);

function DrawnStroke({ stroke, clock }: { stroke: AcornStroke; clock: SharedValue<number> }) {
  const length = LENGTHS.get(stroke.name)!;
  const animatedProps = useAnimatedProps(() => ({
    strokeDashoffset: length * (1 - phase(clock.value, stroke.draw, easeOut)),
    strokeOpacity: clock.value >= stroke.draw.at ? 1 : 0,
  }));
  return <AnimatedPath d={stroke.d} strokeWidth={stroke.width} strokeDasharray={[length, length]} animatedProps={animatedProps} />;
}

/** The easter egg: the title icon grows to the middle of the screen, draws itself, and says what the app is for. */
function AcornStory({ from, onClose }: { from: Rect; onClose: () => void }) {
  const clock = useSharedValue(0);
  const origin = useSharedValue({ dx: 0, dy: 0, scale: 0 });
  const started = useRef(false);
  const screen = useWindowDimensions();

  const start = (e: LayoutChangeEvent) => {
    if (started.current) return;
    started.current = true;
    const { x, y, width, height } = e.nativeEvent.layout;
    origin.value = {
      dx: from.x + from.width / 2 - (x + width / 2),
      dy: from.y + from.height / 2 - (y + height / 2),
      scale: from.width / STORY_TILE,
    };
    clock.value = withTiming(STORY_END, { duration: STORY_END, easing: Easing.linear });
  };

  const scrimStyle = useAnimatedStyle(() => ({ opacity: phase(clock.value, SCRIM, easeOut) }));
  const tileStyle = useAnimatedStyle(() => {
    const p = phase(clock.value, ZOOM, overshoot);
    const { dx, dy, scale } = origin.value;
    return {
      transform: [{ translateX: dx * (1 - p) }, { translateY: dy * (1 - p) }, { scale: scale + (1 - scale) * p }],
    };
  });
  const captionStyle = useAnimatedStyle(() => {
    const p = phase(clock.value, CAPTION, easeOut);
    return { opacity: p, transform: [{ translateY: 8 * (1 - p) }] };
  });

  return (
    <Modal transparent statusBarTranslucent navigationBarTranslucent animationType="none" onRequestClose={onClose}>
      <Pressable accessibilityLabel={copy.acorn.storyLabel} accessibilityHint={copy.acorn.tapToClose} onPress={onClose} style={StyleSheet.absoluteFill}>
        <Animated.View style={[StyleSheet.absoluteFill, st.scrim, scrimStyle]} />
        {/* Sized to the window, not the modal, so a keyboard hiding underneath cannot move the tile mid-zoom. */}
        <View style={[st.story, { width: screen.width, height: screen.height }]} pointerEvents="none">
          <Animated.View onLayout={start} style={tileStyle}>
            <Tile size={STORY_TILE}>
              <Glyph size={STORY_GLYPH}>
                {ACORN.map((s) => (
                  <DrawnStroke key={s.name} stroke={s} clock={clock} />
                ))}
              </Glyph>
            </Tile>
          </Animated.View>
          <Animated.Text accessibilityLabel={STORY} style={[st.caption, captionStyle]}>
            {keepAll(STORY)}
          </Animated.Text>
        </View>
      </Pressable>
    </Modal>
  );
}

/** The app icon beside a tab title. Three taps within a second open the acorn story. */
export function TitleMark() {
  const ref = useRef<ComponentRef<typeof View>>(null);
  const taps = useRef<number[]>([]);
  const [from, setFrom] = useState<Rect | null>(null);

  const onPress = () => {
    const next = addTap(taps.current, Date.now());
    taps.current = next.taps;
    if (next.fired) ref.current?.measureInWindow((x, y, width, height) => setFrom({ x, y, width, height }));
  };

  return (
    <>
      <Pressable ref={ref} accessibilityRole="button" accessibilityLabel={copy.acorn.label} onPress={onPress} hitSlop={8}>
        <Tile size={28}>
          <Glyph size={20} />
        </Tile>
      </Pressable>
      {from && <AcornStory from={from} onClose={() => setFrom(null)} />}
    </>
  );
}

const st = StyleSheet.create({
  tile: { backgroundColor: ACORN_TILE_COLOR, alignItems: 'center', justifyContent: 'center' },
  scrim: { backgroundColor: 'rgba(0,0,0,0.72)' },
  story: { position: 'absolute', top: 0, left: 0, alignItems: 'center', justifyContent: 'center', gap: 28, paddingHorizontal: 36 },
  caption: { color: '#dadada', fontSize: 15, lineHeight: 25.5, textAlign: 'center' },
});
