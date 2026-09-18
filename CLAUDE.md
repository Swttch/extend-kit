# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트 개요

`@swttch/extend-kit` — Swttch가 쓰지만 **플러그인 번들 안에 들어갈 수 없어서** 사용자 머신에 따로 설치되는 도구들의 모음. TypeScript npm 패키지.

## ★ 편입 기준 (이 저장소의 존재 이유)

새 기능을 여기 넣을지 말지는 **"플러그인에 번들링할 수 있는가?"** 하나로 판정한다.

번들링이 불가능한 이유는 지금까지 두 가지다:

| 도구 | 번들링 불가 사유 |
|------|-----------------|
| `battery` | 사용자 머신의 Claude Code 로그인 자격증명(keychain/파일)을 읽어야 함 |
| `stt` | 받아쓰기가 OAuth 토큰을 전송하는데, JetBrains 플러그인은 자격증명을 다룰 수 없음 |

번들링 가능한 기능이면 여기 오면 안 되고, 플러그인 본체에 넣는다.

## 구조

```
src/
├── index.ts        # 전체 배럴. battery의 export를 flat하게 재노출(하위호환)
├── battery/        # Claude Code 계정·사용량 SDK (구 claude-code-battery)
├── stt/            # 음성 입력 (예정, 현재 비어 있음)
├── settings-env.ts # Claude Code 설정파일의 env 블록을 process.env에 적용
└── cli/            # ccb 명령. battery를 호출한다
```

## ★ `ccb` 명령 이름은 바꾸지 않는다

`ccb`는 **사용자가 터미널에 직접 타이핑하고, 플러그인 백엔드가 `Command('ccb', ...)` 로 exec하는 이름**이다. 리브랜딩을 이유로 바꾸면:

- 이미 설치한 사용자의 명령이 사라진다
- 플러그인의 사용량 패널이 `ccb_missing` 으로 죽는다

패키지 이름이 무엇으로 바뀌든 `bin.ccb` 는 유지한다.

## STT 구현 시 알아야 할 것 (실측으로 확인함)

`wss://api.anthropic.com/api/ws/speech_to_text/voice_stream` 는 **미문서 엔드포인트**다. 아래는 붙여서 확인한 실제 동작이며, 문서가 아니라 관찰이다.

1. **오디오 형식이 틀리면 에러가 아니라 무음이다.** `linear16` / 16kHz / mono 가 아니면 조용히 아무것도 안 돌아온다. 디버깅할 때 "연결은 되는데 전사가 없다"면 형식부터 의심할 것.
2. **`TranscriptText` 는 누적 텍스트를 갱신해 보내며, 뒤로 후퇴하기도 한다.** `"Hello. This is a test"` 뒤에 `"Hello."` 가 올 수 있다. 그래서 `pending` 은 **가장 긴 것**을 유지한다. 마지막 값을 쓰면 내용을 잃는다.
3. **`TranscriptEndpoint` 에는 `data` 가 없다.** "여기서 확정"이라는 신호일 뿐이라, 텍스트는 그때까지 모아둔 `pending` 에서 꺼내야 한다.
4. **소켓이 열리기 전 오디오는 버퍼링해야 한다.** `openSpeechToTextStream()` 이 반환된 시점에 소켓은 아직 CONNECTING 이다. 버퍼링 없이 곧바로 `sendAudio` 하면 **첫 문장이 통째로 사라진다**(구현 중 실제로 겪음).
5. **인증은 battery 와 같은 OAuth 토큰**이다. 그래서 두 도구가 같은 패키지에 있는 것이 자연스럽다.

VS Code 확장이 정의한 UX 계약(참고용): `voice.mode` 는 `hold`(기본, 누르는 동안 말하기) / `tap`(눌러서 시작, 다시 눌러 종료+제출), `voice.autoSubmit` 은 hold 에서 떼면 자동 전송.

## ★ 프록시: `fetch` 를 쓰지 않는 이유 (실측으로 확인함)

이 패키지의 바깥 통신은 **전역 `fetch` 를 쓰지 않는다.** `src/battery/api/http.ts` 가 `node:https` 로 요청하고, `src/proxy.ts` 가 만든 agent를 넘긴다. 되돌리지 말 것.

1. **Node의 전역 `fetch` 는 `HTTP_PROXY` 를 무시한다.** 환경변수를 아무리 정확히 넘겨도 요청은 프록시를 타지 않고 직결한다. Node 24에 `NODE_USE_ENV_PROXY=1` 이 생겼지만 **기본이 꺼져 있고, 이 패키지는 Node 20을 지원하며, 그 옵션은 SOCKS를 지원하지 않는다.** 셋 중 무엇 하나만으로도 대안이 못 된다.
2. **`node:https` 를 쓰는 이유는 `ws` 와 프록시 구현을 공유하기 위해서다.** `https.request` 와 `ws` 는 **둘 다 `http.Agent` 를 `agent` 라는 같은 이름으로 받는다.** `fetch` 는 agent를 받지 못하므로, `fetch` 를 유지하면 두 전송 경로에 프록시 구현을 각각 만들어야 한다.
3. **프록시 동작을 "요청이 성공했나"로 검증하면 안 된다.** 목적지에 직접 닿을 수 있는 환경에서는 **프록시를 건너뛰어도 요청이 성공한다.** 그래서 "성공했으니 프록시가 동작한다"는 판정은 항상 참이 되어 아무것도 증명하지 못한다. **프록시 서버가 `CONNECT` 를 받았는지로 판정한다** — `src/battery/api/http.test.ts` 가 실제 CONNECT 프록시를 띄워 그렇게 검증한다.

