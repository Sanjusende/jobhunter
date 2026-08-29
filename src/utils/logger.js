/**
 * Production-Grade Structured Logger
 * Provides level-based filtering, timestamps, metadata support, and automatic secret redaction.
 */

const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

// Sensitive keys to automatically redact in log payloads
const SENSITIVE_KEY_PATTERNS = [
  /pass(word)?/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /auth(orization)?/i,
  /private[_-]?key/i,
  /credential/i
];

/**
 * Recursively redacts sensitive keys from objects and sanitizes strings.
 * @param {*} data - Target data to sanitize
 * @param {WeakSet} [seen] - Cycle detection set
 * @returns {*} Sanitized copy of data
 */
function sanitize(data, seen = new WeakSet()) {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === 'string') {
    // Redact mongodb connection strings containing user:pass
    let sanitized = data.replace(/(mongodb(?:\+srv)?:\/\/[^:]+:)([^@]+)(@)/gi, '$1***:***$3');
    // Redact Bearer tokens in text
    sanitized = sanitized.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, '$1***REDACTED***');
    return sanitized;
  }

  if (typeof data !== 'object') {
    return data;
  }

  if (data instanceof Error) {
    return {
      name: data.name,
      message: sanitize(data.message, seen),
      stack: sanitize(data.stack, seen),
      ...(data.details ? { details: sanitize(data.details, seen) } : {})
    };
  }

  if (seen.has(data)) {
    return '[Circular Reference]';
  }
  seen.add(data);

  if (Array.isArray(data)) {
    return data.map((item) => sanitize(item, seen));
  }

  const sanitizedObj = {};
  for (const [key, value] of Object.entries(data)) {
    const isSensitive = SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
    if (isSensitive) {
      sanitizedObj[key] = '***REDACTED***';
    } else {
      sanitizedObj[key] = sanitize(value, seen);
    }
  }

  return sanitizedObj;
}

class Logger {
  constructor() {
    this.configuredLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
  }

  /**
   * Determine if a message at the given level should be logged.
   * @param {string} level 
   * @returns {boolean}
   */
  shouldLog(level) {
    const currentThreshold = LOG_LEVELS[this.configuredLevel] !== undefined
      ? LOG_LEVELS[this.configuredLevel]
      : LOG_LEVELS.info;
    const targetLevel = LOG_LEVELS[level] !== undefined ? LOG_LEVELS[level] : LOG_LEVELS.info;
    return targetLevel <= currentThreshold;
  }

  /**
   * Formats and writes the log entry to the standard output / error stream.
   * @param {string} level 
   * @param {string} message 
   * @param {*} [meta] 
   */
  log(level, message, meta) {
    if (!this.shouldLog(level)) {
      return;
    }

    const timestamp = new Date().toISOString();
    const cleanMessage = sanitize(message);
    const cleanMeta = meta !== undefined ? sanitize(meta) : undefined;

    const logEntry = {
      timestamp,
      level: level.toUpperCase(),
      message: cleanMessage,
      ...(cleanMeta !== undefined ? { meta: cleanMeta } : {})
    };

    const outputString = JSON.stringify(logEntry);

    if (level === 'error') {
      console.error(outputString);
    } else if (level === 'warn') {
      console.warn(outputString);
    } else {
      console.log(outputString);
    }
  }

  info(message, meta) {
    this.log('info', message, meta);
  }

  warn(message, meta) {
    this.log('warn', message, meta);
  }

  error(message, meta) {
    this.log('error', message, meta);
  }

  debug(message, meta) {
    this.log('debug', message, meta);
  }
}

const logger = new Logger();

module.exports = logger;
