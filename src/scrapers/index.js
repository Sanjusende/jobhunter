/**
 * ATS Scrapers Aggregator
 * Central entry point for all job ingestion scrapers.
 */

const greenhouse = require('./greenhouse');

module.exports = {
  greenhouse,
  fetchGreenhouseJobs: greenhouse.fetchGreenhouseJobs,
  fetchAllGreenhouseJobs: greenhouse.fetchAllGreenhouseJobs
};
