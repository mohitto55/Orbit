# Girsktop

도메인 모델, 기능 명세, 설계, 테스트, 나중에 할 일을 한곳에서 관리하는 데스크톱 앱. Claude Code / Codex 작업 대화를 읽어 도메인 모델과 비교할 수 있다.

위 층 문서가 바뀌면 아래 층에 **확인표시**를 띄워, 도메인과 명세와 코드가 서로 어긋나지 않게 한다.

```
도메인 (역할) ──기준──▶ 기능 명세 표 (요구사항 + AC) ──기준──▶ 설계
                               │
                               └──검증──▶ 테스트 (이름에 AC ID)
```

## 설치

[Releases](../../releases)에서 운영체제에 맞는 파일을 받는다.

| OS | 파일 |
|---|---|
| Windows | `Girsktop-Setup-x.y.z.exe` |
| macOS | `Girsktop-x.y.z.dmg` |
| Linux | `Girsktop-x.y.z.AppImage` |

설치 후에는 새 버전이 나오면 자동으로 업데이트된다.

## 주요 기능

| 화면 | 하는 일 |
|---|---|
| 도메인 | 도메인 트리 (하위 도메인의 상위는 하나), 도메인별 역할·용어, 기능 명세 표, 기능별 설계, 변경 이력 |
| 확인표시 | 큰 변경으로 생긴 확인표시를 위 층 변경 내역과 나란히 보고 `변경 불필요` / `수정 필요` / `보류` 처리 |
| 할 일 | 빠른 기록(Inbox, `Ctrl+Shift+Space`) → 유형·시기를 붙여 Task로. 기한·트리거가 되면 알림 |
| 테스트 | 테스트 명령 실행, JUnit 결과를 AC 단위로 표시 (통과 / 실패 / 테스트 없음 / 확인 필요) |
| 작업 대화 | 주기적으로 Claude Code / Codex 대화와 도메인을 나란히 보여주고, 사람이 표시한 부분을 도메인 변경 요청·할 일·지식으로 넘김 |
| 지식 | 결정(ADR), 프로젝트 용어, 컨벤션, 교훈 |
| 관계도 | 문서를 노드로, 관계를 링크로. 전체 / 로컬 / 계층 보기, `[[이름]]` 링크와 미정의 노드 |

## 데이터

모든 데이터는 프로젝트 안의 md 파일이다 (`.girsktop/`, 또는 `docs/domains/`가 있으면 `docs/`). git으로 이력이 남고, 앱의 인덱스는 언제든 다시 만들 수 있는 캐시다.

```
.girsktop/
  project.md          설정
  system-design.md    시스템 공통 설계
  domains/<도메인>/    domain.md · spec.md · design/<기능ID>.md
  changes/            변경 기록 (추가만 함)
  features/<앱 기능>/  spec.md (도메인이 아닌 기술 기능)
  reviews/ inbox/ tasks/ drift/ knowledge/ requests/ verification/
```

이 저장소의 [`docs/`](docs/domain-model.md)는 Girsktop 자신을 Girsktop으로 관리한 데이터 폴더다.

## 테스트와 AC 연결

테스트 이름에 검증하는 수용 기준 ID를 붙이면 앱이 연결을 찾는다.

```ts
it('[TK-F03-AC2] 유형이나 시기가 없으면 Task로 저장되지 않는다', ...)
```

프로젝트 설정의 테스트 명령은 JUnit XML을 만들어야 한다. 예: `npx vitest run --reporter=junit --outputFile.junit=test-results/junit.xml`

## 개발

```bash
npm install
npm run dev         # 개발 모드 실행
npm test            # 핵심 로직 테스트
npm run typecheck
npm run dist        # 현재 OS용 설치 파일 (release/)
```

릴리스: `v*` 태그를 push하면 GitHub Actions가 세 OS용 설치 파일을 만들어 Releases에 올린다.

```bash
git tag v0.1.0 && git push origin v0.1.0
```

구조: `src/core` (md 기반 도메인 로직, Electron 의존 없음) · `src/main` (Electron 메인, IPC, 파일 감시, 테스트 실행) · `src/renderer` (React 화면).
