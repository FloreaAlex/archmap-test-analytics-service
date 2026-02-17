# Analytics Service

Event-sourced analytics service for the Archmap Test Platform. Consumes all Kafka events from order and payment topics, builds pre-aggregated metrics in PostgreSQL, and exposes an admin-only REST API for the analytics dashboard.

## Quick Start

```bash
# Install dependencies
npm install

# Start service (requires PostgreSQL + Kafka)
npm start

# Run tests
npm test
```

## Configuration

Copy `.env.example` to `.env` and adjust values. All environment variables have sensible defaults for local development.

## API Endpoints

All analytics endpoints require `x-user-role: admin` header.

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Health check (public) |
| GET | /analytics/overview | Dashboard summary |
| GET | /analytics/revenue | Revenue time series |
| GET | /analytics/orders | Orders by status time series |
| GET | /analytics/products/top | Top products |
| GET | /analytics/conversion | Conversion funnel |

## Docker

```bash
docker build -t analytics-service .
docker run -p 3007:3007 analytics-service
```
