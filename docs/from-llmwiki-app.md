# llmwiki-app에서 dotoriwiki로

dotoriwiki는 llmwiki-app과 같은 엔진입니다. 달라진 것은 엔진이 무엇을 가정하느냐입니다. llmwiki-app은 작성자 한 사람의 위키를 가정하고 그 위키의 사실을 코드에 적어 두었습니다. 도메인 이름, 시간대, 언어가 그런 사실입니다. dotoriwiki는 그 사실을 위키 쪽으로 옮겼습니다. 이제 위키가 자기 설명을 들고 다니고, 코드는 그 설명을 읽습니다.

이 문서는 llmwiki-app `5d47cf7`과 dotoriwiki P3 완료 시점(`4c237fc`)을 비교합니다.

## 그대로인 것: 메모가 위키가 되는 길

메모는 먼저 `inbox/`에 파일로 떨어집니다.

```mermaid
flowchart LR
  app[앱 / HTTP / MCP] --> inbox[inbox/]
```

분류기가 메모를 읽고 도메인 하나를 고릅니다.

```mermaid
flowchart LR
  app[앱 / HTTP / MCP] --> inbox[inbox/]
  inbox --> classify[분류기] --> domain["&lt;domain&gt;/raw/"]
```

도메인마다 작업을 하나씩 순서대로 처리합니다. 매번 `claude -p`가 `wiki/` 페이지를 고치고, 게이트웨이가 log.md에 한 줄을 남기고 커밋합니다.

```mermaid
flowchart LR
  app[앱 / HTTP / MCP] --> inbox[inbox/]
  inbox --> classify[분류기] --> domain["&lt;domain&gt;/raw/"]
  domain --> ingest["claude -p ingest"] --> wiki["&lt;domain&gt;/wiki/ + log.md"] --> commit[git commit]
```

이 흐름과 이 흐름을 지키는 장치는 두 저장소가 같습니다. 도메인별 직렬 처리, inflight 마커, 재시도 3회, `.gateway/lock`, 사진 원본은 커밋하지 않는 `_originals/`가 그런 장치입니다. llmwiki-app에서 P0 이후에 생긴 기능도 dotoriwiki에 손으로 옮겼습니다. 채팅 세션, 사진과 EXIF, Claude Code 플러그인이 그것이고, `5d47cf7`까지 반영했습니다.

## 바뀐 것 1. 위키의 설정이 코드에서 `dotoriwiki.yaml`로

llmwiki-app은 위키에 대한 사실을 네 곳에서 따로 알아냈습니다.

| 사실 | llmwiki-app이 알아내던 곳 |
| --- | --- |
| 도메인 목록 | 루트 `CLAUDE.md`의 `도메인 목록` 표. 게이트웨이가 이 한국어 제목을 찾아 읽었습니다 |
| 페이지 종류 | 도메인 `CLAUDE.md`의 `페이지 종류` 표 |
| 분류 실패 시 갈 곳 | `src/main.ts`의 `fallbackDomain: '일상'` |
| 피드가 들어갈 도메인과 시간대 | `src/feeds.ts`의 `'개발소식지식베이스'`, `'Asia/Seoul'`. `mcp.ts`에도 시간대가 따로 있었습니다 |
| 도메인별 모델 | `models.json`의 `edit.byDomain`. 도메인 이름을 키로 썼습니다 |

그래서 다른 사람이 쓰려면 한국어 제목을 똑같이 맞추고, `일상` 폴더를 만들고, 코드를 고쳐야 했습니다.

dotoriwiki에서는 이 사실이 모두 위키 루트의 `dotoriwiki.yaml` 한 파일에 있습니다.

```mermaid
flowchart LR
  subgraph before[llmwiki-app]
    A1["CLAUDE.md 한국어 표"] --> G1[게이트웨이]
    A2["main.ts '일상'"] --> G1
    A3["feeds.ts 도메인, 시간대"] --> G1
  end
  subgraph after[dotoriwiki]
    Y["dotoriwiki.yaml"] --> P["parseWikiConfig"] --> G2[게이트웨이]
  end
```

이 파일은 요청마다 다시 읽습니다. 그래서 고치면 재시작 없이 바로 반영됩니다. 파일이 잘못되면 게이트웨이는 죽지 않고 멈춤(paused) 상태가 됩니다. 메모는 계속 `inbox/`에 받고, 분류와 ingest만 쉬고, `/status`가 고칠 키를 하나씩 알려줍니다. 사용자가 손으로 고친 설정은 게이트웨이가 `manual(config)`로 커밋합니다.

