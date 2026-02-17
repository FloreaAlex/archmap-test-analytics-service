const { EVENT_TYPES } = require('@florea-alex/order-events-schemas');
const { getPool } = require('./db');
const repository = require('./repository');
const logger = require('./logger');

/**
 * Process a validated Kafka event into analytics metrics.
 * Idempotent: duplicate events are skipped via events_log unique constraint.
 * All writes for a single event are wrapped in a database transaction
 * to prevent partial metric updates on crash/failure.
 */
async function processEvent(event, correlationId) {
  const { type, orderId, userId, data } = event;
  const today = new Date().toISOString().split('T')[0];

  const childLogger = logger.child({ correlationId, orderId, eventType: type });

  // Acquire a dedicated client for the transaction
  const client = await getPool().connect();

  try {
    await client.query('BEGIN');

    // 1. Insert into events_log (idempotency check)
    const eventId = await repository.insertEvent(type, orderId, userId, correlationId, data, client);

    if (eventId === null) {
      await client.query('ROLLBACK');
      childLogger.info('Duplicate event skipped');
      return false;
    }

    childLogger.info('Processing event');

    // 2. Update metrics based on event type
    switch (type) {
      case EVENT_TYPES.ORDER_CREATED: {
        await repository.upsertDailyMetrics(today, { ordersCreated: 1 }, client);
        await repository.upsertHourlyMetrics(1, 0, client);
        break;
      }

      case EVENT_TYPES.ORDER_CONFIRMED: {
        const totalAmount = data?.totalAmount || 0;
        await repository.upsertDailyMetrics(today, {
          ordersConfirmed: 1,
          revenueConfirmed: totalAmount
        }, client);
        await repository.upsertHourlyMetrics(0, totalAmount, client);

        // Update product metrics for each item
        if (data?.items && Array.isArray(data.items)) {
          for (const item of data.items) {
            const itemRevenue = (item.price || 0) * (item.quantity || 0);
            await repository.upsertProductMetrics(
              item.productId,
              item.quantity || 0,
              itemRevenue,
              new Date(),
              client
            );
          }
        }
        break;
      }

      case EVENT_TYPES.ORDER_CANCELLED: {
        const cancelledAmount = data?.totalAmount || 0;
        await repository.upsertDailyMetrics(today, {
          ordersCancelled: 1,
          revenueCancelled: cancelledAmount
        }, client);
        break;
      }

      case EVENT_TYPES.ORDER_SHIPPED: {
        await repository.upsertDailyMetrics(today, { ordersShipped: 1 }, client);
        break;
      }

      case EVENT_TYPES.PAYMENT_AUTHORIZED: {
        await repository.upsertDailyMetrics(today, { paymentSuccessCount: 1 }, client);
        break;
      }

      case EVENT_TYPES.PAYMENT_FAILED: {
        await repository.upsertDailyMetrics(today, { paymentFailureCount: 1 }, client);
        break;
      }

      default:
        childLogger.warn('Unknown event type, logged but not aggregated', { type });
    }

    await client.query('COMMIT');
    childLogger.info('Event processed successfully');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    childLogger.error('Event processing failed, transaction rolled back', {
      error: error.message,
      stack: error.stack
    });
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { processEvent };
