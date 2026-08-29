/**
 * MongoDB Database Connection Manager
 * Manages Mongoose connection lifecycle, event subscriptions, connection pooling, and graceful teardown.
 */

const mongoose = require('mongoose');
const config = require('./env');
const logger = require('../utils/logger');

let isConnected = false;

// Mongoose event listeners
mongoose.connection.on('connected', () => {
  isConnected = true;
  logger.info('MongoDB connection established successfully');
});

mongoose.connection.on('error', (err) => {
  logger.error('MongoDB connection error encountered', { error: err.message });
});

mongoose.connection.on('disconnected', () => {
  isConnected = false;
  logger.warn('MongoDB disconnected');
});

/**
 * Connect to MongoDB instance with resilient timeout and pool configurations.
 * @returns {Promise<typeof mongoose>}
 */
async function connectDB() {
  if (isConnected || mongoose.connection.readyState === 1) {
    logger.debug('MongoDB already connected');
    return mongoose;
  }

  const options = {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    maxPoolSize: 10,
    minPoolSize: 2
  };

  try {
    logger.info('Connecting to MongoDB...');
    await mongoose.connect(config.database.uri, options);
    return mongoose;
  } catch (error) {
    logger.error('Failed to connect to MongoDB', { error: error.message });
    throw error;
  }
}

/**
 * Disconnect cleanly from MongoDB instance.
 * @returns {Promise<void>}
 */
async function disconnectDB() {
  if (mongoose.connection.readyState !== 0) {
    try {
      logger.info('Closing MongoDB connection...');
      await mongoose.disconnect();
      isConnected = false;
      logger.info('MongoDB disconnected cleanly');
    } catch (error) {
      logger.error('Error during MongoDB disconnect', { error: error.message });
      throw error;
    }
  }
}

module.exports = {
  connectDB,
  disconnectDB,
  getConnectionStatus: () => mongoose.connection.readyState
};
