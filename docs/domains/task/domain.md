---
id: dom-task
kind: domain
title: 할 일
subdomainType: Core
version: 4
status: draft
---

# 할 일

> 해결 문제: P2

## 역할

나중에 할 일을 작업 유형과 시기를 붙여 보관하고, 때가 되면 다시 알려준다.

## 용어

이 도메인(바운디드 컨텍스트) 안에서의 뜻이다. 같은 단어도 다른 도메인에서는 뜻이 다를 수 있다.

| 용어 | 뜻 | 비고 |
|---|---|---|
| Inbox 항목 | 분류 전 할 일. 한 줄만 있어도 된다 |  |
| Task | 유형과 시기가 붙은 할 일 | 유형·시기 없이는 Task가 아니다 |
| 유형 | `feature` / `bug` / `refactor` / `tech-debt` / `research` / `docs` / `test` / `spec-sync` / `design-sync` / `domain-sync` |  |
| 시기 (Horizon) | `지금` / `다음` / `나중` / `언젠가` |  |
| 기한 | 시기에 덧붙이는 날짜 |  |
| 트리거 | 날짜 대신 조건으로 정한 시기 (명세 활성, 도메인 변경, 다른 Task 완료) |  |
| 재검토 | `나중`·`언젠가` Task를 주기적으로 다시 훑는 것 |  |
| 버림 | Task로 만들지 않고 닫은 Inbox 항목 |  |

## 하지 않는 것

- 작업 실행 자체

## 문서

- [기능 명세 표](spec.md)
