// Set NODE_ENV to test BEFORE requiring anything
process.env.NODE_ENV = 'test';

// Mock pg module
const mockQuery = jest.fn();
const mockEnd = jest.fn();
const mockOn = jest.fn();

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: mockQuery,
    end: mockEnd,
    on: mockOn,
  })),
}));

// Mock Kafka consumer
jest.mock('../src/kafka', () => ({
  startConsumer: jest.fn().mockResolvedValue(),
  stopConsumer: jest.fn().mockResolvedValue(),
  getHealthStatus: jest.fn().mockReturnValue('connected')
}));

const request = require('supertest');
const app = require('../src/index');

describe('Analytics Service', () => {
  beforeEach(() => {
    mockQuery.mockClear();
  });

  // ---- Health Check ----
  describe('GET /health', () => {
    it('should return 200 when healthy', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        status: 'ok',
        service: 'analytics-service',
        database: 'connected',
        kafka: { consumer: 'connected' }
      });
    });

    it('should return 503 when database is down', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Connection refused'));

      const response = await request(app).get('/health');

      expect(response.status).toBe(503);
      expect(response.body.status).toBe('error');
      expect(response.body.database).toBe('disconnected');
    });
  });

  // ---- Admin Guard ----
  describe('Admin Guard', () => {
    it('should return 403 without admin role', async () => {
      const response = await request(app).get('/analytics/overview');

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({
        success: false,
        error: 'Admin access required'
      });
    });

    it('should return 403 with non-admin role', async () => {
      const response = await request(app)
        .get('/analytics/overview')
        .set('x-user-role', 'customer');

      expect(response.status).toBe(403);
      expect(response.body.success).toBe(false);
    });

    it('should allow admin access', async () => {
      // Mock the two queries for overview (totals + today)
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            total_orders: '10', orders_confirmed: '8', orders_cancelled: '2',
            orders_shipped: '5', total_revenue: '500.00',
            payment_success: '8', payment_failure: '2'
          }]
        })
        .mockResolvedValueOnce({
          rows: [{ today_orders: '3', today_revenue: '150.00' }]
        });

      const response = await request(app)
        .get('/analytics/overview')
        .set('x-user-role', 'admin');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  // ---- GET /analytics/overview ----
  describe('GET /analytics/overview', () => {
    it('should return correct aggregated overview', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            total_orders: '150', orders_confirmed: '135', orders_cancelled: '15',
            orders_shipped: '100', total_revenue: '4523.50',
            payment_success: '135', payment_failure: '15'
          }]
        })
        .mockResolvedValueOnce({
          rows: [{ today_orders: '12', today_revenue: '389.99' }]
        });

      const response = await request(app)
        .get('/analytics/overview')
        .set('x-user-role', 'admin');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      const data = response.body.data;
      expect(data.totalOrders).toBe(150);
      expect(data.totalRevenue).toBe('4523.50');
      expect(data.averageOrderValue).toBe('30.16');
      expect(data.paymentSuccessRate).toBe(90);
      expect(data.ordersByStatus).toMatchObject({
        created: 0,
        confirmed: 35,
        shipped: 100,
        cancelled: 15
      });
      expect(data.todayOrders).toBe(12);
      expect(data.todayRevenue).toBe('389.99');
    });

    it('should handle empty metrics', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            total_orders: '0', orders_confirmed: '0', orders_cancelled: '0',
            orders_shipped: '0', total_revenue: '0',
            payment_success: '0', payment_failure: '0'
          }]
        })
        .mockResolvedValueOnce({ rows: [] });

      const response = await request(app)
        .get('/analytics/overview')
        .set('x-user-role', 'admin');

      expect(response.status).toBe(200);
      const data = response.body.data;
      expect(data.totalOrders).toBe(0);
      expect(data.totalRevenue).toBe('0.00');
      expect(data.averageOrderValue).toBe('0.00');
      expect(data.paymentSuccessRate).toBe(0);
      expect(data.todayOrders).toBe(0);
      expect(data.todayRevenue).toBe('0.00');
    });

    it('should return 500 on database error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB error'));

      const response = await request(app)
        .get('/analytics/overview')
        .set('x-user-role', 'admin');

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Internal server error');
    });
  });

  // ---- GET /analytics/revenue ----
  describe('GET /analytics/revenue', () => {
    it('should return revenue time series with default period', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { date: '2026-02-01', revenue: '523.50', orders: '15' },
          { date: '2026-02-02', revenue: '312.00', orders: '9' }
        ]
      });

      const response = await request(app)
        .get('/analytics/revenue?from=2026-02-01&to=2026-02-02')
        .set('x-user-role', 'admin');

      expect(response.status).toBe(200);
      expect(response.body.data.period).toBe('daily');
      expect(response.body.data.series).toHaveLength(2);
      expect(response.body.data.series[0]).toMatchObject({
        date: '2026-02-01',
        revenue: '523.50',
        orders: 15
      });
    });

    it('should accept weekly period', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await request(app)
        .get('/analytics/revenue?period=weekly&from=2026-01-01&to=2026-02-01')
        .set('x-user-role', 'admin');

      expect(response.status).toBe(200);
      expect(response.body.data.period).toBe('weekly');
    });

    it('should accept monthly period', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await request(app)
        .get('/analytics/revenue?period=monthly&from=2026-01-01&to=2026-02-01')
        .set('x-user-role', 'admin');

      expect(response.status).toBe(200);
      expect(response.body.data.period).toBe('monthly');
    });

    it('should reject invalid period', async () => {
      const response = await request(app)
        .get('/analytics/revenue?period=yearly')
        .set('x-user-role', 'admin');

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });
  });

  // ---- GET /analytics/orders ----
  describe('GET /analytics/orders', () => {
    it('should return orders time series by status', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { date: '2026-02-01', created: '15', confirmed: '13', cancelled: '2', shipped: '10' }
        ]
      });

      const response = await request(app)
        .get('/analytics/orders?from=2026-02-01&to=2026-02-01')
        .set('x-user-role', 'admin');

      expect(response.status).toBe(200);
      expect(response.body.data.period).toBe('daily');
      expect(response.body.data.series[0]).toMatchObject({
        date: '2026-02-01',
        created: 15,
        confirmed: 13,
        cancelled: 2,
        shipped: 10
      });
    });

    it('should reject invalid period', async () => {
      const response = await request(app)
        .get('/analytics/orders?period=hourly')
        .set('x-user-role', 'admin');

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });
  });

  // ---- GET /analytics/products/top ----
  describe('GET /analytics/products/top', () => {
    it('should return top products by revenue', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            product_id: 3,
            total_quantity_sold: '45',
            total_revenue: '1350.00',
            order_count: '30',
            last_ordered_at: new Date('2026-02-17T10:00:00Z')
          }
        ]
      });

      const response = await request(app)
        .get('/analytics/products/top')
        .set('x-user-role', 'admin');

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0]).toMatchObject({
        productId: 3,
        totalQuantitySold: 45,
        totalRevenue: '1350.00',
        orderCount: 30
      });
      expect(response.body.data[0].lastOrderedAt).toBeDefined();
    });

    it('should respect limit parameter', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await request(app)
        .get('/analytics/products/top?limit=5')
        .set('x-user-role', 'admin');

      expect(response.status).toBe(200);
      // Verify limit was passed to query
      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        [5]
      );
    });

    it('should cap limit at 50', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await request(app)
        .get('/analytics/products/top?limit=100')
        .set('x-user-role', 'admin');

      expect(response.status).toBe(200);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        [50]
      );
    });

    it('should sort by quantity when requested', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await request(app)
        .get('/analytics/products/top?sortBy=quantity')
        .set('x-user-role', 'admin');

      expect(response.status).toBe(200);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('total_quantity_sold'),
        expect.any(Array)
      );
    });
  });

  // ---- GET /analytics/conversion ----
  describe('GET /analytics/conversion', () => {
    it('should return conversion funnel data', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          created: '150', confirmed: '135', shipped: '100', cancelled: '15'
        }]
      });

      const response = await request(app)
        .get('/analytics/conversion')
        .set('x-user-role', 'admin');

      expect(response.status).toBe(200);
      const data = response.body.data;
      expect(data.created).toBe(150);
      expect(data.confirmed).toBe(135);
      expect(data.shipped).toBe(100);
      expect(data.cancelled).toBe(15);
      expect(data.conversionRates.createdToConfirmed).toBe(90);
      expect(data.conversionRates.confirmedToShipped).toBe(74.1);
      expect(data.conversionRates.overallCompletionRate).toBe(66.7);
    });

    it('should handle zero values without division errors', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          created: '0', confirmed: '0', shipped: '0', cancelled: '0'
        }]
      });

      const response = await request(app)
        .get('/analytics/conversion')
        .set('x-user-role', 'admin');

      expect(response.status).toBe(200);
      const rates = response.body.data.conversionRates;
      expect(rates.createdToConfirmed).toBe(0);
      expect(rates.confirmedToShipped).toBe(0);
      expect(rates.overallCompletionRate).toBe(0);
    });
  });

  // ---- Correlation ID ----
  describe('Correlation ID', () => {
    it('should return correlation ID in response headers', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

      const response = await request(app).get('/health');

      expect(response.headers['x-correlation-id']).toBeDefined();
    });

    it('should forward provided correlation ID', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

      const response = await request(app)
        .get('/health')
        .set('x-correlation-id', 'test-corr-id');

      expect(response.headers['x-correlation-id']).toBe('test-corr-id');
    });
  });
});

