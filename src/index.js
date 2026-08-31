/**
 * Application Entry Point & Orchestrator
 * Provides unified job execution mode (runJobHunter), Express server for local development,
 * health routes, process-level safety handlers, and graceful shutdown lifecycle.
 */

const express = require('express');
const config = require('./config/env');
const { connectDB, disconnectDB } = require('./config/database');
const logger = require('./utils/logger');
const { formatErrorResponse } = require('./utils/errors');
const jobIngestionService = require('./services/jobIngestionService');
const aiMatcher = require('./services/aiMatcher');
const emailService = require('./services/emailService');
const defaultCandidateProfile = require('./config/candidateProfile');

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
 * Executes the complete end-to-end Job Hunter pipeline:
 * 1. Connects to MongoDB
 * 2. Fetches jobs from Greenhouse, Lever, and Ashby
 * 3. Ingests new jobs with status 'pending'
 * 4. Matches pending jobs against candidate profile using Gemini AI (matched >= threshold, ignored < threshold)
 * 5. Queries top eligible matched jobs and dispatches HTML/text email digest
 * 6. Marks successfully emailed jobs as notified
 * 7. Logs comprehensive summary report
 * 8. Cleans up and disconnects MongoDB
 * 
 * @param {Object} [options={}]
 * @param {Object} [options.candidateProfile] - Custom candidate profile
 * @param {number} [options.batchLimit] - Max pending jobs to evaluate with AI
 * @param {number} [options.topJobsLimit] - Max matched jobs to include in digest
 * @param {number} [options.minFitScore] - Min score threshold for email digest
 * @param {Object} [options.modelInstance] - Injected Gemini AI model instance
 * @param {Object} [options.transporter] - Injected Nodemailer transporter
 * @param {boolean} [options.disconnectOnComplete=true] - Whether to disconnect MongoDB in finally
 * @returns {Promise<{
 *   scraping: Object,
 *   matching: Object,
 *   email: Object,
 *   durationMs: number,
 *   success: boolean
 * }>}
 */
