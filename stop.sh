#!/usr/bin/env bash
# 원커맨드 중지 — cron + 프론트(:3000) 종료, DB 는 정지(데이터 보존).
#   완전 삭제(데이터까지): docker compose -f automation/docker-compose.yml down -v
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; cd "$ROOT"

echo "■ cron 중지…"
pkill -f "tsx scripts/cron.ts" 2>/dev/null || true
echo "■ 프론트(:3000) 중지…"
lsof -ti:3000 2>/dev/null | xargs kill 2>/dev/null || true
echo "■ DB 정지(데이터 유지)…"
docker compose -f automation/docker-compose.yml stop || true
echo "✅ 중지 완료. (DB 데이터 보존 — 완전 삭제는 'docker compose -f automation/docker-compose.yml down -v')"