// ---- Event Processor Tests ----
describe('Event Processor', () => {
  // We need a fresh require with fresh mocks for processor tests
  const repository = require('../src/repository');

  beforeEach(() => {
    mockQuery.mockClear();
  });

  describe('processEvent', () => {
    // Import after mocks are set up
    const { processEvent } = require('../src/processor');

    it('should process order.created event', async () => {
      // insertEvent returns id (not duplicate)
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });
      // upsertDailyMetrics
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // upsertHourlyMetrics
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const event = {
        type: 'order.created',
        orderId: 1,
        userId: 10,
        data: { items: [{ productId: 1, quantity: 2, price: 29.99 }], totalAmount: 59.98 }
      };

      const result = await processEvent(event, 'test-corr');
      expect(result).toBe(true);
      expect(mockQuery).toHaveBeenCalledTimes(3);
    });

    it('should process order.confirmed event with product metrics', async () => {
      // insertEvent
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 2 }] });
      // upsertDailyMetrics
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // upsertHourlyMetrics
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // upsertProductMetrics for item 1
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // upsertProductMetrics for item 2
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const event = {
        type: 'order.confirmed',
        orderId: 2,
        userId: 10,
        data: {
          items: [
            { productId: 1, quantity: 2, price: 29.99 },
            { productId: 3, quantity: 1, price: 15.00 }
          ],
          totalAmount: 74.98
        }
      };

      const result = await processEvent(event, 'test-corr');
      expect(result).toBe(true);
      // insertEvent + daily + hourly + 2 product metrics = 5
      expect(mockQuery).toHaveBeenCalledTimes(5);
    });

    it('should process order.cancelled event', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 3 }] });
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const event = {
        type: 'order.cancelled',
        orderId: 3,
        userId: 10,
        data: { reason: 'payment failed', cancelledBy: 'system', totalAmount: 59.98 }
      };

      const result = await processEvent(event, 'test-corr');
      expect(result).toBe(true);
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('should process order.shipped event', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 4 }] });
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const event = {
        type: 'order.shipped',
        orderId: 4,
        userId: 10,
        data: { trackingNumber: '1Z999AA1' }
      };

      const result = await processEvent(event, 'test-corr');
      expect(result).toBe(true);
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('should process payment.authorized event', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 5 }] });
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const event = {
        type: 'payment.authorized',
        orderId: 5,
        userId: 10,
        data: { amount: 99.99, currency: 'USD', transactionId: 'txn-123' }
      };

      const result = await processEvent(event, 'test-corr');
      expect(result).toBe(true);
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('should process payment.failed event', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 6 }] });
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const event = {
        type: 'payment.failed',
        orderId: 6,
        userId: 10,
        data: { reason: 'Insufficient funds', retryable: false }
      };

      const result = await processEvent(event, 'test-corr');
      expect(result).toBe(true);
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('should skip duplicate events (idempotency)', async () => {
      // insertEvent returns no rows (conflict/duplicate)
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const event = {
        type: 'order.created',
        orderId: 1,
        userId: 10,
        data: { items: [], totalAmount: 0 }
      };

      const result = await processEvent(event, 'test-corr');
      expect(result).toBe(false);
      // Only the insertEvent query should have been called
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });
  });
});
