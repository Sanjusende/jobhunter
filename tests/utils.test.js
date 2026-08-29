const { delay } = require('../src/utils/delay');
const { AppError, formatErrorResponse } = require('../src/utils/errors');
const logger = require('../src/utils/logger');

describe('Utility Modules', () => {
  describe('delay utility', () => {
    it('should resolve after the specified delay', async () => {
      const start = Date.now();
      await delay(50);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(40);
    });

    it('should handle zero or negative delay gracefully', async () => {
      await expect(delay(-10)).resolves.toBeUndefined();
    });
  });

  describe('AppError & Error Formatter', () => {
    it('should create an operational error with status code and details', () => {
      const err = new AppError('Resource not found', 404, { resourceId: '123' });
      expect(err.statusCode).toBe(404);
      expect(err.status).toBe('fail');
      expect(err.isOperational).toBe(true);
      expect(err.details).toEqual({ resourceId: '123' });
    });

    it('should format operational error correctly', () => {
      const err = new AppError('Validation failed', 400, { field: 'email' });
      const formatted = formatErrorResponse(err, false);
      expect(formatted.success).toBe(false);
      expect(formatted.statusCode).toBe(400);
      expect(formatted.message).toBe('Validation failed');
      expect(formatted.details).toEqual({ field: 'email' });
    });

    it('should hide internal error details in production mode', () => {
      const internalErr = new Error('Database raw syntax crash');
      const formatted = formatErrorResponse(internalErr, true);
      expect(formatted.success).toBe(false);
      expect(formatted.statusCode).toBe(500);
      expect(formatted.message).toBe('An internal server error occurred.');
      expect(formatted.stack).toBeUndefined();
    });
  });

  describe('Logger secret redaction', () => {
    it('should redact sensitive keys in logged objects', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      logger.info('User action', {
        username: 'testuser',
        password: 'superSecretPassword123',
        apiKey: 'AIzaSySecretToken',
        token: 'bearer-token-12345'
      });

      expect(consoleSpy).toHaveBeenCalled();
      const loggedData = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(loggedData.meta.password).toBe('***REDACTED***');
      expect(loggedData.meta.apiKey).toBe('***REDACTED***');
      expect(loggedData.meta.token).toBe('***REDACTED***');
      expect(loggedData.meta.username).toBe('testuser');

      consoleSpy.mockRestore();
    });
  });
});