> 3번은 가설이 아니라 실제로 일어난 일이다. 이 문제를 처음 고친 [Swttch/swttch#432](https://github.com/Swttch/swttch/pull/432) 는 환경변수를 `ccb` 에 정확히 전달했고 테스트도 전부 통과했지만, `ccb` 가 그 변수를 읽지 않아 **사용자에게는 아무것도 바뀌지 않았다.** 테스트가 "환경변수가 전달됐나"만 봤기 때문에 통과한 것이다.

## ★ 설정파일 `env` 블록은 통째로 적용한다 (허용목록 금지)

`src/settings-env.ts` 가 Claude Code 설정파일 네 개의 `env` 블록을 읽어 `process.env` 에 올린다. `src/cli/index.ts` 의 `run()` 첫 줄에서 호출하므로, 그 아래 모든 읽기(프록시·OAuth 토큰·설정 디렉토리)가 `claude` 와 같은 환경을 본다.

**이름을 골라 담지 않는다.** 예전에 플러그인 쪽이 허용목록으로 8개 이름만 전달했고, 그 목록에 없는 이름 때문에 같은 증상이 두 번 났다([Swttch/swttch#181](https://github.com/Swttch/swttch/issues/181) 프록시, [Swttch/swttch#432](https://github.com/Swttch/swttch/pull/432) 소문자 표기). 목록에 이름을 더하는 처방은 다음 제보를 기다리는 일이라 그만뒀다.

### 값 처리 규칙 (`claude` 2.1.261 실측)

설정파일에 여섯 가지 형태를 넣고 자식 프로세스가 받은 값을 확인했다.

| 적은 값 | 자식이 받은 값 | 규칙 |
|---|---|---|
| `"value"` | `value` | 문자열은 그대로 |
| `"pre-${HOME}-post"` | `pre-${HOME}-post` | **치환하지 않는다** |
| `"${UNSET:-fb}"` | `${UNSET:-fb}` | 기본값 문법도 치환하지 않는다 |
| `""` | 빈 값으로 설정됨 | **삭제가 아니다** |
| `1234` | `"1234"` | 숫자는 문자열로 |
| `true` | `"true"` | 참거짓도 문자열로 |

객체·배열·null은 우리가 건너뛴다. `claude` 의 처리는 **미측정**이고, `String({})` 이 `"[object Object]"` 가 되는 쪽이 더 나쁘기 때문이다.

### 우선순위

**`--env=NAME=VALUE` > 설정파일 `env` 블록 > 물려받은 환경변수.**

가운데가 오른쪽을 이기는 것은 `claude` 실측 결과다. 셸에 export한 값과 설정파일 값을 다르게 두고 실행했더니 설정파일 값이 쓰였다.

`--env` 플래그가 따로 있는 이유는, **`FOO=bar ccb` 형태로 앞에 붙인 값과 startup 파일에서 export한 값을 받는 쪽이 구분할 수 없기 때문**이다. 환경변수 자료구조에 출처 정보가 없다. 그래서 "이번엔 이걸 써라"를 말할 수단을 플래그로 따로 뒀다.

### `CLAUDE_CONFIG_DIR` 만 예외다

설정파일의 **위치를 정하는 값**이라 그 파일에서 읽으면 순환이다. `EXCLUDED_NAMES` 에 있고, 환경변수에서만 읽는다. 플러그인도 이 변수만 자기 설정파일에 두고 넘겨준다.

## 하위호환 (claude-code-battery 사용자)

이 패키지는 `claude-code-battery`(월 3천여 다운로드)를 흡수했다. 기존 사용자를 끊지 않기 위해:

- `src/index.ts` 는 battery의 export를 **flat하게** 재노출한다. `import { ClaudeCodeClient } from '@swttch/extend-kit'` 가 예전과 동일하게 동작해야 한다.
- `claude-code-battery` 패키지 자체는 이 패키지를 재노출하는 얇은 껍데기로 남아 있다. 거기의 export 목록을 줄이면 남의 코드가 깨진다.

## 개발 명령어

```bash
npm install          # 의존성 설치
npm run build        # TypeScript 컴파일
npm test             # 테스트 실행 (build 후 dist 기준으로 돈다)
npm run lint         # 타입체크만
```

`npm test` 는 `dist/**/*.test.js` 를 돌리므로 **테스트 전에 build가 필요**하다.

## 표준언어

모든 소통은 **한글**로 진행합니다.
