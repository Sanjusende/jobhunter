/**
 * Unified ATS Ingestion Orchestrator Service
 * Coordinates sequential execution of Greenhouse, Lever, and Ashby scrapers,
 * isolates failures between platforms, and aggregates pipeline statistics.
 */

const scrapers = require('../scrapers');
const logger = require('../utils/logger');

/**
 * Executes all ATS scrapers sequentially in order:
 * 1. Greenhouse
 * 2. Lever
 * 3. Ashby
 * 
 * Ensures independent execution so failures in one platform do not halt the others.
 * 
 * @returns {Promise<{
 *   greenhouse: Object,
 *   lever: Object,
 *   ashby: Object,
 *   totalFetched: number,
 *   totalInserted: number,
 *   totalDuplicates: number,
 *   totalFailures: number
 * }>}
 */
async function runAllScrapers() {
  logger.info('Starting Unified ATS Ingestion Pipeline...');
  const startTime = Date.now();

  const summary = {
    greenhouse: null,
    lever: null,
    ashby: null,
    totalFetched: 0,
    totalInserted: 0,
    totalDuplicates: 0,
    totalFailures: 0
  };

  // 1. Greenhouse Execution
  try {
    logger.info('[1/3] Initiating Greenhouse job ingestion...');
    const greenhouseResult = await scrapers.fetchAllGreenhouseJobs();
    summary.greenhouse = greenhouseResult;

    const fetched = greenhouseResult.totalJobsFetched || 0;
    const inserted = greenhouseResult.totalJobsInserted || 0;
    const duplicates = greenhouseResult.totalDuplicatesSkipped || 0;
    const failures = greenhouseResult.failedCompanies || 0;

    summary.totalFetched += fetched;
    summary.totalInserted += inserted;
    summary.totalDuplicates += duplicates;
    summary.totalFailures += failures;

    logger.info('[1/3] Greenhouse ingestion completed', {
      fetched,
      inserted,
      duplicates,
      failures
    });
  } catch (error) {
    summary.totalFailures++;
    summary.greenhouse = {
      success: false,
      error: error.message,
      totalJobsFetched: 0,
      totalJobsInserted: 0,
      totalDuplicatesSkipped: 0,
      failedCompanies: 1
    };
    logger.error('[1/3] Unhandled error in Greenhouse scraper module', { error: error.message });
  }

  // 2. Lever Execution
  try {
    logger.info('[2/3] Initiating Lever job ingestion...');
    const leverResult = await scrapers.fetchAllLeverJobs();
    summary.lever = leverResult;

    const fetched = leverResult.jobsFetched || 0;
    const inserted = leverResult.jobsInserted || 0;
    const duplicates = leverResult.duplicates || 0;
    const failures = leverResult.failures || 0;

    summary.totalFetched += fetched;
    summary.totalInserted += inserted;
    summary.totalDuplicates += duplicates;
    summary.totalFailures += failures;

    logger.info('[2/3] Lever ingestion completed', {
      fetched,
      inserted,
      duplicates,
      failures
    });
  } catch (error) {
    summary.totalFailures++;
    summary.lever = {
      success: false,
      error: error.message,
      jobsFetched: 0,
      jobsInserted: 0,
      duplicates: 0,
      failures: 1
    };
    logger.error('[2/3] Unhandled error in Lever scraper module', { error: error.message });
  }

  // 3. Ashby Execution
  try {
    logger.info('[3/3] Initiating Ashby job ingestion...');
    const ashbyResult = await scrapers.fetchAllAshbyJobs();
    summary.ashby = ashbyResult;

    const fetched = ashbyResult.jobsFetched || 0;
    const inserted = ashbyResult.jobsInserted || 0;
    const duplicates = ashbyResult.duplicates || 0;
    const failures = ashbyResult.failures || 0;

    summary.totalFetched += fetched;
    summary.totalInserted += inserted;
    summary.totalDuplicates += duplicates;
    summary.totalFailures += failures;

    logger.info('[3/3] Ashby ingestion completed', {
      fetched,
      inserted,
      duplicates,
      failures
    });
  } catch (error) {
    summary.totalFailures++;
    summary.ashby = {
      success: false,
      error: error.message,
      jobsFetched: 0,
      jobsInserted: 0,
      duplicates: 0,
      failures: 1
    };
    logger.error('[3/3] Unhandled error in Ashby scraper module', { error: error.message });
  }

  const durationMs = Date.now() - startTime;
  logger.info('Unified ATS Ingestion Pipeline completed successfully', {
    totalFetched: summary.totalFetched,
    totalInserted: summary.totalInserted,
    totalDuplicates: summary.totalDuplicates,
    totalFailures: summary.totalFailures,
    durationMs
  });

  return summary;
}

module.exports = {
  runAllScrapers
};
