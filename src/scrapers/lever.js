/**
 * Lever ATS Job Ingestion Scraper
 * Fetches, normalizes, and persists postings from the Lever API (https://api.lever.co/v0/postings/{company}?mode=json).
 */

const axios = require('axios');
const cheerio = require('cheerio');
const config = require('../config/env');
const logger = require('../utils/logger');
const { delay } = require('../utils/delay');
const { AppError } = require('../utils/errors');
const jobRepository = require('../services/jobRepository');

const LEVER_BASE_URL = 'https://api.lever.co/v0/postings';

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
 * Formats Lever location fields from categories and workplace metadata.
 * @param {Object} [categories={}] 
 * @param {string} [workplaceType=''] 
 * @returns {string} Normalized location string
 */
function resolveLeverLocation(categories = {}, workplaceType = '') {
  const parts = [];

  if (categories && typeof categories === 'object') {
    if (categories.location && typeof categories.location === 'string') {
      parts.push(categories.location.trim());
    } else if (Array.isArray(categories.allLocations) && categories.allLocations.length > 0) {
      parts.push(categories.allLocations.filter(Boolean).join(', '));
    }
  }

  if (workplaceType && typeof workplaceType === 'string') {
    const wp = workplaceType.trim().toLowerCase();
    const existingStr = parts.join(' ').toLowerCase();
    if (!existingStr.includes(wp)) {
      const formattedWp = wp.charAt(0).toUpperCase() + wp.slice(1);
      parts.push(`(${formattedWp})`);
    }
  }

  return parts.filter(Boolean).join(' ').trim();
}

/**
 * Combines description text, requirement lists, and additional notes from Lever job payload.
 * @param {Object} rawJob 
 * @returns {string} Comprehensive formatted description text
 */
function assembleLeverDescription(rawJob) {
  const sections = [];

  // Main description
  if (rawJob.description) {
    const mainText = cleanHtml(rawJob.description);
    if (mainText) sections.push(mainText);
  } else if (rawJob.descriptionPlain) {
    sections.push(rawJob.descriptionPlain.trim());
  }

  // Structured bullet lists (e.g., Responsibilities, Qualifications)
  if (Array.isArray(rawJob.lists) && rawJob.lists.length > 0) {
    for (const list of rawJob.lists) {
      if (!list) continue;
      const heading = list.text ? `### ${list.text.trim()}` : '';
      const listContent = list.content ? cleanHtml(list.content) : '';
      const combined = [heading, listContent].filter(Boolean).join('\n');
      if (combined) sections.push(combined);
    }
  }

  // Additional notes/closing statements
  if (rawJob.additional) {
    const addText = cleanHtml(rawJob.additional);
    if (addText) sections.push(addText);
  } else if (rawJob.additionalPlain) {
    sections.push(rawJob.additionalPlain.trim());
  }

  return sections.join('\n\n').trim();
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

      // Do not retry 4xx errors except 429 (Rate Limit)
      const isClientError = statusCode && statusCode >= 400 && statusCode < 500 && statusCode !== 429;
      if (isClientError || attempt > maxRetries) {
        throw error;
      }

      const backoffMs = baseDelayMs * Math.pow(2, attempt - 1);
      logger.warn(`Lever request failed (attempt ${attempt}/${maxRetries}), retrying in ${backoffMs}ms...`, {
        url,
        statusCode,
        error: error.message
      });

      await delay(backoffMs);
    }
  }
}

/**
 * Normalizes a raw Lever posting object into internal Job schema.
 * @param {Object} rawJob 
 * @param {string} companySlug 
 * @returns {Object|null}
 */
function normalizeLeverJob(rawJob, companySlug) {
  if (!rawJob || !rawJob.text) {
    return null;
  }

  const jobUrl = rawJob.hostedUrl || (rawJob.urls && rawJob.urls.show) || rawJob.applyUrl;
  if (!jobUrl || typeof jobUrl !== 'string') {
    return null;
  }

  const location = resolveLeverLocation(rawJob.categories, rawJob.workplaceType);
  const description = assembleLeverDescription(rawJob);

  return {
    title: String(rawJob.text).trim(),
    company: companySlug.trim(),
    atsSource: 'lever',
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
 * Fetches and ingests all active jobs from a Lever company board.
 * @param {string} companySlug 
 * @returns {Promise<{ company: string, totalFetched: number, newInserted: number, duplicatesSkipped: number, success: boolean, error?: string }>}
 */
async function fetchLeverJobs(companySlug) {
  if (!companySlug || typeof companySlug !== 'string' || !companySlug.trim()) {
    throw new AppError('Valid company slug is required for Lever scraper', 400);
  }

  const cleanSlug = companySlug.trim().toLowerCase();
  const targetUrl = `${LEVER_BASE_URL}/${encodeURIComponent(cleanSlug)}?mode=json`;

  logger.info(`Fetching Lever jobs for company: "${cleanSlug}"`, { url: targetUrl });

  try {
    const response = await fetchWithRetry(targetUrl);

    if (!Array.isArray(response.data)) {
      logger.warn(`Unexpected non-array response from Lever API for "${cleanSlug}"`, { data: response.data });
      return {
        company: cleanSlug,
        totalFetched: 0,
        newInserted: 0,
        duplicatesSkipped: 0,
        success: true
      };
    }

    const rawJobs = response.data;
    const normalizedJobs = rawJobs
      .map((job) => normalizeLeverJob(job, cleanSlug))
      .filter((job) => job !== null);

    logger.info(`Fetched and normalized ${normalizedJobs.length} Lever jobs for "${cleanSlug}"`);

    // Ingest into MongoDB with duplicate prevention
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
    logger.error(`Error fetching Lever jobs for "${cleanSlug}"`, {
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
 * Ingests jobs for all configured Lever companies sequentially.
 * @returns {Promise<{ companiesProcessed: number, jobsFetched: number, jobsInserted: number, duplicates: number, failures: number, results: Array }>}
 */
async function fetchAllLeverJobs() {
  const companies = config.companies.lever || [];

  if (companies.length === 0) {
    logger.info('No Lever companies configured in LEVER_COMPANIES.');
    return {
      companiesProcessed: 0,
      jobsFetched: 0,
      jobsInserted: 0,
      duplicates: 0,
      failures: 0,
      results: []
    };
  }

  logger.info(`Starting Lever scraper batch for ${companies.length} companies`, { companies });

  const results = [];
  let totalJobsFetched = 0;
  let totalJobsInserted = 0;
  let totalDuplicates = 0;
  let successCount = 0;
  let failureCount = 0;

  for (let i = 0; i < companies.length; i++) {
    const company = companies[i];

    try {
      const summary = await fetchLeverJobs(company);
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
      logger.error(`Unhandled error scraping Lever company "${company}"`, { error: error.message });
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

  logger.info('Completed Lever scraping batch', batchSummary);
  return batchSummary;
}

module.exports = {
  fetchLeverJobs,
  fetchAllLeverJobs,
  normalizeLeverJob,
  resolveLeverLocation,
  assembleLeverDescription,
  cleanHtml
};
