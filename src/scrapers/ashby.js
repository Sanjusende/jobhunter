/**
 * Ashby ATS Job Ingestion Scraper
 * Fetches, normalizes, and persists postings from the Ashby Job Board API
 * (https://api.ashbyhq.com/posting-api/job-board/{company}).
 */

const axios = require('axios');
const cheerio = require('cheerio');
const config = require('../config/env');
const logger = require('../utils/logger');
const { delay } = require('../utils/delay');
const { AppError } = require('../utils/errors');
const jobRepository = require('../services/jobRepository');

const ASHBY_BASE_URL = 'https://api.ashbyhq.com/posting-api/job-board';

/**
 * Sanitizes HTML content into human-readable plain text.
 * @param {string} [html=''] 
 * @returns {string} Clean plain text
 */
function cleanHtml(html) {
  if (!html || typeof html !== 'string') {
    return '';
  }

  try {
    const decoded = html
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");

    const $ = cheerio.load(decoded);
    $('script, style, noscript, iframe, svg, head').remove();
    $('br').replaceWith('\n');
    $('p, div, li, tr, h1, h2, h3, h4, h5, h6').each((_, el) => {
      $(el).append('\n');
    });

    return $.text()
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join('\n\n')
      .trim();
  } catch (_error) {
    return html.replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim();
  }
}

/**
 * Resolves location string from primary location, secondary locations, and isRemote flag.
 * @param {string|Object} [primaryLocation] 
 * @param {Array} [secondaryLocations=[]] 
 * @param {boolean} [isRemote=false] 
 * @returns {string} Normalized location string
 */
function resolveAshbyLocation(primaryLocation, secondaryLocations = [], isRemote = false) {
  const parts = [];

  // Primary location (can be string or object)
  if (typeof primaryLocation === 'string' && primaryLocation.trim()) {
    parts.push(primaryLocation.trim());
  } else if (primaryLocation && typeof primaryLocation === 'object' && primaryLocation.name) {
    parts.push(String(primaryLocation.name).trim());
  }

  // Secondary locations
  if (Array.isArray(secondaryLocations) && secondaryLocations.length > 0) {
    for (const sec of secondaryLocations) {
      if (typeof sec === 'string' && sec.trim()) {
        parts.push(sec.trim());
      } else if (sec && typeof sec === 'object') {
        const secName = sec.location || sec.name || '';
        if (secName && typeof secName === 'string') {
          parts.push(secName.trim());
        }
      }
    }
  }

  const combinedLocations = parts.filter(Boolean).join(', ');

  // Remote indicator
  if (isRemote) {
    const lower = combinedLocations.toLowerCase();
    if (!lower.includes('remote')) {
      return combinedLocations ? `${combinedLocations} (Remote)` : 'Remote';
    }
  }

  return combinedLocations;
}

/**
 * Extracts and sanitizes description text from Ashby job posting.
 * @param {Object} rawJob 
 * @returns {string} Plain text description
 */
function extractAshbyDescription(rawJob) {
  if (!rawJob) return '';

  if (rawJob.descriptionHtml) {
    return cleanHtml(rawJob.descriptionHtml);
  }

  if (rawJob.descriptionPlain && typeof rawJob.descriptionPlain === 'string') {
    return rawJob.descriptionPlain.trim();
  }

  if (rawJob.description && typeof rawJob.description === 'string') {
    return cleanHtml(rawJob.description);
  }

  return '';
}

/**
 * Executes an HTTP GET request with exponential backoff for transient errors.
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

      // Fast-fail 4xx client errors except rate-limiting (429)
      const isClientError = statusCode && statusCode >= 400 && statusCode < 500 && statusCode !== 429;
      if (isClientError || attempt > maxRetries) {
        throw error;
      }

      const backoffMs = baseDelayMs * Math.pow(2, attempt - 1);
      logger.warn(`Ashby request failed (attempt ${attempt}/${maxRetries}), retrying in ${backoffMs}ms...`, {
        url,
        statusCode,
        error: error.message
      });

      await delay(backoffMs);
    }
  }
}

/**
 * Normalizes an Ashby posting object into the standard Job schema.
 * @param {Object} rawJob 
 * @param {string} companySlug 
 * @returns {Object|null}
 */