모델 선택은 도메인 이름 대신 프로필 이름을 씁니다. `models.json`에 `edit.profiles`를 두고, 도메인이 `model_profile`로 그중 하나를 고릅니다. 도메인 이름은 위키의 사실이고 모델은 머신의 사실이라서, 두 파일이 서로의 이름을 알 필요가 없게 한 것입니다.

설계와 근거는 `docs/design/wiki-config.md`에 있습니다. 작성자 위키처럼 옛 표를 쓰는 위키는 `scripts/migrate-config.ts`로 한 번 변환합니다.

## 바뀐 것 2. 한국어가 코드에서 언어별 파일로

llmwiki-app의 `src/`에는 한국어 줄이 13개 파일에 113줄 있었습니다. 프롬프트, index.md 제목, 커밋 메시지, log.md 단어가 모두 코드 안의 한국어 문자열이었습니다. 영어 사용자가 써도 모든 출력이 한국어로 나왔습니다.

dotoriwiki는 이 글자를 두 종류로 나눴습니다.

**사람이나 모델만 읽는 글자.** 프롬프트, index.md, `_review.md`, 커밋 메시지, 자막 sidecar, 피드 메모가 여기에 속합니다. 이 글자는 `src/wiki/text.ko.ts`와 `text.en.ts`로 옮겼습니다. 둘 다 `Text` 타입을 따르기 때문에 번역이 빠지면 `tsc`가 실패합니다. 위키의 `locale`이 어느 쪽을 쓸지 정합니다.

**코드가 다시 읽는 글자.** log.md의 `실패 1/3`, `포기 3/3`, `새 페이지` 같은 단어입니다. log.md는 기록이면서 게이트웨이의 상태 저장소입니다. 게이트웨이는 메모의 줄을 다시 읽어 그 메모가 처리됐는지 계산합니다. 그래서 이 단어는 번역 파일에 두지 않고 파서 옆 `LEDGER_WORDS`에 둡니다.

```mermaid
flowchart LR
  job[작업 결과] -->|"위키 locale 단어로 쓰기"| log[log.md]
  log -->|"모든 locale 단어 표로 읽기"| meaning["고정 의미<br/>failed, gave-up, created ..."] --> state[메모 상태]
```

쓸 때는 그 위키의 언어 하나로 씁니다. 읽을 때는 모든 언어의 단어를 담은 표 하나로 읽습니다. 그래서 한국어 위키의 log.md는 llmwiki-app이 쓰던 것과 바이트 단위로 같습니다. 작성자 위키의 작업 305개를 옛 파서와 새 파서로 읽었을 때 결과가 다른 작업은 0개였습니다.

모델의 판정도 바뀌었습니다. 예전에는 모델이 `새 페이지` 같은 한국어로 답했고, 그 글자가 그대로 log.md와 앱 화면에 갔습니다. 지금은 `created`, `updated`, `conflict`, `unchanged` 중 하나로 답하고, 목록 밖의 답은 그 시도를 실패로 처리합니다. 앱 응답에는 화면용 `verdict` 글자를 그대로 두고 `verdict_id`를 더했습니다.

`src/`에 남은 한국어는 17줄입니다. 읽기 표의 한국어 단어, 메모 링크 라벨, 주석의 예시 이름이 전부입니다. 설계는 `docs/design/locale.md`에 있습니다.

## 바뀐 것 3. 위키를 만드는 방법

llmwiki-app에는 위키를 새로 만드는 방법이 없었습니다. 작성자의 위키가 이미 있었고, 설치 스크립트 `install-launchd.sh`가 그 경로를 기본값으로 가정했습니다. 테스트는 테스트 전용 fixture 위키를 썼습니다.

dotoriwiki는 프리셋에서 시작합니다.

```mermaid
flowchart LR
  preset["presets/en 또는 presets/ko"] --> init["init"] --> wiki["새 위키 + 첫 커밋"]
```

`init`은 프리셋을 복사하고, 시간대를 이 머신 값으로 채우고, `git init`과 첫 커밋을 합니다. 그리고 게이트웨이가 쓸 머신 env 파일을 만듭니다.

```mermaid
flowchart LR
  preset["presets/en 또는 presets/ko"] --> init["init"] --> wiki["새 위키 + 첫 커밋"]
  init --> env["~/.config/.../gateway.env<br/>WIKI_ROOT, 토큰, 포트"]
  wiki --> doctor["doctor"]
  env --> doctor
```

