# Risu Contextual YouTube BGM v0.4.2

RisuAI의 최근 대화 맥락을 `otherAx` 보조 모델에 보내 BGM 후보를 만들고, 로컬 플레이어가 YouTube Data API로 검색해 재생하는 프로토타입입니다.

RisuAI API v3 샌드박스는 외부 iframe을 허용하지 않으므로 프로젝트가 두 부분으로 나뉩니다.

- `risu-plugin/contextual-youtube-bgm-v0.4.2.plugin.js`: 응답 완료 감지, 대화 맥락 정리, 보조 모델 선곡
- `helper/`: YouTube 검색·재생, 상태 관리, 반복 방지 이력 저장

YouTube 음원을 추출하거나 다운로드하지 않습니다. 공식 Data API 검색 결과와 공식 IFrame Player를 사용합니다.

## 요구 사항

- Node.js 20 이상
- YouTube Data API v3가 활성화된 Google API 키
- `otherAx` 보조 모델이 설정된 RisuAI
- 로컬 도우미 접근이 가능한 RisuAI 데스크톱판 또는 로컬 설치판 권장

## 1. 로컬 플레이어 설정

Windows에서는 프로젝트 폴더의 `start-local-player.bat`을 더블클릭하면 도우미 서버가 실행되고, 준비가 끝난 뒤 인증된 플레이어 페이지가 브라우저에서 자동으로 열립니다. `helper/config.local.json`이 없거나 YouTube API 키가 비어 있는 첫 실행에서는 키를 입력받아 설정 파일에 저장합니다. 이어서 자동재생 제한을 해제한 전용 브라우저로 열지 Y/N으로 한 번 물어보고 선택을 저장합니다. 동시에 임의 생성된 helper token이 들어간 로컬 설치본 `risu-plugin/local/contextual-youtube-bgm-v0.4.2.local.plugin.js`를 생성합니다. 이 폴더는 Git에서 제외되므로 토큰이 public 저장소에 커밋되지 않습니다. 이미 도우미가 실행 중이라면 중복 실행하지 않고 플레이어 페이지만 엽니다. BGM을 사용하는 동안 열린 터미널 창은 닫지 마세요.

- `Y`: Edge 또는 Chrome을 별도 전용 프로필과 `--autoplay-policy=no-user-gesture-required` 옵션으로 실행합니다. 플레이어 카드에 맞춘 약 980×824px 크기의 앱 창으로 열리며, 이 옵션은 해당 전용 프로필에만 사용됩니다.
- `N`: 시스템 기본 브라우저로 엽니다. 브라우저 정책에 따라 첫 곡에서 `소리 재생 허용` 클릭이 필요할 수 있습니다.

선택을 다시 바꾸려면 `helper/config.local.json`의 `browserAutoplayBypass`를 `true` 또는 `false`로 수정합니다. 값을 지우고 BAT을 실행하면 다시 Y/N을 묻습니다.

명령줄에서 같은 기능을 실행하려면 다음을 사용합니다.

```powershell
npm run player
```

최초 실행 시 `helper/config.local.json`이 자동 생성됩니다. 배포 ZIP에는 API 키와 인증 토큰 보호를 위해 이 로컬 설정 파일을 포함하지 않습니다. BAT이 `risu-plugin/local/`에 만든 플러그인 JS에는 로컬 helper token이 들어가므로 그 파일도 다른 사람에게 그대로 공유하지 마세요.

`helper/config.local.json`의 `youtubeApiKey`에 API 키를 입력하거나 환경 변수로 전달합니다.

```powershell
$env:RISU_BGM_YOUTUBE_API_KEY = 'YOUR_KEY'
npm start
```

또는 설정 파일을 직접 편집한 뒤 프로젝트 루트에서 실행합니다.

```powershell
npm start
```

서버는 `127.0.0.1:43127`에만 바인딩됩니다. 터미널에 다음 항목이 표시됩니다.

- Player URL
- Plugin helper URL
- Plugin helper token

Player URL을 일반 브라우저에서 열어 둡니다. 자동재생이 차단되면 플레이어의 `소리 재생 허용` 버튼을 누릅니다.

여러 플레이어 탭이 열려 있어도 가장 최근에 준비된 탭 하나만 활성 플레이어가 됩니다. 이전 탭은 명령과 상태 이벤트에서 제외되므로 서로 다른 탭의 `playing`/`cued` 신호가 섞이지 않습니다.

