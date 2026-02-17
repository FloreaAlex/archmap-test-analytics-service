# Analytics Service — Interfaces

## REST API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /health | Public | Health check (DB + Kafka status) |
| GET | /analytics/overview | Admin | Dashboard summary: totals, rates, today's metrics |
| GET | /analytics/revenue | Admin | Revenue time series (daily/weekly/monthly) |
| GET | /analytics/orders | Admin | Order count time series by status |
| GET | /analytics/products/top | Admin | Top products by revenue or quantity |
| GET | /analytics/conversion | Admin | Conversion funnel (created → confirmed → shipped) |

### Query Parameters

**GET /analytics/revenue**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| period | string | daily | Grouping: daily, weekly, monthly |
| from | date | 30 days ago | Start date (YYYY-MM-DD) |
| to | date | today | End date (YYYY-MM-DD) |

**GET /analytics/orders**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| period | string | daily | Grouping: daily, weekly, monthly |
| from | date | 30 days ago | Start date (YYYY-MM-DD) |
| to | date | today | End date (YYYY-MM-DD) |

**GET /analytics/products/top**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| limit | integer | 10 | Max results (1-50) |
| sortBy | string | revenue | Sort by: revenue or quantity |

## Database Tables (analytics_service)

### events_log
| Column | Type | Constraints |
|--------|------|-------------|
| id | SERIAL | PRIMARY KEY |
| event_type | TEXT | NOT NULL |
| order_id | INTEGER | NOT NULL |
| user_id | INTEGER | |
| correlation_id | TEXT | |
| data | JSONB | |
| received_at | TIMESTAMP WITH TIME ZONE | DEFAULT NOW() |

**Indexes**: UNIQUE(event_type, order_id), received_at

### daily_metrics
| Column | Type | Constraints |
|--------|------|-------------|
| id | SERIAL | PRIMARY KEY |
| date | DATE | NOT NULL, UNIQUE |
| orders_created | INTEGER | DEFAULT 0 |
| orders_confirmed | INTEGER | DEFAULT 0 |
| orders_cancelled | INTEGER | DEFAULT 0 |
| orders_shipped | INTEGER | DEFAULT 0 |
| revenue_confirmed | NUMERIC(12,2) | DEFAULT 0 |
| revenue_cancelled | NUMERIC(12,2) | DEFAULT 0 |
| payment_success_count | INTEGER | DEFAULT 0 |
| payment_failure_count | INTEGER | DEFAULT 0 |

**Indexes**: date

### product_metrics
| Column | Type | Constraints |
|--------|------|-------------|
| id | SERIAL | PRIMARY KEY |
| product_id | INTEGER | NOT NULL, UNIQUE |
| total_quantity_sold | INTEGER | DEFAULT 0 |
| total_revenue | NUMERIC(12,2) | DEFAULT 0 |
| order_count | INTEGER | DEFAULT 0 |
| last_ordered_at | TIMESTAMP WITH TIME ZONE | |

**Indexes**: total_revenue DESC

### hourly_order_counts
| Column | Type | Constraints |
|--------|------|-------------|
| id | SERIAL | PRIMARY KEY |
| hour_bucket | TIMESTAMP WITH TIME ZONE | NOT NULL, UNIQUE |
| order_count | INTEGER | DEFAULT 0 |
| revenue | NUMERIC(12,2) | DEFAULT 0 |

**Indexes**: hour_bucket

## Kafka Events Consumed

| Topic | Event Type | Consumer Group | Action |
|-------|-----------|----------------|--------|
| order.events | order.created | analytics-service-group | Increment daily orders_created, hourly order_count |
| order.events | order.confirmed | analytics-service-group | Increment daily orders_confirmed + revenue, update product_metrics |
| order.events | order.cancelled | analytics-service-group | Increment daily orders_cancelled + revenue_cancelled |
| order.events | order.shipped | analytics-service-group | Increment daily orders_shipped |
| payment.events | payment.authorized | analytics-service-group | Increment daily payment_success_count |
| payment.events | payment.failed | analytics-service-group | Increment daily payment_failure_count |

## Kafka Events Published

None — this is a pure event consumer.

## Environment Variables

| Variable | Default | Required |
|----------|---------|----------|
| PORT | 3007 | No |
| DB_HOST | localhost | No |
| DB_PORT | 5432 | No |
| DB_NAME | analytics_service | No |
| DB_USER | postgres | No |
| DB_PASSWORD | postgres | No |
| DB_POOL_MAX | 10 | No |
| DB_SSL | false | No |
| KAFKA_BROKERS | localhost:9092 | No |
| KAFKA_CLIENT_ID | analytics-service | No |
| LOG_LEVEL | info | No |
