/**
 * AI Job Matching Engine
 * Evaluates candidate fit against job postings using Google Gemini AI,
 * validates model responses, handles rate-limits with jittered backoff, and updates job statuses.
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config/env');
const defaultCandidateProfile = require('../config/candidateProfile');
const logger = require('../utils/logger');
const { delay } = require('../utils/delay');
const { AppError } = require('../utils/errors');
const jobRepository = require('./jobRepository');

const VALID_VERDICTS = ['Strong Match', 'Moderate Match', 'Low Match'];

/**
 * Initializes Google Gemini generative model instance.
 * @returns {import('@google/generative-ai').GenerativeModel}
 */
function getGenerativeModel() {
  const apiKey = config.gemini.apiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new AppError('GEMINI_API_KEY is not configured in environment variables.', 500);
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  return genAI.getGenerativeModel({
    model: config.gemini.model || 'gemini-1.5-flash',
    generationConfig: {
      temperature: 0.1,
      topP: 0.8,
      responseMimeType: 'application/json'
    }
  });
}

/**
 * Constructs a strict, grounded prompt for Gemini candidate-job evaluation.
 * @param {Object} job 
 * @param {Object} candidateProfile 
 * @returns {string} Prompt text
 */
function buildEvaluationPrompt(job, candidateProfile) {
  return `You are an expert technical recruiter and talent evaluator.
Your task is to objectively evaluate the alignment between a candidate profile and a specific job posting.

IMPORTANT EVALUATION RULES:
1. Base your evaluation ONLY on the provided candidate profile and job description.
2. DO NOT invent, assume, or hallucinate candidate skills or experience not explicitly listed.
3. Distinguish between hard technical requirements vs nice-to-have / preferred qualifications.
4. Heavily weight core technical skills, seniority/experience level alignment, and role domain fit.
5. fitScore is an estimated suitability score from 0 to 100 (integer):
   - 80-100: Strong Match (meets core stack, seniority, and most requirements)
   - 60-79: Moderate Match (meets foundational requirements with minor gaps)
   - 0-59: Low Match (significant skill gaps or level mismatch)
6. verdict MUST be exactly one of: "Strong Match", "Moderate Match", "Low Match".
7. matchingSkills MUST be an array of specific skills the candidate possesses that match the role.
8. missingSkills MUST be an array of required or desired skills the candidate lacks.
9. reasoning MUST be a concise 1-2 sentence explanation of the score.

CANDIDATE PROFILE:
${JSON.stringify(candidateProfile, null, 2)}

JOB POSTING:
Title: ${job.title}
Company: ${job.company}
Location: ${job.location || 'Not Specified'}
ATS Platform: ${job.atsSource}
Description:
${job.description || 'No description provided.'}

RETURN ONLY A VALID JSON OBJECT WITH NO MARKDOWN, NO CODE FENCES, AND NO ADDITIONAL COMMENTARY:
{
  "fitScore": 85,
  "verdict": "Strong Match",
  "matchingSkills": ["Node.js", "MongoDB", "Express"],
  "missingSkills": ["Kubernetes"],
  "reasoning": "Candidate has extensive experience in Node.js and MongoDB backend architecture required for this role."
}`;
}

/**
 * Safely extracts and sanitizes JSON from raw AI model response strings.
 * Recovers from accidental markdown code fences (```json ... ```) or prefix text.
 * 
 * @param {string} rawText 
 * @returns {Object} Parsed JSON object
 */
function extractAndParseJSON(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    throw new Error('Empty response from AI model');
  }

  let cleaned = rawText.trim();

  // Strip markdown code fences if present
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  // Attempt direct parse
  try {
    return JSON.parse(cleaned);
  } catch (_err) {
    // Attempt substring extraction if model wrapped JSON in conversational text
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    throw new Error(`Failed to parse valid JSON from AI response: "${rawText.slice(0, 100)}..."`);
  }
}

/**
 * Validates and normalizes parsed AI evaluation fields to ensure strict schema compliance.
 * @param {Object} rawEvaluation 
 * @returns {{ fitScore: number, verdict: string, matchingSkills: string[], missingSkills: string[], reasoning: string }}
 */
