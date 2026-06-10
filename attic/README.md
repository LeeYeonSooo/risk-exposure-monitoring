# attic/ — 격리된 구(舊) 코드 (빌드에서 제외)

> 설계서 §10 triage. 삭제하지 않고 **격리**한다(이유 기록). 라이브 제품은 이 폴더를 import하지 않는다(확인됨: 0건).

## 무엇이 왜 여기 있나

전부 구 **"Cross-protocol DeFi contagion simulator"** 시대의 코드다. 현재 제품(`automation` + `frontend` + Postgres)과 **단절**돼 있다 — 프론트가 Python 백엔드 `:8000` 프록시를 제거하면서 끊겼고, 라이브 빌드가 이들을 참조하지 않는다. 설계서 WON'T(W1: 디페그 전염 시뮬레이션 엔진)에 해당.

| 격리물 | 정체 | 단절 증거 |
|---|---|---|
| `backend/` | Python FastAPI 시뮬레이터(`/api/contagion*`, `/api/backtest`, `/api/focus`, `/api/events`) + DebtRank 전파 + `events.db` | 프론트가 `:8000`/`NEXT_PUBLIC_API_URL` 참조 0건, `next.config.ts`에 "프록시 제거됨" |
| `modules/` | aave·lido·morpho·pendle·sky 프로토콜 모듈(`instances.json`) | 오직 `integration`만 읽음 |
| `shared/` | 모듈 공통 스키마·vocab·템플릿 | 오직 `modules`/`integration`만 참조 |
| `integration/` | `module_loader` → `combined_graph.json` / `simulator_graph.json` | 산출물을 **오직 `backend/api/core/module_bridge.py`**(격리됨)만 소비 |
| `fly-deploy.yml.disabled` | 격리된 backend를 Fly.io에 배포하던 GitHub Actions | backend가 사라져 무의미 → 비활성 |

## 되살리려면

설계 로드맵상 일부는 미래에 부활 가능하다:
- **백테스트 알고리즘(설계 §7.3)** 도착 시 — `backend`의 사건 replay(`contagion_backtest.py`)·사건 라이브러리가 출발점이 될 수 있음. 단 *알림 임계값 튜닝*용으로 재해석 필요(전염 시뮬 자체는 WON'T).
- **모듈 통일 스키마(`shared/schemas`)** — pluggable 어댑터를 늘릴 때 참고. 단 라이브는 `automation/src/types/edge-schema.ts`가 이미 통일 스키마를 가짐.

부활시킬 땐 `attic/`에서 꺼내 라이브 배선(automation/Postgres/frontend)에 명시적으로 연결하고, 이 표와 `DECISIONS.md`를 갱신할 것.
