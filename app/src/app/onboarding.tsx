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
import { copy } from '../text';

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
        <View accessibilityLabel={copy.onboarding.steps(index + 1, 3)} style={st.steps}>
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
      ? copy.onboarding.repairLede
      : copy.onboarding.lede;

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={st.main} keyboardShouldPersistTaps="handled">
        <View style={{ gap: 8 }}>
          <Text style={[st.title, { color: t.fg }]}>{props.repair ? copy.onboarding.repairTitle : copy.onboarding.title}</Text>
          <Text style={[st.lede, { color: t.muted }]}>{lede}</Text>
        </View>

        {!connected && mode === 'qr' && <QrView checking={checking} onScan={(data) => props.onCheck(parseQr(data), 'qr')} />}

        {!connected && mode === 'manual' && (
          <View style={{ gap: 16 }}>
            <Field label={copy.onboarding.address} value={addr} onChange={setAddr} placeholder="my-computer.tail-xxxx.ts.net:8787" keyboardType="url" />
            <Field label={copy.onboarding.token} value={token} onChange={setToken} placeholder={copy.onboarding.tokenPlaceholder} secure onSubmit={() => !checking && props.onCheck(parseManual(addr, token), 'manual')} />
          </View>
        )}

        {connected && (
          <Notice tone="ok">
            <View accessibilityRole="text" style={st.row8}>
              <Icon name="checkCircle" size={18} color={t.okFg} />
              <Text style={{ color: t.okFg, fontSize: 14, fontWeight: '500' }}>{copy.onboarding.found(connected.length)}</Text>
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

        {!connected && mode === 'qr' && <QuietButton label={copy.onboarding.manual} onPress={() => props.onMode('manual')} />}
        {!connected && mode === 'manual' && (
          <View style={{ gap: 8 }}>
            <PrimaryButton
              tall
              label={checking ? copy.common.checking : copy.onboarding.check}
              busy={checking}
              disabled={addr.trim() === '' || token.trim() === ''}
              onPress={() => props.onCheck(parseManual(addr, token), 'manual')}
            />
            <QuietButton label={copy.onboarding.useQr} onPress={() => props.onMode('qr')} />
          </View>
        )}
        {connected && <PrimaryButton tall label={props.repair ? copy.onboarding.done : copy.onboarding.next} onPress={props.onNext} />}
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
    <Pressable accessibilityRole="button" accessibilityLabel={copy.onboarding.scanQr} onPress={live ? undefined : requestPermission} style={st.qr}>
      {live && <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={scanned} />}
      <View style={st.frame}>
        <View style={[st.corner, { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 10 }]} />
        <View style={[st.corner, { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 10 }]} />
        <View style={[st.corner, { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 10 }]} />
        <View style={[st.corner, { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 10 }]} />
      </View>
      <Text style={st.qrLabel}>{checking ? copy.onboarding.reading : live ? copy.onboarding.aimQr : copy.onboarding.tapForCamera}</Text>
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
  return (
    <View style={st.main}>
      <View style={[st.badge, { backgroundColor: t.onBg }]}>
        <Icon name="pin" size={26} color={t.onFg} />
      </View>
      <View style={{ gap: 8 }}>
        <Text style={[st.title, { color: t.fg }]}>{copy.onboarding.locationTitle}</Text>
        <Text style={[st.lede, { color: t.muted }]}>{copy.onboarding.locationLede}</Text>
      </View>
      <View style={{ gap: 12 }}>
        {copy.onboarding.locationPoints.map((p) => (
          <View key={p} style={{ flexDirection: 'row', gap: 10 }}>
            <Icon name="check" size={18} color={t.okFg} />
            <Text style={{ flex: 1, color: t.muted, fontSize: 14, lineHeight: 21 }}>{p}</Text>
          </View>
        ))}
      </View>
      <View style={{ flex: 1 }} />
      <View style={{ gap: 8 }}>
        <PrimaryButton tall label={copy.onboarding.allowLocation} onPress={() => onChoose(true)} />
        <QuietButton label={copy.onboarding.later} onPress={() => onChoose(false)} />
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
        <Text style={[st.title, { color: t.fg }]}>{copy.onboarding.readyTitle}</Text>
        <Text style={[st.lede, { color: t.muted }]}>{copy.onboarding.readyLede}</Text>
      </View>
      <Card>
        <View style={[st.kv, { borderBottomWidth: 1, borderBottomColor: t.line }]}>
          <Text style={{ color: t.muted, fontSize: 14 }}>{copy.onboarding.computer}</Text>
          <Text style={{ color: t.okFg, fontSize: 14 }}>{copy.common.connected}</Text>
        </View>
        <View style={st.kv}>
          <Text style={{ color: t.muted, fontSize: 14 }}>{copy.common.attachLocation}</Text>
          <Text style={{ color: t.fg, fontSize: 14 }}>{location ? copy.onboarding.on : copy.onboarding.off}</Text>
        </View>
      </Card>
      <Text style={{ color: t.faint, fontSize: 13, lineHeight: 21 }}>{copy.onboarding.shareHint}</Text>
      <View style={{ flex: 1 }} />
      <PrimaryButton tall label={copy.onboarding.firstMemo} onPress={() => router.replace('/')} />
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
