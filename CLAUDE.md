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
