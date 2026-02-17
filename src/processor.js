const { EVENT_TYPES } = require('@florea-alex/order-events-schemas');
const repository = require('./repository');
const logger = require('./logger');

/**
 * Process a validated Kafka event into analytics metrics.
 * Idempotent: duplicate events are skipped via events_log unique constraint.
 */
async function processEvent(event, correlationId) {
  const { type, orderId, userId, data } = event;
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  // Truncate to hour for hourly bucketing
  const hourBucket = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());

  const childLogger = logger.child({ correlationId, orderId, eventType: type });

  // 1. Insert into events_log (idempotency check)
  const eventId = await repository.insertEvent(type, orderId, userId, correlationId, data);

  if (eventId === null) {
    childLogger.info('Duplicate event skipped');
    return false;
  }

  childLogger.info('Processing event');

  // 2. Update metrics based on event type
  switch (type) {
    case EVENT_TYPES.ORDER_CREATED: {
      await repository.upsertDailyMetrics(today, { ordersCreated: 1 });
      await repository.upsertHourlyMetrics(hourBucket, 1, 0);
      break;
    }

    case EVENT_TYPES.ORDER_CONFIRMED: {
      const totalAmount = data?.totalAmount || 0;
      await repository.upsertDailyMetrics(today, {
        ordersConfirmed: 1,
        revenueConfirmed: totalAmount
      });
      await repository.upsertHourlyMetrics(hourBucket, 0, totalAmount);

      // Update product metrics for each item
      if (data?.items && Array.isArray(data.items)) {
        for (const item of data.items) {
          const itemRevenue = (item.price || 0) * (item.quantity || 0);
          await repository.upsertProductMetrics(
            item.productId,
            item.quantity || 0,
            itemRevenue,
            now
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
      });
      break;
    }

    case EVENT_TYPES.ORDER_SHIPPED: {
      await repository.upsertDailyMetrics(today, { ordersShipped: 1 });
      break;
    }

    case EVENT_TYPES.PAYMENT_AUTHORIZED: {
      await repository.upsertDailyMetrics(today, { paymentSuccessCount: 1 });
      break;
    }

    case EVENT_TYPES.PAYMENT_FAILED: {
      await repository.upsertDailyMetrics(today, { paymentFailureCount: 1 });
      break;
    }

    default:
      childLogger.warn('Unknown event type, logged but not aggregated', { type });
  }

  childLogger.info('Event processed successfully');
  return true;
}

module.exports = { processEvent };