async function runJobHunter(options = {}) {
  const {
    candidateProfile = defaultCandidateProfile,
    batchLimit = 50,
    topJobsLimit = config.agent.topJobsLimit || 5,
    minFitScore = config.agent.aiMatchThreshold || 70,
    modelInstance = null,
    transporter = null,
    disconnectOnComplete = true
  } = options;

  logger.info('====================================================');
  logger.info('   AI JOB AUTOMATION AGENT - PIPELINE EXECUTION     ');
  logger.info('====================================================');
  const startTime = Date.now();

  let scrapingResult = null;
  let matchingResult = null;
  let emailResult = null;
  let overallSuccess = true;

  try {
    // 1. Connect MongoDB
    logger.info('[Step 1/5] Connecting to MongoDB database...');
    await connectDB();

    // 2. Scraping Phase: Greenhouse, Lever, Ashby
    logger.info('[Step 2/5] Initiating ATS Scrapers (Greenhouse, Lever, Ashby)...');
    try {
      scrapingResult = await jobIngestionService.runAllScrapers();
    } catch (scraperError) {
      logger.error('Unexpected fatal error in scraper orchestrator', { error: scraperError.message });
      scrapingResult = {
        greenhouse: null,
        lever: null,
        ashby: null,
        totalFetched: 0,
        totalInserted: 0,
        totalDuplicates: 0,
        totalFailures: 1,
        error: scraperError.message
      };
      // Scraper failures do not immediately abort subsequent steps if existing jobs are pending
    }

    // 3. AI Matching Phase: Gemini AI Evaluation
    logger.info('[Step 3/5] Evaluating pending jobs with Gemini AI...');
    try {
      matchingResult = await aiMatcher.matchPendingJobs(batchLimit, candidateProfile, modelInstance);
    } catch (aiError) {
      logger.error('AI Matching Engine encountered a critical failure', { error: aiError.message });
      matchingResult = {
        totalProcessed: 0,
        matched: 0,
        ignored: 0,
        failed: 1,
        results: [],
        error: aiError.message,
        success: false
      };
      overallSuccess = false;
    }

    // 4. Email Digest Phase: Top Matched Jobs & Delivery
    logger.info(`[Step 4/5] Selecting Top ${topJobsLimit} matched jobs & dispatching email digest...`);
    try {
      emailResult = await emailService.sendJobDigest({
        limit: topJobsLimit,
        transporter,
        candidateName: candidateProfile?.name || 'Candidate'
      });
    } catch (emailError) {
      logger.error('Failed to deliver job digest email', { error: emailError.message });
      emailResult = {
        sent: false,
        error: emailError.message
      };
      overallSuccess = false;
    }

    // Determine overall success state
    // Success requires: AI matching didn't throw critically, and email didn't fail when attempted
    if (emailResult && emailResult.error) {
      overallSuccess = false;
    }
    if (matchingResult && matchingResult.error) {
      overallSuccess = false;
    }

    const durationMs = Date.now() - startTime;

    // 5. Complete Summary Log
    logger.info('====================================================');
    logger.info('          PIPELINE EXECUTION SUMMARY                ');
    logger.info('====================================================');
    logger.info(`Pipeline Status   : ${overallSuccess ? 'SUCCESS' : 'FAILED / DEGRADED'}`);
    logger.info(`Execution Time    : ${(durationMs / 1000).toFixed(2)}s (${durationMs}ms)`);
    logger.info('--- ATS Scraping ---');
    logger.info(`  Total Fetched   : ${scrapingResult ? scrapingResult.totalFetched : 0}`);
    logger.info(`  New Inserted    : ${scrapingResult ? scrapingResult.totalInserted : 0}`);
    logger.info(`  Duplicates      : ${scrapingResult ? scrapingResult.totalDuplicates : 0}`);
    logger.info(`  Scraper Errors  : ${scrapingResult ? scrapingResult.totalFailures : 0}`);
    logger.info('--- AI Matching ---');
    logger.info(`  Evaluated       : ${matchingResult ? matchingResult.totalProcessed : 0}`);
    logger.info(`  Matched (>=${minFitScore}) : ${matchingResult ? matchingResult.matched : 0}`);
    logger.info(`  Ignored (<${minFitScore})  : ${matchingResult ? matchingResult.ignored : 0}`);
    logger.info(`  Match Errors    : ${matchingResult ? matchingResult.failed : 0}`);
    logger.info('--- Email Digest ---');
    logger.info(`  Email Sent      : ${emailResult ? (emailResult.sent ? 'YES' : 'NO') : 'NO'}`);
    if (emailResult && emailResult.jobsSent) {
      logger.info(`  Jobs Notified   : ${emailResult.jobsSent}`);
    }
    if (emailResult && emailResult.reason) {
      logger.info(`  Skip Reason     : ${emailResult.reason}`);
    }
    if (emailResult && emailResult.error) {
      logger.info(`  Email Error     : ${emailResult.error}`);
    }
    logger.info('====================================================');

    return {
      scraping: scrapingResult,
      matching: matchingResult,
      email: emailResult,
      durationMs,
      success: overallSuccess
    };
  } finally {
    if (disconnectOnComplete) {
      try {
        logger.info('[Step 5/5] Disconnecting from MongoDB database...');
        await disconnectDB();
      } catch (dbCloseError) {
        logger.error('Error closing MongoDB connection in orchestrator finally block', {
          error: dbCloseError.message
        });
      }
    }
  }
}

/**
 * Bootstrap and start the Express HTTP server (for local dev and health monitoring)
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
      logger.info(`AI Job Automation Agent HTTP Server started on port ${config.server.port} [${config.env}]`);
      logger.info(`Health check available at: http://localhost:${config.server.port}/health`);
    });
  } catch (error) {
    logger.error('Fatal error during application server startup', { error: error.message });
    process.exit(1);
  }
}

// Check if running as primary entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  const isRunMode = args.includes('--run') || args.includes('-r') || process.env.RUN_JOBS === 'true';

  if (isRunMode) {
    runJobHunter()
      .then((summary) => {
        logger.info(`Job Hunter execution completed with status code: ${summary.success ? 0 : 1}`);
        process.exit(summary.success ? 0 : 1);
      })
      .catch((err) => {
        logger.error('Fatal unhandled error during Job Hunter batch execution', {
          error: err.message,
          stack: err.stack
        });
        process.exit(1);
      });
  } else {
    startServer();
  }
}

module.exports = {
  app,
  startServer,
  runJobHunter,
  gracefulShutdown
};
