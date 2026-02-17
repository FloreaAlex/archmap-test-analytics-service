-- Raw event log for replay/debugging
CREATE TABLE IF NOT EXISTS events_log (
  id SERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  order_id INTEGER NOT NULL,
  user_id INTEGER,
  correlation_id TEXT,
  data JSONB,
  received_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_log_dedup ON events_log(event_type, order_id);
CREATE INDEX IF NOT EXISTS idx_events_log_received ON events_log(received_at);

-- Pre-aggregated daily metrics
CREATE TABLE IF NOT EXISTS daily_metrics (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL UNIQUE,
  orders_created INTEGER DEFAULT 0,
  orders_confirmed INTEGER DEFAULT 0,
  orders_cancelled INTEGER DEFAULT 0,
  orders_shipped INTEGER DEFAULT 0,
  revenue_confirmed NUMERIC(12,2) DEFAULT 0,
  revenue_cancelled NUMERIC(12,2) DEFAULT 0,
  payment_success_count INTEGER DEFAULT 0,
  payment_failure_count INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_daily_metrics_date ON daily_metrics(date);

-- Per-product aggregations
CREATE TABLE IF NOT EXISTS product_metrics (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL UNIQUE,
  total_quantity_sold INTEGER DEFAULT 0,
  total_revenue NUMERIC(12,2) DEFAULT 0,
  order_count INTEGER DEFAULT 0,
  last_ordered_at TIMESTAMP WITH TIME ZONE
);
CREATE INDEX IF NOT EXISTS idx_product_metrics_revenue ON product_metrics(total_revenue DESC);

-- Hourly time series for charts
CREATE TABLE IF NOT EXISTS hourly_order_counts (
  id SERIAL PRIMARY KEY,
  hour_bucket TIMESTAMP WITH TIME ZONE NOT NULL UNIQUE,
  order_count INTEGER DEFAULT 0,
  revenue NUMERIC(12,2) DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_hourly_bucket ON hourly_order_counts(hour_bucket);
