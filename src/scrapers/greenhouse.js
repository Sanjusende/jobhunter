/**
 * Greenhouse ATS Job Ingestion Scraper
 * Fetches, sanitizes, normalizes, and persists job postings from Greenhouse API boards.
 */

const axios = require('axios');
const cheerio = require('cheerio');
const config = require('../config/env');
const logger = require('../utils/logger');
const { delay } = require('../utils/delay');
const { AppError } = require('../utils/errors');
const jobRepository = require('../services/jobRepository');

const GREENHOUSE_BASE_URL = 'https://boards-api.greenhouse.io/v1/boards';

/**
 * Converts raw HTML content into readable, formatted plain text.
 * Strips script/style tags and preserves paragraph/list breaks.
 * 
 * @param {string} [htmlContent=''] 
 * @returns {string} Clean plain text
 */
function cleanHtmlToText(htmlContent) {
  if (!htmlContent || typeof htmlContent !== 'string') {
    return '';
  }

  try {
    // Unescape entities in case the API returned double-encoded HTML
    const decoded = htmlContent
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");

    const $ = cheerio.load(decoded);

    // Remove non-content elements
    $('script, style, noscript, iframe, svg, head').remove();

    // Replace structural block tags with newlines to preserve readability
    $('br').replaceWith('\n');
    $('p, div, li, tr, h1, h2, h3, h4, h5, h6').each((_, el) => {
      $(el).append('\n');
    });

    const text = $.text();

    // Normalize whitespace while preserving linebreaks
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join('\n\n')
      .trim();
  } catch (error) {
    logger.warn('Failed to parse job HTML content with Cheerio, using fallback text stripping', {
      error: error.message
    });
    return htmlContent.replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim();
  }
}

/**
 * Executes an HTTP GET request with exponential backoff for transient errors.
 * 
 * @param {string} url 
 * @param {Object} [options={}] 
 * @param {number} [maxRetries=3] 
 * @param {number} [baseDelayMs=1000] 
 * @returns {Promise<import('axios').AxiosResponse>}
 */
async function fetchWithRetry(url, options = {}, maxRetries = 3, baseDelayMs = 1000) {
  let attempt = 0;

  while (attempt <= maxRetries) {
    try {
      return await axios.get(url, {
        timeout: config.server.requestTimeoutMs || 15000,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'JobHunterAgent/1.0 (+https://github.com/Sanjusende/jobhunter)'
        },
        ...options
      });
    } catch (error) {
      attempt++;
      const statusCode = error.response ? error.response.status : null;

      // Do not retry client errors (4xx) except rate-limiting (429)
      const isClientError = statusCode && statusCode >= 400 && statusCode < 500 && statusCode !== 429;
      if (isClientError || attempt > maxRetries) {
        throw error;
      }

      const backoffMs = baseDelayMs * Math.pow(2, attempt - 1);
      logger.warn(`Greenhouse request failed (attempt ${attempt}/${maxRetries}), retrying in ${backoffMs}ms...`, {
        url,
        statusCode,
        error: error.message
      });

      await delay(backoffMs);
    }
  }
}

/**
 * Normalizes raw Greenhouse job objects into the application's internal Job schema.
 * 
 * @param {Object} rawJob 
 * @param {string} companySlug 
 * @returns {Object|null}
 */
function normalizeGreenhouseJob(rawJob, companySlug) {
  if (!rawJob || !rawJob.title || !rawJob.absolute_url) {
    return null;
  }

  const location = rawJob.location && rawJob.location.name
    ? rawJob.location.name.trim()
    : '';

  return {
    title: String(rawJob.title).trim(),
    company: companySlug.trim(),
    atsSource: 'greenhouse',
    jobUrl: String(rawJob.absolute_url).trim(),
    description: cleanHtmlToText(rawJob.content),
    location,
    fitScore: null,
    verdict: null,
    matchingSkills: [],
    missingSkills: [],
    status: 'pending',
    notified: false
  };
}

/**
 * Fetches and ingests all active jobs for a specific Greenhouse company board.
 * 
 * @param {string} companySlug 
 * @returns {Promise<{ company: string, totalFetched: number, newInserted: number, duplicatesSkipped: number, success: boolean }>}
 */
