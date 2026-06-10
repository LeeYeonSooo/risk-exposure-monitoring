-- ─────────────────────────────────────────────────────────────
-- Migration 005 — edges 시계열 경량화 (압축 + 보존 정책)
--
-- 문제: 매시간 모든 토큰×프로토콜의 fat attrs(JSONB, Morpho는 ~6KB)를 통째 저장.
--   안 변해도 재저장 → 장기적으로 무거워짐.
-- 해결(둘 다 TimescaleDB 네이티브, 옛 chunk 에만 적용 → 지금 데이터엔 즉시 영향 X):
--   1) 압축: 7일 지난 chunk 압축 (반복 JSONB라 10~20x 절감)
--   2) 보존: 90일 지난 chunk 자동 삭제 (frontend=최신, diff=직전만 필요 → 충분)
--
-- 값 변경: 아래 INTERVAL 수정 후 재적용. 정책은 멱등(이미 있으면 skip).
-- ─────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    RAISE NOTICE 'timescaledb 미설치 — 압축/보존 정책 skip';
    RETURN;
  END IF;

  -- edges 가 hypertable 인지 확인
  IF NOT EXISTS (
    SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'edges'
  ) THEN
    RAISE NOTICE 'edges 가 hypertable 아님 — skip';
    RETURN;
  END IF;

  -- 1) 압축 설정 (token×protocol 단위로 정렬·세그먼트 → 동일 시리즈 묶어 고압축)
  BEGIN
    ALTER TABLE edges SET (
      timescaledb.compress,
      timescaledb.compress_segmentby = 'token_node_id, protocol_node_id',
      timescaledb.compress_orderby = 'snapshot_ts DESC'
    );
  EXCEPTION WHEN others THEN
    RAISE NOTICE '압축 설정 이미 적용됨 또는 skip: %', SQLERRM;
  END;

  -- 7일 지난 chunk 자동 압축
  PERFORM add_compression_policy('edges', INTERVAL '7 days', if_not_exists => TRUE);

  -- 90일 지난 chunk 자동 삭제 (보존 기간)
  PERFORM add_retention_policy('edges', INTERVAL '90 days', if_not_exists => TRUE);

  RAISE NOTICE 'edges 압축(7d) + 보존(90d) 정책 적용 완료';
END$$;
