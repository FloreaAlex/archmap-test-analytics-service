const { getPool } = require('./db');
const logger = require('./logger');

/**
 * Insert an event into events_log. Returns the inserted row id, or null if duplicate.
 * Uses ON CONFLICT DO NOTHING for idempotency.
 */
async function insertEvent(eventType, orderId, userId, correlationId, data) {
  const result = await getPool().query(
    `INSERT INTO events_log (event_type, order_id, user_id, correlation_id, data)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (event_type, order_id) DO NOTHING
     RETURNING id`,
    [eventType, orderId, userId, correlationId, JSON.stringify(data)]
  );
  return result.rows.length > 0 ? result.rows[0].id : null;
}

/**
 * UPSERT daily_metrics for a given date with increments.
 */
async function upsertDailyMetrics(date, increments) {
  const {
    ordersCreated = 0,
    ordersConfirmed = 0,
    ordersCancelled = 0,
    ordersShipped = 0,
    revenueConfirmed = 0,
    revenueCancelled = 0,
    paymentSuccessCount = 0,
    paymentFailureCount = 0
  } = increments;

  await getPool().query(
    `INSERT INTO daily_metrics (date, orders_created, orders_confirmed, orders_cancelled, orders_shipped, revenue_confirmed, revenue_cancelled, payment_success_count, payment_failure_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (date) DO UPDATE SET
       orders_created = daily_metrics.orders_created + EXCLUDED.orders_created,
       orders_confirmed = daily_metrics.orders_confirmed + EXCLUDED.orders_confirmed,
       orders_cancelled = daily_metrics.orders_cancelled + EXCLUDED.orders_cancelled,
       orders_shipped = daily_metrics.orders_shipped + EXCLUDED.orders_shipped,
       revenue_confirmed = daily_metrics.revenue_confirmed + EXCLUDED.revenue_confirmed,
       revenue_cancelled = daily_metrics.revenue_cancelled + EXCLUDED.revenue_cancelled,
       payment_success_count = daily_metrics.payment_success_count + EXCLUDED.payment_success_count,
       payment_failure_count = daily_metrics.payment_failure_count + EXCLUDED.payment_failure_count`,
    [date, ordersCreated, ordersConfirmed, ordersCancelled, ordersShipped, revenueConfirmed, revenueCancelled, paymentSuccessCount, paymentFailureCount]
  );
}

/**
 * UPSERT hourly_order_counts for a given hour bucket.
 */
async function upsertHourlyMetrics(hourBucket, orderCountIncrement, revenueIncrement) {
  await getPool().query(
    `INSERT INTO hourly_order_counts (hour_bucket, order_count, revenue)
     VALUES ($1, $2, $3)
     ON CONFLICT (hour_bucket) DO UPDATE SET
       order_count = hourly_order_counts.order_count + EXCLUDED.order_count,
       revenue = hourly_order_counts.revenue + EXCLUDED.revenue`,
    [hourBucket, orderCountIncrement, revenueIncrement]
  );
}

/**
 * UPSERT product_metrics for a given product.
 */
async function upsertProductMetrics(productId, quantitySold, revenue, now) {
  await getPool().query(
    `INSERT INTO product_metrics (product_id, total_quantity_sold, total_revenue, order_count, last_ordered_at)
     VALUES ($1, $2, $3, 1, $4)
     ON CONFLICT (product_id) DO UPDATE SET
       total_quantity_sold = product_metrics.total_quantity_sold + EXCLUDED.total_quantity_sold,
       total_revenue = product_metrics.total_revenue + EXCLUDED.total_revenue,
       order_count = product_metrics.order_count + 1,
       last_ordered_at = EXCLUDED.last_ordered_at`,
    [productId, quantitySold, revenue, now]
  );
}

/**
 * Get aggregated overview metrics (totals from daily_metrics).
 */
async function getOverview() {
  const pool = getPool();

  // All-time totals
  const totalsResult = await pool.query(
    `SELECT
       COALESCE(SUM(orders_created), 0) AS total_orders,
       COALESCE(SUM(orders_confirmed), 0) AS orders_confirmed,
       COALESCE(SUM(orders_cancelled), 0) AS orders_cancelled,
       COALESCE(SUM(orders_shipped), 0) AS orders_shipped,
       COALESCE(SUM(revenue_confirmed), 0) AS total_revenue,
       COALESCE(SUM(payment_success_count), 0) AS payment_success,
       COALESCE(SUM(payment_failure_count), 0) AS payment_failure
     FROM daily_metrics`
  );

  // Today's metrics
  const todayResult = await pool.query(
    `SELECT
       COALESCE(orders_created, 0) AS today_orders,
       COALESCE(revenue_confirmed, 0) AS today_revenue
     FROM daily_metrics
     WHERE date = CURRENT_DATE`
  );

  const totals = totalsResult.rows[0];
  const today = todayResult.rows[0] || { today_orders: 0, today_revenue: '0' };

  const totalOrders = parseInt(totals.total_orders, 10);
  const totalRevenue = parseFloat(totals.total_revenue);
  const paymentSuccess = parseInt(totals.payment_success, 10);
  const paymentFailure = parseInt(totals.payment_failure, 10);
  const paymentTotal = paymentSuccess + paymentFailure;

  return {
    totalOrders,
    totalRevenue: totalRevenue.toFixed(2),
    averageOrderValue: totalOrders > 0 ? (totalRevenue / totalOrders).toFixed(2) : '0.00',
    paymentSuccessRate: paymentTotal > 0 ? parseFloat(((paymentSuccess / paymentTotal) * 100).toFixed(1)) : 0,
    ordersByStatus: {
      created: totalOrders - parseInt(totals.orders_confirmed, 10) - parseInt(totals.orders_cancelled, 10),
      confirmed: parseInt(totals.orders_confirmed, 10) - parseInt(totals.orders_shipped, 10),
      shipped: parseInt(totals.orders_shipped, 10),
      cancelled: parseInt(totals.orders_cancelled, 10)
    },
    todayOrders: parseInt(today.today_orders, 10),
    todayRevenue: parseFloat(today.today_revenue).toFixed(2)
  };
}