function validateAndNormalizeEvaluation(rawEvaluation) {
  if (!rawEvaluation || typeof rawEvaluation !== 'object') {
    throw new Error('Evaluation result must be a non-null object');
  }

  // 1. Validate & coerce fitScore (0 - 100 integer)
  let fitScore = Number(rawEvaluation.fitScore);
  if (isNaN(fitScore)) {
    throw new Error(`Invalid non-numeric fitScore returned: ${rawEvaluation.fitScore}`);
  }
  fitScore = Math.min(100, Math.max(0, Math.round(fitScore)));

  // 2. Validate & normalize verdict
  let verdict = rawEvaluation.verdict;
  if (!VALID_VERDICTS.includes(verdict)) {
    // Derive deterministic verdict from fitScore if model hallucinated a custom string
    if (fitScore >= 80) verdict = 'Strong Match';
    else if (fitScore >= 60) verdict = 'Moderate Match';
    else verdict = 'Low Match';
  }

  // 3. Validate matchingSkills array
  const matchingSkills = Array.isArray(rawEvaluation.matchingSkills)
    ? rawEvaluation.matchingSkills.map(String).map((s) => s.trim()).filter(Boolean)
    : [];

  // 4. Validate missingSkills array
  const missingSkills = Array.isArray(rawEvaluation.missingSkills)
    ? rawEvaluation.missingSkills.map(String).map((s) => s.trim()).filter(Boolean)
    : [];

  // 5. Validate reasoning string
  const reasoning = typeof rawEvaluation.reasoning === 'string'
    ? rawEvaluation.reasoning.trim()
    : 'No reasoning provided.';

  return {
    fitScore,
    verdict,
    matchingSkills,
    missingSkills,
    reasoning
  };
}

/**
 * Determines whether an error from Gemini API is transient and retryable.
 * @param {Error} error 
 * @returns {boolean}
 */
function isTransientError(error) {
  const message = (error.message || '').toLowerCase();
  const status = error.status || (error.response ? error.response.status : null);

  if (status === 429 || message.includes('429') || message.includes('resource_exhausted') || message.includes('rate limit') || message.includes('quota')) {
    return true;
  }

  if (status && status >= 500) {
    return true;
  }

  if (message.includes('timeout') || message.includes('econnreset') || message.includes('etimedout') || message.includes('network error') || message.includes('fetch failed')) {
    return true;
  }

  return false;
}

/**
 * Evaluates a single job against candidate profile with exponential backoff & jitter.
 * 
 * @param {Object} job - Standardized Job document
 * @param {Object} [candidateProfile] - Candidate profile (defaults to configured profile)
 * @param {Object} [modelInstance] - Optional injected Gemini model for testing
 * @returns {Promise<{ fitScore: number, verdict: string, matchingSkills: string[], missingSkills: string[], reasoning: string }>}
 */
async function matchJob(job, candidateProfile = defaultCandidateProfile, modelInstance = null) {
  if (!job || !job.title) {
    throw new AppError('Valid job object with title is required for matching.', 400);
  }

  const model = modelInstance || getGenerativeModel();
  const prompt = buildEvaluationPrompt(job, candidateProfile);

  const maxRetries = 3;
  const baseDelayMs = 1000;
  const maxDelayMs = 10000;
  let attempt = 0;

  while (attempt <= maxRetries) {
    try {
      logger.debug(`Sending job "${job.title}" (${job.company}) to Gemini AI for evaluation (attempt ${attempt + 1})...`);
      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();

      const rawJson = extractAndParseJSON(text);
      const normalized = validateAndNormalizeEvaluation(rawJson);

      logger.info(`Gemini AI evaluated "${job.title}" @ ${job.company}`, {
        fitScore: normalized.fitScore,
        verdict: normalized.verdict
      });

      return normalized;
    } catch (error) {
      attempt++;
      const isRetryable = isTransientError(error);

      if (!isRetryable || attempt > maxRetries) {
        logger.error(`AI matching failed permanently for job "${job.title}" @ ${job.company}`, {
          error: error.message
        });
        throw error;
      }

      // Exponential backoff with random jitter
      const jitter = Math.random() * 500;
      const backoffMs = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1) + jitter);

      logger.warn(`Gemini AI rate limit / transient error on attempt ${attempt}/${maxRetries}. Retrying in ${Math.round(backoffMs)}ms...`, {
        error: error.message
      });

      await delay(backoffMs);
    }
  }
}

