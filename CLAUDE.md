# Analytics Service

## System Architecture Overview

**Workspace**: Archmap Test Platform
**Architecture Style**: Microservices with event-driven communication
**This Component's Role**: Event-sourced analytics service that consumes all Kafka events to build pre-aggregated metrics and exposes an admin-only REST API
**Component Type**: service
**Position in Flow**: Receives from: Order Service (kafka), Payment Service (kafka), API Gateway (http) → Stores in: Analytics Database (postgresql)

**Related Components**:
  - ← **Order Service** (service) - kafka - Publishes order lifecycle events (order.created, order.confirmed, order.shipped, order.cancelled)
  - ← **Payment Service** (service) - kafka - Publishes payment events (payment.authorized, payment.failed)
  - ← **API Gateway** (gateway) - http - Proxies REST API requests with JWT validation and admin role enforcement
  - → **Analytics Database** (database) - postgresql - Persists raw event log and pre-aggregated metrics
  - → **Order Events Schemas** (library) - npm - Shared schemas for event validation, topic names, and consumer group constants

## Patterns

### System-Wide Patterns (include if relevant to this repo)

- **Event-Driven Architecture**: This service consumes ALL events from both Kafka topics (`order.events`, `payment.events`) using a single KafkaJS consumer group (`analytics-service-group`). All events are validated against Zod schemas from the `@florea-alex/order-events-schemas` library before processing. Correlation IDs from Kafka message headers enable distributed tracing across the platform.

- **CQRS Read Model**: This service implements the read side of a CQRS pattern. It builds materialized views (pre-aggregated metrics) from the event stream. Aggregation happens at write time (when events are consumed), so reads are fast. The service makes zero HTTP calls to other services — it gets all data from Kafka events.

- **Repository Pattern for Database Access**: All database operations are encapsulated in repository functions for metrics queries and event log management. This isolates SQL queries from business logic and makes testing easier by allowing database mocking.

- **API Response Format**: All REST endpoints return a standardized JSON structure with `success`, `data`, `error`, and `timestamp` fields. This matches the platform-wide convention used across all microservices.

- **Environment Variables Naming**: Uses uppercase snake_case (DB_HOST, KAFKA_BROKERS, LOG_LEVEL, NODE_ENV) with sensible defaults for local development, consistent with other services in the platform.

### Component-Specific Patterns

- **Pre-Aggregated Metrics**: Metrics are computed and stored at event consumption time using PostgreSQL UPSERT (`INSERT ... ON CONFLICT DO UPDATE`). Daily metrics, hourly counts, and per-product stats are updated incrementally. This avoids expensive query-time aggregation.

- **Event Log for Replay**: Raw events are stored in `events_log` alongside aggregated metrics. If aggregation logic changes, metrics can be rebuilt by replaying from the event log.

- **Idempotent Event Processing**: The `events_log` table has a UNIQUE constraint on `(event_type, order_id)`. Duplicate events (from Kafka redelivery) are silently skipped via `ON CONFLICT DO NOTHING`.

## Component Details

**Purpose**: Event-sourced analytics service. Consumes all Kafka events from order.events and payment.events topics to build pre-aggregated metrics (daily/hourly revenue, order counts, product performance, conversion funnel). Exposes admin-only REST API for the analytics dashboard. Pure event consumer — zero HTTP calls to other services.
**Tech Stack**: JavaScript (Node.js), Express 4.18, KafkaJS 2.2, PostgreSQL (pg 8.11), Winston (logging)
**Architecture**: Event-driven consumer with Express REST API and PostgreSQL persistence

**Key Directories**:
- `src/` - Source code
  - `index.js` - Main service entry point: initializes database, starts Express server, starts Kafka consumer, handles graceful shutdown
  - `db.js` - PostgreSQL connection pool, migration runner, health checks
  - `kafka.js` - Kafka consumer setup for both order.events and payment.events topics
  - `processor.js` - Event processing logic: maps each event type to metric updates
  - `repository.js` - Database queries for reading aggregated metrics (overview, revenue, orders, products, conversion)
- `migrations/` - Database migrations
  - `001_create_analytics_tables.sql` - Creates events_log, daily_metrics, product_metrics, hourly_order_counts tables
- `__tests__/` - Test suite

## Dependencies

