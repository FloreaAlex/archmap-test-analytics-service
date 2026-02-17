const { Kafka } = require('kafkajs');
const { TOPICS, CONSUMER_GROUPS, validateEvent } = require('@florea-alex/order-events-schemas');
const logger = require('./logger');

const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
const KAFKA_CLIENT_ID = process.env.KAFKA_CLIENT_ID || 'analytics-service';
const KAFKA_GROUP_ID = CONSUMER_GROUPS.ANALYTICS_SERVICE;

const kafka = new Kafka({
  clientId: KAFKA_CLIENT_ID,
  brokers: KAFKA_BROKERS,
  retry: {
    retries: 8,
    initialRetryTime: 300,
    maxRetryTime: 30000
  }
});

const consumer = kafka.consumer({
  groupId: KAFKA_GROUP_ID,
  sessionTimeout: 30000,
  heartbeatInterval: 3000
});

let isRunning = false;

/**
 * Start the Kafka consumer, subscribing to both order and payment topics
 */
const startConsumer = async (messageHandler) => {
  if (isRunning) {
    logger.warn('Consumer already running');
    return;
  }

  await consumer.connect();

  // Subscribe to both topics
  await consumer.subscribe({ topic: TOPICS.ORDER_EVENTS, fromBeginning: false });
  await consumer.subscribe({ topic: TOPICS.PAYMENT_EVENTS, fromBeginning: false });

  logger.info('Kafka consumer started', {
    topics: [TOPICS.ORDER_EVENTS, TOPICS.PAYMENT_EVENTS],
    groupId: KAFKA_GROUP_ID,
    brokers: KAFKA_BROKERS
  });

  isRunning = true;

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      let correlationId = null;

      // Extract correlation ID from Kafka headers
      if (message.headers) {
        const headerValue = message.headers['x-correlation-id'] || message.headers.correlationId;
        if (headerValue) {
          correlationId = Buffer.isBuffer(headerValue) ? headerValue.toString() : headerValue;
        }
      }

      try {
        const rawValue = message.value ? message.value.toString() : null;
        if (!rawValue) {
          logger.error('Received empty message from Kafka', {
            topic, partition, offset: message.offset
          });
          return;
        }

        let event;
        try {
          event = JSON.parse(rawValue);
        } catch (parseError) {
          logger.error('Failed to parse Kafka message as JSON', {
            error: parseError.message,
            topic, partition, offset: message.offset,
            rawValue: rawValue.substring(0, 200)
          });
          return;
        }

        // Inject correlation ID from headers if available
        if (correlationId) {
          event.correlationId = correlationId;
        }

        // Validate event using shared schema library
        const result = validateEvent(event);
        if (!result.success) {
          logger.warn('Event validation failed', {
            error: result.error?.message || 'Unknown validation error',
            eventType: event.type,
            topic, partition, offset: message.offset,
            correlationId
          });
          return;
        }

        // Pass validated event to the processor
        await messageHandler(result.data, correlationId);

      } catch (error) {
        logger.error('Failed to process message', {
          error: error.message,
          stack: error.stack,
          topic, partition, offset: message.offset,
          correlationId
        });
        // Don't rethrow — log and skip to avoid crashing the consumer
      }
    }
  });
};

/**
 * Stop the Kafka consumer
 */
const stopConsumer = async () => {
  if (isRunning) {
    await consumer.disconnect();
    isRunning = false;
    logger.info('Kafka consumer stopped');
  }
};

/**
 * Get Kafka consumer health status
 */
const getHealthStatus = () => {
  return isRunning ? 'connected' : 'disconnected';
};

module.exports = {
  startConsumer,
  stopConsumer,
  getHealthStatus
};
