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
| `stt` (예정) | 네이티브 바이너리·모델 파일이 필요해 플러그인이 실어 나를 수 없음 |

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
