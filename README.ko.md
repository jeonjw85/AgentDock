# AgentDock

[![CI](https://github.com/jeonjw85/AgentDock/actions/workflows/ci.yml/badge.svg)](https://github.com/jeonjw85/AgentDock/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

여러 AI 코딩 에이전트를 격리된 git worktree 위에서 함께 돌리기 위한 오픈소스 실행 환경입니다.

[English](README.md)

AgentDock은 Claude Code, Codex, Kiro, OpenCode, Gemini를 대체하지 않습니다. 그 위에서 동작합니다. 하나의 작업을 잘게 나누고, 나뉜 조각을 여러 에이전트에게 동시에 맡기고, 각 에이전트를 자기만의 git worktree 안에 두어 서로 충돌하지 않게 하고, 실행 전체에 걸쳐 비용과 도구 호출과 diff를 한곳에서 지켜볼 수 있습니다.

```
                        AgentDock
                            |
        +-------------------+-------------------+
        v                   v                   v
    Claude Code           Codex             OpenCode        (어댑터를 통해)
        |                   |                   |
        +-------------------+-------------------+
                            |
                    Workspace Runtime  (로컬 또는 docker)
                            |
        +-------------------+-------------------+
        v                   v                   v
    Git Worktree         Sandbox             Diff Tracking
        |
        v
       Repo
```

## 왜 필요한가

이제 대부분의 개발자가 코딩 에이전트를 매일 쓰고, 여러 개를 한 번에 쓰는 경우도 많습니다. 문제는 에이전트마다 git, 터미널, 컨텍스트, 작업, 권한을 각자 따로 관리한다는 점입니다. 공통의 제어 계층이 없습니다. AgentDock이 그 제어 계층입니다.

- 하나의 작업 그래프를 플래너, 워커, 리뷰어 같은 여러 에이전트로 나눠서 맡깁니다.
- 모든 작업이 자기 브랜치와 자기 worktree에서 돌기 때문에 에이전트끼리 서로의 결과를 덮어쓸 일이 없습니다.
- 세션, 토큰 사용량, 비용, 도구 호출, diff가 모두 하나의 이벤트 버스를 통해 흐르므로 한곳에서 지켜볼 수 있습니다.
- 작은 인터페이스 하나만 구현하면 어떤 CLI 코딩 에이전트든 어댑터로 붙일 수 있습니다.

## 빠른 시작

Node.js 22.13 이상과 git이 필요합니다.

```bash
# AgentDock 저장소에서
pnpm install
pnpm build

# 여러분의 프로젝트 저장소에서
node /path/to/AgentDock/packages/cli/dist/bin.js init --name my-project

# 이슈를 백엔드/프론트엔드/리뷰 작업 그래프로 나눕니다
agentdock plan "OAuth login" --desc "OAuth 로그인 전체 구현"

# 모든 작업을 끝까지 실행합니다
agentdock run

# 확인합니다
agentdock status
agentdock sessions      # 세션별 토큰 사용량과 비용
agentdock worktrees     # 작업마다 생성된 격리 체크아웃
agentdock events        # 전체 이벤트 로그 (세션 재생)
```

AgentDock은 mock 어댑터를 기본으로 포함하므로, 외부 에이전트가 하나도 설치돼 있지 않아도 전체 파이프라인이 오프라인으로 동작합니다. Claude Code, Codex, OpenCode 같은 실제 에이전트를 연결하려면 [docs/adapters.md](docs/adapters.md)를 참고하세요.

## 동작 예시

```
이슈: "OAuth login"
   |
   v  플래너가 작업을 나눔
   |- work:   OAuth login - backend    (병렬 실행,
   |- work:   OAuth login - frontend    각자 자기 worktree에서)
   |- review: OAuth login - review     (둘 다 끝나길 기다린 뒤 리뷰)

repo/
+-- .worktrees/
    |-- task-<id>-a1/   (agentdock/task-<id>-a1 브랜치)   backend
    |-- task-<id>-a1/   (agentdock/task-<id>-a1 브랜치)   frontend
    +-- task-<id>-a1/   (agentdock/task-<id>-a1 브랜치)   review
```

성공한 작업은 자동으로 해당 작업 브랜치에 커밋됩니다.

## 패키지

| 패키지 | 역할 |
|---|---|
| `@agentdock/core` | 도메인 모델, 이벤트 버스, 교체 가능한 저장소(`Store`) |
| `@agentdock/git` | worktree 생명주기, diff 추적, 커밋 도우미 |
| `@agentdock/adapters` | `AgentAdapter` 규약, 레지스트리, 기본 mock 및 범용 CLI 어댑터 |
| `@agentdock/runtime` | 실행 백엔드: `LocalRuntime`과 `DockerRuntime`(샌드박스) |
| `@agentdock/orchestrator` | DAG 스케줄러, 플래너, 재시도, 오케스트레이션 엔진 |
| `@agentdock/cli` | `agentdock` 명령어 |

## 명령어

```
agentdock init [--name <name>]                 저장소에 AgentDock 초기화
agentdock plan <title> [--desc <text>]         작업을 작업 그래프로 나누기
             [--planner default|single] [--gate review|work|plan]
agentdock add <title> [--role work|review|plan]  단일 작업 추가
             [--agent <id>] [--max-attempts <n>] [--desc <text>] [--approve]
agentdock run [--concurrency <n>]              대기 중인 작업을 끝까지 실행
agentdock approve <taskId> [--by <name>]       승인 대기 중인 작업 승인
agentdock reject <taskId> [--reason <text>]    승인 대기 중인 작업 거절
agentdock pr <taskId> [--body <text>]          브랜치를 push하고 PR 생성 (gh 사용)
agentdock merge <taskId>                       성공한 작업을 base 브랜치에 병합
agentdock status                               작업 그래프 상태
agentdock sessions                             사용량과 비용이 포함된 세션 목록
agentdock worktrees                            추적 중인 worktree
agentdock events [--task <id>]                 이벤트 로그와 세션 재생
agentdock agents                               등록된 어댑터
```

## 사람이 개입하는 워크플로우

특정 단계를 사람 승인 뒤로 미뤄 두고, 이후에 PR을 올리고 병합할 수 있습니다.

```bash
# 리뷰 단계에 승인을 요구
agentdock plan "OAuth login" --desc "..." --gate review
agentdock run                     # 워커를 실행한 뒤, 승인이 걸린 리뷰에서 멈춤
agentdock status                  # 해당 작업이 잠금 표시와 함께 승인 대기 상태로 보임
agentdock approve <taskId> --by me
agentdock run                     # 승인됐으니 이어서 진행

# 작업 브랜치로 PR 열기 (remote와 gh가 필요)
agentdock pr <taskId>

# 또는 작업 브랜치를 base 브랜치에 로컬에서 병합
agentdock merge <taskId>
```

`origin` remote가 없거나 GitHub CLI가 설치돼 있지 않으면 `pr`은 오류 없이 대체 경로로 넘어가며, PR을 직접 열도록 안내합니다. 로컬 흐름은 그대로 동작합니다.

## 개발

```bash
pnpm install
pnpm build       # 모든 패키지에 대한 tsc 프로젝트 레퍼런스 빌드
pnpm test        # vitest (단위 및 통합 테스트)
pnpm typecheck
```

## 설계 문서

- [ARCHITECTURE.md](ARCHITECTURE.md)는 각 구성 요소가 어떻게 맞물리는지 설명합니다.
- [docs/adapters.md](docs/adapters.md)는 여러분의 에이전트를 위한 어댑터 작성법을 안내합니다.

## 현황과 로드맵

AgentDock은 초기 기반 단계입니다. 지금 동작하는 것: 작업 분해, 재시도가 포함된 DAG 스케줄링, worktree 격리, diff 캡처, 세션과 비용 관측, 로컬 및 Docker 런타임, 교체 가능한 어댑터 계층, 실제 Claude Code 어댑터, 그리고 사람이 개입하는 워크플로우(승인 게이트, `gh`를 통한 PR 생성, 브랜치 병합).

로드맵:

- Codex, OpenCode, Gemini를 위한 정식 어댑터
- 이벤트 버스를 읽는 실시간 TUI 또는 웹 대시보드
- 더 큰 환경을 위한 SQLite 및 Postgres `Store` 백엔드
- 체크포인트와 재개 가능한 실행
- MCP 도구 지원

## 라이선스

MIT
