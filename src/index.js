/**
 * Application Entry Point
 * Initializes Express, connects to MongoDB, attaches middleware and health routes,
 * and configures graceful shutdown and process-level safety handlers.
 */

const express = require('express');
const config = require('./config/env');
const { connectDB, disconnectDB } = require('./config/database');
const logger = require('./utils/logger');
const { formatErrorResponse } = require('./utils/errors');

// Process-level safety handlers
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception detected! Terminating process...', {
    name: err.name,
    message: err.message,
    stack: err.stack
  });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Promise Rejection detected!', {
    reason: reason instanceof Error ? { message: reason.message, stack: reason.stack } : reason
  });
});

const app = express();

// Standard middleware
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    service: 'ai-job-automation-agent',
    status: 'healthy'
  });
});

// 404 handler for undefined routes
app.use((req, res) => {
  res.status(404).json({
    success: false,
    status: 'fail',
    statusCode: 404,
    message: `Cannot ${req.method} ${req.originalUrl}`
  });
});

// Global error handling middleware
app.use((err, req, res, _next) => {
  const errorResponse = formatErrorResponse(err, config.isProduction);
  logger.error('API Error Encountered', {
    method: req.method,
    url: req.originalUrl,
    statusCode: errorResponse.statusCode,
    message: err.message
  });
  res.status(errorResponse.statusCode).json(errorResponse);
});

let server = null;
let isShuttingDown = false;

/**
 * Graceful termination handler
 * Stops accepting new connections, drains existing connections, closes DB, and exits.
 * @param {string} signal 
 */
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Received ${signal}. Initiating graceful shutdown...`);

  // Force exit after 10 seconds if shutdown hangs
  const forceExitTimer = setTimeout(() => {
    logger.error('Graceful shutdown timed out. Forcing termination.');
    process.exit(1);
  }, 10000);
  forceExitTimer.unref();

  try {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) return reject(err);
          logger.info('HTTP server closed successfully');
          resolve();
        });
      });
    }

    await disconnectDB();
    logger.info('Graceful shutdown complete. Exiting.');
    process.exit(0);
  } catch (error) {
    logger.error('Error occurred during graceful shutdown', { error: error.message });
    process.exit(1);
  }
}

// Attach OS signal listeners
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

/**
 * Bootstrap and start the application server
 */
async function startServer() {
  try {
    // Attempt database connection
    try {
      await connectDB();
    } catch (dbError) {
      logger.warn('Initial MongoDB connection failed. Server will continue in degraded mode if database is offline.', {
        error: dbError.message
      });
    }

    server = app.listen(config.server.port, () => {
      logger.info(`AI Job Automation Agent started on port ${config.server.port} [${config.env}]`);
      logger.info(`Health check available at: http://localhost:${config.server.port}/health`);
    });
  } catch (error) {
    logger.error('Fatal error during application startup', { error: error.message });
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer };
