-- ===========================================================================
-- v134 — Decision KPI Store
--
-- Design principle: a KPI is only useful if it can change a decision.
-- Therefore every metric here stores, alongside its value:
--   * the benchmark it is measured against,
--   * the direction that is GOOD (a high value is not always better),
--   * and the action the reader should take when it breaches.
--
-- Metrics that cannot be acted upon are deliberately not modelled: vanity
-- numbers such as "total customers" inflate dashboards without informing a
-- single decision.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. KPI REGISTRY — the catalogue, declared once
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dypos.kpi_definitions (
  code              VARCHAR(64) PRIMARY KEY,
  name              VARCHAR(128) NOT NULL,
  name_en           VARCHAR(128) NOT NULL,
  category          VARCHAR(24) NOT NULL
                    CHECK (category IN ('sales','margin','inventory','receivable',
                                        'payable','cash','fx','hr','compliance')),
  -- Higher is better, lower is better, or target-band.
  polarity          VARCHAR(8) NOT NULL DEFAULT 'higher'
                    CHECK (polarity IN ('higher','lower','target')),
  unit              VARCHAR(16) NOT NULL,   -- currency|percent|days|ratio|count
  formula           TEXT NOT NULL,          -- documented so it is auditable
  benchmark         NUMERIC(18,4),
  warn_threshold    NUMERIC(18,4),
  critical_threshold NUMERIC(18,4),
  -- What the operator should actually DO when this breaches.
  action            VARCHAR(255) NOT NULL,
  sort_order        SMALLINT NOT NULL DEFAULT 100,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_kpi_defs_cat
  ON dypos.kpi_definitions (category, sort_order);

-- ---------------------------------------------------------------------------
-- 2. DAILY KPI SNAPSHOTS
-- An append-only series, so a trend can be shown and a drift detected. A
-- metric is never silently rewritten after the fact.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dypos.kpi_snapshots (
  id            TEXT PRIMARY KEY,
  tenant_id     VARCHAR(64) NOT NULL,
  branch_id     VARCHAR(64),
  kpi_code      VARCHAR(64) NOT NULL REFERENCES dypos.kpi_definitions(code),
  scope_date    DATE NOT NULL,
  zone_id       VARCHAR(64),
  currency_code VARCHAR(8) NOT NULL DEFAULT 'SAR',
  value         NUMERIC(20,6) NOT NULL,
  -- Benchmark as it stood when measured, so history stays comparable even
  -- after the target is revised.
  benchmark     NUMERIC(18,4),
  status        VARCHAR(20) NOT NULL DEFAULT 'ok'
                CHECK (status IN ('ok','warn','critical','insufficient_data')),
  notes         TEXT,
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- The natural key folds the NULL branch into a sentinel so a tenant-wide
  -- snapshot upserts instead of colliding on the primary key.
  UNIQUE (tenant_id, kpi_code, scope_date)
);

-- A NULL branch_id is "tenant-wide", and Postgres treats NULLs as distinct in a
  -- plain unique index — which would let a tenant-wide snapshot duplicate on
  -- every run. COALESCE folds the null into a sentinel so the natural key is
  -- genuinely unique.
CREATE UNIQUE INDEX IF NOT EXISTS uq_kpi_snapshot_natural
  ON dypos.kpi_snapshots (
    tenant_id, COALESCE(branch_id, '__all__'), kpi_code, scope_date
  );

CREATE INDEX IF NOT EXISTS idx_kpi_snap_time
  ON dypos.kpi_snapshots (tenant_id, scope_date DESC, kpi_code);

-- ---------------------------------------------------------------------------
-- 3. ALERTS — the point of the exercise
-- A metric that breaches a threshold must produce an actionable item, not just
-- change a colour on a chart.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dypos.kpi_alerts (
  id            TEXT PRIMARY KEY,
  tenant_id     VARCHAR(64) NOT NULL,
  branch_id     VARCHAR(64),
  kpi_code      VARCHAR(64) NOT NULL REFERENCES dypos.kpi_definitions(code),
  severity      VARCHAR(20) NOT NULL
                CHECK (severity IN ('warn','critical','insufficient_data')),
  scope_date    DATE NOT NULL,
  observed      NUMERIC(20,6) NOT NULL,
  benchmark     NUMERIC(18,4),
  title         VARCHAR(160) NOT NULL,
  detail        TEXT,
  recommended_action VARCHAR(255) NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','acknowledged','resolved','ignored')),
  acknowledged_by VARCHAR(64),
  acknowledged_at TIMESTAMPTZ,
  resolved_by   VARCHAR(64),
  resolved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kpi_alerts_open
  ON dypos.kpi_alerts (tenant_id, status, severity, scope_date DESC);

-- One alert per KPI per day keeps re-running the engine idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS uq_kpi_alert_day
  ON dypos.kpi_alerts (tenant_id, branch_id, kpi_code, scope_date)
  WHERE status IN ('open','acknowledged');

-- ---------------------------------------------------------------------------
-- 4. COHORT RETENTION
-- Repeat purchase is the only durable proof that a customer is worth keeping,
-- and it cannot be derived from a single snapshot.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dypos.customer_cohorts (
  id               TEXT PRIMARY KEY,
  tenant_id        VARCHAR(64) NOT NULL,
  customer_id      VARCHAR(64) NOT NULL,
  cohort_month     VARCHAR(7) NOT NULL,       -- YYYY-MM of the first purchase
  first_value      NUMERIC(18,2) NOT NULL DEFAULT 0,
  order_count      SMALLINT NOT NULL DEFAULT 1,
  lifetime_value   NUMERIC(18,2) NOT NULL DEFAULT 0,
  last_order_at    DATE,
  repeat_indicator BOOLEAN NOT NULL DEFAULT FALSE,
  -- Value measured 30 / 60 / 90 days after the first purchase.
  value_30d        NUMERIC(18,2) NOT NULL DEFAULT 0,
  value_60d        NUMERIC(18,2) NOT NULL DEFAULT 0,
  value_90d        NUMERIC(18,2) NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_cohort_month
  ON dypos.customer_cohorts (tenant_id, cohort_month);

-- ---------------------------------------------------------------------------
-- 5. PRICE REALISATION
-- The gap between list price and the price actually charged. Falling
-- realisation on steady volume is margin leakage no sales report reveals.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dypos.price_realisation (
  id           TEXT PRIMARY KEY,
  tenant_id    VARCHAR(64) NOT NULL,
  branch_id    VARCHAR(64),
  product_id   VARCHAR(64) NOT NULL,
  scope_date   DATE NOT NULL,
  list_price   NUMERIC(18,2) NOT NULL,
  avg_realised NUMERIC(18,2) NOT NULL,
  units_sold   NUMERIC(18,4) NOT NULL DEFAULT 0,
  discount_gap NUMERIC(8,4) NOT NULL DEFAULT 0,   -- fraction below list
  margin_pct   NUMERIC(8,4) NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, branch_id, product_id, scope_date)
);