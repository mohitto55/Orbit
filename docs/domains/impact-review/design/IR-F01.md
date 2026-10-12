---
id: design-IR-F01
kind: design
title: 검토 열기 — 확인 대상 계산
basedOn:
  - { ref: spec-impact-review, feature: IR-F01, version: 1 }
refs:
  - { ref: system-design, section: s4 }
  - { ref: system-design, section: s5 }
  - { ref: system-design, section: s6 }
version: 1
status: draft
---

# 검토 열기 — 확인 대상 계산

## 개요

`DomainChanged` / `SpecChanged` / `DesignChanged` 이벤트를 받아, 큰 변경이면 확인 대상을 계산해 ReviewItem을 만든다. 4층 구조의 연결 규칙(아래 층은 위 층 버전을 기준으로 삼음)을 실제로 동작시키는 핵심 로직이다.

## 처리 흐름

```
이벤트 수신 (ChangeSet)
  │
  ├─ size == minor ──▶ 종료
  │
  ▼
대상 후보 찾기 (인덱스의 basedOn / refs / 테스트 연결 역참조)
  │
  ▼
후보별 필터
  ├ 후보의 기준 버전 >= ChangeSet.to ──▶ 제외 (이미 반영됨)
  ├ 후보가 폐기/대체 상태           ──▶ 제외
  └ 하위 항목 불일치                ──▶ 제외 (아래 "하위 항목 매칭")
  │
  ▼
기존 미처리 ReviewItem 있음? ──예──▶ 기존 항목에 ChangeSet 덧붙임 (IR-F06)
  │ 아니오
  ▼
ReviewItem 생성 → reviews/ 에 저장
  │
  ▼
참고 목록 계산 (IR-F02) → 같은 검토 파일에 기록
```

## 대상 후보 찾기

| 변경 대상 | 찾는 방법 |
|---|---|
| 도메인 | `basedOn.ref == 도메인 id` 인 기능 명세 표 |
| 기능 명세 표 | `basedOn.ref == 표 id` 인 기능별 설계 + 바뀐 AC에 연결된 테스트 |
| 시스템 공통 설계 | `refs.ref == system-design` 인 기능별 설계 |

## 하위 항목 매칭

기능 명세 표와 공통 설계는 문서 전체가 아니라 **바뀐 하위 항목**으로 대상을 좁힌다 (D2).

| 변경 대상 | ChangeSet.changed | 후보가 남는 조건 |
|---|---|---|
| 기능 명세 표 → 설계 | 기능 ID 목록 | 설계의 `basedOn.feature`가 목록에 있음 |
| 기능 명세 표 → 테스트 | AC ID 목록 | 테스트가 연결된 AC가 목록에 있음. 기능 ID만 있으면 그 기능의 모든 AC |
| 공통 설계 → 설계 | 섹션 id 목록 | 설계의 `refs.section`이 목록에 있음. `refs`에 섹션이 없으면 항상 남음 |

`changed`가 비어 있는 큰 변경은 문서 전체가 바뀐 것으로 보고 모든 후보를 남긴다.

## 참고 목록 (IR-F02)

- 도메인 변경일 때만 계산한다.
- 하위 도메인(상위 링크 역방향 1단계)과 이 도메인에 `의존` 링크를 건 도메인을 찾고, 그 도메인들의 기능 명세 표를 참고 목록에 넣는다.

## 데이터

```yaml
# reviews/rev-20261012-0003.md
---
id: rev-20261012-0003
kind: review
trigger: chg-20261012-0007
items:
  - { target: design-PAY-F02, layer: design, status: pending }
  - { target: test:PAY-F02-AC1, layer: test, status: pending }
reference: []
---
```

## 예외 처리

| 상황 | 처리 |
|---|---|
| 앱이 꺼져 있을 때 원본이 바뀜 | 열 때 `changes/` 중 검토 파일에서 참조되지 않은 major ChangeSet을 재처리 |
| 같은 ChangeSet을 두 번 처리 | 검토 파일의 `trigger`로 중복을 확인하고 건너뜀 |
| 후보 문서의 frontmatter 파싱 실패 | 해당 후보를 "확인 불가"로 ReviewItem에 남기고 파일 위치 표시 |

## 대안과 선택 이유

| 대안 | 선택하지 않은 이유 |
|---|---|
| 그래프 전체를 N단계 탐색해 전파 | 확인표시가 과도하게 늘어남. 직접 기준 관계만 확인 대상으로 하고 간접 영향은 참고 목록으로 분리 |
| 저장할 때마다 동기적으로 계산 | 대상이 많으면 저장이 느려짐. 이벤트 기반으로 저장 직후 비동기 처리 |
