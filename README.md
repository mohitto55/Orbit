# Orbit

도메인 모델, 기능 명세, 설계, 테스트, 나중에 할 일을 한곳에서 관리하는 데스크톱 앱. 앱 안 터미널에서 Claude Code / Codex로 작업하고, 그 대화를 도메인 모델과 비교할 수 있다.

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
| Windows | `Orbit-Setup-x.y.z.exe` |
| macOS | `Orbit-x.y.z.dmg` |
| Linux | `Orbit-x.y.z.AppImage` |

설치 후에는 새 버전이 나오면 자동으로 업데이트된다.

## 주요 기능

| 화면 | 하는 일 |
|---|---|
| 도메인 | 도메인 트리 (하위 도메인의 상위는 하나), 도메인별 역할·용어, 기능 명세 표, 기능별 설계, 변경 이력 |
| 변경 검토 | 위 층이 크게 바뀌어 생긴 확인 항목을 위 층 변경 내역과 나란히 보고 `변경 불필요` / `수정 필요` / `보류` 처리 |
| 할 일 | 할 일 추가(Inbox, `Ctrl+Shift+Space`) → 유형·시기를 붙여 Task로. 기한·트리거가 되면 알림 |
| 테스트 | 테스트 명령 실행, JUnit 결과를 AC 단위로 표시 (통과 / 실패 / 테스트 없음 / 확인 필요) |
| 도메인 점검 | 주기적으로 Claude Code / Codex 대화와 도메인을 나란히 보여주고, 사람이 표시한 부분을 도메인 변경 요청·할 일·지식으로 넘김 |
| 지식 | 결정(ADR), 프로젝트 용어, 컨벤션, 교훈 |
| 터미널 | 프로젝트 폴더에서 Claude Code · Codex · 셸을 탭으로 실행. 실행 명령 설정, 이름 변경, 앱 재시작 시 탭·세션 자동 복원 |
| 관계도 | 문서를 노드로, 관계를 링크로. 전체 / 로컬 / 계층 보기, `[[이름]]` 링크와 미정의 노드 |

도메인 그래프의 모델 관계는 참조하는 개념에서 참조 대상 개념으로 직접 이어진다. 소속 도메인이 달라도 애그리거트 루트로 합치지 않으며, 화살표로 방향을 표시한다. 같은 두 개념 사이의 서로 다른 관계와 반대 방향 참조도 각각 유지한다.

터미널은 화면을 옮겨도 실행이 유지된다. Orbit을 종료하면 작업은 중단된다. 앱을 다시 켜면 먼저 프로젝트 폴더 선택 화면이 나오고, 같은 프로젝트를 선택하면 열어 두었던 터미널 탭·이름·선택 상태와 CLI 세션을 자동으로 복원한다. 일반 터미널에서 직접 실행한 Claude Code·Codex도 복원 대상이며, CLI에서 기존 대화를 선택했다면 그 세션으로 재개한다. 대화 목록을 따로 고를 필요가 없고, Orbit은 대화 본문을 가져오지 않는다. CLI가 실행 중이지 않은 일반 셸은 탭과 최근 출력을 복원한다. 사용자가 닫은 탭은 다시 열지 않는다.

이전 버전에서 세션 ID 없이 저장된 일반 터미널 탭은 업데이트 후 CLI에서 한 번 재개해야 한다. 이후부터 해당 세션이 자동으로 복원된다.

작업 그래프의 **세션 불러오기** 목록은 해당 세션에 저장된 이름을 우선 표시한다. 세션을 복원하거나 다른 세션을 불러오면 탭에도 그 이름을 표시한다. 이름이 없는 세션은 기존 표시를 유지한다.

설정의 **터미널**에서 Claude Code·Codex 실행 명령과 대화 재개 명령을 바꿀 수 있다. 재개 명령의 `{sessionId}`는 해당 탭의 세션 ID로 바뀐다. 재개 명령을 비워 두면 실행 명령 뒤에 Claude는 `--resume {sessionId}`, Codex는 `resume {sessionId}`를 붙인다.
Codex 탭은 `--no-daemon`을 지원하는 CLI로 독립 실행하여 각 탭의 세션 ID와 저장 위치를 유지한다.

## 데이터

모든 데이터는 프로젝트 안의 md 파일이다 (`.orbit/`, 또는 `docs/domains/`가 있으면 `docs/`). git으로 이력이 남고, 앱의 인덱스는 언제든 다시 만들 수 있는 캐시다.

```
.orbit/
  project.md          설정
  system-design.md    시스템 공통 설계
  domains/<도메인>/    domain.md · spec.md · design/<기능ID>.md
  changes/            변경 기록 (추가만 함)
  reviews/ inbox/ tasks/ drift/ knowledge/ requests/ verification/
```

이 저장소의 [`docs/`](docs/domain-model.md)는 Orbit 자신을 Orbit으로 관리한 데이터 폴더다.

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
