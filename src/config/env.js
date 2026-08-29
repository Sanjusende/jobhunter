/**
 * Environment Configuration and Validation Module
 * Loads dotenv, coerces types, performs sanity validation, and protects secrets.
 */

const path = require('path');
const dotenv = require('dotenv');

// Load environment variables from .env file
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

/**
 * Helper to parse comma-separated string to string array
 * @param {string} val 
 * @returns {string[]}
 */
function parseStringList(val) {
  if (!val || typeof val !== 'string') {
    return [];
  }
  return val
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Validates and normalizes environment variables.
 * @returns {Object} Frozen typed configuration object
 */
function validateAndLoadConfig() {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';

  // Port coercion and validation
  const port = parseInt(process.env.PORT || '5000', 10);
  if (isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(`[Config Error] Invalid PORT specified: "${process.env.PORT}". Expected number between 1 and 65535.`);
  }

  // Log level validation
  const validLogLevels = ['error', 'warn', 'info', 'debug'];
  const logLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
  if (!validLogLevels.includes(logLevel)) {
    throw new Error(`[Config Error] Invalid LOG_LEVEL: "${process.env.LOG_LEVEL}". Must be one of: ${validLogLevels.join(', ')}.`);
  }

  // Mongo URI validation
  const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/job-automation-agent';
  if (!mongoUri.startsWith('mongodb://') && !mongoUri.startsWith('mongodb+srv://')) {
    throw new Error('[Config Error] Invalid MONGO_URI. URI must start with mongodb:// or mongodb+srv://');
  }

  // Timeout coercion
  const requestTimeoutMs = parseInt(process.env.REQUEST_TIMEOUT_MS || '15000', 10);
  if (isNaN(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error(`[Config Error] Invalid REQUEST_TIMEOUT_MS: "${process.env.REQUEST_TIMEOUT_MS}".`);
  }

  // Match threshold & limits
  const aiMatchThreshold = parseInt(process.env.AI_MATCH_THRESHOLD || '70', 10);
  if (isNaN(aiMatchThreshold) || aiMatchThreshold < 0 || aiMatchThreshold > 100) {
    throw new Error(`[Config Error] Invalid AI_MATCH_THRESHOLD: "${process.env.AI_MATCH_THRESHOLD}". Expected 0-100.`);
  }

  const topJobsLimit = parseInt(process.env.TOP_JOBS_LIMIT || '5', 10);
  if (isNaN(topJobsLimit) || topJobsLimit <= 0) {
    throw new Error(`[Config Error] Invalid TOP_JOBS_LIMIT: "${process.env.TOP_JOBS_LIMIT}".`);
  }

  // SMTP Settings
  const smtpPort = parseInt(process.env.SMTP_PORT || '465', 10);
  const smtpSecure = process.env.SMTP_SECURE !== undefined ? process.env.SMTP_SECURE === 'true' : true;

  const config = {
    env: nodeEnv,
    isProduction,
    isDevelopment: nodeEnv === 'development',
    isTest: nodeEnv === 'test',
    server: {
      port,
      requestTimeoutMs
    },
    database: {
      uri: mongoUri
    },
    gemini: {
      apiKey: process.env.GEMINI_API_KEY || '',
      model: process.env.GEMINI_MODEL || 'gemini-1.5-flash'
    },
    smtp: {
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: smtpPort,
      secure: smtpSecure,
      user: process.env.SMTP_USER || '',
      password: process.env.SMTP_PASSWORD || '',
      emailFrom: process.env.EMAIL_FROM || '',
      emailTo: process.env.EMAIL_TO || ''
    },
    companies: {
      greenhouse: parseStringList(process.env.GREENHOUSE_COMPANIES),
      lever: parseStringList(process.env.LEVER_COMPANIES),
      ashby: parseStringList(process.env.ASHBY_COMPANIES)
    },
    agent: {
      aiMatchThreshold,
      topJobsLimit
    },
    logging: {
      level: logLevel
    }
  };

  return Object.freeze(config);
}

const config = validateAndLoadConfig();

module.exports = config;
