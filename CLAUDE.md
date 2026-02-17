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

### System-Wide Patterns

- **Event-Driven Architecture**: Consume events from Kafka topics (`order.events`, `payment.events`). Validate against Zod schemas from `@florea-alex/order-events-schemas`. Propagate correlation IDs from Kafka message headers for distributed tracing.

- **CQRS Read Model**: This service is the read side — it builds materialized views from the event stream. Pre-aggregate at write time so reads are fast. Zero HTTP calls to other services.

- **Repository Pattern for Database Access**: Encapsulate database operations in repository functions. Isolate SQL from business logic for testability.

- **API Response Format**: `{ success, data, error, timestamp }` — matches all other services.

- **Environment Variables Naming**: `SCREAMING_SNAKE_CASE` with `DB_*` and `KAFKA_*` prefixes. Sensible defaults for local dev.

## Conventions

- **API Response Format**: All REST endpoints return `{ success: boolean, data: any, error: string | null, timestamp: ISO8601 }`.
- **Environment Variables**: `SCREAMING_SNAKE_CASE`. DB_HOST, KAFKA_BROKERS, LOG_LEVEL, etc.
- **Correlation IDs**: Extract from Kafka message headers, fall back to event.correlationId, generate UUID if none. Attach to all log entries.
- **Logging**: Winston with structured JSON. Fields: timestamp, level, message, service, correlationId.
- **Health Check**: `GET /health` returns DB and Kafka consumer status. Public (no admin guard).
- **Admin Guard**: All analytics endpoints (except /health) require `x-user-role: admin` header. Defense-in-depth — Gateway also enforces.
- **Testing**: Jest + Supertest. Mock Kafka and database. Follow patterns from other services.

## Boundaries & Constraints

✅ **Responsibilities**:
- Consume ALL events from both Kafka topics (order.events, payment.events)
- Validate incoming events against shared schemas
- Build and maintain pre-aggregated metrics
- Store raw events for replay capability
- Expose admin-only REST API for analytics queries
- Deduplicate events to prevent double-counting
- Gracefully shutdown: stop Kafka consumer → close Express server → close database pool

❌ **NOT Responsible For**:
- Publishing events to Kafka
- Making HTTP calls to other services (pure event consumer)
- User authentication (handled by Gateway)
- Modifying orders, products, or any other service's data

🚫 **Do NOT**:
- Make HTTP calls to Order Service, Product Service, or any other service
- Crash the consumer on individual message failures (log and skip)
- Double-count events on Kafka redelivery
- Expose analytics endpoints without admin role check
- Store sensitive PII data (only metadata and amounts)
- Auto-commit Kafka offsets before successful processing

## Implementation Details

### Project Structure

```
archmap-test-analytics-service/
├── src/
│   ├── index.js          # Express app + routes + startup/shutdown
│   ├── db.js             # PostgreSQL pool + migrations runner
│   ├── kafka.js          # Kafka consumer (both topics)
│   ├── processor.js      # Event processing logic (event → metrics)
│   ├── repository.js     # Database queries (UPSERT + read queries)
│   └── logger.js         # Winston logger configuration
├── migrations/
│   └── 001_create_analytics_tables.sql
├── __tests__/
│   └── index.test.js     # Jest + Supertest tests (29 tests)
├── Dockerfile
├── package.json
├── .env.example
├── .gitignore
└── .github/workflows/ci.yml
```

### Tech Stack
- **Express.js** — HTTP server (port 3007)
- **PostgreSQL** — Metrics storage (analytics_service database)
- **KafkaJS** — Event consumer (order.events + payment.events)
- **Winston** — Structured JSON logging
- **@florea-alex/order-events-schemas** — Shared event validation

### Kafka Consumer
- Consumer group: `analytics-service-group` (from `CONSUMER_GROUPS.ANALYTICS_SERVICE`)
- Subscribes to both `order.events` and `payment.events` topics
- Validates events with `validateEvent()` from shared schemas
- Processes all 6 event types into pre-aggregated metrics
- Retry policy: 8 retries, 300ms initial, 30s max

### Event Processing & Idempotency
- Events are deduplicated via `events_log` table with UNIQUE index on `(event_type, order_id)`
- Uses `INSERT ... ON CONFLICT DO NOTHING RETURNING id` — if no row returned, skip processing
- Metrics updated with PostgreSQL UPSERT (`INSERT ... ON CONFLICT DO UPDATE`)

### Database Tables
- `events_log` — Raw event log for replay/debugging
- `daily_metrics` — Pre-aggregated daily stats
- `product_metrics` — Per-product aggregations
- `hourly_order_counts` — Hourly time series for charts

### Environment Variables
| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 3007 | HTTP server port |
| DB_HOST | localhost | PostgreSQL host |
| DB_PORT | 5432 | PostgreSQL port |
| DB_NAME | analytics_service | Database name |
| DB_USER | postgres | Database user |
| DB_PASSWORD | postgres | Database password |
| DB_POOL_MAX | 10 | Max pool connections |
| DB_SSL | false | Enable SSL |
| KAFKA_BROKERS | localhost:9092 | Kafka broker addresses |
| KAFKA_CLIENT_ID | analytics-service | Kafka client ID |
| LOG_LEVEL | info | Winston log level |

### Testing
- **Framework**: Jest + Supertest
- **29 tests** covering all endpoints, admin guard, event processing, idempotency, error handling
- **Mocking**: pg Pool, Kafka consumer — no external dependencies required
- Run: `npm test`

---

*This file was auto-generated by Atelier. Updated with implementation details.*
