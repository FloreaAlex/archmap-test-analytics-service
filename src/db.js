const { Pool } = require('pg');
const fs = require('fs').promises;
const path = require('path');
const logger = require('./logger');

let pool = null;

/**
 * Initialize database connection pool (lazy singleton)
 */
function getPool() {
  if (!pool) {
    pool = new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME || 'analytics_service',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
      max: parseInt(process.env.DB_POOL_MAX || '10', 10),
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
    });

    pool.on('error', (err) => {
      logger.error('Unexpected error on idle database client', {
        error: err.message,
        stack: err.stack
      });
    });

    logger.info('Database connection pool initialized', {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME || 'analytics_service',
      maxConnections: parseInt(process.env.DB_POOL_MAX || '10', 10)
    });
  }

  return pool;
}

/**
 * Run database migrations from migrations/ directory
 */
async function runMigrations() {
  const client = getPool();

  try {
    const migrationsDir = path.join(__dirname, '..', 'migrations');
    const files = await fs.readdir(migrationsDir);
    const sqlFiles = files.filter(f => f.endsWith('.sql')).sort();

    logger.info('Running database migrations', {
      count: sqlFiles.length,
      files: sqlFiles
    });

    for (const file of sqlFiles) {
      const filePath = path.join(migrationsDir, file);
      const sql = await fs.readFile(filePath, 'utf-8');

      logger.info('Executing migration', { file });
      await client.query(sql);
      logger.info('Migration completed', { file });
    }

    logger.info('All database migrations completed successfully');
  } catch (error) {
    logger.error('Failed to run database migrations', {
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

/**
 * Initialize database: run migrations
 */
async function initDatabase() {
  try {
    logger.info('Initializing database');
    await runMigrations();
    logger.info('Database initialization completed successfully');
  } catch (error) {
    logger.error('Database initialization failed', {
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

/**
 * Close database connection pool
 */
async function closePool() {
  if (pool) {
    try {
      await pool.end();
      pool = null;
      logger.info('Database connection pool closed');
    } catch (error) {
      logger.error('Error closing database pool', {
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }
}

/**
 * Check database health
 */
async function checkHealth() {
  try {
    const client = getPool();
    await client.query('SELECT 1');
    return true;
  } catch (error) {
    logger.error('Database health check failed', {
      error: error.message,
      stack: error.stack
    });
    return false;
  }
}

module.exports = {
  getPool,
  initDatabase,
  closePool,
  checkHealth
};
