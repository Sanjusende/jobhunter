/**
 * ATS Scrapers Aggregator
 * Central entry point for all job ingestion scrapers.
 */

const greenhouse = require('./greenhouse');
const lever = require('./lever');
const ashby = require('./ashby');

module.exports = {
  greenhouse,
  lever,
  ashby,
  fetchGreenhouseJobs: greenhouse.fetchGreenhouseJobs,
  fetchAllGreenhouseJobs: greenhouse.fetchAllGreenhouseJobs,
  fetchLeverJobs: lever.fetchLeverJobs,
  fetchAllLeverJobs: lever.fetchAllLeverJobs,
  fetchAshbyJobs: ashby.fetchAshbyJobs,
  fetchAllAshbyJobs: ashby.fetchAllAshbyJobs
};