## 2. RisuAI 플러그인 설치

먼저 `start-local-player.bat`을 한 번 실행한 다음 RisuAI에서 생성된 `risu-plugin/local/contextual-youtube-bgm-v0.4.2.local.plugin.js`를 가져옵니다. 개발 중에는 `Import plugin with hot reload`를 권장합니다. BAT을 다시 실행해 토큰이 바뀐 경우 local 설치본이 갱신되고 hot reload가 이를 반영합니다.

플러그인 인자를 다음처럼 설정합니다.

| 인자 | 값 |
|---|---|
| `helper_url` | `http://127.0.0.1:43127` |
| `helper_token` | 보통 비워 둠(BAT이 JS에 자동 삽입); 원격/수동 설정 시에만 사용 |
| `context_messages` | `6` (허용 범위 3–12) |
| `enabled` | `on` |

플러그인이 요청하는 `replacer` 권한을 허용합니다. 이 권한은 모델 출력이 채팅에 완전히 저장된 시점을 감지하는 데 사용됩니다.

채팅 입력부의 메뉴에서 `Contextual BGM` 버튼을 누르면 제어 창이 열립니다. 여기에서 최근 컨텍스트 메시지 수(3–12, 기본 6), 자동 선곡 사용 여부, 자동 크로스페이드 사용 여부와 길이(1–15초, 기본 5초)를 저장할 수 있고, `아티스트 - 곡명` 형식으로 원하는 곡을 직접 대기열에 넣을 수 있습니다. 현재 곡이 없으면 즉시 재생을 시도하고, 재생 중이면 곡이 끝난 뒤 순서대로 재생합니다. 사용자가 명시적으로 넣은 곡은 자동 선곡용 반복 방지 쿨다운을 적용하지 않습니다.

기본적으로 채팅 화면 오른쪽 위에는 `Now playing: 곡명 - 아티스트` 형식의 한 줄짜리 가로형 플로팅이 표시됩니다. 일시정지하면 같은 곡을 유지한 채 `Paused: 곡명 - 아티스트`로 바뀌고, 크로스페이드 중에는 `Crossfading to: 다음 곡명`을 표시합니다. 곡 재생이 끝나 빈 상태가 되면 접두사 없이 `Waiting...`만 표시합니다. 오른쪽 끝을 위치 기준으로 사용하므로 곡명이 길어지면 오른쪽은 고정된 채 왼쪽으로 늘어납니다. 마우스가 실제로 보이는 플로팅 표면 위에 있을 때 시작한 왼쪽 버튼 드래그만 이동으로 처리합니다. 위치는 오른쪽·위쪽 기준으로 기기에 저장되어 RisuAI를 다시 실행해도 유지됩니다. 이전 버전의 왼쪽 기준 저장값은 처음 불러올 때 자동 변환됩니다. 가운데 버튼·휠 드래그는 무시합니다. 제어 창의 `채팅 화면에 Now Playing 플로팅 표시`를 끄고 설정을 저장하면 제거할 수 있습니다. 이 기능에는 RisuAI의 `mainDom` 권한이 필요합니다.

### 자동 크로스페이드

자동 크로스페이드를 켜면 현재 곡 종료 약 45초 전부터 최근 대화 맥락으로 다음 곡을 한 번 선곡합니다. 수동 대기열에 곡이 있으면 보조 모델을 호출하지 않고 대기열의 첫 곡을 우선 사용합니다. 로컬 플레이어는 두 개의 공식 YouTube IFrame Player를 겹쳐 두고 다음 영상을 음소거 상태로 짧게 준비한 다음, 지정한 마지막 구간에서 기존 곡의 볼륨을 내리고 다음 곡의 볼륨을 올립니다. 크로스페이드가 완료되면 다음 곡이 현재 곡으로 승격되고, 그 곡이 끝나기 전 같은 과정을 반복합니다.

자동 선곡을 꺼도 수동 대기열 곡 사이의 크로스페이드는 동작하지만, 대기열이 비었을 때 보조 모델로 다음 곡을 자동 생성하지는 않습니다. 다음 영상의 자동재생이 브라우저에 차단되거나 프리로드가 늦으면 현재 곡 종료 후 일반 재생으로 전환됩니다. 이 기능은 두 플레이어의 소리 재생이 필요하므로 BAT 첫 실행에서 전용 자동재생 브라우저를 선택하는 것을 권장합니다.