**Database**:
- PostgreSQL
  - Database: `analytics_service`
  - Connection pool: pg 8.11
  - Auto-runs migrations on startup from `migrations/` directory
  - Tables:
    - `events_log` - Raw event log for replay/debugging (UNIQUE on event_type + order_id for dedup)
    - `daily_metrics` - Pre-aggregated daily stats (UNIQUE on date)
    - `product_metrics` - Per-product aggregations (UNIQUE on product_id)
    - `hourly_order_counts` - Hourly time series for charts (UNIQUE on hour_bucket)

**Message Queues**:
- Kafka (via KafkaJS 2.2)
  - Consumer group: Defined by `CONSUMER_GROUPS.ANALYTICS_SERVICE` from shared schemas (`analytics-service-group`)
  - Topics:
    - `TOPICS.ORDER_EVENTS` - Order lifecycle events (order.created, order.confirmed, order.shipped, order.cancelled)
    - `TOPICS.PAYMENT_EVENTS` - Payment processing events (payment.authorized, payment.failed)
  - Default broker: localhost:9092

**External Libraries**:
- `@florea-alex/order-events-schemas` - Shared schema library for event validation, topic names, and consumer group constants
- `express` 4.18 - Web framework for REST API
- `pg` 8.11 - PostgreSQL client for Node.js
- `winston` 3.x - Structured JSON logging
- `uuid` 9.x - UUID generation for correlation IDs

**Environment Variables**:
- `PORT` - Express server port (default: 3007)
- `DB_HOST` - PostgreSQL host (default: localhost)
- `DB_PORT` - PostgreSQL port (default: 5432)
- `DB_NAME` - Database name (default: analytics_service)
- `DB_USER` - Database user (default: postgres)
- `DB_PASSWORD` - Database password (default: postgres)
- `DB_POOL_MAX` - Max connections in pool (default: 10)
- `DB_SSL` - Enable SSL for database connection (default: false)
- `KAFKA_BROKERS` - Comma-separated Kafka broker addresses (default: localhost:9092)
- `KAFKA_CLIENT_ID` - Kafka client identifier (default: analytics-service)
- `KAFKA_GROUP_ID` - Consumer group ID (default: from shared schemas CONSUMER_GROUPS.ANALYTICS_SERVICE)
- `LOG_LEVEL` - Winston log level (default: info)
- `NODE_ENV` - Environment (default: development)

## API Contracts

### REST Endpoints

**Authentication**: All endpoints (except `/health`) require `x-user-role: admin` header (injected by API Gateway). Returns 403 if not admin.

#### GET /analytics/overview
Dashboard summary with all-time and today's metrics.

**Response** (200):
```json
{
  "success": true,
  "data": {
    "totalOrders": 150,
    "totalRevenue": "4523.50",
    "averageOrderValue": "35.18",
    "paymentSuccessRate": 91.2,
    "ordersByStatus": {
      "created": 5,
      "confirmed": 80,
      "shipped": 55,
      "cancelled": 10
    },
    "todayOrders": 12,
    "todayRevenue": "389.99"
  },
  "error": null,
  "timestamp": "2026-02-17T12:00:00Z"
}
```

#### GET /analytics/revenue
Revenue time series with period grouping.

**Query Parameters**:
- `period` (optional) - Grouping: `daily` (default), `weekly`, `monthly`
- `from` (optional, date) - Start date (default: 30 days ago)
- `to` (optional, date) - End date (default: today)

**Response** (200):
```json
{
  "success": true,
  "data": {
    "period": "daily",
    "series": [
      { "date": "2026-02-01", "revenue": "523.50", "orders": 15 },
      { "date": "2026-02-02", "revenue": "312.00", "orders": 9 }
    ]
  },
  "error": null,
  "timestamp": "2026-02-17T12:00:00Z"
}
```

#### GET /analytics/orders
Order count time series by status.

**Query Parameters**:
- `period` (optional) - Grouping: `daily` (default), `weekly`, `monthly`
- `from` (optional, date) - Start date (default: 30 days ago)
- `to` (optional, date) - End date (default: today)

