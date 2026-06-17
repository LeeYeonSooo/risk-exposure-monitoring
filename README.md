# Exposure Intelligence — 실행 가이드 (어떤 서버를 띄워야 하나)

> 큐레이터 토큰 익스포저 매핑 + 결정론적 리스크 알림. **이 문서는 "무엇을 띄워야 프로젝트가 돌아가나"만** 다룬다.
> 상세 설계·재현·진행 이력·백로그는 [MANUAL.md](MANUAL.md). (운영 절차·알림 채널·배포는 이 문서 아래 "운영" 절로 통합.)

---

## TL;DR — 보기만 할 거면 RPC(cron)는 필요 없다

프론트엔드가 **DB를 직접 읽는다**(별도 백엔드·API 서버 없음). 그래서 **데이터를 보여주는 것**과 **데이터를 갱신하는 것**이 완전히 분리돼 있다.

```
┌── 보기 / 읽기 (데모·발표) ───────────────────────┐      ┌── 갱신 / 쓰기 (라이브) ────────────┐
│   Postgres (DB) ──pg SELECT──▶ Frontend :3000   │      │  automation cron ──▶ RPC·API 호출  │
│   = 스냅샷 저장소                = Next.js 화면   │      │  ──▶ pg INSERT ──▶ DB             │
└──────────────────────────────────────────────────┘      └────────────────────────────────────┘
         ▲ 데모는 이 왼쪽 둘만 있으면 끝                          ▲ "데이터 신선도"가 필요할 때만 켠다
```

화면의 그래프·알림·dossier는 전부 **DB에 이미 쌓인 스냅샷**이다. **cron을 안 켜도** 마지막 스냅샷 시점 데이터로 완전히 동작한다 — cron은 그 데이터를 *최신으로 유지*할 뿐, 화면을 띄우는 데 필수가 아니다.

| 목적 | 띄울 것 | RPC 쏘나? |
|---|---|---|
| **발표·데모 (현재 데이터 보기)** | ① DB  ② 프론트엔드 | ❌ 아니오 |
| **공유 링크 (원격에서 보기)** | ① DB  ② 프론트  ③ cloudflared 터널 | ❌ 아니오 |
| **라이브 모니터링 (새 스냅샷·알림 적재)** | ① DB  ② 프론트  ③ automation cron | ✅ 예 (cron이 쏨) |

> **결론:** "서버랑 RPC 쏘는 것까지 열어야 하나?" → **데모/확인용이면 No.** DB + 프론트만. RPC(cron)는 데이터를 새로 쌓을 때만.

---

## 구성요소 4개

### ① DB — Postgres + TimescaleDB *(필수, 스냅샷 저장소)*
```bash
cd automation && docker compose up -d        # timescaledb pg16, :5433/wbtc_mapping
docker ps | grep wbtc-db                      # "Up ... (healthy)" 확인
```
- 모든 데이터(그래프 nodes/edges · 알림 · 공급 시계열 …)가 여기 산다.
- 프론트·automation 둘 다 같은 `DATABASE_URL`(`…@localhost:5433/wbtc_mapping`)을 본다.

### ② 프론트엔드 — Next.js *(필수, 보는 화면)*
```bash
cd frontend
npm install                                   # 최초 1회
npm run build && PORT=3000 npm run start       # 프로덕션 → http://localhost:3000
# (개발 중이면) npm run dev                     # HMR, 약간 느림
```
- `frontend/.env.local` 에 `DATABASE_URL` (DB와 **동일** 문자열) 필요.
- **RPC 호출 0** — DB만 읽으므로 비용 0. 코드 바꾸면 `build` 다시.

### ③ cloudflared — 공개 공유 링크 *(선택, 원격 시연용)*
```bash
cloudflared tunnel --url http://localhost:3000   # https://<랜덤>.trycloudflare.com 출력
```
- 로컬(`localhost:3000`)은 내 PC에서만. 멘토·팀에게 보여주려면 이 터널의 공개 URL을 공유.
- ⚠️ quick tunnel은 재시작마다 URL이 바뀜 + 가끔 끊김. 상시 운영은 named tunnel 또는 Vercel+Neon 권장(→ 아래 "운영 — 공개 배포").

### ④ automation cron — 라이브 데이터 갱신 *(선택, = RPC 쏘는 곳)*
```bash
cd automation
npm install                                   # 최초 1회
cat > .env <<'EOF'
DATABASE_URL=postgres://wbtc:<pw>@localhost:5433/wbtc_mapping
ALCHEMY_API_KEY=<무료 키>                       # 없으면 publicnode 폴백
EOF
npm run cron                                   # 9개 루프 주기 실행 (기본은 안 켜져 있음)
```
- **여기서만 RPC(viem/Multicall3)·외부 API를 쏜다.** 9 루프: 스냅샷(20분)·discover(1일)·curators(30분)·chain-supply(1h)·wallets(2h)·bridge-auth(6h)·backing(1h)·mintburn(1h)·value-drift(1h).
- 기본 OFF(무료티어 RPC 소모 방지). 알림 채널(Discord/Telegram)은 `.env`에 토큰 넣으면 활성(→ 아래 "운영 — 알림 채널").