드래그 가능 범위를 직접 바꾸려면 플러그인 파일 상단의 `NOW_PLAYING_DRAG_BOUNDS` 값을 수정합니다. `left`, `top`, `right`, `bottom`은 각 화면 가장자리에서 확보할 여백(px)입니다. 값을 크게 하면 이동 범위가 안쪽으로 좁아지고, 음수로 설정하면 해당 방향으로 화면 밖까지 이동할 수 있습니다. 최초 위치 여백은 바로 아래 `NOW_PLAYING_DEFAULT_OFFSET`에서 바꿀 수 있습니다.

제어 창의 `재생 이력 펼치기`를 누르면 최근 100곡을 최신순으로 볼 수 있습니다.

`보조 모델 선곡 지침`에는 분위기, 장르, 보컬 선호 등 선곡 기준을 자유롭게 작성할 수 있습니다. JSON 스키마, 후보 개수, 반복 차단, 8분 제한과 대화문을 지시로 취급하지 않는 안전 규칙은 플러그인이 별도로 덧붙이므로 편집란에 노출하지 않습니다. 빈 값으로 저장하면 기본 선곡 지침을 사용합니다.

## 동작 규칙

1. AI 응답이 채팅에 저장됩니다.
2. 곡이 없고 다른 선곡 작업도 없을 때만 실행됩니다.
3. 설정한 최근 메시지 3–12개(기본 6개)와 반복 차단 목록을 `otherAx`에 전달합니다.
4. 보조 모델은 실제로 검색 가능한 후보를 최대 5개 반환합니다.
5. 로컬 도우미가 곡·아티스트 이력을 강제로 다시 검사합니다.
6. YouTube 검색 결과도 영상 ID, 정규화된 곡명, 채널 기준으로 검사합니다.
7. `videos.list`로 공개·임베드 허용·지역 제한과 실제 재생시간을 사전 검사하며, 8분 초과 영상은 제외합니다.
8. 제목·설명·태그에 명시적인 Shorts 표식이 있는 영상은 제외합니다. Data API에는 Shorts 전용 판별 필드가 없으므로 표식이 전혀 없는 쇼츠까지 100% 식별할 수는 없습니다.
9. 개인 사용자의 가사·클린 음원 업로드를 먼저 시도합니다. Official Audio/Video, Topic, VEVO, 라이브/공연 영상과 cover·reaction·remix·slowed/reverb 같은 가공 영상은 후순위로 보냅니다. 기본 검색 결과가 소진되면 `아티스트 + 곡명 + lyrics` 검색도 사용합니다.
10. 그래도 플레이어 오류 5/100/101/150이 발생하면 해당 영상을 제외하고 다른 업로드로 자동 전환합니다.
11. 오류 이벤트가 없더라도 15초 안에 재생이 시작되지 않으면 자동으로 다음 후보를 시도합니다.
12. 플레이어가 음소거 해제·볼륨 1 이상 상태에서 실제 재생 위치가 10초 이상 전진한 것이 확인될 때만 재생 이력에 기록합니다.
13. 크로스페이드가 꺼져 있으면 수동 대기열의 다음 곡을 곡 종료 후 재생하고, 대기열이 없으면 `idle`로 돌아갑니다.
14. 크로스페이드가 켜져 있으면 종료 약 45초 전에 수동 대기열 또는 보조 모델 후보를 두 번째 플레이어에 준비하고, 설정한 1–15초 동안 선형 볼륨 크로스페이드를 수행합니다.

## 플러그인 자동 업데이트

RisuAI는 플러그인의 `//@version`과 `//@update-url` 메타데이터를 이용한 자동 업데이트 확인을 지원합니다. `update-url`은 항상 최신 플러그인 JS를 반환하는 공개 URL이어야 하고 CORS 및 HTTP Range 요청을 지원해야 하므로, GitHub 저장소의 raw URL을 사용하는 방식이 가장 간단합니다.

```javascript
//@name contextual_youtube_bgm
//@api 3.0
//@version 0.4.2
//@update-url https://raw.githubusercontent.com/pleia1/Contextual-bgm/main/risu-plugin/contextual-youtube-bgm.plugin.js
```

