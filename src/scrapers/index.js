/**
 * ATS Scrapers Aggregator
 * Central entry point for all job ingestion scrapers.
 */

const greenhouse = require('./greenhouse');
const lever = require('./lever');

module.exports = {
  greenhouse,
  lever,
  fetchGreenhouseJobs: greenhouse.fetchGreenhouseJobs,
  fetchAllGreenhouseJobs: greenhouse.fetchAllGreenhouseJobs,
  fetchLeverJobs: lever.fetchLeverJobs,
  fetchAllLeverJobs: lever.fetchAllLeverJobs
};