/**
 * Processes pending jobs in MongoDB with controlled rate-limited execution.
 * Evaluates each job, compares against AI_MATCH_THRESHOLD, and updates database records.
 * 
 * @param {number} [batchLimit=20] - Max pending jobs to process in this run
 * @param {Object} [candidateProfile] - Target candidate profile
 * @param {Object} [modelInstance] - Optional injected model instance for testing
 * @returns {Promise<{ totalProcessed: number, matched: number, ignored: number, failed: number, results: Array }>}
 */
async function matchPendingJobs(batchLimit = 20, candidateProfile = defaultCandidateProfile, modelInstance = null) {
  logger.info(`Querying pending jobs for AI evaluation (limit: ${batchLimit})...`);
  const pendingJobs = await jobRepository.findPendingJobs(batchLimit);

  if (!pendingJobs || pendingJobs.length === 0) {
    logger.info('No pending jobs found for AI matching.');
    return {
      totalProcessed: 0,
      matched: 0,
      ignored: 0,
      failed: 0,
      results: []
    };
  }

  logger.info(`Found ${pendingJobs.length} pending jobs to evaluate with Gemini AI.`);

  const matchThreshold = config.agent.aiMatchThreshold || 70;
  const results = [];
  let matchedCount = 0;
  let ignoredCount = 0;
  let failedCount = 0;

  for (let i = 0; i < pendingJobs.length; i++) {
    const job = pendingJobs[i];
    logger.info(`[${i + 1}/${pendingJobs.length}] Evaluating job: "${job.title}" @ ${job.company}`);

    try {
      const evaluation = await matchJob(job, candidateProfile, modelInstance);
      const isMatched = evaluation.fitScore >= matchThreshold;
      const status = isMatched ? 'matched' : 'ignored';

      if (isMatched) {
        matchedCount++;
      } else {
        ignoredCount++;
      }

      const updatedJob = await jobRepository.updateMatchResult(job._id, {
        fitScore: evaluation.fitScore,
        verdict: evaluation.verdict,
        matchingSkills: evaluation.matchingSkills,
        missingSkills: evaluation.missingSkills,
        status
      });

      results.push({
        jobId: job._id,
        title: job.title,
        company: job.company,
        fitScore: evaluation.fitScore,
        verdict: evaluation.verdict,
        status,
        success: true
      });
    } catch (error) {
      failedCount++;
      logger.error(`Failed to process AI match for job "${job.title}" (ID: ${job._id})`, {
        error: error.message
      });

      // Mark as ignored on fatal failure to maintain pipeline integrity
      try {
        await jobRepository.updateMatchResult(job._id, {
          fitScore: 0,
          verdict: 'Low Match',
          matchingSkills: [],
          missingSkills: [],
          status: 'ignored'
        });
      } catch (dbError) {
        logger.error('Failed to update job status after AI failure', { dbError: dbError.message });
      }

      results.push({
        jobId: job._id,
        title: job.title,
        company: job.company,
        status: 'ignored',
        success: false,
        error: error.message
      });
    }

    // Polite delay between Gemini calls to stay within free/standard tier RPM quotas
    if (i < pendingJobs.length - 1) {
      await delay(500);
    }
  }

  const batchSummary = {
    totalProcessed: pendingJobs.length,
    matched: matchedCount,
    ignored: ignoredCount,
    failed: failedCount,
    results
  };

  logger.info('Completed AI matching batch for pending jobs', batchSummary);
  return batchSummary;
}

module.exports = {
  matchJob,
  matchPendingJobs,
  buildEvaluationPrompt,
  extractAndParseJSON,
  validateAndNormalizeEvaluation,
  isTransientError
};
