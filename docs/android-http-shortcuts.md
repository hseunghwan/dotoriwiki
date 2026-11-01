# 안드로이드 HTTP Shortcuts 설정

Expo 앱 전까지 쓰는 메모 입력 방법. 폰에 Tailscale이 켜져 있어야 한다.

## 준비

1. F-Droid나 Play 스토어에서 HTTP Shortcuts 설치.
2. 맥미니에서 토큰 확인. `cat ~/.config/dotoriwiki/gateway.env`의 `GATEWAY_TOKEN=` 뒤 값.

## 전역 변수

앱 메뉴의 변수 화면에서 만든다.

| 이름 | 종류 | 설정 |
| --- | --- | --- |
| `shared` | 상수(Static) | "Allow Receiving Value from Share Dialog" 켬. 값은 비워 둠 |
| `body` | 상수(Static) | 값은 비워 둠. 스크립트가 채운다 |
| `token` | 상수(Static) | `GATEWAY_TOKEN` 값 |

## 단축어 "메모"

- 방식 `POST`, URL `http://100.64.0.7:8787/memos`
- 헤더 `Authorization`: `Bearer {token}` (변수 삽입 버튼으로 `token`을 넣는다)
- 본문 종류 Custom, Content-Type `application/json`, 본문은 `{body}` 변수 하나
- 고급 설정에서 "Wait for connection when offline" 켬
- 응답 처리는 "토스트로 표시"
- 스크립트의 "Run before execution"에 아래를 붙여 넣는다

```js
let text = '';
try { text = getVariable('shared'); } catch (e) {}
setVariable('shared', '');
const source = text ? 'share' : 'typed';
if (!text) text = prompt('메모', '', { multiline: true });
if (!text || !text.trim()) abort();

const now = new Date();
const off = -now.getTimezoneOffset();
const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
const local = new Date(now.getTime() + off * 60000).toISOString().slice(0, 19);
const capturedAt = `${local}${off >= 0 ? '+' : '-'}${pad(off / 60)}:${pad(off % 60)}`;

let location = null;
const loc = getLocation();
if (loc.status === 'success') location = { lat: loc.latitude, lon: loc.longitude };

setVariable('body', JSON.stringify({ id: uuidv4(), text, captured_at: capturedAt, tz: 'Asia/Seoul', location, source }));
```

`getLocation()`은 최대 20초쯤 걸릴 수 있다. 전송이 늦게 느껴지면 위치 세 줄을 지운다.

## 붙이는 곳

- 홈 화면 위젯 또는 빠른 설정 타일에 "메모"를 둔다.
- 다른 앱에서 공유하기를 누르고 HTTP Shortcuts의 "메모"를 고르면 공유한 텍스트가 그대로 메모가 된다.
- 텍스트 선택 메뉴에는 직접 나오지 않는다. 선택 후 "공유"를 거친다.

## 확인

맥미니 로그 `~/Library/Logs/dotoriwiki.log`에 `routed`와 `committed` 줄이 생기면 끝까지 처리된 것이다.

## 단축어 "상태" (선택)

`GET http://100.64.0.7:8787/status`, 같은 `Authorization` 헤더, 응답을 대화상자로 표시. 도메인별 대기와 실패 개수가 나온다.
