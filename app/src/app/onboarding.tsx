import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import * as Location from 'expo-location';
import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { gateway } from '../lib/gateway';
import { pairingFailureCopy, parseManual, parseQr, type Candidate, type PairingFailure, type PairingMode } from '../lib/pairing';
import { pair, updateSettings, useApp } from '../state';
import { Icon } from '../ui/icon';
import { Card, Notice, PrimaryButton, QuietButton, Screen } from '../ui/parts';
import { useTheme } from '../ui/theme';

type Connect = {
  mode: PairingMode;
  checking: boolean;
  failure: PairingFailure | null;
  /** Domain names once GET /status answered. */
  connected: string[] | null;
};

type Step = { kind: 'connect' } | { kind: 'location' } | { kind: 'done' };
const STEP_INDEX: Record<Step['kind'], number> = { connect: 0, location: 1, done: 2 };

export default function Onboarding() {
  const t = useTheme();
  const { repair } = useLocalSearchParams<{ repair?: string }>();
  const [step, setStep] = useState<Step>({ kind: 'connect' });
  const [connect, setConnect] = useState<Connect>({ mode: 'qr', checking: false, failure: null, connected: null });
  const location = useApp((a) => a.settings.location);

  async function check(candidate: Candidate | null, mode: PairingMode) {
    if (!candidate) return setConnect({ mode, checking: false, failure: 'invalid', connected: null });
    setConnect({ mode, checking: true, failure: null, connected: null });
    const r = await gateway.check(candidate);
    if (!r.ok) return setConnect({ mode, checking: false, failure: r.failure, connected: null });
    await pair(r.pairing, r.status);
    setConnect({ mode, checking: false, failure: null, connected: Object.keys(r.status.domains) });
  }

  function next() {
    if (repair) {
      if (router.canGoBack()) router.back();
      else router.replace('/');
    } else setStep({ kind: 'location' });
  }

  async function chooseLocation(allow: boolean) {
    const granted = allow && (await Location.requestForegroundPermissionsAsync()).granted;
    await updateSettings({ location: granted });
    setStep({ kind: 'done' });
  }

  const index = STEP_INDEX[step.kind];
  return (
    <Screen>
      {!repair && (
        <View accessibilityLabel={`3단계 중 ${index + 1}단계`} style={st.steps}>
          {[0, 1, 2].map((i) => (
            <View key={i} style={[st.step, { backgroundColor: i <= index ? t.link : t.line2 }]} />
          ))}
        </View>
      )}
      {step.kind === 'connect' && (
        <ConnectStep state={connect} repair={repair ?? null} onCheck={check} onMode={(mode) => setConnect({ mode, checking: false, failure: null, connected: null })} onNext={next} />
      )}
      {step.kind === 'location' && <LocationStep onChoose={chooseLocation} />}
      {step.kind === 'done' && <DoneStep location={location} />}
    </Screen>
  );
}

