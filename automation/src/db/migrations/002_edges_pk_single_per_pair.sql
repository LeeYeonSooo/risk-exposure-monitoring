-- ─────────────────────────────────────────────────────────────
-- Migration 002 — edges PK becomes (snapshot_ts, token, protocol).
-- Reason: multi-role per (token, protocol) edge — one row holds N roles
-- inside attrs.classification.roles[].
--
-- Safe to run repeatedly; checks current PK before changing.
-- DELETES duplicate rows (same (ts, token, protocol), keeps largest weight).
-- ─────────────────────────────────────────────────────────────

DO $$
BEGIN
  -- 1) Dedupe within (snapshot_ts, token, protocol) — keep row with largest weight
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'edges' AND constraint_type = 'PRIMARY KEY'
      AND constraint_name = 'edges_pkey'
  ) THEN
    -- Existing rows: collapse by (ts, token, protocol)
    DELETE FROM edges e1
    WHERE EXISTS (
      SELECT 1 FROM edges e2
      WHERE e2.snapshot_ts = e1.snapshot_ts
        AND e2.token_node_id = e1.token_node_id
        AND e2.protocol_node_id = e1.protocol_node_id
        AND (e2.weight > e1.weight
             OR (e2.weight = e1.weight AND e2.edge_type > e1.edge_type))
    );

    -- Drop old PK
    ALTER TABLE edges DROP CONSTRAINT IF EXISTS edges_pkey;
    -- Add new PK
    ALTER TABLE edges ADD PRIMARY KEY (snapshot_ts, token_node_id, protocol_node_id);
  END IF;
END$$;