function normalizeAshbyJob(rawJob, companySlug) {
  if (!rawJob || !rawJob.title) {
    return null;
  }

  // Canonical Job URL resolution
  const jobUrl = rawJob.jobUrl || rawJob.applyUrl || (rawJob.id ? `https://jobs.ashbyhq.com/${companySlug}/${rawJob.id}` : null);
  if (!jobUrl || typeof jobUrl !== 'string') {
    return null;
  }

  const location = resolveAshbyLocation(rawJob.location, rawJob.secondaryLocations, Boolean(rawJob.isRemote));
  const description = extractAshbyDescription(rawJob);

  return {
    title: String(rawJob.title).trim(),
    company: companySlug.trim(),
    atsSource: 'ashby',
    jobUrl: jobUrl.trim(),
    description,
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
 * Fetches and ingests all active jobs from an Ashby company board.
 * @param {string} companySlug 
 * @returns {Promise<{ company: string, totalFetched: number, newInserted: number, duplicatesSkipped: number, success: boolean, error?: string }>}
 */
async function fetchAshbyJobs(companySlug) {
  if (!companySlug || typeof companySlug !== 'string' || !companySlug.trim()) {
    throw new AppError('Valid company slug is required for Ashby scraper', 400);
  }

  const cleanSlug = companySlug.trim().toLowerCase();
  const targetUrl = `${ASHBY_BASE_URL}/${encodeURIComponent(cleanSlug)}`;

  logger.info(`Fetching Ashby jobs for company: "${cleanSlug}"`, { url: targetUrl });

  try {
    const response = await fetchWithRetry(targetUrl);

    if (!response.data || !Array.isArray(response.data.jobs)) {
      logger.warn(`Unexpected non-array or empty response from Ashby API for "${cleanSlug}"`, {
        data: response.data
      });
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
      .map((job) => normalizeAshbyJob(job, cleanSlug))
      .filter((job) => job !== null);

    logger.info(`Fetched and normalized ${normalizedJobs.length} Ashby jobs for "${cleanSlug}"`);

    // Ingest into MongoDB via shared repository (idempotent upserts)
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
    logger.error(`Error fetching Ashby jobs for "${cleanSlug}"`, {
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
 * Ingests jobs for all configured Ashby companies sequentially.
 * @returns {Promise<{ companiesProcessed: number, jobsFetched: number, jobsInserted: number, duplicates: number, failures: number, results: Array }>}
 */
async function fetchAllAshbyJobs() {
  const companies = config.companies.ashby || [];

  if (companies.length === 0) {
    logger.info('No Ashby companies configured in ASHBY_COMPANIES.');
    return {
      companiesProcessed: 0,
      jobsFetched: 0,
      jobsInserted: 0,
      duplicates: 0,
      failures: 0,
      results: []
    };
  }

  logger.info(`Starting Ashby scraper batch for ${companies.length} companies`, { companies });

  const results = [];
  let totalJobsFetched = 0;
  let totalJobsInserted = 0;
  let totalDuplicates = 0;
  let successCount = 0;
  let failureCount = 0;

  for (let i = 0; i < companies.length; i++) {
    const company = companies[i];

    try {
      const summary = await fetchAshbyJobs(company);
      results.push(summary);

      if (summary.success) {
        successCount++;
        totalJobsFetched += summary.totalFetched;
        totalJobsInserted += summary.newInserted;
        totalDuplicates += summary.duplicatesSkipped;
      } else {
        failureCount++;
      }
    } catch (error) {
      failureCount++;
      logger.error(`Unhandled error scraping Ashby company "${company}"`, { error: error.message });
      results.push({
        company,
        totalFetched: 0,
        newInserted: 0,
        duplicatesSkipped: 0,
        success: false,
        error: error.message
      });
    }

    // Polite delay between requests to respect rate limits
    if (i < companies.length - 1) {
      await delay(1000);
    }
  }

  const batchSummary = {
    companiesProcessed: companies.length,
    jobsFetched: totalJobsFetched,
    jobsInserted: totalJobsInserted,
    duplicates: totalDuplicates,
    failures: failureCount,
    results
  };

  logger.info('Completed Ashby scraping batch', batchSummary);
  return batchSummary;
}

module.exports = {
  fetchAshbyJobs,
  fetchAllAshbyJobs,
  normalizeAshbyJob,
  resolveAshbyLocation,
  extractAshbyDescription,
  cleanHtml
};
