/**
 * Custom Operational Application Error
 * Encapsulates status code, operational flag, and optional error context details.
 */
class AppError extends Error {
  /**
   * @param {string} message - Descriptive error message
   * @param {number} [statusCode=500] - HTTP status code
   * @param {Object} [details=null] - Additional context details
   * @param {boolean} [isOperational=true] - Indicates if error is operational/expected
   */
  constructor(message, statusCode = 500, details = null, isOperational = true) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';
    this.isOperational = isOperational;
    this.details = details;

    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Formats standard error objects for API responses and logs.
 * @param {Error|AppError} err 
 * @param {boolean} isProduction 
 * @returns {Object} Standardized error response payload
 */
function formatErrorResponse(err, isProduction = false) {
  const statusCode = err.statusCode || 500;
  const isOperational = err.isOperational !== undefined ? err.isOperational : false;

  if (isProduction && !isOperational) {
    return {
      success: false,
      status: 'error',
      statusCode: 500,
      message: 'An internal server error occurred.'
    };
  }

  return {
    success: false,
    status: err.status || 'error',
    statusCode,
    message: err.message || 'Internal Server Error',
    ...(err.details ? { details: err.details } : {}),
    ...(!isProduction && err.stack ? { stack: err.stack } : {})
  };
}

module.exports = {
  AppError,
  formatErrorResponse
};