`doctor`는 읽기만 하면서 이 머신과 위키가 준비됐는지 점검합니다. Node, git, env 파일, 위키 설정, 도메인 `CLAUDE.md`, `models.json`, `claude` CLI, 사진 축소 도구를 봅니다. 위키 검사는 게이트웨이가 위키를 열 때(`openWiki`) 하는 검사와 같은 코드(`checkWiki`)입니다. 그래서 두 검사가 서로 다른 판정을 내리지 않습니다.

프리셋은 테스트 fixture이기도 합니다. 테스트가 프리셋으로 위키를 만들기 때문에, 프리셋이 깨지면 테스트가 먼저 실패합니다. 진짜 `claude`를 쓰는 `scripts/e2e.ts`도 이제 작성자 위키가 아니라 `init`으로 새로 만든 위키에서 돕니다.

## 바뀐 것 4. 머신 설정이 한 곳으로

코드, 위키, 머신 설정이 서로 다른 곳에 사는 구조는 llmwiki-app에도 있었습니다. 다만 머신 설정의 경로와 규칙이 `main.ts`, `pair.ts`, 설치 스크립트에 흩어져 있었습니다.

```mermaid
flowchart TB
  code["코드 저장소<br/>게이트웨이 + 앱"]
  wiki["위키 저장소<br/>WIKI_ROOT, dotoriwiki.yaml"]
  machine["머신 설정<br/>gateway.env, models.json"]
  code -->|읽음| wiki
  code -->|읽음| machine
```

dotoriwiki는 머신 쪽 규칙을 `src/machine.ts` 하나에 모았습니다. env 파일 경로, `loadConfig`, env 파일 형식, 게이트웨이 커밋 작성자가 여기에 있습니다. 토큰, 포트, 실행 파일 경로는 위키에 절대 들어가지 않습니다. 위키는 git으로 다른 머신에 옮겨도 그대로 동작해야 하기 때문입니다.

## 파일 지도

| dotoriwiki에 새로 생긴 것 | 하는 일 |
| --- | --- |
| `src/wiki/config.ts` | `dotoriwiki.yaml`을 `WikiConfig`로 파싱하고 문제를 모두 모아 알려줌 |
| `src/wiki/text.ts`, `text.ko.ts`, `text.en.ts` | 사람과 모델이 읽는 글자의 언어별 템플릿 |
| `src/wiki/ledger.ts`의 `LEDGER_WORDS` | 코드가 다시 읽는 log.md 단어. 배포 후 바꾸지 않음 |
| `src/machine.ts` | 머신 설정의 경로와 형식 |
| `src/init.ts`, `src/doctor.ts`, `src/cli.ts` | 위키 만들기와 점검 |
| `presets/en`, `presets/ko` | 새 위키의 출발점이자 테스트 fixture |
| `scripts/migrate-config.ts` | 옛 표를 `dotoriwiki.yaml`로 한 번 변환 |
| `scripts/ledger-audit.ts`, `legacy-ledger.ts` | 옛 파서와 새 파서가 같은 위키를 같게 읽는지 확인 |
| `scripts/check-private.ts` | 개인 정보 패턴이 저장소와 기록에 없는지 확인 |
| `docs/design/`, `docs/plan.md`, `docs/cli.md` | 설계 근거, 단계 계획, 사용법 |

| 없어진 것 | 대신 |
| --- | --- |
| `listDomains`, `도메인 목록` 표 읽기 | `dotoriwiki.yaml`의 `domains` |
| `fallbackDomain: '일상'` | `fallback_domain` |
| `feeds.ts`, `mcp.ts`의 `Asia/Seoul`과 피드 도메인 | `time_zone`, `feeds` |
| `models.json`의 `edit.byDomain` | `edit.profiles`와 도메인의 `model_profile` |
| `test/fixture/wiki` | `presets/ko` |

## 아직 같은 것과 남은 차이

아직 llmwiki-app과 같은 것도 있습니다. 패키지 이름, 설정 디렉터리 `~/.config/llmwiki`, LaunchAgent 이름, 플러그인 이름이 아직 `llmwiki`입니다. 이름 변경은 P4에서 `src/machine.ts`와 설치 스크립트 두 곳만 고치면 되게 모아 두었습니다. 앱의 패키지 id와 화면 언어는 P6입니다.

두 저장소의 관계는 P8에서 끝납니다. 그때까지 llmwiki-app에 생기는 변경은 dotoriwiki로 손으로 옮깁니다. P8에서 작성자의 실제 위키가 dotoriwiki 게이트웨이로 넘어갑니다. 한국어 log.md가 바이트 단위로 같기 때문에, 그 과정에서 두 게이트웨이가 같은 위키를 번갈아 읽어도 상태가 어긋나지 않습니다.