**Response** (200):
```json
{
  "success": true,
  "data": {
    "period": "daily",
    "series": [
      { "date": "2026-02-01", "created": 15, "confirmed": 13, "cancelled": 2, "shipped": 10 }
    ]
  },
  "error": null,
  "timestamp": "2026-02-17T12:00:00Z"
}
```

#### GET /analytics/products/top
Top products by revenue or quantity.

**Query Parameters**:
- `limit` (optional, number) - Max results (default: 10, max: 50)
- `sortBy` (optional) - Sort field: `revenue` (default) or `quantity`

**Response** (200):
```json
{
  "success": true,
  "data": [
    { "productId": 3, "totalQuantitySold": 45, "totalRevenue": "1350.00", "orderCount": 30, "lastOrderedAt": "2026-02-17T10:00:00Z" }
  ],
  "error": null,
  "timestamp": "2026-02-17T12:00:00Z"
}
```

#### GET /analytics/conversion
Conversion funnel with drop-off rates.

**Response** (200):
```json
{
  "success": true,
  "data": {
    "created": 150,
    "confirmed": 135,
    "shipped": 100,
    "cancelled": 15,
    "conversionRates": {
      "createdToConfirmed": 90.0,
      "confirmedToShipped": 74.1,
      "overallCompletionRate": 66.7
    }
  },
  "error": null,
  "timestamp": "2026-02-17T12:00:00Z"
}
```

#### GET /health
Health check for database and Kafka consumer. Public — no admin guard.

**Response** (200):
```json
{
  "status": "ok",
  "service": "analytics-service",
  "database": "connected",
  "kafka": { "consumer": "connected" }
}
```

**Response** (503):
```json
{
  "status": "degraded",
  "service": "analytics-service",
  "database": "disconnected",
  "kafka": { "consumer": "connected" }
}
```

### Events Published
*This component does not publish events — it only consumes.*

### Events Consumed

#### Topic: `TOPICS.ORDER_EVENTS`
Consumes order lifecycle events and **updates aggregated metrics**:
- `order.created` → Increment daily orders_created, hourly order_count
- `order.confirmed` → Increment daily orders_confirmed + revenue_confirmed, update product_metrics per item, increment hourly revenue
- `order.shipped` → Increment daily orders_shipped
- `order.cancelled` → Increment daily orders_cancelled + revenue_cancelled

#### Topic: `TOPICS.PAYMENT_EVENTS`
Consumes payment events and **updates payment metrics**:
- `payment.authorized` → Increment daily payment_success_count
- `payment.failed` → Increment daily payment_failure_count

**All events** are logged to `events_log` table for replay capability.

**Correlation ID Handling**:
- Extracted from Kafka message headers
- Falls back to event.correlationId
- Generates UUID if none provided

## Conventions

### System-Wide Conventions (include if relevant to this repo)

- **API Response Format**: All REST endpoints return standardized JSON with `{ success, data, error, timestamp }` structure. This matches the platform-wide convention for consistent error handling and response parsing across frontend and backend services.

- **Environment Variables Naming**: Uses uppercase snake_case (KAFKA_BROKERS, LOG_LEVEL, NODE_ENV) with sensible defaults for local development. This matches the naming convention across all services in the platform.

## Boundaries & Constraints

✅ **Responsibilities**:
- Consume ALL events from both Kafka topics (order.events, payment.events)
- Validate incoming events against shared schemas
- Maintain pre-aggregated metrics tables (daily, hourly, per-product)
- Store raw events in event log for replay capability
- Expose admin-only REST API for analytics queries
- Deduplicate events via unique constraint on events_log
- Track Kafka consumer health for health endpoint
- Gracefully shutdown: stop Kafka consumer → close Express server → close database pool

❌ **NOT Responsible For**:
- Publishing events to Kafka
- Making HTTP calls to other services (pure event consumer)
- User authentication (handled by Gateway)
- Modifying orders, products, or any other service's data
- Real-time streaming to the frontend (admin fetches on demand)

🚫 **Do NOT**:
- Make HTTP calls to Order Service, Product Service, or any other service
- Crash the consumer on individual message failures (log and skip)
- Double-count events (use events_log dedup constraint)
- Expose analytics endpoints without admin role check
- Store sensitive PII data in the events_log (only metadata and amounts)
- Auto-commit Kafka offsets before successful processing

---

*This file was auto-generated by Atelier. Update it as the component evolves.*