function ConnectStep(props: {
  state: Connect;
  repair: string | null;
  onCheck: (c: Candidate | null, mode: PairingMode) => void;
  onMode: (m: PairingMode) => void;
  onNext: () => void;
}) {
  const t = useTheme();
  const { mode, checking, failure, connected } = props.state;
  const [addr, setAddr] = useState('');
  const [token, setToken] = useState('');
  const lede =
    props.repair === '401'
      ? '맥미니의 토큰이 바뀌어서 메모를 보내지 못하고 있어요. 보내지 못한 메모는 휴대폰에 그대로 있어요. 맥미니에서 QR을 다시 띄워 연결해 주세요.'
      : '집에 있는 맥미니가 메모를 받아서 위키로 정리해요. 휴대폰에서 Tailscale을 켠 다음, 맥미니에 띄운 연결용 QR을 비춰 주세요.';

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={st.main} keyboardShouldPersistTaps="handled">
        <View style={{ gap: 8 }}>
          <Text style={[st.title, { color: t.fg }]}>{props.repair ? '다시 연결해요' : '맥미니에 연결해요'}</Text>
          <Text style={[st.lede, { color: t.muted }]}>{lede}</Text>
        </View>

        {!connected && mode === 'qr' && <QrView checking={checking} onScan={(data) => props.onCheck(parseQr(data), 'qr')} />}

        {!connected && mode === 'manual' && (
          <View style={{ gap: 16 }}>
            <Field label="맥미니 주소" value={addr} onChange={setAddr} placeholder="macmini.tail-xxxx.ts.net:8787" keyboardType="url" />
            <Field label="토큰" value={token} onChange={setToken} placeholder="맥미니에 적어 둔 토큰" secure onSubmit={() => !checking && props.onCheck(parseManual(addr, token), 'manual')} />
          </View>
        )}

        {connected && (
          <Notice tone="ok">
            <View accessibilityRole="text" style={st.row8}>
              <Icon name="checkCircle" size={18} color={t.okFg} />
              <Text style={{ color: t.okFg, fontSize: 14, fontWeight: '500' }}>연결됐어요. 위키 {connected.length}개를 찾았어요.</Text>
            </View>
            <View style={st.wrap6}>
              {connected.map((d) => (
                <View key={d} style={[st.tag, { backgroundColor: t.bg2 }]}>
                  <Text style={{ color: t.muted, fontSize: 12 }}>{d}</Text>
                </View>
              ))}
            </View>
          </Notice>
        )}

        {failure && (
          <Notice tone="bad">
            <View accessibilityRole="alert" style={st.row8top}>
              <Icon name="alert" size={18} color={t.bad} />
              <Text style={{ flex: 1, color: t.bad, fontSize: 14, lineHeight: 21 }}>{pairingFailureCopy(mode, failure)}</Text>
            </View>
          </Notice>
        )}

        <View style={{ flex: 1 }} />

        {!connected && mode === 'qr' && <QuietButton label="직접 입력" onPress={() => props.onMode('manual')} />}
        {!connected && mode === 'manual' && (
          <View style={{ gap: 8 }}>
            <PrimaryButton
              tall
              label={checking ? '확인하는 중' : '연결 확인'}
              busy={checking}
              disabled={addr.trim() === '' || token.trim() === ''}
              onPress={() => props.onCheck(parseManual(addr, token), 'manual')}
            />
            <QuietButton label="QR로 연결하기" onPress={() => props.onMode('qr')} />
          </View>
        )}
        {connected && <PrimaryButton tall label={props.repair ? '완료' : '다음'} onPress={props.onNext} />}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function QrView({ checking, onScan }: { checking: boolean; onScan: (data: string) => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const last = useRef<{ data: string; at: number } | null>(null);
  const live = permission?.granted === true;

  function scanned(r: BarcodeScanningResult) {
    if (checking || (r.data === last.current?.data && Date.now() - last.current.at < 4_000)) return;
    last.current = { data: r.data, at: Date.now() };
    onScan(r.data);
  }

  return (
    <Pressable accessibilityRole="button" accessibilityLabel="QR 코드 찍기" onPress={live ? undefined : requestPermission} style={st.qr}>
      {live && <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={scanned} />}
      <View style={st.frame}>
        <View style={[st.corner, { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 10 }]} />
        <View style={[st.corner, { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 10 }]} />
        <View style={[st.corner, { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 10 }]} />
        <View style={[st.corner, { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 10 }]} />
      </View>
      <Text style={st.qrLabel}>{checking ? '읽는 중' : live ? '맥미니 QR을 네모 안에 맞춰 주세요' : '눌러서 카메라를 켜 주세요'}</Text>
    </Pressable>
  );
}

function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  keyboardType?: 'url';
  secure?: boolean;
  onSubmit?: () => void;
}) {
  const t = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: t.muted, fontSize: 13, fontWeight: '500' }}>{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        value={props.value}
        onChangeText={props.onChange}
        placeholder={props.placeholder}
        placeholderTextColor={t.faint}
        keyboardType={props.keyboardType ?? 'default'}
        secureTextEntry={props.secure}
        onSubmitEditing={props.onSubmit}
        returnKeyType={props.onSubmit ? 'go' : 'next'}
        autoCapitalize="none"
        autoCorrect={false}
        style={[st.input, { borderColor: t.line2, backgroundColor: t.bg2, color: t.fg }]}
      />
    </View>
  );
}

