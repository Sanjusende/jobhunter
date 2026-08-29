/**
 * Promisified asynchronous delay utility.
 * @param {number} ms - Duration in milliseconds to wait.
 * @returns {Promise<void>} Resolves after the specified duration.
 */
function delay(ms) {
  const duration = typeof ms === 'number' && ms >= 0 ? ms : 0;
  return new Promise((resolve) => setTimeout(resolve, duration));
}

module.exports = { delay };