async function fetchGreenhouseJobs(companySlug) {
  if (!companySlug || typeof companySlug !== 'string' || !companySlug.trim()) {
    throw new AppError('Valid company slug is required for Greenhouse scraper', 400);
  }

  const cleanSlug = companySlug.trim().toLowerCase();
  const targetUrl = `${GREENHOUSE_BASE_URL}/${encodeURIComponent(cleanSlug)}/jobs?content=true`;

  logger.info(`Fetching Greenhouse jobs for company: "${cleanSlug}"`, { url: targetUrl });

  try {
    const response = await fetchWithRetry(targetUrl);

    if (!response.data || !Array.isArray(response.data.jobs)) {
      logger.warn(`Malformed or empty response from Greenhouse API for company: "${cleanSlug}"`);
      return {
        company: cleanSlug,
        totalFetched: 0,
        newInserted: 0,
        duplicatesSkipped: 0,
        success: true
      };
    }

    const rawJobs = response.data.jobs;
    const normalizedJobs = rawJobs
      .map((job) => normalizeGreenhouseJob(job, cleanSlug))
      .filter((job) => job !== null);

    logger.info(`Fetched and normalized ${normalizedJobs.length} jobs for "${cleanSlug}"`);

    // Ingest into database with duplicate prevention
    const { inserted, duplicates } = await jobRepository.bulkInsertJobs(normalizedJobs);

    return {
      company: cleanSlug,
      totalFetched: normalizedJobs.length,
      newInserted: inserted,
      duplicatesSkipped: duplicates,
      success: true
    };
  } catch (error) {
    const statusCode = error.response ? error.response.status : 500;
    logger.error(`Error fetching Greenhouse jobs for "${cleanSlug}"`, {
      statusCode,
      error: error.message
    });

    return {
      company: cleanSlug,
      totalFetched: 0,
      newInserted: 0,
      duplicatesSkipped: 0,
      success: false,
      error: error.message
    };
  }
}

/**
 * Ingests jobs for all configured Greenhouse companies sequentially.
 * 
 * @returns {Promise<{ totalCompanies: number, successfulCompanies: number, failedCompanies: number, totalJobsFetched: number, totalJobsInserted: number, totalDuplicatesSkipped: number, results: Array }>}
 */
async function fetchAllGreenhouseJobs() {
  const companies = config.companies.greenhouse || [];

  if (companies.length === 0) {
    logger.info('No Greenhouse companies configured in GREENHOUSE_COMPANIES.');
    return {
      totalCompanies: 0,
      successfulCompanies: 0,
      failedCompanies: 0,
      totalJobsFetched: 0,
      totalJobsInserted: 0,
      totalDuplicatesSkipped: 0,
      results: []
    };
  }

  logger.info(`Starting Greenhouse scraper batch for ${companies.length} company boards`, { companies });

  const results = [];
  let totalJobsFetched = 0;
  let totalJobsInserted = 0;
  let totalDuplicatesSkipped = 0;
  let successfulCompanies = 0;
  let failedCompanies = 0;

  for (let i = 0; i < companies.length; i++) {
    const company = companies[i];

    try {
      const summary = await fetchGreenhouseJobs(company);
      results.push(summary);

      if (summary.success) {
        successfulCompanies++;
        totalJobsFetched += summary.totalFetched;
        totalJobsInserted += summary.newInserted;
        totalDuplicatesSkipped += summary.duplicatesSkipped;
      } else {
        failedCompanies++;
      }
    } catch (error) {
      failedCompanies++;
      logger.error(`Unhandled error processing company "${company}"`, { error: error.message });
      results.push({
        company,
        totalFetched: 0,
        newInserted: 0,
        duplicatesSkipped: 0,
        success: false,
        error: error.message
      });
    }

    // Polite delay between companies to respect rate limits
    if (i < companies.length - 1) {
      await delay(1000);
    }
  }

  const batchSummary = {
    totalCompanies: companies.length,
    successfulCompanies,
    failedCompanies,
    totalJobsFetched,
    totalJobsInserted,
    totalDuplicatesSkipped,
    results
  };

  logger.info('Completed Greenhouse scraping batch', batchSummary);
  return batchSummary;
}

module.exports = {
  fetchGreenhouseJobs,
  fetchAllGreenhouseJobs,
  normalizeGreenhouseJob,
  cleanHtmlToText,
  fetchWithRetry
};
