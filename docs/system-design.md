---
id: system-design
kind: design
title: 시스템 공통 설계
version: 4
status: draft
---

# 시스템 공통 설계

여러 기능이 함께 쓰는 결정을 모은다. 기능별 설계는 이 문서의 섹션을 `refs`로 참조한다.

## S1. 비기능 요구사항 {#s1}

| 항목 | 요구 |
|---|---|
| 동작 환경 | Windows / macOS 데스크톱. GitHub Releases로 배포 |
| 오프라인 | GitHub 연동을 제외한 모든 기능이 네트워크 없이 동작 |
| 원본 | md 파일이 유일한 원본. 앱 내부 저장소는 모두 재생성 가능한 캐시 |
| 응답성 | 문서 1,000개 기준, 프로젝트 열기 3초 이내, 인덱스 증분 갱신 1초 이내 |
| 안전성 | 앱은 사람의 확인 없이 원본 md·외부 파일을 덮어쓰지 않음 |
| 사용자 | 1인 (동시 편집 고려 안 함) |

## S2. 규모 산정 {#s2}

1인 사용 기준 추정치. 이 규모를 넘으면 S4의 인덱스 방식을 재검토한다.

| 대상 | 예상 규모 |
|---|---|
| 도메인 | 10~100개 |
| 기능 명세 표 | 도메인 수와 동일, 표당 기능 5~50개 |
| 수용 기준 | 수백~수천 개 |
| 설계 문서 | 수십~수백 개 |
| Task | 수백~수천 개 (누적) |
| 세션 | 하루 수 개~수십 개, 세션당 수 MB |
| ChangeSet | 문서당 수십 개 (누적, 삭제 없음) |

## S3. 전체 구조 {#s3}

```
┌───────────────────────────── 데스크톱 앱 ─────────────────────────────┐
│  UI (표 편집, 그래프, 확인 화면, 알림)                                   │
│        │                                                              │
│  애플리케이션 계층: 도메인별 서비스 (Domain Modeling, Spec, Design ...)    │
│        │                    ▲                                         │
│        ▼                    │ 도메인 이벤트 (S6)                        │
│  ┌──────────────┐    ┌──────────────┐    ┌───────────────────┐        │
│  │ md 저장소     │───▶│ 인덱스 (캐시) │    │ Integration 어댑터 │        │
│  │ 읽기/쓰기     │    │ 노드·링크·상태 │    │ GitHub / 에이전트 /│        │
│  └──────┬───────┘    └──────────────┘    │ 테스트 실행기      │        │
│         │ 파일 감시                       └───────────────────┘        │
└─────────┼─────────────────────────────────────────────────────────────┘
          ▼
   <프로젝트>/.orbit/*.md   (git으로 이력 관리)
```

- 기술 스택(데스크톱 셸, UI 프레임워크, 인덱스 저장소)은 미정. S7에서 결정한다.

## S4. 데이터 폴더와 파일 형식 {#s4}

```
<프로젝트>/.orbit/
  project.md              프로젝트 설정
  domain-model.md         전체 지도 (도메인 트리, 관계, 결정 사항)
  system-design.md        시스템 공통 설계
  domains/
    <도메인 폴더>/         도메인 하나 = 폴더 하나 (계층 없이 나열)
      domain.md           1층: 역할 (parent로 상위 도메인 표기)
      spec.md             2층: 기능 명세 표
      design/<기능ID>.md   3층: 기능별 설계 (필요할 때만)
  verification/           AC–테스트 연결 확인 기록, 실행 이력 요약
  changes/                ChangeSet (1건당 1파일, 추가만 함)
  reviews/                Impact Review
  inbox/                  분류 전 할 일
  tasks/                  Task
  drift/                  Drift 검토 회차
  knowledge/              지식
  .cache/                 인덱스, 테스트 결과 원본 (git 제외)
```

- **도메인 폴더는 중첩하지 않는다.** 하위 도메인도 `domains/` 바로 아래에 두고, 상위는 `domain.md`의 `parent`로만 표현한다. 하위 도메인을 다른 상위로 옮겨도 폴더는 그대로다.
- 폴더 이름은 생성 시 정해지고 바꾸지 않는다 (`id`와 같은 취급). 표시 이름은 `title`로 바꾼다.
- 이 저장소의 `docs/`도 같은 구조를 따른다.

**공통 frontmatter**