/**
 * Get revenue time series grouped by period.
 */
async function getRevenueSeries(period, from, to) {
  let dateExpr;
  switch (period) {
    case 'weekly':
      dateExpr = "date_trunc('week', date)::date";
      break;
    case 'monthly':
      dateExpr = "date_trunc('month', date)::date";
      break;
    default:
      dateExpr = 'date';
  }

  const result = await getPool().query(
    `SELECT
       ${dateExpr} AS date,
       COALESCE(SUM(revenue_confirmed), 0) AS revenue,
       COALESCE(SUM(orders_confirmed), 0) AS orders
     FROM daily_metrics
     WHERE date >= $1 AND date <= $2
     GROUP BY 1
     ORDER BY 1`,
    [from, to]
  );

  return result.rows.map(row => ({
    date: row.date instanceof Date ? row.date.toISOString().split('T')[0] : row.date,
    revenue: parseFloat(row.revenue).toFixed(2),
    orders: parseInt(row.orders, 10)
  }));
}

/**
 * Get order count time series by status grouped by period.
 */
async function getOrdersSeries(period, from, to) {
  let dateExpr;
  switch (period) {
    case 'weekly':
      dateExpr = "date_trunc('week', date)::date";
      break;
    case 'monthly':
      dateExpr = "date_trunc('month', date)::date";
      break;
    default:
      dateExpr = 'date';
  }

  const result = await getPool().query(
    `SELECT
       ${dateExpr} AS date,
       COALESCE(SUM(orders_created), 0) AS created,
       COALESCE(SUM(orders_confirmed), 0) AS confirmed,
       COALESCE(SUM(orders_cancelled), 0) AS cancelled,
       COALESCE(SUM(orders_shipped), 0) AS shipped
     FROM daily_metrics
     WHERE date >= $1 AND date <= $2
     GROUP BY 1
     ORDER BY 1`,
    [from, to]
  );

  return result.rows.map(row => ({
    date: row.date instanceof Date ? row.date.toISOString().split('T')[0] : row.date,
    created: parseInt(row.created, 10),
    confirmed: parseInt(row.confirmed, 10),
    cancelled: parseInt(row.cancelled, 10),
    shipped: parseInt(row.shipped, 10)
  }));
}

/**
 * Get top products by revenue or quantity.
 */
async function getTopProducts(limit, sortBy) {
  const orderColumn = sortBy === 'quantity' ? 'total_quantity_sold' : 'total_revenue';

  const result = await getPool().query(
    `SELECT product_id, total_quantity_sold, total_revenue, order_count, last_ordered_at
     FROM product_metrics
     ORDER BY ${orderColumn} DESC
     LIMIT $1`,
    [limit]
  );

  return result.rows.map(row => ({
    productId: row.product_id,
    totalQuantitySold: parseInt(row.total_quantity_sold, 10),
    totalRevenue: parseFloat(row.total_revenue).toFixed(2),
    orderCount: parseInt(row.order_count, 10),
    lastOrderedAt: row.last_ordered_at ? row.last_ordered_at.toISOString() : null
  }));
}

/**
 * Get conversion funnel metrics.
 */
async function getConversion() {
  const result = await getPool().query(
    `SELECT
       COALESCE(SUM(orders_created), 0) AS created,
       COALESCE(SUM(orders_confirmed), 0) AS confirmed,
       COALESCE(SUM(orders_shipped), 0) AS shipped,
       COALESCE(SUM(orders_cancelled), 0) AS cancelled
     FROM daily_metrics`
  );

  const row = result.rows[0];
  const created = parseInt(row.created, 10);
  const confirmed = parseInt(row.confirmed, 10);
  const shipped = parseInt(row.shipped, 10);
  const cancelled = parseInt(row.cancelled, 10);

  return {
    created,
    confirmed,
    shipped,
    cancelled,
    conversionRates: {
      createdToConfirmed: created > 0 ? parseFloat(((confirmed / created) * 100).toFixed(1)) : 0,
      confirmedToShipped: confirmed > 0 ? parseFloat(((shipped / confirmed) * 100).toFixed(1)) : 0,
      overallCompletionRate: created > 0 ? parseFloat(((shipped / created) * 100).toFixed(1)) : 0
    }
  };
}

module.exports = {
  insertEvent,
  upsertDailyMetrics,
  upsertHourlyMetrics,
  upsertProductMetrics,
  getOverview,
  getRevenueSeries,
  getOrdersSeries,
  getTopProducts,
  getConversion
};
