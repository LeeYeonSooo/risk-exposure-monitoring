#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# 원커맨드 기동 — DB + (최초 시 시드·스냅샷) + 프론트(:3000) + 모니터링 cron 을 한 번에.
#
#   ./start.sh            전체 라이브 (DB + 프론트 + cron — RPC 사용, 데이터 계속 갱신)  ← 권장
#   ./start.sh --no-cron  보기 전용 (DB + 프론트만 — RPC 안 쏨, 마지막 스냅샷으로 데모)
#
# 헤더의 "라이브 · N분 전" 배지로 데이터 신선도를 항상 확인 가능(cron 꺼짐/폴백 의심 해소).
# 중지: ./stop.sh
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; cd "$ROOT"
NO_CRON=0; [ "${1:-}" = "--no-cron" ] && NO_CRON=1
DBURL="postgres://wbtc:wbtc_local_pw@localhost:5433/wbtc_mapping"
mkdir -p .run

echo "▶ 1/5 DB 기동 (TimescaleDB, :5433)…"
docker compose -f automation/docker-compose.yml up -d
printf "   healthy 대기"
for _ in $(seq 1 40); do
  if docker exec wbtc-db pg_isready -U wbtc -d wbtc_mapping >/dev/null 2>&1; then echo " ✓"; break; fi
  printf "."; sleep 2
done

echo "▶ 2/5 .env 보장 (automation·frontend 동일 DATABASE_URL)…"
[ -f automation/.env ] || printf "DATABASE_URL=%s\n" "$DBURL" > automation/.env
if ! grep -q '^DATABASE_URL' frontend/.env.local 2>/dev/null; then printf "DATABASE_URL=%s\n" "$DBURL" >> frontend/.env.local; fi
# ALCHEMY_API_KEY 를 프론트로 전파 — breadth 멀티체인 supply 를 Alchemy(신뢰)로. 없으면 publicnode 폴백(무회귀).
AK=$(grep -E '^ALCHEMY_API_KEY' automation/.env 2>/dev/null | cut -d= -f2- | tr -d ' "')
if [ -n "$AK" ] && ! grep -q '^ALCHEMY_API_KEY' frontend/.env.local 2>/dev/null; then printf "ALCHEMY_API_KEY=%s\n" "$AK" >> frontend/.env.local; fi

echo "▶ 3/5 의존성 + 마이그레이션…"
[ -d automation/node_modules ] || ( cd automation && npm install )
[ -d frontend/node_modules ]   || ( cd frontend && npm install )
npm --prefix automation run init-db >/dev/null

TOK=$(docker exec wbtc-db psql -U wbtc -d wbtc_mapping -tA -c "SELECT count(*) FROM nodes WHERE type='Token'" 2>/dev/null || echo 0)
if [ "${TOK:-0}" -lt 1 ]; then
  echo "   DB 비어있음 → 위험토큰 시드 + 첫 스냅샷 (몇 분 소요, 빈 화면/폴백 방지)…"
  npm --prefix automation run seed:risk || true
  npm --prefix automation run snapshot:all || true
fi

echo "▶ 4/5 프론트엔드 빌드 + 기동 (:3000)…"
( cd frontend && npm run build )
lsof -ti:3000 2>/dev/null | xargs kill 2>/dev/null || true
nohup bash -c 'cd "'"$ROOT"'/frontend" && PORT=3000 npm run start' > .run/frontend.log 2>&1 &
printf "   :3000 대기"
for _ in $(seq 1 30); do
  if curl -sf http://localhost:3000/api/health >/dev/null 2>&1; then echo " ✓"; break; fi
  printf "."; sleep 1
done

if [ "$NO_CRON" -eq 0 ]; then
  echo "▶ 5/5 모니터링 cron 기동 (라이브 데이터 갱신 — RPC 사용)…"
  pkill -f "tsx scripts/cron.ts" 2>/dev/null || true
  nohup bash -c 'cd "'"$ROOT"'/automation" && npm run cron' > .run/cron.log 2>&1 &
  echo "   cron 백그라운드 — 9개 루프(스냅샷·discovery·backing·mintburn·valuedrift·reflexivity…)"
else
  echo "▶ 5/5 cron 생략(--no-cron) — 마지막 스냅샷으로 보기만(RPC 0)."
fi

echo ""
echo "✅ 기동 완료 → http://localhost:3000"
echo "   · 헤더 '라이브 · N분 전' 배지 = 데이터 신선도(초록=라이브). cron 끄면 시간이 흐를수록 노랑/주황."
echo "   · 로그:  tail -f .run/frontend.log   ·   tail -f .run/cron.log"
echo "   · 공유 링크(원격):  cloudflared tunnel --url http://localhost:3000"
echo "   · 중지:  ./stop.sh"
