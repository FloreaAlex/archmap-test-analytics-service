const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { checkHealth: checkDbHealth, initDatabase, closePool } = require('./db');
const { startConsumer, stopConsumer, getHealthStatus: getKafkaHealth } = require('./kafka');
const { processEvent } = require('./processor');
const repository = require('./repository');
const logger = require('./logger');

const app = express();
const PORT = process.env.PORT || 3007;

// Middleware
app.use(express.json());

// Correlation ID middleware
app.use((req, res, next) => {
  req.correlationId = req.headers['x-correlation-id'] || uuidv4();
  res.setHeader('x-correlation-id', req.correlationId);
  next();
});

// HTTP request logging middleware
app.use((req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info('HTTP request', {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration,
      correlationId: req.correlationId
    });
  });

  next();
});

// Admin guard middleware — defense-in-depth (Gateway also enforces)
function requireAdmin(req, res, next) {
  if (req.headers['x-user-role'] !== 'admin') {
    return res.status(403).json({
      success: false,
      data: null,
      error: 'Admin access required',
      timestamp: new Date().toISOString()
    });
  }
  next();
}

// ---- Routes ----

/**
 * GET /health
 * Health check (public, no admin guard)
 */
app.get('/health', async (req, res) => {
  const dbHealthy = await checkDbHealth();
  const kafkaStatus = getKafkaHealth();

  const status = dbHealthy && kafkaStatus === 'connected' ? 'ok' : 'error';
  const statusCode = status === 'ok' ? 200 : 503;

  res.status(statusCode).json({
    status,
    service: 'analytics-service',
    database: dbHealthy ? 'connected' : 'disconnected',
    kafka: { consumer: kafkaStatus }
  });
});

/**
 * GET /analytics/overview
 * Dashboard summary — admin only
 */
app.get('/analytics/overview', requireAdmin, async (req, res) => {
  try {
    const data = await repository.getOverview();
    res.json({
      success: true,
      data,
      error: null,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error fetching overview', { error: error.message, correlationId: req.correlationId });
    res.status(500).json({
      success: false,
      data: null,
      error: 'Internal server error',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /analytics/revenue
 * Revenue time series — admin only
 */
app.get('/analytics/revenue', requireAdmin, async (req, res) => {
  try {
    const period = req.query.period || 'daily';
    const to = req.query.to || new Date().toISOString().split('T')[0];
    const from = req.query.from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    if (!['daily', 'weekly', 'monthly'].includes(period)) {
      return res.status(400).json({
        success: false,
        data: null,
        error: 'Invalid period. Must be daily, weekly, or monthly.',
        timestamp: new Date().toISOString()
      });
    }

    const series = await repository.getRevenueSeries(period, from, to);
    res.json({
      success: true,
      data: { period, series },
      error: null,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error fetching revenue', { error: error.message, correlationId: req.correlationId });
    res.status(500).json({
      success: false,
      data: null,
      error: 'Internal server error',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /analytics/orders
 * Order count time series by status — admin only
 */
app.get('/analytics/orders', requireAdmin, async (req, res) => {
  try {
    const period = req.query.period || 'daily';
    const to = req.query.to || new Date().toISOString().split('T')[0];
    const from = req.query.from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    if (!['daily', 'weekly', 'monthly'].includes(period)) {
      return res.status(400).json({
        success: false,
        data: null,
        error: 'Invalid period. Must be daily, weekly, or monthly.',
        timestamp: new Date().toISOString()
      });
    }

    const series = await repository.getOrdersSeries(period, from, to);
    res.json({
      success: true,
      data: { period, series },
      error: null,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error fetching orders', { error: error.message, correlationId: req.correlationId });
    res.status(500).json({
      success: false,
      data: null,
      error: 'Internal server error',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /analytics/products/top
 * Top products by revenue or quantity — admin only
 */
app.get('/analytics/products/top', requireAdmin, async (req, res) => {
  try {
    let limit = parseInt(req.query.limit, 10) || 10;
    if (limit < 1) limit = 1;
    if (limit > 50) limit = 50;

    const sortBy = req.query.sortBy === 'quantity' ? 'quantity' : 'revenue';

    const data = await repository.getTopProducts(limit, sortBy);
    res.json({
      success: true,
      data,
      error: null,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error fetching top products', { error: error.message, correlationId: req.correlationId });
    res.status(500).json({
      success: false,
      data: null,
      error: 'Internal server error',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /analytics/conversion
 * Conversion funnel — admin only
 */
app.get('/analytics/conversion', requireAdmin, async (req, res) => {
  try {
    const data = await repository.getConversion();
    res.json({
      success: true,
      data,
      error: null,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error fetching conversion', { error: error.message, correlationId: req.correlationId });
    res.status(500).json({
      success: false,
      data: null,
      error: 'Internal server error',
      timestamp: new Date().toISOString()
    });
  }
});

// ---- Startup & Shutdown ----

let server = null;

const shutdown = async (signal) => {
  logger.info('Shutdown signal received', { signal });

  try {
    await stopConsumer();

    if (server) {
      await new Promise((resolve) => {
        server.close(() => {
          logger.info('Express server closed');
          resolve();
        });
      });
    }

    await closePool();
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown', { error: error.message });
    process.exit(1);
  }
};

const start = async () => {
  try {
    // Initialize database and run migrations
    await initDatabase();

    // Start Kafka consumer
    await startConsumer(processEvent);

    // Start HTTP server
    server = app.listen(PORT, () => {
      logger.info('Analytics service started', { port: PORT });
    });
  } catch (error) {
    logger.error('Failed to start service', { error: error.message });
    process.exit(1);
  }
};

// Only start if not in test mode
if (process.env.NODE_ENV !== 'test') {
  start();
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = app;