function LocationStep({ onChoose }: { onChoose: (allow: boolean) => void }) {
  const t = useTheme();
  const points = ['메모를 쓰는 순간에만 위치를 확인해요.', '위치는 내 맥미니에만 저장돼요.', '메모마다 위치를 뺄 수 있고, 설정에서 언제든 끌 수 있어요.'];
  return (
    <View style={st.main}>
      <View style={[st.badge, { backgroundColor: t.onBg }]}>
        <Icon name="pin" size={26} color={t.onFg} />
      </View>
      <View style={{ gap: 8 }}>
        <Text style={[st.title, { color: t.fg }]}>메모에 위치를 붙일까요</Text>
        <Text style={[st.lede, { color: t.muted }]}>어디서 쓴 메모인지 남겨 두면 &quot;그때 거기서 무슨 생각 했지?&quot; 같은 질문에도 답할 수 있어요.</Text>
      </View>
      <View style={{ gap: 12 }}>
        {points.map((p) => (
          <View key={p} style={{ flexDirection: 'row', gap: 10 }}>
            <Icon name="check" size={18} color={t.okFg} />
            <Text style={{ flex: 1, color: t.muted, fontSize: 14, lineHeight: 21 }}>{p}</Text>
          </View>
        ))}
      </View>
      <View style={{ flex: 1 }} />
      <View style={{ gap: 8 }}>
        <PrimaryButton tall label="위치 허용" onPress={() => onChoose(true)} />
        <QuietButton label="나중에" onPress={() => onChoose(false)} />
      </View>
    </View>
  );
}

function DoneStep({ location }: { location: boolean }) {
  const t = useTheme();
  return (
    <View style={st.main}>
      <View style={[st.badge, { backgroundColor: t.okBg }]}>
        <Icon name="check" size={26} color={t.okFg} />
      </View>
      <View style={{ gap: 8 }}>
        <Text style={[st.title, { color: t.fg }]}>준비됐어요</Text>
        <Text style={[st.lede, { color: t.muted }]}>대충 막 적어도 맥미니가 알아서 위키에 쌓아요.</Text>
      </View>
      <Card>
        <View style={[st.kv, { borderBottomWidth: 1, borderBottomColor: t.line }]}>
          <Text style={{ color: t.muted, fontSize: 14 }}>맥미니</Text>
          <Text style={{ color: t.okFg, fontSize: 14 }}>연결됨</Text>
        </View>
        <View style={st.kv}>
          <Text style={{ color: t.muted, fontSize: 14 }}>위치 붙이기</Text>
          <Text style={{ color: t.fg, fontSize: 14 }}>{location ? '켬' : '꺼짐'}</Text>
        </View>
      </Card>
      <Text style={{ color: t.faint, fontSize: 13, lineHeight: 21 }}>다른 앱에서 공유하기를 누르거나 글자를 선택한 메뉴에서도 LLM 위키로 바로 보낼 수 있어요.</Text>
      <View style={{ flex: 1 }} />
      <PrimaryButton tall label="첫 메모 쓰기" onPress={() => router.replace('/')} />
    </View>
  );
}

const st = StyleSheet.create({
  steps: { flexDirection: 'row', gap: 6, paddingTop: 24, paddingHorizontal: 24 },
  step: { flex: 1, height: 4, borderRadius: 2 },
  main: { flexGrow: 1, paddingTop: 40, paddingHorizontal: 24, paddingBottom: 24, gap: 24 },
  title: { fontSize: 24, fontWeight: '600', letterSpacing: -0.48 },
  lede: { fontSize: 15, lineHeight: 24 },
  qr: { height: 300, borderRadius: 16, backgroundColor: '#111111', alignItems: 'center', justifyContent: 'center', gap: 20, overflow: 'hidden' },
  frame: { width: 180, height: 180 },
  corner: { position: 'absolute', width: 28, height: 28, borderColor: '#ffffff' },
  qrLabel: { fontSize: 14, color: '#b3b3b3' },
  input: { height: 48, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1, fontSize: 15 },
  row8: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  row8top: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  wrap6: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tag: { height: 26, paddingHorizontal: 10, borderRadius: 6, justifyContent: 'center' },
  badge: { width: 56, height: 56, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  kv: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 52, paddingHorizontal: 16 },
});
