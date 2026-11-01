# 앱 연결 (QR 페어링)

## 게이트웨이 컴퓨터에서 QR 띄우기

```
dotoriwiki pair
```

QR을 띄우기 전에 그 주소로 `GET /status`를 먼저 호출한다. 실제로 연결되는 주소만 QR에 넣는다. QR 아래에는 연결 확인 결과, 직접 입력용 주소, 토큰 위치가 함께 나온다. `dotoriwiki pair --show-token`으로 실행하면 토큰도 평문으로 보인다.

연결용 웹 페이지는 없다. 게이트웨이는 Tailscale 주소 하나에서만 요청을 받는다. 페이지를 두면 그 주소로 토큰이 노출된다.

## QR 내용

`src/api.ts`의 `PairingPayload`를 JSON으로 직렬화한 값이다.

```ts
type PairingPayload = { v: 1; url: string; token: string; server: string };
```

`url`은 Tailscale MagicDNS 이름을 먼저 쓴다(지금은 `http://my-mac.tail-1234.ts.net:8787`). 그 이름으로 연결되지 않으면 `100.x` 주소를 쓴다.

## 앱의 연결 확인

`GET {url}/status`에 헤더 `Authorization: Bearer {token}`을 붙여 보낸다.

```json
{"server":"0.1.0","inbox":0,"domains":{"개발소식지식베이스":{"pending":0,"held":0,"failed":0,"running":null},"미루기 아카이빙":{},"스터디":{},"일상":{}}}
```

도메인 이름 목록은 `Object.keys(domains)`로 얻는다.

## 실패 구분

| 상황 | 앱이 받는 것 | 안내 |
| --- | --- | --- |
| Tailscale 꺼짐, 서버 꺼짐, 주소 틀림 | 응답 없음. fetch가 reject되거나 타임아웃(5~8초 권장) | QR: "Tailscale이 켜져 있는지 확인하고 QR을 다시 띄워 주세요" / 직접 입력: "주소와 토큰이 맞는지 확인해 주세요" |
| 토큰 틀림 | HTTP 401, `{"error":"unauthorized"}` | "주소와 토큰이 맞는지 확인해 주세요" |
| 다른 서버가 응답 | 401이 아닌 다른 상태 코드, 또는 `server` 필드 없음 | 주소 확인 안내 |