---

## 빠른 레시피

**A. 데모만 (가장 흔함, RPC 0)**
```bash
cd automation && docker compose up -d
cd ../frontend && npm run build && PORT=3000 npm run start
# → http://localhost:3000
```

**B. 공유 링크까지**
```bash
# A 실행 후, 다른 터미널에서:
cloudflared tunnel --url http://localhost:3000
# → 출력된 https://....trycloudflare.com 공유
```

**C. 풀 라이브 (데이터도 계속 갱신)**
```bash
# A 실행 후, 다른 터미널에서:
cd automation && npm run cron
```

---

## DB가 비어 있을 때 (최초 1회 데이터 채우기)
```bash
cd automation
npm run init-db          # 마이그레이션 적용 (테이블 생성)
npm run snapshot:all     # 첫 스냅샷 (RPC 한 번 쏨 → DB 적재)
npm run backtest         # (선택) 탐지기 회귀 검증 → 🟢 GREEN 확인
```
이후엔 cron 없이도 프론트가 이 스냅샷을 계속 보여준다. 신선도가 필요하면 `npm run cron`.

---

## 포트 · 환경변수 요약

| 프로세스 | 명령 | 포트 | 필수 ENV |
|---|---|---|---|
| DB | `docker compose up -d` (automation/) | 5433 | (compose에 내장) |
| 프론트 | `PORT=3000 npm run start` (frontend/) | 3000 | `DATABASE_URL` |
| cron | `npm run cron` (automation/) | — | `DATABASE_URL` · `ALCHEMY_API_KEY`(권장) · (선택) `DISCORD_WEBHOOK_URL`·`ARCHIVE_RPC_URL` |
| 터널 | `cloudflared tunnel --url …` | — | — |

- `DATABASE_URL` 은 프론트(`frontend/.env.local`)·automation(`automation/.env`)이 **반드시 동일 DB**.
- RPC 우선순위: Alchemy → publicnode(무료 폴백). 키 없이도 cron 동작(비용 0).

---

## 운영 — 알림 채널 · 상시구동 · 배포 (구 ops/OPS.md 통합)

> 모두 **zero-cost 기본**. 알림 채널·deep history·공개 배포는 운영자가 자기 크리덴셜로 opt-in(자동화가 계정·토큰을 대신 못 채움).

### 알림 채널 (Discord / Telegram / Webhook) — cron이 warning·critical만 발송
`automation/.env`에 채우면 활성(비우면 no-op, info는 항상 DB만):
```bash
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...   # 채널 → 설정 → 연동 → 웹후크 → URL 복사
TELEGRAM_BOT_TOKEN=123456:ABC...                           # @BotFather /newbot 으로 발급
TELEGRAM_CHAT_ID=-1001234567890                            # 봇 넣은 채널/그룹 chat id (getUpdates로 확인)
ALERT_WEBHOOK_URL=https://your.endpoint/alerts            # 범용 JSON POST(자체 수신기)
```
cron 기동 로그에 활성 채널 표시(`[cron] 알림 채널: discord, telegram`). 발송 실패는 삼켜 메인 파이프라인 비차단.

### 상시 구동 (launchd — 재부팅/크래시 자동 복구)
`ops/`의 plist 2개. **먼저 plist 안 `/ABSOLUTE/PATH/TO/risk-exposure-monitoring`를 실제 경로로 치환** → `~/Library/LaunchAgents/`로 복사 후 load:
```bash
cp ops/com.exposure.frontend.plist ~/Library/LaunchAgents/   # 프론트(무비용 — 항상 켜두기 권장)
launchctl load ~/Library/LaunchAgents/com.exposure.frontend.plist
cp ops/com.exposure.cron.plist ~/Library/LaunchAgents/       # cron(OPT-IN — 무료티어 RPC 연속 소모)
launchctl load ~/Library/LaunchAgents/com.exposure.cron.plist
launchctl unload ~/Library/LaunchAgents/com.exposure.cron.plist   # 해제
```
KeepAlive=true(죽으면 자동 재시작) · RunAtLoad=true(부팅 시 기동) · 로그 `/tmp/exposure-*.log`.

