# Spec: Android app (Expo)

The phone client for the gateway. Screens come from the design canvas https://claude.ai/artifact/52N14tD35LXvidZmh8Wxnp (8 artboards under `project/`: Main 메모, Chat 질문, Activity 기록, Share 공유 시트, Onboarding 첫 실행, Settings 설정, MemoDetail 메모 상세, MoveSheet 도메인 옮기기). Decisions: `docs/design/설계.md` (앱 UI, 앱 연결, 확신 낮은 분류 rows), `docs/design/요구사항-QR페어링.md`, `요구사항-확인대기.md`, `앱-실패문구.md`. Gateway contract: `src/api.ts`, `docs/pairing.md`, `docs/spec-hold.md`, `docs/spec-memos.md`.

## Where and how

- Lives in `app/` inside this repo. Expo (current stable SDK), expo-router, TypeScript. Wire types come from `../src/api.ts` with `import type` only, so Metro never bundles server code.
- Android only. Built locally with Gradle (`npx expo prebuild` then `./gradlew assembleRelease`, signed with a local keystore kept out of git). No EAS.
- Toolchain on this Mac: `JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home`, `ANDROID_HOME=/opt/homebrew/share/android-commandlinetools` (platform-tools, emulator, android-35, build-tools 35, arm64 system image installed), AVD `llmwiki_test`.
- Plain HTTP to the Tailscale address, so cleartext must be allowed (`expo-build-properties`).

## Data first

```ts
// expo-secure-store. Parsed from the QR (PairingPayload, v must be 1) or manual entry.
type Pairing = { url: string; token: string; server: string };

// expo-sqlite. The outbox is the only local state that matters: a memo is saved the moment it lands here.
type OutboxRow = {
  id: string;            // client UUID, also the POST idempotency key
  body: string;          // MemoRequest JSON, frozen at capture
  created_at: string;
  attempts: number;
  state: 'queued' | 'dead';
  last_error: string | null;
};
```

- **Capture** builds the `MemoRequest` once: `id` from `expo-crypto` `randomUUID`, `captured_at` with the local offset, `tz` from `Intl` (fallback `Asia/Seoul`), `source`, optional `domain_hint`. Location is attached only if it arrives within ~3 s (`getLastKnownPositionAsync` first). Location never blocks the save.
- **Flush** is one function with one transition table. 2xx removes the row. Network error, timeout, 408, 429 or 5xx keeps it `queued` with backoff. 401 pauses every flush and sends the user to re-pair. Any other 4xx marks the row `dead` with the error, shown in the app. Triggers: after enqueue, app foreground, network change, and a timer while foregrounded. One flush runs at a time.
- **Recent memos** shown in the app = outbox rows (labelled 전송 대기) merged with `GET /memos`, deduped by id.
- **Chat** keeps `session_id` per target in memory for the screen's life. The SSE body is read as a stream (`expo/fetch` supports streaming responses); parse frames per `ChatFrame`. "답 저장" posts `/answers`; "기억해" posts a memo with `source: 'chat'` and the chat's domain as `domain_hint`.
- **Failure copy** maps `failure.code` exactly per `앱-실패문구.md`.

## Screens

Match the artboards: layout, copy, spacing. Use the Obsidian default theme in both dark and light, following the system setting. No domain colors. The app opens straight into memo input with the keyboard up.

- 첫 실행: QR scan (`expo-camera` barcode scanning) plus manual entry. Confirm with `GET /status` and show the domain count and names. Show the two failure messages from the requirement (QR vs manual; connection failure vs 401).
- 메모 tab: input, optional domain hint, send. Recent memos with their state (전송 대기, 받음, 확인 필요, 정리 대기, 정리 중, 정리됨, 실패).
- 질문 tab: target picker (domain or 전체), streaming answer, cited pages, 답 저장, 기억해.
- 기록 tab: header "정리 중 N · 확인 M" from `/status`. 확인이 필요해요 cards from `/held` with 맞아요 / 다른 곳으로. Memo list from `GET /memos`, grouped by date, paged with `next_before`.
- 메모 상세 from `GET /memos/:id`. The move button appears only for `held` and `failed`.
- 도메인 옮기기 sheet: `POST /memos/:id/move`. A move can take minutes when it waits for that domain's lane, so show progress and allow leaving.
- 설정: connection info, re-pair, dead outbox rows with retry or delete.
- 공유: receiving shared text (`expo-share-intent` or the official equivalent) opens a compose sheet prefilled with `source: 'share'`. Text selection: a config plugin adds a `PROCESS_TEXT` activity that opens the same sheet with `source: 'selection'`.

## Verification

- Unit tests (jest) for the outbox transition table, pairing parse, capture time formatting, SSE frame parsing, failure copy.
- On the emulator, with a release build, against a **test gateway**: a second gateway process on this Mac pointed at a copy of the wiki (`WIKI_ROOT=<copy>`, `HOST=127.0.0.1`, its own `PORT` and token; the emulator reaches it at `10.0.2.2`). Never pair the emulator with the live gateway. Walk every screen: pair by manual entry, send a memo and watch it reach 정리됨, send one while the gateway is stopped and watch it flush after restart, chat two turns and save an answer, confirm and move a held memo (make one by sending with a classifier result below threshold, or by writing a hold file in the copy), open a failed memo's detail. Screenshot each screen in dark and light (`adb exec-out screencap -p`) and compare against the artboards.
- QR scanning cannot be exercised on the emulator camera. Cover it with a unit test of the decode-to-Pairing path and leave the real scan to the phone.
- Deliverable: the release APK path, and its sha256.
