/**
 * Job Repository & Persistence Service
 * Provides robust database access patterns, graceful duplicate key handling,
 * bulk upsert capabilities, and targeted queries for the automation pipeline.
 */

const { Job } = require('../models/Job');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');

/**
 * Creates a single job if it does not already exist (identified by unique jobUrl).
 * Handles duplicate key race conditions gracefully.
 * 
 * @param {Object} jobData 
 * @returns {Promise<{ job: Object, isNew: boolean }>}
 */
async function createJobIfNotExists(jobData) {
  try {
    const existing = await Job.findOne({ jobUrl: jobData.jobUrl }).lean();
    if (existing) {
      logger.debug('Job already exists in database', { jobUrl: jobData.jobUrl });
      return { job: existing, isNew: false };
    }

    const newJob = await Job.create(jobData);
    logger.info('New job created', { id: newJob._id, title: newJob.title, company: newJob.company });
    return { job: newJob.toObject(), isNew: true };
  } catch (error) {
    // Check for MongoDB duplicate key error (code 11000)
    if (error.code === 11000) {
      logger.debug('Duplicate key detected during job creation, returning existing record', {
        jobUrl: jobData.jobUrl
      });
      const existing = await Job.findOne({ jobUrl: jobData.jobUrl }).lean();
      return { job: existing, isNew: false };
    }
    logger.error('Failed to create job', { error: error.message, jobUrl: jobData.jobUrl });
    throw error;
  }
}

/**
 * Bulk inserts an array of job listings safely, ignoring existing duplicates.
 * Uses atomic upsert operations ($setOnInsert) to guarantee idempotency and avoid 11000 crashes.
 * 
 * @param {Array<Object>} jobsArray 
 * @returns {Promise<{ total: number, inserted: number, duplicates: number }>}
 */
async function bulkInsertJobs(jobsArray) {
  if (!Array.isArray(jobsArray) || jobsArray.length === 0) {
    return { total: 0, inserted: 0, duplicates: 0 };
  }

  const operations = jobsArray.map((job) => ({
    updateOne: {
      filter: { jobUrl: job.jobUrl },
      update: { $setOnInsert: job },
      upsert: true
    }
  }));

  try {
    const result = await Job.bulkWrite(operations, { ordered: false });
    const insertedCount = result.upsertedCount || 0;
    const duplicateCount = jobsArray.length - insertedCount;

    logger.info('Bulk job ingestion completed', {
      total: jobsArray.length,
      inserted: insertedCount,
      duplicates: duplicateCount
    });

    return {
      total: jobsArray.length,
      inserted: insertedCount,
      duplicates: duplicateCount
    };
  } catch (error) {
    logger.error('Bulk job insert encountered an error', { error: error.message });
    throw error;
  }
}

/**
 * Retrieves un-evaluated pending jobs for the AI matcher.
 * 
 * @param {number} [limit=50] 
 * @returns {Promise<Array<Object>>}
 */
async function findPendingJobs(limit = 50) {
  return Job.find({ status: 'pending' })
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();
}

/**
 * Retrieves top-matched, unnotified jobs sorted by fit score descending.
 * 
 * @param {number} [limit=5] 
 * @param {number} [minFitScore=70] 
 * @returns {Promise<Array<Object>>}
 */
async function findTopUnnotifiedMatchedJobs(limit = 5, minFitScore = 70) {
  return Job.find({
    notified: false,
    status: 'matched',
    fitScore: { $gte: minFitScore }
  })
    .sort({ fitScore: -1, createdAt: -1 })
    .limit(limit)
    .lean();
}

/**
 * Marks a single job or an array of jobs as notified.
 * 
 * @param {string|string[]|import('mongoose').Types.ObjectId} jobIds 
 * @returns {Promise<number>} Number of modified documents
 */
async function markJobsNotified(jobIds) {
  const ids = Array.isArray(jobIds) ? jobIds : [jobIds];
  if (ids.length === 0) return 0;

  const result = await Job.updateMany(
    { _id: { $in: ids } },
    { $set: { notified: true } }
  );

  logger.info('Marked jobs as notified', { count: result.modifiedCount, ids });
  return result.modifiedCount;
}

/**
 * Updates AI match results (fit score, verdict, skill lists, status) for a job.
 * 
 * @param {string|import('mongoose').Types.ObjectId} jobId 
 * @param {Object} matchData 
 * @param {number} matchData.fitScore 
 * @param {string} matchData.verdict 
 * @param {string[]} [matchData.matchingSkills] 
 * @param {string[]} [matchData.missingSkills] 
 * @param {string} [matchData.status] 
 * @returns {Promise<Object>} Updated job document
 */
async function updateMatchResult(jobId, matchData) {
  const { fitScore, verdict, matchingSkills = [], missingSkills = [], status } = matchData;

  const updatePayload = {
    fitScore,
    verdict,
    matchingSkills,
    missingSkills
  };

  if (status) {
    updatePayload.status = status;
  }

  const updatedJob = await Job.findByIdAndUpdate(
    jobId,
    { $set: updatePayload },
    { new: true, runValidators: true }
  ).lean();

  if (!updatedJob) {
    throw new AppError(`Job with ID ${jobId} not found`, 404);
  }

  logger.info('Updated match results for job', {
    id: jobId,
    fitScore,
    verdict,
    status: updatedJob.status
  });

  return updatedJob;
}

module.exports = {
  createJobIfNotExists,
  bulkInsertJobs,
  findPendingJobs,
  findTopUnnotifiedMatchedJobs,
  markJobsNotified,
  updateMatchResult
};