public 저장소의 고정 배포 파일 `risu-plugin/contextual-youtube-bgm.plugin.js`가 업데이트 확인 주소입니다. 최초 설치는 BAT이 `risu-plugin/local/`에 생성하는 토큰 포함 설치본으로 진행하고, 저장소의 버전 파일과 고정 배포 파일은 항상 토큰 없는 원본으로 유지합니다. v0.4.0부터 플러그인이 삽입된 helper token을 RisuAI의 기기 로컬 플러그인 저장소에도 복사하므로, 원격 업데이트가 토큰 없는 고정 배포 파일로 코드를 교체해도 같은 `@name`을 유지하는 한 로컬 도우미 연결값을 이어받습니다. 새 버전을 배포할 때는 버전 파일과 고정 배포 파일의 코드 및 `//@version`을 함께 갱신해야 합니다. 공식 규격은 [RisuAI Plugin Development Guide](https://github.com/kwaroran/RisuAI/blob/main/plugins.md)의 `@update-url`과 `@version` 항목을 참고하세요.

RisuAI 자동 업데이트는 플러그인 JS만 교체합니다. `helper/` 코드가 바뀐 릴리스에서는 새 프로젝트 ZIP도 받아 로컬 도우미를 함께 교체해야 합니다.

## GitHub 버전 관리

이 폴더에는 `helper/config.local.json`, 재생 이력, `node_modules`를 커밋하지 않도록 `.gitignore`가 포함되어 있습니다. 현재 개발 원격 저장소는 `https://github.com/pleia1/Contextual-bgm.git`입니다. 새 PC에서 수동 연결해야 할 때는 프로젝트 폴더에서 아래 명령을 사용합니다.

```powershell
git init
git add .
git commit -m "Release v0.4.2"
git branch -M main
git remote add origin https://github.com/pleia1/Contextual-bgm.git
git push -u origin main
```

GitHub CLI(`gh`)가 없어도 Git for Windows의 HTTPS 로그인 창으로 인증할 수 있습니다. Codex Cloud까지 연결하려면 Codex에서 GitHub 연결을 허용하고 접근할 저장소를 선택한 뒤, 그 저장소용 Cloud environment를 생성합니다. 로컬 Codex 데스크톱에서는 이 Git 저장소 폴더를 프로젝트로 열면 그대로 커밋·브랜치·diff 작업을 이어갈 수 있습니다.

일시정지, 버퍼링, 로딩, 자동재생 대기 상태도 모두 “곡이 존재하는 상태”로 간주하므로 새 선곡이 시작되지 않습니다. `cued`에서 실제 재생으로 넘어가지 않으면 플레이어가 한 번 더 재생을 시도한 뒤 `소리 재생 허용` 버튼을 표시하며, 응답이 없는 영상은 기존 시작 타임아웃으로 다음 후보를 시도합니다.

## 반복 방지 기본값

- 동일 YouTube 영상: 최근 40곡 및 30일 이내 차단
- 동일 곡의 다른 업로드: 최근 30곡 및 30일 이내 차단
- 동일 아티스트: 최근 8곡 및 7일 이내 차단
- 최대 이력: 500곡

곡과 영상 제한은 강제합니다. 모든 후보가 아티스트 제한에만 걸리면 가장 오래된 아티스트부터 제한을 완화하지만 동일 곡은 계속 차단합니다.

이력은 `helper/data/history.json`에 기기 로컬로 저장됩니다. 플러그인 제어 화면에서 초기화할 수 있습니다.

## 설정 조정

`helper/config.local.json`에서 다음을 변경할 수 있습니다.

- `defaultVolume`: 시작 볼륨 0–100
- `browserAutoplayBypass`: `true`면 자동재생 제한을 해제한 전용 Edge/Chrome 프로필로 플레이어 열기
- `browserWindowWidth`, `browserWindowHeight`: 전용 플레이어 창의 초기 크기(기본 980×824px, 각각 640–3840)
- `recordAfterSeconds`: 재생 이력 확정까지 필요한 연속 재생 시간
- `playbackStartTimeoutSeconds`: 오류 이벤트 없이 로딩에 멈췄을 때 다음 후보로 넘어갈 시간(기본 15초, 5–60초)
- `regionCode`, `relevanceLanguage`: YouTube 검색 지역과 언어
- `policy.*CooldownPlays`: 최근 몇 곡 동안 차단할지
- `policy.*CooldownDays`: 며칠 동안 차단할지
- `policy.maxHistory`: 저장할 최대 이력

쿨다운은 재생 횟수 범위와 날짜 범위에 모두 들어올 때 적용됩니다. 둘 중 하나를 벗어나면 다시 후보가 될 수 있습니다.

## 개발 및 검증

```powershell
npm run check
npm test
```

테스트는 제목·아티스트 정규화, 영상/곡/아티스트 쿨다운, 다른 업로드 감지, 아티스트 제한 완화를 검사합니다.

### 플러그인 디버그 로그

RisuAI 개발자 도구 콘솔에서 `[Contextual YouTube BGM]`으로 필터링하면 응답 감지, 도우미 상태, 보조모델에 전달한 최근 맥락, 원본 모델 응답, 파싱된 후보와 재생 요청 결과를 순서대로 볼 수 있습니다. `auxiliary response envelope`의 `type`이 `fail`이면 보조모델 설정/API 오류이며, `auxiliary response text`에는 실제 JSON 응답이 표시됩니다. 로그에는 최근 대화 맥락이 포함되므로 외부에 그대로 공유할 때 주의하세요.

보조 모델이 `<Thoughts>`나 일반 문장을 JSON 앞에 출력하거나 생각 블록 안에 JSON 스키마 예시를 되풀이해도, 플러그인은 응답에서 `candidates`가 포함된 마지막 유효 JSON 객체를 찾아 사용합니다.

## 로컬 API

모든 `/v1/*` 요청은 `Authorization: Bearer <authToken>` 헤더가 필요합니다.

- `GET /v1/status`
- `GET /v1/history/blocklist`
- `GET /v1/history?limit=100`
- `POST /v1/play-candidates`
- `POST /v1/preload-candidates`
- `POST /v1/crossfade/settings`
- `POST /v1/queue`
- `DELETE /v1/queue`
- `POST /v1/control`
- `DELETE /v1/history`
- `GET /v1/player-command`
- `POST /v1/player-event`

도우미는 `127.0.0.1`에만 열리고 임의 생성 토큰으로 요청을 인증합니다. YouTube API 키와 전체 대화 내용은 도우미로 전달되지 않으며, 도우미는 최종 후보의 아티스트·곡명·검색어만 받습니다.

## 알려진 제약

- YouTube 자동재생 정책에 따라 최초 또는 일부 재생에서 사용자 클릭이 필요할 수 있습니다.
- 크로스페이드는 두 YouTube iframe의 프리로드·재생 타이밍에 의존하므로 네트워크 상태와 브라우저 정책에 따라 완전히 겹치지 않을 수 있습니다. 이 경우 준비된 다음 곡을 일반 방식으로 이어 재생합니다.
- v0.3.2부터 재생 진행 증거가 없는 구버전 이력 항목은 시작 시 폐기됩니다. 실제로 재생되지 않았던 항목이 반복 차단 목록에 남는 문제를 방지하기 위한 한 번의 이력 마이그레이션입니다.
- YouTube 오류 101/150은 해당 업로드가 외부 임베드를 허용하지 않는다는 뜻입니다. 공식 영상 전체가 일괄 차단되는 것은 아니지만 권리자 설정, 플랫폼 정책, Content ID 등으로 Data API의 `embeddable` 사전 검사 이후에도 실제 플레이어에서 거부될 수 있습니다. 도우미는 공식/Topic/VEVO 결과를 후순위로 두고 최대 12개의 실패 영상을 건너뜁니다.
- 보조모델이 앨범·장시간 믹스를 제안하더라도 실제 YouTube 영상 길이가 8분을 넘거나 길이를 확인할 수 없으면 재생하지 않습니다.
- 자동 폴백을 기다리지 않으려면 플러그인 제어 화면이나 로컬 플레이어의 `다음 후보` 버튼을 누를 수 있습니다.
- RisuAI 웹사이트가 HTTPS에서 실행되는 경우 브라우저의 로컬 네트워크 정책 때문에 HTTP 도우미 연결이 막힐 수 있습니다. 데스크톱판 또는 로컬 RisuAI를 우선 권장합니다.
- 플러그인 `0.1.0`에서 상태 조회가 `Invalid body type`으로 실패했다면 `0.1.1` 이상을 다시 가져오세요. RisuAI `nativeFetch`의 기본 POST 동작을 피하도록 모든 로컬 API 메서드를 명시합니다.
- 보조 모델이 존재하지 않는 곡을 제안하면 도우미가 다음 후보를 시도합니다. 모든 후보가 실패하면 다음 AI 응답에서 다시 시도합니다.
- YouTube 검색 API 할당량이 소모됩니다. 한 번의 선곡에서 후보 검색 실패가 많으면 검색 호출 수도 늘어납니다.