### deep history (유료 archive RPC, 선택)
무료 RPC는 `eth_getLogs` 범위 제한(Alchemy 10블록·publicnode ~200k) → bounded 최근 스캔만. 깊은 과거(브릿지 mint 이력 등)가 필요하면 `automation/.env`:
```bash
ARCHIVE_RPC_URL=https://your-archive-rpc   # 단일 엔드포인트(보통 홈체인)
```
설정 시 `scanLogsRecent(deep=true)`가 한 콜 `fromBlock:0` 전체 과거. 미설정이면 publicnode bounded(비용 0).

### 공개 배포 (선택, 운영자 크리덴셜)
1. **터널(가장 간단, 무료)**: `cloudflared tunnel --url http://localhost:3000` → 임시 공개 URL(DB도 로컬 유지). quick tunnel은 URL이 자주 바뀌므로 고정은 **named tunnel**(Cloudflare 계정+도메인).
2. **Vercel + Neon(관리형, 무료 티어)**: 프론트를 Vercel(Root=`frontend`), DB를 Neon Postgres로. `frontend/.env`의 `DATABASE_URL`을 Neon 연결 문자열로 교체 → `vercel deploy`. automation cron은 로컬에 두고 같은 Neon DB에 적재. ⚠️ 계정 생성·연결 문자열은 운영자가 직접.

> 기본값은 **로컬·비용 0**. 위는 opt-in 경로일 뿐 강제 아님.

---

## 지갑 추적 실행 (선택, 구 WALLET-TRACKING.md 통합)

큐레이터/펀드 지갑의 밸류 급감을 감시(`wallet_value_drop`: 직전 대비 30%↓ warning / 50%↓ critical, 26h 중복 억제). 스크레이프(automation)와 서빙(frontend)은 **같은 Postgres**만 공유.

**우선순위: 공식 API(키) → 우회 스크레이프 → 온체인 폴백(키 없어도 동작).**
```bash
cd automation
# (A) DeBank 공식 OpenAPI — 서버→서버라 Cloudflare/IP 무관, 가장 확실. 유료 키.
DEBANK_ACCESS_KEY=xxxx npm run snapshot:wallets
# (B) 키 없을 때 — 헤드풀+영속 프로필로 Cloudflare 1회 통과(쿠키 재사용)
DEBANK_HEADFUL=1 DEBANK_PROFILE_DIR=~/.debank-profile npm run snapshot:wallets -- 0x주소 "이름" curator
#     데이터센터 IP 차단 정공법: DEBANK_PROXY=http://user:pass@host:port (주거용 프록시)
# (C) 차단 환경 폴백 — 온체인-매핑 가치만으로 추적+급감 알림(프로토콜 포지션 분해만 빠짐)
WALLET_SKIP_DEBANK=1 npm run snapshot:wallets
```
- cron의 `walletLoop`이 2시간마다 `snapshot-wallets` 실행. 차단 환경이면 `WALLET_SKIP_DEBANK=1`로 cron 기동. `tracked_wallets` 비면 no-op.
  (지갑 자동 발굴 `discover:wallets` 는 Dune 폐기와 함께 제거 — MANUAL §17 2026-06-12.)

---

## 트러블슈팅
- **:3000 이미 점유** → `lsof -ti:3000 | xargs kill` 후 재시작.
- **화면은 뜨는데 데이터 없음/`dbConnected:false`** → DB 미기동 또는 `DATABASE_URL` 불일치. `docker ps`로 wbtc-db 확인, 두 `.env`의 URL 일치 확인.
- **그래프에 특정 체인이 안 보임** → breadth dust 컷오프(`CHAIN_TVL_MIN`, `frontend/app/api/breadth/[symbol]/route.ts`). 해당 체인의 DeFi TVL이 컷 미만이면 숨겨짐(의도된 동작).
- **cloudflared URL이 매번 바뀜/끊김** → quick tunnel 특성. 고정 URL은 named tunnel 또는 Vercel 배포(→ 아래 "운영 — 공개 배포").
- **데이터 흐름 점검** → `curl -s http://localhost:3000/api/tokens | head` (토큰 목록 뜨면 DB→프론트 배선 OK).
- **토큰 symbol=UNKNOWN·edges 0** → 주소 EIP-55 체크섬 오류(진입점 소문자화로 해결됨). seed 주소는 소문자 권장.
- **`getPoolDataProvider failed`** → RPC가 llamarpc(봇 차단)/ankr(불안정). **`eth.llamarpc.com` 금지** → Alchemy 키 설정 또는 publicnode 사용.
- **Morpho 데이터 없음** → GraphQL 필드명 변경. introspection으로 필드 확인 후 수정.
- **discover 즉시 종료** → `DATABASE_URL` 빈값. `.env` 설정 또는 `npm run discover:dry`(DB 없이 랭킹만).
- **첫 스냅샷에 알림 폭탄** → cold start(기준선 없음). diff가 자동 감지·skip(정상 동작).
</content>