| 필드 | 필수 | 설명 |
|---|---|---|
| `id` | O | 불변 식별자. 종류 접두어 + 짧은 이름 (`dom-order`, `spec-order`, `task-0042`) |
| `kind` | O | `domain` / `concept` / `spec` / `design` / `task` / `inbox` / `knowledge` / `review` / `change` / ... |
| `title` | O | 표시 이름. 바꿔도 `id`는 유지 |
| `version` | 버전 대상만 | 정수. 저장 시 1씩 증가 |
| `basedOn` | 아래 층 문서만 | 기준 대상과 버전 목록 |
| `links` | - | 기타 링크 (`{ type, to }`) |

**기준(basedOn) 표기**

```yaml
# 기능 명세 표 → 도메인
basedOn:
  - { ref: dom-order, version: 3 }

# 기능별 설계 → 기능 (+ 공통 설계 참조)
basedOn:
  - { ref: spec-payment, feature: PAY-F02, version: 5 }
refs:
  - { ref: system-design, section: s4, version: 2 }
```

## S5. 변경 기록 (ChangeSet) {#s5}

- 버전 대상 문서를 저장할 때마다 `changes/`에 파일 1개를 추가한다. 기존 파일은 고치지 않는다.
- 내용: 대상 id, 이전/새 버전, 변경 크기(`major` / `minor`), 요약, 출처, 바뀐 하위 항목(기능 ID, AC ID, 섹션 id).
- 저장할 때 이전/새 본문 스냅샷을 `changes/snapshots/`에 함께 저장하고, 비교는 이 스냅샷만 쓴다. git은 쓰지 않는다.

```yaml
---
id: chg-20261012-0007
kind: change
target: spec-payment
from: 4
to: 5
size: major
summary: 가챠 천장 횟수 90 → 80
source: manual
changed: [PAY-F02, PAY-F02-AC1]
---
```

## S6. 도메인 이벤트 {#s6}

도메인 사이 연결은 앱 내부 이벤트로 한다. 이벤트는 저장 직후 발행되고, 앱을 다시 열 때는 `changes/`를 읽어 처리되지 않은 이벤트를 재생한다.

| 이벤트 | 발행 | 구독 |
|---|---|---|
| `DomainChanged` | 도메인 | 확인표시 |
| `SpecChanged` | 기능 명세 | 확인표시, 테스트 |
| `DesignChanged` | 설계 | 확인표시 |
| `TestRunCompleted` | 테스트 | 기능 명세(검증 상태 열), 관계도 |
| `FilesChanged` | 프로젝트 | 관계도 (인덱스 갱신) |

## S7. 기술 결정 {#s7}

| 항목 | 결정 | 이유 |
|---|---|---|
| 데스크톱 셸 | **Electron** (electron-vite) | Rust·C++ 빌드 도구 없이 md 읽기·쓰기, 파일 감시, 테스트 프로세스 실행을 TypeScript 하나로 처리 |
| UI | React + TypeScript | |
| 인덱스 | 메모리 (매번 md에서 계산) | S2 규모에서 충분. 느려지면 SQLite 캐시 검토 |
| md 파싱 | gray-matter | frontmatter + 본문 |
| 파일 감시 | chokidar | WS-F05 |
| 그래프 렌더링 | Cytoscape.js | 전체 / 로컬 / 계층(breadthfirst) 보기 |
| 테스트 결과 | JUnit XML (fast-xml-parser) | 언어·도구와 무관 (D6) |
| 배포 | electron-builder + GitHub Releases, electron-updater 자동 업데이트 | `v*` 태그 push → `.github/workflows/release.yml` |

**코드 구조**

| 위치 | 역할 |
|---|---|
| `src/core/` | 도메인별 로직. Electron에 의존하지 않아 테스트로 바로 검증 (`tests/`, 테스트 이름에 AC ID) |
| `src/main/` | Electron 메인: IPC(`api:<이름>`), 파일 감시, 테스트 실행, 알림, 전역 단축키 |
| `src/renderer/` | React 화면 |

## S8. 앱 기반 도메인과 코드 위치 {#s8}

기술 기능은 상위 도메인 **앱 기반** 아래 하위 도메인으로 둔다 (도메인 모델 원칙 8).

| 도메인 | 코드 |
|---|---|
| 앱 기반 | 화면 이동 `src/renderer/src/App.tsx`, 알림 규칙 `src/core/notify.ts`, 알림·단축키·자동 업데이트 `src/main/index.ts` |
| └ 프로젝트 | `src/core/workspace.ts`, 파일 감시 `src/main/index.ts` |
| └ 관계도 | `src/core/graph.ts`, 화면 `src/renderer/src/pages/Graph.tsx` |
| └ 연동 | 세션 읽기 `src/core/drift.ts`, 테스트 실행 `src/main/api.ts` |
